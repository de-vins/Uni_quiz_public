"""Storage applicativo separato dai database SQLite delle materie.

Usa SQLite in locale e MySQL in produzione quando APP_DATABASE_URL è impostata.
I database dei quiz non passano da questo modulo e restano SQLite read-only.
"""

from __future__ import annotations

import contextlib
import os
import threading
import time
from pathlib import Path

from sqlalchemy import (
    Column,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    MetaData,
    String,
    Table,
    Text,
    and_,
    case,
    cast,
    create_engine,
    delete,
    event,
    func,
    inspect,
    insert,
    or_,
    select,
    update,
)
from sqlalchemy.engine import URL
from sqlalchemy.dialects.mysql import insert as mysql_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.exc import OperationalError


def database_url_from_env():
    """Restituisce la configurazione del solo database applicativo.

    APP_DATABASE_URL ha la precedenza. In alternativa accetta variabili
    separate, evitando di dover codificare i caratteri speciali della password
    dentro un URL.
    """
    direct_url = (os.environ.get("APP_DATABASE_URL") or "").strip()
    if direct_url:
        return direct_url

    env_names = {
        "username": "APP_MYSQL_USER",
        "password": "APP_MYSQL_PASSWORD",
        "host": "APP_MYSQL_HOST",
        "database": "APP_MYSQL_DATABASE",
    }
    parts = {
        name: os.environ.get(env_name)
        for name, env_name in env_names.items()
    }
    configured = [bool(value) for value in parts.values()]
    if not any(configured):
        return None
    if not all(configured):
        missing = ", ".join(
            env_names[name]
            for name, value in parts.items()
            if not value
        )
        raise RuntimeError(f"Configurazione MySQL incompleta; mancano: {missing}")

    return URL.create(
        "mysql+mysqldb",
        username=parts["username"],
        password=parts["password"],
        host=parts["host"],
        database=parts["database"],
        query={"charset": "utf8mb4"},
    )


