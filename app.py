from flask import Flask, jsonify, render_template, request, session, redirect, url_for
import base64
import sqlite3
import os
import time
import re
from functools import wraps
from werkzeug.security import generate_password_hash, check_password_hash
import logging
from logging.handlers import RotatingFileHandler
from datetime import datetime, timedelta
from io import BytesIO
from html import escape

import contextlib
import threading
import json
import hmac
import hashlib
import unicodedata
from sqlalchemy.exc import IntegrityError, SQLAlchemyError

from app_store import AppStore, database_url_from_env



app = Flask(__name__)

# ------------------------
#   Security config
# ------------------------

app.secret_key = os.environ.get("SECRET_KEY", "dev-secret-change-me")

PEPPER = os.environ.get("PASSWORD_PEPPER")
if not PEPPER:
    raise RuntimeError("PASSWORD_PEPPER non impostato: impostalo come variabile ambiente (stringa random lunga).")

RATE_SECRET = os.environ.get("RATE_SECRET")
if not RATE_SECRET:
    raise RuntimeError("RATE_SECRET non impostato: impostalo come variabile ambiente (stringa random lunga).")

def ip_token(ip: str) -> str:
    return hmac.new(
        RATE_SECRET.encode("utf-8"),
        ip.encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()

# Cookie/session hardening (su PythonAnywhere sei in HTTPS -> True; in locale puoi mettere False)
app.config.update(
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
    SESSION_COOKIE_SECURE=True,
)

app.config["PERMANENT_SESSION_LIFETIME"] = timedelta(hours=2)

# ------------------------
#   Disable HTTP caching for API responses
#   (important: prevents stale questions after changing DB)
# ------------------------
@app.after_request
def _no_cache_api(resp):
    try:
        if request.path.startswith("/api/"):
            resp.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
            resp.headers["Pragma"] = "no-cache"
            resp.headers["Expires"] = "0"
            resp.headers["Vary"] = "Cookie"
    except Exception:
        pass
    return resp

USERNAME_RE = re.compile(r"^[a-z0-9_]{3,20}$")
PASSWORD_RE = re.compile(r"^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z0-9]).{8,}$")

# ------------------------
#   Paths / DB scanning
# ------------------------

DB_DIR = os.path.join(app.root_path, "data")
os.makedirs(DB_DIR, exist_ok=True)

_DB_CATALOG_LOCK = threading.Lock()
_DB_CATALOG_SIGNATURE = None
_DB_CATALOG = {}

def _title_from_filename(filename: str) -> str:
    name = os.path.splitext(os.path.basename(filename))[0]
    name = name.replace("-", " ").replace("_", " ").strip()
    for suffix in (" quiz", " db"):
        if name.lower().endswith(suffix):
            name = name[: -len(suffix)].strip()
    return name.title() if name else "Materia"

def _normalize_search(value) -> str:
    """Normalizza testo per una ricerca case/accent-insensitive."""
    if value is None:
        return ""
    text = unicodedata.normalize("NFKD", str(value)).casefold()
    return " ".join(
        "".join(ch for ch in text if not unicodedata.combining(ch)).split()
    )

def _escape_like(value: str) -> str:
    return value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")

def get_subject_label(db_path: str) -> str:
    """Legge il nome materia da meta.subject, fallback sul filename."""
    fallback = _title_from_filename(db_path)
    try:
        conn = sqlite3.connect(db_path)
        try:
            cur = conn.cursor()
            cur.execute("SELECT value FROM meta WHERE key='subject' LIMIT 1")
            row = cur.fetchone()
            if row and row[0]:
                return str(row[0]).strip()
        finally:
            conn.close()
    except Exception:
        pass
    return fallback

def scan_databases():
    """Ritorna: {db_key: {path, label}}. db_key = filename (es: programmazione_2.db)."""
    global _DB_CATALOG_SIGNATURE, _DB_CATALOG

    entries = []
    for fname in os.listdir(DB_DIR):
        if not fname.lower().endswith(".db"):
            continue
        full = os.path.join(DB_DIR, fname)
        if not os.path.isfile(full):
            continue
        stat = os.stat(full)
        entries.append((fname, full, stat.st_mtime_ns, stat.st_size))

    signature = tuple(sorted((fname, mtime, size) for fname, _, mtime, size in entries))
    if signature == _DB_CATALOG_SIGNATURE:
        return _DB_CATALOG

    with _DB_CATALOG_LOCK:
        if signature != _DB_CATALOG_SIGNATURE:
            _DB_CATALOG = {
                fname: {"path": full, "label": get_subject_label(full)}
                for fname, full, _, _ in entries
            }
            _DB_CATALOG_SIGNATURE = signature
    return _DB_CATALOG

def get_db_path():
    dbs = scan_databases()
    active = session.get("db_key")
    if not active or active not in dbs:
        return None
    return dbs[active]["path"]

def get_connection():
    db_path = get_db_path()
    if not db_path:
        raise RuntimeError("Nessun database selezionato")
    return sqlite3.connect(db_path)

def require_db_selected():
    if not get_db_path():
        return jsonify({"error": "Seleziona prima una materia"}), 400
    return None

# ------------------------
#   App DB (users + saved)
# ------------------------

def _detect_app_db_path() -> str:
    """Sceglie il DB applicativo corretto (utenti + salvataggi).

    Questa funzione prova più candidati e sceglie quello che contiene già la tabella 'users'.
    """
    env_path = os.environ.get("APP_DB_PATH")
    if env_path:
        return os.path.abspath(env_path)

    candidates = []
    candidates.append(os.path.join(app.root_path, "instance", "app.db"))
    candidates.append(os.path.join(app.root_path, "app.db"))

    def has_users_table(p: str) -> bool:
        try:
            if not os.path.exists(p) or os.path.isdir(p):
                return False
            conn = sqlite3.connect(p)
            try:
                cur = conn.cursor()
                cur.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='users'")
                return cur.fetchone() is not None
            finally:
                conn.close()
        except Exception:
            return False

    # se un candidato esiste già ed ha 'users', usalo
    for p in candidates:
        if p and has_users_table(p):
            return p

    # altrimenti, se esiste un file DB (anche vuoto) usa quello in instance per default
    return candidates[0]

APP_DB_PATH = _detect_app_db_path()
os.makedirs(os.path.dirname(APP_DB_PATH), exist_ok=True)

def get_app_connection():
    conn = sqlite3.connect(APP_DB_PATH, timeout=30, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys=ON;")
    conn.execute("PRAGMA journal_mode=WAL;")
    conn.execute("PRAGMA synchronous=NORMAL;")
    conn.execute("PRAGMA busy_timeout=10000;")
    return conn



# --- App DB helpers: safe reads/writes with proper close + retries ---
APP_DB_WRITE_LOCK = threading.Lock()

def _sleep_backoff(attempt: int) -> None:
    # small exponential backoff (ms -> s)
    time.sleep(min(1.5, 0.15 * (2 ** attempt)))

@contextlib.contextmanager
def app_db_read():
    """Open app.db for read operations. Always closes."""
    conn = get_app_connection()
    try:
        yield conn
    finally:
        try:
            conn.close()
        except Exception:
            pass

@contextlib.contextmanager
def app_db_write():
    """Open app.db for a single write transaction.

    - Serializes writes within the worker (threading lock)
    - Uses BEGIN IMMEDIATE + retry on 'database is locked'
    - Guarantees rollback/close on errors
    """
    with APP_DB_WRITE_LOCK:
        conn = get_app_connection()
        try:
            # Acquire the write lock early to avoid long waits mid-operation.
            for attempt in range(6):
                try:
                    conn.execute("BEGIN IMMEDIATE")
                    break
                except sqlite3.OperationalError as e:
                    if "locked" in str(e).lower():
                        _sleep_backoff(attempt)
                        continue
                    raise
            else:
                raise sqlite3.OperationalError("database is locked (BEGIN IMMEDIATE retries exhausted)")

            yield conn

            conn.commit()
        except Exception:
            try:
                conn.rollback()
            except Exception:
                pass
            raise
        finally:
            try:
                conn.close()
            except Exception:
                pass
def execute_with_retry(conn, sql, params=(), retries: int = 4):
    delay = 0.12
    for _ in range(retries):
        try:
            return conn.execute(sql, params)
        except sqlite3.OperationalError as e:
            if "locked" in str(e).lower():
                time.sleep(delay)
                delay *= 1.8
                continue
            raise
    raise sqlite3.OperationalError("database is locked (after retries)")


def _saved_count(user_id: int, db_key: str) -> int:
    conn = get_app_connection()
    cur = conn.cursor()
    cur.execute(
        "SELECT COUNT(*) FROM saved_questions WHERE user_id=? AND db_key=?",
        (user_id, db_key),
    )
    n = int(cur.fetchone()[0] or 0)
    conn.close()
    return n


def _saved_ids(user_id: int, db_key: str) -> list[int]:
    conn = get_app_connection()
    cur = conn.cursor()
    cur.execute(
        "SELECT question_id FROM saved_questions WHERE user_id=? AND db_key=? ORDER BY created_at ASC",
        (user_id, db_key),
    )
    ids = [int(r[0]) for r in cur.fetchall()]
    conn.close()
    return ids


_ATTEMPT_ACCURACY_SQL = (
    "(correct_count * 1.0 / (correct_count + wrong_count))"
)
_REVIEW_ERRORS_WHERE = (
    "wrong_count > 0 AND "
    f"(last_result = 0 OR ({_ATTEMPT_ACCURACY_SQL} < 0.50 AND correct_streak < 3))"
)
_REVIEW_STRENGTHS_WHERE = (
    "correct_count > 0 AND last_result = 1 AND "
    "(wrong_count = 0 OR correct_streak >= 3)"
)
_REVIEW_CONSOLIDATE_WHERE = (
    "wrong_count > 0 AND "
    f"NOT ({_REVIEW_ERRORS_WHERE}) AND "
    f"NOT ({_REVIEW_STRENGTHS_WHERE})"
)


def _review_stats(user_id: int, db_key: str) -> dict:
    with app_db_read() as conn:
        row = conn.execute(
            f"""
            SELECT
                COUNT(*) AS tracked,
                SUM(CASE WHEN {_REVIEW_ERRORS_WHERE} THEN 1 ELSE 0 END) AS errors,
                SUM(CASE WHEN {_REVIEW_CONSOLIDATE_WHERE} THEN 1 ELSE 0 END) AS consolidate,
                SUM(CASE WHEN {_REVIEW_STRENGTHS_WHERE} THEN 1 ELSE 0 END) AS strengths
            FROM question_attempt_stats
            WHERE user_id=? AND db_key=?
            """,
            (user_id, db_key),
        ).fetchone()

    return {
        "tracked": int(row["tracked"] or 0),
        "errors": int(row["errors"] or 0),
        "consolidate": int(row["consolidate"] or 0),
        "strengths": int(row["strengths"] or 0),
    }


def init_app_db():
    # Anche la migrazione deve essere serializzata a livello SQLite:
    # il lock Python da solo non copre più worker/processi WSGI.
    with app_db_write() as conn:
        cur = conn.cursor()

        # Utenti
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT NOT NULL UNIQUE,
                password_hash TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                is_active INTEGER NOT NULL DEFAULT 1,
                last_db_key TEXT,
                last_login TEXT
            )
            """
        )

        # Legacy (se presente da versioni precedenti)
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS saved_questions (
                user_id INTEGER NOT NULL,
                db_key TEXT NOT NULL,
                question_id INTEGER NOT NULL,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                PRIMARY KEY (user_id, db_key, question_id),
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            )
            """
        )
        cur.execute("CREATE INDEX IF NOT EXISTS idx_saved_user_db ON saved_questions(user_id, db_key)")
        cur.execute("CREATE INDEX IF NOT EXISTS idx_saved_qid ON saved_questions(question_id)")

        # Nuova tabella salvataggi per utente e materia (db)
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS user_saved_questions (
                user_id INTEGER NOT NULL,
                db_key TEXT NOT NULL,
                question_id INTEGER NOT NULL,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                PRIMARY KEY (user_id, db_key, question_id),
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            )
            """
        )
        cur.execute("CREATE INDEX IF NOT EXISTS idx_saved_user_db2 ON user_saved_questions(user_id, db_key)")

        # Statistiche personali per il ripasso. Restano nell'app DB:
        # i database delle materie non vengono modificati.
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS question_attempt_stats (
                user_id INTEGER NOT NULL,
                db_key TEXT NOT NULL,
                question_id INTEGER NOT NULL,
                correct_count INTEGER NOT NULL DEFAULT 0,
                wrong_count INTEGER NOT NULL DEFAULT 0,
                correct_streak INTEGER NOT NULL DEFAULT 0,
                last_result INTEGER NOT NULL DEFAULT 0,
                last_attempt_at TEXT NOT NULL DEFAULT (datetime('now')),
                PRIMARY KEY (user_id, db_key, question_id),
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            )
            """
        )
        cur.execute(
            "CREATE INDEX IF NOT EXISTS idx_attempts_user_db "
            "ON question_attempt_stats(user_id, db_key)"
        )
        cur.execute(
            "CREATE INDEX IF NOT EXISTS idx_attempts_review "
            "ON question_attempt_stats(user_id, db_key, wrong_count, correct_count)"
        )

        # --- MIGRAZIONI SCHEMA (compatibilità con DB già esistenti) ---
        def _ensure_column(table: str, col: str, col_def: str):
            cur.execute(f"PRAGMA table_info({table})")
            cols = [r[1] for r in cur.fetchall()]
            if col not in cols:
                cur.execute(f"ALTER TABLE {table} ADD COLUMN {col} {col_def}")

        # users: last_login può mancare se il DB è stato creato con una versione precedente
        _ensure_column("users", "last_login", "TEXT")
        _ensure_column("users", "last_db_key", "TEXT")
        _ensure_column("users", "is_active", "INTEGER DEFAULT 1")
        _ensure_column("question_attempt_stats", "correct_streak", "INTEGER NOT NULL DEFAULT 0")


