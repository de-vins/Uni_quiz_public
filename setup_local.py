"""Configura una demo locale sicura della baseline, senza dipendenze esterne."""
from __future__ import annotations

import secrets
import sqlite3
from pathlib import Path

ROOT = Path(__file__).resolve().parent
CONFIG = ROOT / ".env.local"
DB = ROOT / "data" / "demo_informatica.db"

# Domande dimostrative originali; non provengono da archivi universitari.
ITEMS = [
    ("Quale componente esegue le istruzioni di un programma?", ["CPU", "SSD", "Monitor", "Router"], 0),
    ("Quale protocollo viene normalmente usato per visitare una pagina web in modo cifrato?", ["FTP", "HTTP", "HTTPS", "SMTP"], 2),
    ("Quale delle seguenti strutture conserva coppie chiave-valore in Python?", ["tuple", "dict", "set", "str"], 1),
    ("Quale comando SQL legge i dati da una tabella?", ["INSERT", "SELECT", "UPDATE", "DELETE"], 1),
    ("In una rete, a cosa serve in generale un indirizzo IP?", ["A indicare la risoluzione dello schermo", "A identificare un'interfaccia di rete", "A cifrare i file", "A misurare la RAM"], 1),
    ("Quale formato è comunemente utilizzato per scambiare dati strutturati tra API?", ["JPEG", "MP3", "JSON", "PNG"], 2),
    ("Quale caratteristica descrive meglio una chiave primaria di una tabella?", ["Identifica univocamente una riga", "Contiene sempre testo", "È opzionalmente duplicata", "Ordina sempre i risultati"], 0),
    ("Quale funzione svolge un sistema di controllo versione come Git?", ["Sostituisce il database", "Registra modifiche ai file nel tempo", "Aumenta la frequenza della CPU", "Fornisce un antivirus"], 1),
    ("Che cosa significa che un database SQLite è integrato nell'applicazione?", ["Richiede sempre un server remoto", "Usa esclusivamente XML", "Può essere gestito come file locale", "È un servizio DNS"], 2),
    ("In Python, quale costrutto è usato per gestire eccezioni?", ["switch/case", "try/except", "select/from", "import/export"], 1),
    ("Quale metodo HTTP è normalmente utilizzato per recuperare una risorsa?", ["GET", "DELETE", "PATCH", "CONNECT"], 0),
    ("Quale buona pratica riduce il rischio di esporre una password di database su GitHub?", ["Inserirla nel README", "Salvarla nel JavaScript pubblico", "Gestirla tramite variabili d'ambiente", "Aggiungerla al nome del repository"], 2),
]


def create_config():
    if CONFIG.exists():
        print("Configurazione locale esistente: nessuna modifica a .env.local")
        return
    fields = {
        "SECRET_KEY": secrets.token_urlsafe(48),
        "PASSWORD_PEPPER": secrets.token_urlsafe(48),
        "RATE_SECRET": secrets.token_urlsafe(48),
    }
    content = "# Configurazione locale privata. Non pubblicare su Git.\n" + "".join(f"{name}={value}\n" for name, value in fields.items())
    with CONFIG.open("x", encoding="utf-8") as file:
        file.write(content)
    print("Creata .env.local con chiavi locali casuali (conserva il file per i successivi avvii).")


def create_demo_db():
    DB.parent.mkdir(exist_ok=True)
    if DB.exists():
        print("Database di esempio già presente: nessuna modifica a data/demo_informatica.db")
        return
    con = sqlite3.connect(DB)
    try:
        con.execute("PRAGMA foreign_keys = ON")
        con.executescript("""
        CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
        CREATE TABLE questions (
            id INTEGER PRIMARY KEY,
            testo TEXT NOT NULL,
            immagine BLOB,
            is_saved INTEGER,
            source TEXT
        );
        CREATE TABLE answers (
            id INTEGER PRIMARY KEY,
            domanda_id INTEGER,
            testo TEXT,
            immagine BLOB,
            corretta BOOLEAN,
            FOREIGN KEY(domanda_id) REFERENCES questions(id)
        );
        CREATE TABLE db_sources (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            db_key TEXT NOT NULL,
            q_from INTEGER NOT NULL,
            q_to INTEGER NOT NULL,
            source TEXT NOT NULL,
            note TEXT
        );
        """)
        con.execute("INSERT INTO meta(key, value) VALUES(?, ?)", ("subject", "Informatica - demo"))
        for qid, (question, options, correct_index) in enumerate(ITEMS, start=1):
            con.execute("INSERT INTO questions(id, testo, immagine, is_saved, source) VALUES(?, ?, NULL, 0, ?)", (qid, question, "Dimostrativa"))
            for i, option in enumerate(options):
                con.execute("INSERT INTO answers(id, domanda_id, testo, immagine, corretta) VALUES(?, ?, ?, NULL, ?)", ((qid - 1) * 4 + i + 1, qid, option, int(i == correct_index)))
        con.execute("INSERT INTO db_sources(db_key, q_from, q_to, source, note) VALUES(?, ?, ?, ?, ?)", (DB.name, 1, len(ITEMS), "Dimostrativa", "Domande originali create per mostrare l'applicazione"))
        con.commit()
    except BaseException:
        con.rollback()
        con.close()
        DB.unlink(missing_ok=True)
        raise
    finally:
        try:
            con.close()
        except Exception:
            pass
    print(f"Creato database dimostrativo: {DB.name} ({len(ITEMS)} domande).")


if __name__ == "__main__":
    create_config()
    create_demo_db()
    print("Preparazione completata. Avvia con: python run_local.py")