class AppStore:
    """Repository cross-database per utenti, salvataggi e ripasso."""

    def __init__(self, database_url, sqlite_path: str):
        self.sqlite_path = os.path.abspath(sqlite_path)
        self.database_url = database_url or self._sqlite_url(self.sqlite_path)
        backend = (
            self.database_url.drivername
            if isinstance(self.database_url, URL)
            else str(self.database_url).split(":", 1)[0]
        )
        self.is_sqlite = backend.startswith("sqlite")
        self._write_lock = threading.Lock()

        engine_options = {"future": True, "pool_pre_ping": True}
        if self.is_sqlite:
            engine_options["connect_args"] = {
                "timeout": 30,
                "check_same_thread": False,
            }
        else:
            # PythonAnywhere chiude le connessioni MySQL inattive dopo 5 minuti.
            engine_options["pool_recycle"] = 280

        self.engine = create_engine(self.database_url, **engine_options)
        if self.is_sqlite:
            event.listen(self.engine, "connect", self._configure_sqlite_connection)

        self.metadata = MetaData()
        self.users = Table(
            "users",
            self.metadata,
            Column("id", Integer, primary_key=True, autoincrement=True),
            Column("username", String(20), nullable=False, unique=True),
            Column("password_hash", Text, nullable=False),
            Column("created_at", DateTime, nullable=False, server_default=func.now()),
            Column("is_active", Integer, nullable=False, server_default="1"),
            Column("last_db_key", String(255)),
            Column("last_login", DateTime),
        )
        self.saved_questions = Table(
            "saved_questions",
            self.metadata,
            Column(
                "user_id",
                Integer,
                ForeignKey("users.id", ondelete="CASCADE"),
                primary_key=True,
            ),
            Column("db_key", String(255), primary_key=True),
            Column("question_id", Integer, primary_key=True),
            Column("created_at", DateTime, nullable=False, server_default=func.now()),
        )
        self.user_saved_questions = Table(
            "user_saved_questions",
            self.metadata,
            Column(
                "user_id",
                Integer,
                ForeignKey("users.id", ondelete="CASCADE"),
                primary_key=True,
            ),
            Column("db_key", String(255), primary_key=True),
            Column("question_id", Integer, primary_key=True),
            Column("created_at", DateTime, nullable=False, server_default=func.now()),
        )
        self.question_attempt_stats = Table(
            "question_attempt_stats",
            self.metadata,
            Column(
                "user_id",
                Integer,
                ForeignKey("users.id", ondelete="CASCADE"),
                primary_key=True,
            ),
            Column("db_key", String(255), primary_key=True),
            Column("question_id", Integer, primary_key=True),
            Column("correct_count", Integer, nullable=False, server_default="0"),
            Column("wrong_count", Integer, nullable=False, server_default="0"),
            Column("correct_streak", Integer, nullable=False, server_default="0"),
            Column("last_result", Integer, nullable=False, server_default="0"),
            Column("last_attempt_at", DateTime, nullable=False, server_default=func.now()),
        )
        Index(
            "idx_saved_user_db",
            self.saved_questions.c.user_id,
            self.saved_questions.c.db_key,
        )
        Index("idx_saved_qid", self.saved_questions.c.question_id)
        Index(
            "idx_saved_user_db2",
            self.user_saved_questions.c.user_id,
            self.user_saved_questions.c.db_key,
        )
        Index(
            "idx_attempts_user_db",
            self.question_attempt_stats.c.user_id,
            self.question_attempt_stats.c.db_key,
        )
        Index(
            "idx_attempts_review",
            self.question_attempt_stats.c.user_id,
            self.question_attempt_stats.c.db_key,
            self.question_attempt_stats.c.wrong_count,
            self.question_attempt_stats.c.correct_count,
        )

    @staticmethod
    def _sqlite_url(path: str) -> str:
        return f"sqlite:///{Path(path).as_posix()}"

    @staticmethod
    def _configure_sqlite_connection(dbapi_connection, _connection_record):
        cursor = dbapi_connection.cursor()
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.execute("PRAGMA synchronous=NORMAL")
        cursor.execute("PRAGMA busy_timeout=10000")
        cursor.close()

    @property
    def backend_name(self) -> str:
        return self.engine.dialect.name

    def close(self):
        """Chiude il pool, utile per script e test; la web app lo lascia attivo."""
        self.engine.dispose()

    @contextlib.contextmanager
    def read(self):
        with self.engine.connect() as connection:
            yield connection

    @contextlib.contextmanager
    def write(self):
        """Transazione breve; SQLite usa BEGIN IMMEDIATE e retry."""
        if not self.is_sqlite:
            with self.engine.begin() as connection:
                yield connection
            return

        with self._write_lock:
            connection = None
            last_locked_error = None
            for attempt in range(6):
                connection = self.engine.connect()
                try:
                    connection.exec_driver_sql("BEGIN IMMEDIATE")
                    break
                except OperationalError as exc:
                    connection.close()
                    connection = None
                    if "locked" not in str(exc).lower():
                        raise
                    last_locked_error = exc
                    time.sleep(min(1.5, 0.15 * (2**attempt)))
            if connection is None:
                raise last_locked_error or RuntimeError(
                    "BEGIN IMMEDIATE retries exhausted"
                )

            try:
                yield connection
                connection.commit()
            except Exception:
                connection.rollback()
                raise
            finally:
                connection.close()

    def initialize(self):
        if self.is_sqlite:
            os.makedirs(os.path.dirname(self.sqlite_path), exist_ok=True)
            with self.engine.connect() as connection:
                connection.exec_driver_sql("PRAGMA journal_mode=WAL")

        with self.write() as connection:
            self.metadata.create_all(bind=connection)
            inspector = inspect(connection)
            self._ensure_columns(connection, inspector)

    def _ensure_columns(self, connection, inspector):
        migrations = {
            "users": {
                "last_login": "DATETIME NULL",
                "last_db_key": "VARCHAR(255) NULL",
                "is_active": "INTEGER NOT NULL DEFAULT 1",
            },
            "question_attempt_stats": {
                "correct_streak": "INTEGER NOT NULL DEFAULT 0",
            },
        }
        for table_name, columns in migrations.items():
            existing = {column["name"] for column in inspector.get_columns(table_name)}
            for column_name, definition in columns.items():
                if column_name not in existing:
                    connection.exec_driver_sql(
                        f"ALTER TABLE {table_name} ADD COLUMN {column_name} {definition}"
                    )

    def get_user_by_username(self, username: str):
        statement = select(
            self.users.c.id,
            self.users.c.password_hash,
            self.users.c.is_active,
            self.users.c.last_db_key,
        ).where(self.users.c.username == username)
        with self.read() as connection:
            row = connection.execute(statement).mappings().first()
        return dict(row) if row else None

    def create_user(self, username: str, password_hash: str) -> int:
        with self.write() as connection:
            result = connection.execute(
                insert(self.users).values(
                    username=username,
                    password_hash=password_hash,
                )
            )
            return int(result.inserted_primary_key[0])

    def update_last_login(self, user_id: int):
        with self.write() as connection:
            connection.execute(
                update(self.users)
                .where(self.users.c.id == user_id)
                .values(last_login=func.now())
            )

    def update_last_db_key(self, user_id: int, db_key: str):
        with self.write() as connection:
            connection.execute(
                update(self.users)
                .where(self.users.c.id == user_id)
                .values(last_db_key=db_key)
            )

    def get_password_hash(self, user_id: int):
        with self.read() as connection:
            return connection.execute(
                select(self.users.c.password_hash).where(self.users.c.id == user_id)
            ).scalar_one_or_none()

    def update_password_hash(self, user_id: int, password_hash: str):
        with self.write() as connection:
            connection.execute(
                update(self.users)
                .where(self.users.c.id == user_id)
                .values(password_hash=password_hash)
            )

    def saved_count(self, user_id: int, db_key: str) -> int:
        with self.read() as connection:
            value = connection.execute(
                select(func.count())
                .select_from(self.saved_questions)
                .where(
                    self.saved_questions.c.user_id == user_id,
                    self.saved_questions.c.db_key == db_key,
                )
            ).scalar_one()
        return int(value or 0)

    def saved_ids(self, user_id: int, db_key: str) -> list[int]:
        statement = (
            select(self.saved_questions.c.question_id)
            .where(
                self.saved_questions.c.user_id == user_id,
                self.saved_questions.c.db_key == db_key,
            )
            .order_by(self.saved_questions.c.created_at.asc())
        )
        with self.read() as connection:
            return [int(value) for value in connection.execute(statement).scalars()]

    def add_saved_question(self, user_id: int, db_key: str, question_id: int):
        values = {
            "user_id": user_id,
            "db_key": db_key,
            "question_id": question_id,
        }
        if self.backend_name == "mysql":
            statement = mysql_insert(self.saved_questions).values(**values)
            statement = statement.prefix_with("IGNORE")
        else:
            statement = sqlite_insert(self.saved_questions).values(**values)
            statement = statement.on_conflict_do_nothing(
                index_elements=["user_id", "db_key", "question_id"]
            )
        with self.write() as connection:
            connection.execute(statement)

    def remove_saved_question(self, user_id: int, db_key: str, question_id: int):
        with self.write() as connection:
            connection.execute(
                delete(self.saved_questions).where(
                    self.saved_questions.c.user_id == user_id,
                    self.saved_questions.c.db_key == db_key,
                    self.saved_questions.c.question_id == question_id,
                )
            )

    def clear_saved_questions(self, user_id: int, db_key: str):
        with self.write() as connection:
            connection.execute(
                delete(self.saved_questions).where(
                    self.saved_questions.c.user_id == user_id,
                    self.saved_questions.c.db_key == db_key,
                )
            )

    def _review_expressions(self):
        table = self.question_attempt_stats
        accuracy = cast(table.c.correct_count, Float) / (
            table.c.correct_count + table.c.wrong_count
        )
        errors = and_(
            table.c.wrong_count > 0,
            or_(
                table.c.last_result == 0,
                and_(accuracy < 0.50, table.c.correct_streak < 3),
            ),
        )
        strengths = and_(
            table.c.correct_count > 0,
            table.c.last_result == 1,
            or_(table.c.wrong_count == 0, table.c.correct_streak >= 3),
        )
        consolidate = and_(
            table.c.wrong_count > 0,
            ~errors,
            ~strengths,
        )
        return accuracy, {
            "errors": errors,
            "consolidate": consolidate,
            "strengths": strengths,
        }

    def review_stats(self, user_id: int, db_key: str) -> dict:
        _, categories = self._review_expressions()
        table = self.question_attempt_stats
        statement = select(
            func.count().label("tracked"),
            func.sum(case((categories["errors"], 1), else_=0)).label("errors"),
            func.sum(case((categories["consolidate"], 1), else_=0)).label(
                "consolidate"
            ),
            func.sum(case((categories["strengths"], 1), else_=0)).label(
                "strengths"
            ),
        ).where(table.c.user_id == user_id, table.c.db_key == db_key)
        with self.read() as connection:
            row = connection.execute(statement).mappings().one()
        return {
            key: int(row[key] or 0)
            for key in ("tracked", "errors", "consolidate", "strengths")
        }

    def review_rows(
        self,
        user_id: int,
        db_key: str,
        category: str,
        limit: int,
    ) -> list[dict]:
        accuracy, categories = self._review_expressions()
        if category not in categories:
            raise ValueError("Categoria non valida")

        table = self.question_attempt_stats
        ordering = {
            "errors": (
                table.c.last_result.asc(),
                table.c.wrong_count.desc(),
                accuracy.asc(),
                table.c.last_attempt_at.desc(),
            ),
            "consolidate": (
                accuracy.asc(),
                table.c.correct_streak.asc(),
                (table.c.correct_count + table.c.wrong_count).desc(),
                table.c.last_attempt_at.desc(),
            ),
            "strengths": (
                accuracy.desc(),
                table.c.correct_streak.desc(),
                table.c.correct_count.desc(),
                table.c.last_attempt_at.desc(),
            ),
        }
        statement = (
            select(
                table.c.question_id,
                table.c.correct_count,
                table.c.wrong_count,
                table.c.correct_streak,
                table.c.last_result,
            )
            .where(
                table.c.user_id == user_id,
                table.c.db_key == db_key,
                categories[category],
            )
            .order_by(*ordering[category])
            .limit(limit)
        )
        with self.read() as connection:
            rows = connection.execute(statement).mappings().all()
        return [dict(row) for row in rows]

    def record_attempts(self, rows: list[dict]):
        if not rows:
            return
        table = self.question_attempt_stats
        if self.backend_name == "mysql":
            statement = mysql_insert(table).values(rows)
            incoming = statement.inserted
            statement = statement.on_duplicate_key_update(
                correct_count=table.c.correct_count + incoming.correct_count,
                wrong_count=table.c.wrong_count + incoming.wrong_count,
                correct_streak=case(
                    (incoming.wrong_count > 0, incoming.correct_streak),
                    else_=table.c.correct_streak + incoming.correct_streak,
                ),
                last_result=incoming.last_result,
                last_attempt_at=func.now(),
            )
        else:
            statement = sqlite_insert(table).values(rows)
            incoming = statement.excluded
            statement = statement.on_conflict_do_update(
                index_elements=["user_id", "db_key", "question_id"],
                set_={
                    "correct_count": table.c.correct_count + incoming.correct_count,
                    "wrong_count": table.c.wrong_count + incoming.wrong_count,
                    "correct_streak": case(
                        (incoming.wrong_count > 0, incoming.correct_streak),
                        else_=table.c.correct_streak + incoming.correct_streak,
                    ),
                    "last_result": incoming.last_result,
                    "last_attempt_at": func.now(),
                },
            )
        with self.write() as connection:
            connection.execute(statement)