APP_DATABASE_URL = database_url_from_env()
APP_STORE = AppStore(APP_DATABASE_URL, APP_DB_PATH)
APP_STORE.initialize()


def _saved_count(user_id: int, db_key: str) -> int:
    return APP_STORE.saved_count(user_id, db_key)


def _saved_ids(user_id: int, db_key: str) -> list[int]:
    return APP_STORE.saved_ids(user_id, db_key)


def _review_stats(user_id: int, db_key: str) -> dict:
    return APP_STORE.review_stats(user_id, db_key)

#-------------------------
#  auth.log
#-------------------------

AUTH_LOG_PATH = os.environ.get(
    "AUTH_LOG_PATH",
    os.path.join(os.path.expanduser("~"), "auth.log"),
)

auth_logger = logging.getLogger("auth")
auth_logger.setLevel(logging.INFO)

if not auth_logger.handlers:
    handler = RotatingFileHandler(AUTH_LOG_PATH, maxBytes=2_000_000, backupCount=3)
    formatter = logging.Formatter("%(asctime)s %(levelname)s %(message)s")
    handler.setFormatter(formatter)
    auth_logger.addHandler(handler)


def _client_ip() -> str:

    return (request.headers.get("X-Forwarded-For") or request.remote_addr or "unknown").split(",")[0].strip()


def auth_log(event: str, **fields):
    ua = request.headers.get("User-Agent", "?")
    ipk = ip_token(_client_ip())
    kv = " ".join([f"{k}={repr(v)}" for k, v in fields.items()])
    auth_logger.info(f"{event} ipk={ipk} ua={ua!r} {kv}")



# ------------------------
#   Simple rate limit (in-memory)
# ------------------------

_RATE = {}  # key -> [timestamps]

def _rate_ok(key: str, limit: int, window_sec: int) -> bool:
    now = time.time()
    lst = _RATE.get(key, [])
    lst = [t for t in lst if now - t <= window_sec]
    if len(lst) >= limit:
        _RATE[key] = lst
        return False
    lst.append(now)
    _RATE[key] = lst
    return True

# ------------------------
#   Auth helpers
# ------------------------

def login_required(view):
    @wraps(view)
    def wrapped(*args, **kwargs):
        if not session.get("user_id"):
            if request.path.startswith("/api/"):
                return jsonify({"error": "Not authenticated"}), 401
            return redirect(url_for("login", next=request.path))
        return view(*args, **kwargs)
    return wrapped

# ------------------------
#   Question payload + cache
# ------------------------

QUESTION_CACHE = {}
QUESTION_CACHE_ORDER = []
QUESTION_CACHE_MAX = 500  # per processo

def _cache_get(key):
    if key in QUESTION_CACHE:
        try:
            QUESTION_CACHE_ORDER.remove(key)
        except ValueError:
            pass
        QUESTION_CACHE_ORDER.append(key)
        return QUESTION_CACHE[key]
    return None

def _cache_set(key, value):
    if key in QUESTION_CACHE:
        QUESTION_CACHE[key] = value
        try:
            QUESTION_CACHE_ORDER.remove(key)
        except ValueError:
            pass
        QUESTION_CACHE_ORDER.append(key)
        return
    QUESTION_CACHE[key] = value
    QUESTION_CACHE_ORDER.append(key)
    while len(QUESTION_CACHE_ORDER) > QUESTION_CACHE_MAX:
        old = QUESTION_CACHE_ORDER.pop(0)
        QUESTION_CACHE.pop(old, None)

def _blob_to_b64(val):
    if val is None:
        return None

    # sqlite può restituire memoryview per i BLOB
    if isinstance(val, memoryview):
        val = val.tobytes()

    # se è già una stringa (probabilmente base64 già pronta)
    if isinstance(val, str):
        s = val.strip()
        try:
            # se è base64 valido lo restituiamo così com'è
            base64.b64decode(s, validate=True)
            return s
        except Exception:
            # fallback: codifica il testo
            return base64.b64encode(s.encode("utf-8")).decode("utf-8")

    # caso normale: bytes
    return base64.b64encode(val).decode("utf-8")

def _image_mime(val) -> str:
    if val is None:
        return "application/octet-stream"
    if isinstance(val, memoryview):
        raw = val.tobytes()
    elif isinstance(val, str):
        try:
            raw = base64.b64decode(val.strip(), validate=True)
        except Exception:
            raw = val.encode("utf-8", errors="ignore")
    else:
        raw = bytes(val)

    if raw.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if raw.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if raw.startswith((b"GIF87a", b"GIF89a")):
        return "image/gif"
    if raw.startswith(b"RIFF") and raw[8:12] == b"WEBP":
        return "image/webp"
    return "application/octet-stream"


def _load_db_meta():
    meta_path = os.path.join(app.root_path, "data", "db_meta.json")
    if not os.path.exists(meta_path):
        return {}
    try:
        with open(meta_path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def _source_meta_from_db_or_legacy(cursor, db_key, question_id):
    try:
        cursor.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='db_sources'")
        if cursor.fetchone() is not None:
            cursor.execute(
                "SELECT source, note FROM db_sources WHERE db_key=? AND ? BETWEEN q_from AND q_to ORDER BY id DESC LIMIT 1",
                (db_key, question_id),
            )
            row = cursor.fetchone()
            if row:
                s = (row[0] or "").strip()
                n = (row[1] or "").strip()
                return s or None, n or None
    except Exception:
        pass

    meta = _load_db_meta().get(db_key, {})
    for item in meta.get("ranges", []) or []:
        try:
            a = int(item.get("from") or 0); b = int(item.get("to") or 0)
        except Exception:
            continue
        lo, hi = (a, b) if a <= b else (b, a)
        if lo <= question_id <= hi:
            return (str(item.get("source") or "").strip() or None, str(item.get("note") or "").strip() or None)
    return None, None


def _database_info_from_db_or_legacy(db_key):
    dbs = scan_databases()
    info = dbs.get(db_key)
    if not info:
        return None
    db_path = info.get("path")
    title = info.get("label")
    total = 0
    sources = []
    try:
        conn = sqlite3.connect(db_path)
        cur = conn.cursor()
        try:
            cur.execute("SELECT value FROM meta WHERE key='subject' LIMIT 1")
            row = cur.fetchone()
            if row and row[0]:
                title = str(row[0]).strip()
        except Exception:
            pass
        try:
            cur.execute("SELECT COUNT(*) FROM questions")
            total = int(cur.fetchone()[0] or 0)
        except Exception:
            total = 0
        try:
            cur.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='db_sources'")
            if cur.fetchone() is not None:
                cur.execute(
                    "SELECT q_from, q_to, TRIM(COALESCE(source,'')) as source, TRIM(COALESCE(note,'')) as note FROM db_sources WHERE db_key=? ORDER BY q_from ASC, q_to ASC",
                    (db_key,),
                )
                rows = cur.fetchall()
                agg = {}
                for q_from, q_to, src, note in rows:
                    try:
                        a = int(q_from); b = int(q_to)
                    except Exception:
                        continue
                    if a <= 0 or b <= 0:
                        continue
                    lo, hi = (a, b) if a <= b else (b, a)
                    label = src if src else "(senza fonte)"
                    item = agg.setdefault(label, {"source": label, "count": 0, "from": lo, "to": hi, "ranges": [], "note": None})
                    item["count"] += (hi - lo + 1)
                    item["from"] = min(item["from"], lo)
                    item["to"] = max(item["to"], hi)
                    item["ranges"].append([lo, hi])
                    if not item["note"] and note:
                        item["note"] = note
                sources = list(agg.values())
                sources.sort(key=lambda x: (x.get("from", 10**9), x.get("to", 10**9)))
        except Exception:
            sources = []
        conn.close()
    except Exception:
        pass
    if not sources:
        meta = _load_db_meta().get(db_key, {})
        title = meta.get("title") or title
        for item in meta.get("ranges", []) or []:
            try:
                a = int(item.get("from") or 0); b = int(item.get("to") or 0)
            except Exception:
                continue
            if a <= 0 or b <= 0:
                continue
            lo, hi = (a, b) if a <= b else (b, a)
            sources.append({"source": str(item.get("source") or "").strip() or "(senza fonte)", "count": hi-lo+1, "from": lo, "to": hi, "ranges": [[lo,hi]], "note": str(item.get("note") or "").strip() or None})
    return {"db_key": db_key, "title": title, "total": total, "sources": sources}


def build_question_payload(cursor, question_id, include_images=True):
    cursor.execute("SELECT id, testo, immagine FROM questions WHERE id = ?", (question_id,))
    row = cursor.fetchone()
    if row is None:
        return None

    q_id, testo, img_blob = row
    image_b64 = _blob_to_b64(img_blob) if img_blob is not None and include_images else None


    cursor.execute(
        "SELECT id, testo, corretta, immagine FROM answers WHERE domanda_id = ?",
        (q_id,),
    )

    answers = []
    correct_id = None
    for ans_id, ans_text, corretta, ans_blob in cursor.fetchall():
        ans_img_b64 = _blob_to_b64(ans_blob) if ans_blob is not None and include_images else None

        answers.append({
            "id": ans_id,
            "testo": ans_text,
            "immagine": ans_img_b64,
            "immagine_mime": _image_mime(ans_blob) if ans_img_b64 else None,
        })
        if corretta:
            correct_id = ans_id

    source_label, source_note = _source_meta_from_db_or_legacy(cursor, session.get("db_key"), q_id)

    return {
        "id": q_id,
        "testo": testo,
        "immagine": image_b64,
        "immagine_mime": _image_mime(img_blob) if image_b64 else None,
        "risposte": answers,
        "corretta": correct_id,
        "source": source_label,
        "source_note": source_note,
    }

def get_question_cached(qid: int, include_images: bool):
    db_key = session.get("db_key")
    if not db_key:
        return None
    db_path = get_db_path()
    if not db_path:
        return None
    try:
        db_version = os.stat(db_path).st_mtime_ns
    except OSError:
        return None
    cache_key = (db_key, db_version, qid, include_images)
    hit = _cache_get(cache_key)
    if hit is not None:
        return hit

    conn = get_connection()
    cur = conn.cursor()
    payload = build_question_payload(cur, qid, include_images=include_images)
    conn.close()

    if payload is not None:
        _cache_set(cache_key, payload)
    return payload

# ------------------------
#   Routes: Auth pages
# ------------------------

@app.route("/login", methods=["GET", "POST"])
def login():
    # next può arrivare sia in querystring (GET) sia nel form (POST)
    next_url = request.args.get("next") or request.form.get("next") or "/"

    if request.method == "GET":
        return render_template("login.html", next=next_url)

    ipk = ip_token(_client_ip())
    if not _rate_ok(f"login:ip:{ipk}", limit=10, window_sec=60):
        auth_log("LOGIN_RATE_LIMIT", scope="ip")
        return render_template("login.html", next=next_url, error="Troppi tentativi. Riprova tra un minuto."), 429


    username = (request.form.get("username") or "").strip().lower()
    password = request.form.get("password") or ""

    if not username or not password:
        auth_log("LOGIN_FAIL", reason="missing_fields", user=username)
        # 200: errore umano, non errore di request
        return render_template("login.html", next=next_url, error="Inserisci username e password."), 200

    if not _rate_ok(f"login:user:{username}", limit=5, window_sec=60):
        auth_log("LOGIN_RATE_LIMIT", scope="user", user=username)
        return render_template("login.html", next=next_url, error="Troppi tentativi su questo utente. Riprova tra un minuto."), 429

    row = APP_STORE.get_user_by_username(username)

    # Messaggio unico “bad credentials” (non rivela se l’utente esiste)
    if not row:
        auth_log("LOGIN_FAIL", reason="bad_credentials_user_not_found", user=username)
        return render_template("login.html", next=next_url, error="Credenziali non valide."), 200

    user_id = int(row["id"])
    pw_hash = row["password_hash"]
    is_active = bool(row["is_active"])
    last_db_key = row["last_db_key"]
    if not is_active:
        auth_log("LOGIN_FAIL", reason="inactive_account", user=username, user_id=user_id)
        return render_template("login.html", next=next_url, error="Account disattivato."), 403

    if not check_password_hash(pw_hash, password + PEPPER):
        auth_log("LOGIN_FAIL", reason="bad_credentials_bad_password", user=username, user_id=user_id)
        return render_template("login.html", next=next_url, error="Credenziali non valide."), 200

    # OK
    session.clear()
    session["user_id"] = user_id
    session["username"] = username
    session.permanent = True

    # last_login
    try:
        APP_STORE.update_last_login(user_id)
    except SQLAlchemyError:
        pass


    dbs = scan_databases()
    if last_db_key and last_db_key in dbs:
        session["db_key"] = last_db_key
    else:
        session.pop("db_key", None)

    auth_log("LOGIN_OK", user=username, user_id=user_id, next=next_url)
    return redirect(next_url)


@app.route("/register", methods=["GET", "POST"])
def register():
    if request.method == "GET":
        return render_template("register.html")

    ipk = ip_token(_client_ip())
    if not _rate_ok(f"register:ip:{ipk}", limit=5, window_sec=3600):
        auth_log("REGISTER_RATE_LIMIT", scope="ip")
        return render_template("register.html", error="Troppe registrazioni da questo IP. Riprova più tardi."), 429

    # honeypot anti-bot
    if (request.form.get("website") or "").strip():
        auth_log("REGISTER_FAIL", reason="honeypot", website=request.form.get("website"))
        return render_template("register.html", error="Registrazione non valida."), 200

    username = (request.form.get("username") or "").strip().lower()
    password = request.form.get("password") or ""
    password2 = request.form.get("password2") or ""

    if not USERNAME_RE.fullmatch(username):
        auth_log("REGISTER_FAIL", reason="bad_username", user=username)
        return render_template(
            "register.html",
            error="Username non valido. Usa 3-20 caratteri: lettere, numeri e underscore (non case-sensitive)."
        ), 200

    if password != password2:
        auth_log("REGISTER_FAIL", reason="pw_mismatch", user=username)
        return render_template("register.html", error="Le password non coincidono."), 200

    if not PASSWORD_RE.match(password):
        auth_log("REGISTER_FAIL", reason="pw_weak", user=username)
        return render_template(
            "register.html",
            error="Password non valida: min 8 caratteri, almeno una maiuscola, una minuscola, un numero e un carattere speciale."
        ), 200

    pw_hash = generate_password_hash(password + PEPPER)

    try:
        # ✅ WRITE protetta
        user_id = APP_STORE.create_user(username, pw_hash)
    except IntegrityError:
        auth_log("REGISTER_FAIL", reason="username_taken", user=username)
        return render_template("register.html", error="Username già registrato."), 200

    auth_log("REGISTER_OK", user=username, user_id=user_id)
    return redirect(url_for("login", registered=1))



@app.route("/logout", methods=["POST"])
@login_required
def logout():
    session.clear()
    return redirect(url_for("login"))

# ------------------------
#   Page: Quiz (protetta)
# ------------------------

@app.route("/")
@login_required
def index():
    return render_template("quiz.html", username=session.get("username",""))

# ------------------------
#   API: User (protette)
# ------------------------

@app.route("/api/me", methods=["GET"])
@login_required
def api_me():
    return jsonify({"username": session.get("username", "")})

@app.route("/api/saved_count", methods=["GET"])
@login_required
def api_saved_count():
    user_id = int(session["user_id"])
    db_key = session.get("db_key", "") or ""
    if not db_key:
        return jsonify({"count": 0})
    return jsonify({"count": _saved_count(user_id, db_key)})


@app.route("/api/saved_ids", methods=["GET"])
@login_required
def api_saved_ids():
    user_id = int(session["user_id"])
    db_key = session.get("db_key", "") or ""
    if not db_key:
        return jsonify({"ids": []})
    return jsonify({"ids": _saved_ids(user_id, db_key)})

# ------------------------
#   API: Materie (protette)
# ------------------------

@app.route("/api/databases", methods=["GET"])
@login_required
def list_databases():
    dbs = scan_databases()
    active = session.get("db_key")
    if active not in dbs:
        active = None

    options = [{"key": k, "label": v["label"]} for k, v in dbs.items()]
    options.sort(key=lambda x: x["label"].lower())
    return jsonify({"active": active, "options": options})

@app.get("/api/database_info")
@login_required
def api_database_info():
    db_key = request.args.get("db_key", "").strip()
    if not db_key:
        return jsonify({"ok": False, "error": "missing db_key"}), 400

    info = _database_info_from_db_or_legacy(db_key)
    if info is None:
        return jsonify({"ok": False, "error": "db_key not found"}), 404

    return jsonify({
        "ok": True,
        "db_key": db_key,
        "title": info.get("title"),
        "total": info.get("total", 0),
        "sources": info.get("sources", []),
        "ranges": [{"from": s.get("from"), "to": s.get("to"), "source": s.get("source"), "note": s.get("note")} for s in info.get("sources", [])],
    })


@app.post("/api/random_questions_weighted")
@login_required
def random_questions_weighted():
    guard = require_db_selected()
    if guard:
        return guard

    data = request.get_json(silent=True)
    if data is None:
        data = {}
    if not isinstance(data, dict):
        return jsonify({"error": "Payload non valido"}), 400
    try:
        limit = int(data.get("limit") or 30)
    except (TypeError, ValueError):
        return jsonify({"error": "Numero di domande non valido"}), 400
    limit = max(1, min(limit, 200))
    weights = data.get("weights") or {}
    if not isinstance(weights, dict):
        weights = {}

    clean_weights = {}
    for k, v in list(weights.items())[:50]:
        try:
            pct = float(v)
        except Exception:
            continue
        pct = max(0.0, min(100.0, pct))
        name = str(k).strip()
        if name:
            clean_weights[name] = pct

    conn = get_connection()
    cur = conn.cursor()

    def random_fallback(msg=None):
        cur.execute("SELECT id FROM questions ORDER BY RANDOM() LIMIT ?", (limit,))
        ids = [r[0] for r in cur.fetchall()]
        out = []
        for qid in ids:
            payload = get_question_cached(qid, include_images=True)
            if payload:
                out.append(payload)
        return jsonify({"questions": out, "warning": msg, "meta": {"limit": limit, "selected_sources": []}})

    if not clean_weights or sum(clean_weights.values()) <= 0:
        try:
            return random_fallback(None)
        finally:
            conn.close()

    db_key = session.get("db_key")
    info = _database_info_from_db_or_legacy(db_key) or {}
    source_defs = info.get("sources", []) or []
    pools = {}
    notes = {}
    for item in source_defs:
        label = str(item.get("source") or "").strip() or "(senza fonte)"
        ranges = []
        for pair in item.get("ranges", []) or []:
            try:
                a, b = int(pair[0]), int(pair[1])
            except Exception:
                continue
            lo, hi = (a, b) if a <= b else (b, a)
            ranges.append((lo, hi))
        if not ranges:
            try:
                a = int(item.get("from")); b = int(item.get("to"))
                lo, hi = (a, b) if a <= b else (b, a)
                ranges = [(lo, hi)]
            except Exception:
                ranges = []
        if ranges:
            pools[label] = {"ranges": ranges, "count": int(item.get("count") or sum(hi-lo+1 for lo,hi in ranges))}
            if item.get("note"):
                notes[label] = item.get("note")

    if not pools:
        try:
            return random_fallback("Nessun pool/fonte configurato per questa materia.")
        finally:
            conn.close()

    selected = {k: v for k, v in clean_weights.items() if k in pools and v > 0}
    if not selected:
        try:
            return random_fallback("I pool selezionati non esistono per questa materia.")
        finally:
            conn.close()

    total_pct = sum(selected.values())
    raw = [(src, (pct / total_pct) * limit) for src, pct in selected.items()]
    base = {src: int(x) for src, x in raw}
    remaining = limit - sum(base.values())
    remainders = sorted([(src, x - base[src]) for src, x in raw], key=lambda t: t[1], reverse=True)
    for i in range(max(0, remaining)):
        src = remainders[i % len(remainders)][0]
        base[src] += 1

    picked_ids = []
    picked_set = set()

    def pick_from_ranges(ranges, n_take):
        if n_take <= 0:
            return []
        clauses = []
        params = []
        for lo, hi in ranges:
            clauses.append("(id BETWEEN ? AND ?)")
            params.extend([lo, hi])
        q = f"SELECT id FROM questions WHERE ({' OR '.join(clauses) if clauses else '1=0'}) ORDER BY RANDOM() LIMIT ?"
        params.append(n_take * 3)
        cur.execute(q, tuple(params))
        ids = []
        for (qid,) in cur.fetchall():
            if qid in picked_set:
                continue
            picked_set.add(qid)
            ids.append(qid)
            if len(ids) >= n_take:
                break
        return ids

    for src, n_take in base.items():
        picked_ids.extend(pick_from_ranges(pools[src]["ranges"], n_take))

    missing = limit - len(picked_ids)
    if missing > 0:
        all_ranges = []
        for src in selected.keys():
            all_ranges.extend(pools[src]["ranges"])
        picked_ids.extend(pick_from_ranges(all_ranges, missing))

    available = sum(pools[src]["count"] for src in selected.keys())
    warning = None
    if limit > available:
        warning = f"Hai chiesto {limit} domande ma i pool selezionati ne hanno solo {available}."

    out = []
    for qid in picked_ids[:limit]:
        payload = get_question_cached(qid, include_images=True)
        if payload:
            out.append(payload)

    conn.close()
    return jsonify({"questions": out, "warning": warning, "meta": {"limit": limit, "requested": limit, "available": available, "selected_sources": [{"source": s, "pct": float(selected[s]), "count": int(pools[s]["count"]), "note": notes.get(s)} for s in selected.keys()]}})


@app.route("/api/set_database", methods=["POST"])
@login_required
def set_database():
    dbs = scan_databases()
    data = request.get_json(silent=True)
    if data is None:
        data = {}
    if not isinstance(data, dict):
        return jsonify({"error": "Payload non valido"}), 400
    db_key = data.get("db_key")

    if not db_key or db_key not in dbs:
        return jsonify({"error": "Materia/Database non valido"}), 400

    session["db_key"] = db_key
    session.modified = True

    user_id = session["user_id"]

    # ✅ WRITE protetta: lock + BEGIN IMMEDIATE + retry + commit/close garantiti
    APP_STORE.update_last_db_key(user_id, db_key)

    return jsonify({"message": "Materia impostata", "active": db_key})


# ------------------------
#   API: Quiz (protette)
# ------------------------


@app.route("/api/questions_count", methods=["GET"])
@login_required
def questions_count():
    guard = require_db_selected()
    if guard:
        return guard
    conn = get_connection()
    cur = conn.cursor()
    cur.execute("SELECT COUNT(*) FROM questions")
    n = int(cur.fetchone()[0] or 0)
    conn.close()
    return jsonify({"count": n})

@app.route("/api/search_questions", methods=["GET"])
@login_required
def search_questions():
    guard = require_db_selected()
    if guard:
        return guard

    query = (request.args.get("q") or "").strip()
    if len(query) < 2:
        return jsonify({"error": "Inserisci almeno 2 caratteri"}), 400
    if len(query) > 120:
        return jsonify({"error": "Ricerca troppo lunga"}), 400

    terms = [_escape_like(term) for term in _normalize_search(query).split()[:8] if term]
    if not terms:
        return jsonify({"error": "Ricerca non valida"}), 400

    limit = request.args.get("limit", default=40, type=int)
    limit = max(1, min(limit or 40, 50))
    where_sql = " AND ".join(["haystack LIKE ? ESCAPE '\\'"] * len(terms))
    params = [f"%{term}%" for term in terms]
    searchable_cte = """
        WITH searchable AS (
            SELECT
                q.id,
                q.testo,
                q.immagine IS NOT NULL AS has_image,
                search_norm(
                    COALESCE(q.testo, '') || ' ' ||
                    COALESCE(GROUP_CONCAT(a.testo, ' '), '')
                ) AS haystack
            FROM questions q
            LEFT JOIN answers a ON a.domanda_id = q.id
            GROUP BY q.id
        )
    """

    conn = get_connection()
    conn.create_function("search_norm", 1, _normalize_search, deterministic=True)
    try:
        cur = conn.cursor()
        cur.execute(
            searchable_cte + f"SELECT COUNT(*) FROM searchable WHERE {where_sql}",
            params,
        )
        total = int(cur.fetchone()[0] or 0)

        cur.execute(
            searchable_cte
            + f"""
                SELECT id, testo, has_image
                FROM searchable
                WHERE {where_sql}
                ORDER BY id ASC
                LIMIT ?
            """,
            (*params, limit),
        )
        rows = cur.fetchall()

        answer_where = " OR ".join(
            ["search_norm(COALESCE(testo, '')) LIKE ? ESCAPE '\\'"] * len(terms)
        )
        answer_params = [f"%{term}%" for term in terms]
        results = []
        for qid, text, has_image in rows:
            cur.execute(
                f"""
                    SELECT id, testo
                    FROM answers
                    WHERE domanda_id=? AND ({answer_where})
                    ORDER BY id
                    LIMIT 4
                """,
                (qid, *answer_params),
            )
            matches = [
                {"id": int(answer_id), "testo": answer_text or ""}
                for answer_id, answer_text in cur.fetchall()
            ]
            results.append({
                "id": int(qid),
                "testo": text or "",
                "has_image": bool(has_image),
                "answer_matches": matches,
            })
    finally:
        conn.close()

    return jsonify({
        "query": query,
        "total": total,
        "limited": total > len(results),
        "results": results,
    })

@app.route("/api/question/<int:qid>", methods=["GET"])
@login_required
def get_question_by_id(qid):
    guard = require_db_selected()
    if guard:
        return guard

    payload = get_question_cached(qid, include_images=True)
    if payload is None:
        return jsonify({"error": "Domanda non trovata"}), 404
    return jsonify(payload)

@app.route("/api/questions_batch", methods=["GET"])
@login_required
def questions_batch():
    guard = require_db_selected()
    if guard:
        return guard

    start = request.args.get("start", default=1, type=int)
    limit = request.args.get("limit", default=10, type=int)
    if limit <= 0:
        limit = 10
    if limit > 50:
        limit = 50

    conn = get_connection()
    cur = conn.cursor()
    cur.execute("SELECT id FROM questions WHERE id >= ? ORDER BY id ASC LIMIT ?", (start, limit))
    ids = [r[0] for r in cur.fetchall()]
    conn.close()

    out = []
    for qid in ids:
        payload = get_question_cached(qid, include_images=True)
        if payload:
            out.append(payload)
    return jsonify(out)

@app.route("/api/questions_by_ids", methods=["POST"])
@login_required
def questions_by_ids():
    guard = require_db_selected()
    if guard:
        return guard

    data = request.get_json(silent=True)
    if data is None:
        data = {}
    if not isinstance(data, dict):
        return jsonify({"error": "Payload non valido"}), 400
    ids = data.get("ids") or []
    if not isinstance(ids, list):
        return jsonify({"error": "ids non valido"}), 400

    clean = []
    for x in ids[:250]:
        try:
            clean.append(int(x))
        except Exception:
            pass

    out = []
    for qid in clean:
        payload = get_question_cached(qid, include_images=True)
        if payload:
            out.append(payload)
    return jsonify(out)

@app.route("/api/random_question_ids", methods=["GET"])
@login_required
def random_question_ids():
    guard = require_db_selected()
    if guard:
        return guard

    limit = request.args.get("limit", default=30, type=int)
    if limit <= 0:
        limit = 30
    if limit > 500:
        limit = 500

    conn = get_connection()
    cur = conn.cursor()
    cur.execute("SELECT id FROM questions ORDER BY RANDOM() LIMIT ?", (limit,))
    ids = [r[0] for r in cur.fetchall()]
    conn.close()
    return jsonify(ids)

@app.route("/api/random_questions", methods=["GET"])
@login_required
def random_questions():
    guard = require_db_selected()
    if guard:
        return guard

    limit = request.args.get("limit", default=30, type=int)
    if limit <= 0:
        limit = 30
    if limit > 200:
        limit = 200

    conn = get_connection()
    cur = conn.cursor()
    cur.execute("SELECT id FROM questions ORDER BY RANDOM() LIMIT ?", (limit,))
    ids = [r[0] for r in cur.fetchall()]
    conn.close()

    out = []
    for qid in ids:
        payload = get_question_cached(qid, include_images=True)
        if payload:
            out.append(payload)
    return jsonify(out)


@app.route("/api/question_attempts", methods=["POST"])
@login_required
def record_question_attempts():
    """Aggiorna le statistiche personali senza modificare il DB della materia."""
    guard = require_db_selected()
    if guard:
        return guard

    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        return jsonify({"error": "Payload non valido"}), 400
    db_key = session.get("db_key", "") or ""
    if data.get("db_key") != db_key:
        return jsonify({"error": "Materia cambiata durante il salvataggio"}), 409

    attempts = data.get("attempts")
    if not isinstance(attempts, list) or not attempts:
        return jsonify({"error": "attempts non valido"}), 400
    if len(attempts) > 250:
        return jsonify({"error": "Troppi tentativi"}), 400

    aggregated = {}
    for attempt in attempts:
        if not isinstance(attempt, dict):
            return jsonify({"error": "Tentativo non valido"}), 400
        try:
            qid = int(attempt.get("question_id"))
        except (TypeError, ValueError):
            return jsonify({"error": "ID domanda non valido"}), 400
        if qid <= 0 or not isinstance(attempt.get("correct"), bool):
            return jsonify({"error": "Tentativo non valido"}), 400

        entry = aggregated.setdefault(
            qid,
            {"correct": 0, "wrong": 0, "last": 0, "trailing_correct": 0},
        )
        if attempt["correct"]:
            entry["correct"] += 1
            entry["last"] = 1
            entry["trailing_correct"] += 1
        else:
            entry["wrong"] += 1
            entry["last"] = 0
            entry["trailing_correct"] = 0

    qids = list(aggregated)
    placeholders = ",".join("?" for _ in qids)
    subject_conn = get_connection()
    try:
        existing = {
            int(row[0])
            for row in subject_conn.execute(
                f"SELECT id FROM questions WHERE id IN ({placeholders})",
                qids,
            ).fetchall()
        }
    finally:
        subject_conn.close()

    if not existing:
        return jsonify({"error": "Nessuna domanda valida"}), 400

    user_id = int(session["user_id"])
    rows = [
        {
            "user_id": user_id,
            "db_key": db_key,
            "question_id": qid,
            "correct_count": aggregated[qid]["correct"],
            "wrong_count": aggregated[qid]["wrong"],
            "correct_streak": aggregated[qid]["trailing_correct"],
            "last_result": aggregated[qid]["last"],
        }
        for qid in qids
        if qid in existing
    ]

    APP_STORE.record_attempts(rows)

    return jsonify({
        "recorded": len(rows),
        "stats": _review_stats(user_id, db_key),
    })


@app.route("/api/review_stats", methods=["GET"])
@login_required
def review_stats():
    guard = require_db_selected()
    if guard:
        return guard
    return jsonify(_review_stats(
        int(session["user_id"]),
        session.get("db_key", "") or "",
    ))


@app.route("/api/review_questions", methods=["GET"])
@login_required
def review_questions():
    guard = require_db_selected()
    if guard:
        return guard

    category = (request.args.get("category") or "").strip().lower()
    if category not in {"errors", "consolidate", "strengths"}:
        return jsonify({"error": "Categoria non valida"}), 400

    limit = request.args.get("limit", default=40, type=int)
    limit = max(1, min(limit, 100))
    user_id = int(session["user_id"])
    db_key = session.get("db_key", "") or ""
    rows = APP_STORE.review_rows(user_id, db_key, category, limit)

    out = []
    for row in rows:
        payload = get_question_cached(int(row["question_id"]), include_images=True)
        if not payload:
            continue
        payload["attempt_stats"] = {
            "correct": int(row["correct_count"] or 0),
            "wrong": int(row["wrong_count"] or 0),
            "correct_streak": int(row["correct_streak"] or 0),
            "last_correct": bool(row["last_result"]),
        }
        out.append(payload)

    return jsonify({
        "category": category,
        "questions": out,
        "total": len(out),
    })


@app.route("/api/save_question/<int:qid>", methods=["POST"])
@login_required
def save_question(qid):
    guard = require_db_selected()
    if guard:
        return guard

    db_key = session.get("db_key")
    user_id = session["user_id"]

    conn = get_connection()
    try:
        exists = conn.execute("SELECT 1 FROM questions WHERE id=? LIMIT 1", (qid,)).fetchone()
    finally:
        conn.close()
    if not exists:
        return jsonify({"error": "Domanda non trovata"}), 404

    APP_STORE.add_saved_question(user_id, db_key, qid)

    return jsonify({"message": "Domanda salvata", "id": qid, "count": _saved_count(user_id, db_key)})

@app.route("/api/saved_questions", methods=["GET"])
@login_required
def get_saved_questions():
    """Ritorna le domande salvate dell'utente per la materia corrente."""
    guard = require_db_selected()
    if guard:
        return guard

    user_id = int(session["user_id"])
    db_key = session.get("db_key", "") or ""
    if not db_key:
        return jsonify([])

    ids = _saved_ids(user_id, db_key)[:250]
    out = []
    for qid in ids:
        payload = get_question_cached(int(qid), include_images=True)
        if payload:
            out.append(payload)
    return jsonify(out)

@app.route("/api/remove_saved_question/<int:qid>", methods=["DELETE"])
@login_required
def remove_saved_question(qid):
    guard = require_db_selected()
    if guard:
        return guard

    db_key = session.get("db_key")
    user_id = session["user_id"]

    APP_STORE.remove_saved_question(user_id, db_key, qid)

    return jsonify({"message": "Domanda salvata rimossa", "id": qid, "count": _saved_count(user_id, db_key)})

@app.route("/api/clear_saved_questions", methods=["DELETE"])
@login_required
def clear_saved_questions():
    user_id = int(session["user_id"])
    db_key = session.get("db_key", "") or ""
    if not db_key:
        return jsonify({"error": "Materia non selezionata"}), 400

    APP_STORE.clear_saved_questions(user_id, db_key)


    return jsonify({"count": 0})

@app.route("/api/change_password", methods=["POST"])
@login_required
def change_password():
    data = request.get_json(silent=True)
    if data is None:
        data = {}
    if not isinstance(data, dict):
        return jsonify({"error": "Payload non valido"}), 400
    current_pw = data.get("current_password") or ""
    new_pw = data.get("new_password") or ""
    new_pw2 = data.get("new_password2") or ""

    uid = session.get("user_id")
    if not _rate_ok(f"chpw:user:{uid}", limit=5, window_sec=600):
        return jsonify({"error": "Troppi tentativi. Riprova tra 10 minuti."}), 429

    if not current_pw or not new_pw or not new_pw2:
        return jsonify({"error": "Compila tutti i campi"}), 400
    if new_pw != new_pw2:
        return jsonify({"error": "Le nuove password non coincidono"}), 400
    if not PASSWORD_RE.match(new_pw):
        return jsonify({"error": "Password non valida: min 8, maiuscola, minuscola, numero e carattere speciale"}), 400
    if current_pw == new_pw:
        return jsonify({"error": "La nuova password deve essere diversa da quella attuale"}), 400

    # ✅ READ protetta
    pw_hash = APP_STORE.get_password_hash(uid)
    if not pw_hash:
        return jsonify({"error": "Utente non trovato"}), 404

    if not check_password_hash(pw_hash, current_pw + PEPPER):
        return jsonify({"error": "Password attuale errata"}), 400

    new_hash = generate_password_hash(new_pw + PEPPER)

    # ✅ WRITE protetta
    APP_STORE.update_password_hash(uid, new_hash)

    return jsonify({"message": "Password aggiornata"})


def pdf_safe(text: str) -> str:
    """
    Sicuro per ReportLab Paragraph:
    - escape HTML (< > &) per evitare crash
    - consente SOLO <sup>/<sub> (whitelist) perché servono per le formule
    - newline -> <br/>
    """
    if not text:
        return ""

    t = text.replace("\r\n", "\n").replace("\r", "\n")

    # tokenizzo SOLO i tag che voglio consentire
    t = (t.replace("<sup>", "%%SUP_OPEN%%")
           .replace("</sup>", "%%SUP_CLOSE%%")
           .replace("<sub>", "%%SUB_OPEN%%")
           .replace("</sub>", "%%SUB_CLOSE%%"))

    # escape di tutto il resto (evita "unclosed tags")
    t = escape(t)

    # ripristino i soli tag consentiti
    t = (t.replace("%%SUP_OPEN%%", "<sup>")
           .replace("%%SUP_CLOSE%%", "</sup>")
           .replace("%%SUB_OPEN%%", "<sub>")
           .replace("%%SUB_CLOSE%%", "</sub>"))

    # newline -> <br/>
    t = t.replace("\n", "<br/>")
    return t


# ------------------------
#   PDF export (cached by DB mtime)
# ------------------------

def _safe_register_pdf_font():
    """Registra un font Unicode (accenti IT) se disponibile."""
    try:
        from reportlab.pdfbase import pdfmetrics
        from reportlab.pdfbase.ttfonts import TTFont
    except Exception:
        return None

    candidates = [
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSansCondensed.ttf",
    ]
    for p in candidates:
        try:
            if os.path.exists(p):
                pdfmetrics.registerFont(TTFont("DejaVuSans", p))
                return "DejaVuSans"
        except Exception:
            continue
    return None

def _img_flowable_from_blob(blob: bytes, max_w, max_h):
    if not blob:
        return None
    try:
        from reportlab.platypus import Image
        from reportlab.lib.utils import ImageReader
    except Exception:
        return None

    bio = BytesIO(blob)
    try:
        ir = ImageReader(bio)
        iw, ih = ir.getSize()
    except Exception:
        return None

    # scale down to fit
    scale = min(max_w / iw, max_h / ih, 1.0)
    w, h = iw * scale, ih * scale
    bio.seek(0)
    return Image(bio, width=w, height=h)

@app.get("/api/export_pdf")
@login_required

def export_pdf():
    """Genera (se necessario) e scarica il PDF della materia selezionata.
    Caching: il PDF viene rigenerato solo se il file .db è più recente del PDF.
    """
    dbs = scan_databases()
    db_key = session.get("db_key")

    if not db_key or db_key not in dbs:
        return jsonify({"error": "Seleziona prima una materia"}), 400

    db_path = dbs[db_key]["path"]
    subject = dbs[db_key]["label"]

    # dove salvare i PDF (scrivibile su PythonAnywhere)
    export_dir = os.path.join(app.root_path, "instance", "exports")
    os.makedirs(export_dir, exist_ok=True)

    pdf_name = os.path.splitext(db_key)[0] + ".pdf"
    pdf_path = os.path.join(export_dir, pdf_name)

    # se richiesto, solo check (JS): non scarica, non genera
    if request.args.get("check") == "1":
        return jsonify({"ok": True, "db_key": db_key, "label": subject, "pdf": pdf_name})

    db_mtime = os.path.getmtime(db_path)
    pdf_exists = os.path.exists(pdf_path)
    pdf_mtime = os.path.getmtime(pdf_path) if pdf_exists else 0

    if (not pdf_exists) or (db_mtime > pdf_mtime):
        # rigenera
        from reportlab.lib.pagesizes import A4
        from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, PageBreak
        from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
        from reportlab.lib.units import cm

        font_name = _safe_register_pdf_font() or "Helvetica"
        styles = getSampleStyleSheet()
        base = ParagraphStyle("base", parent=styles["Normal"], fontName=font_name, fontSize=11, leading=14)
        h1 = ParagraphStyle("h1", parent=styles["Heading1"], fontName=font_name)
        h2 = ParagraphStyle("h2", parent=styles["Heading2"], fontName=font_name)

        # leggi domande/risposte
        conn = sqlite3.connect(db_path)
        conn.row_factory = sqlite3.Row
        cur = conn.cursor()

        cur.execute("SELECT id, testo, immagine FROM questions ORDER BY id")
        questions = cur.fetchall()

        info = _database_info_from_db_or_legacy(db_key) or {}
        source_ranges = []
        for item in info.get("sources", []) or []:
            label = str(item.get("source") or "").strip() or "Senza fonte"
            note = str(item.get("note") or "").strip()
            for pair in item.get("ranges", []) or []:
                try:
                    a, b = int(pair[0]), int(pair[1])
                except Exception:
                    continue
                lo, hi = (a, b) if a <= b else (b, a)
                source_ranges.append({"from": lo, "to": hi, "label": label, "note": note})
            if not item.get("ranges") and item.get("from") and item.get("to"):
                try:
                    a = int(item.get("from")); b = int(item.get("to"))
                    lo, hi = (a, b) if a <= b else (b, a)
                    source_ranges.append({"from": lo, "to": hi, "label": label, "note": note})
                except Exception:
                    pass

        def source_for_qid(qid):
            for r in source_ranges:
                if r["from"] <= qid <= r["to"]:
                    return r["label"], r.get("note")
            return None, None

        export_pdf._last_source = None

        buf = BytesIO()
        doc = SimpleDocTemplate(
            buf,
            pagesize=A4,
            leftMargin=1.5 * cm,
            rightMargin=1.5 * cm,
            topMargin=1.5 * cm,
            bottomMargin=1.5 * cm,
            title=f"Quiz - {subject}",
            author="Quiz Università",
        )

        page_w, page_h = A4
        max_img_w = page_w - doc.leftMargin - doc.rightMargin
        max_q_img_h = 9 * cm
        max_a_img_h = 6 * cm

        story = []
        story.append(Paragraph(f"Quiz – {subject}", h1))
        story.append(Paragraph(f"Generato il {datetime.now().strftime('%d/%m/%Y %H:%M')}", base))
        story.append(Spacer(1, 12))

        letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"

        for idx, q in enumerate(questions, start=1):
            q_id = q["id"]
            src_label, src_note = source_for_qid(q_id)
            if src_label and src_label != getattr(export_pdf, "_last_source", None):
                export_pdf._last_source = src_label
                story.append(Paragraph(f"Fonte: {pdf_safe(src_label)}", h2))
                if src_note:
                    story.append(Paragraph(f"Note: {pdf_safe(src_note)}", base))
                story.append(Spacer(1, 10))

            q_text = (q["testo"] or "").strip()

            story.append(Paragraph(f"{idx}) (ID {q_id})", h2))

            q_img = _img_flowable_from_blob(q["immagine"], max_img_w, max_q_img_h)
            if q_img:
                story.append(q_img)
                story.append(Spacer(1, 8))

            if q_text:
                story.append(Paragraph(pdf_safe(q_text), base))

                story.append(Spacer(1, 8))

            cur.execute(
                "SELECT id, testo, immagine, corretta FROM answers WHERE domanda_id=? ORDER BY id",
                (q_id,),
            )
            answers = cur.fetchall()

            correct_letter = None
            for a_i, a in enumerate(answers):
                letter = letters[a_i] if a_i < len(letters) else f"({a_i+1})"
                a_text = (a["testo"] or "").strip()

                if int(a["corretta"] or 0) == 1:
                    correct_letter = letter

                story.append(Paragraph(f"<b>{letter}.</b> {pdf_safe(a_text)}", base)
)


                a_img = _img_flowable_from_blob(a["immagine"], max_img_w, max_a_img_h)
                if a_img:
                    story.append(Spacer(1, 4))
                    story.append(a_img)

                story.append(Spacer(1, 6))

            if correct_letter:
                story.append(Paragraph(f"<b>Risposta corretta:</b> {correct_letter}", base))

            story.append(Spacer(1, 14))

            # page break ogni 6 domande (riduce pagine troppo dense)
            if idx % 6 == 0 and idx != len(questions):
                story.append(PageBreak())

        conn.close()

        doc.build(story)

        # salva su disco
        with open(pdf_path, "wb") as f:
            f.write(buf.getvalue())

    # invia il file (download)
    from flask import send_file
    return send_file(pdf_path, mimetype="application/pdf", as_attachment=True, download_name=pdf_name)

if __name__ == "__main__":
    # Per sviluppo locale senza HTTPS:
    #app.config["SESSION_COOKIE_SECURE"] = False
    app.run(host="0.0.0.0", port=5000, debug=True)
