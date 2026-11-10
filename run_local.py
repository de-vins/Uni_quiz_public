"""Avvio SOLO locale (localhost/HTTP) della baseline Flask."""
from __future__ import annotations

import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SETTINGS = ROOT / ".env.local"

if not SETTINGS.is_file():
    raise SystemExit("Manca .env.local: esegui prima 'python setup_local.py'.")

# Il file viene creato dal generatore e non include valori con virgolette o spazi.
for line in SETTINGS.read_text(encoding="utf-8").splitlines():
    line = line.strip()
    if not line or line.startswith("#"):
        continue
    key, sep, value = line.partition("=")
    if not sep or key not in {"SECRET_KEY", "PASSWORD_PEPPER", "RATE_SECRET"} or not value:
        raise SystemExit(f"Configurazione locale non valida per il campo: {key}")
    os.environ[key] = value

# Evita un'eventuale configurazione di produzione ereditata dal terminale.
for name in ("APP_DATABASE_URL", "APP_MYSQL_USER", "APP_MYSQL_PASSWORD", "APP_MYSQL_HOST", "APP_MYSQL_DATABASE", "APP_DB_PATH"):
    os.environ.pop(name, None)

from app import app  # noqa: E402 — importa Flask dopo aver impostato i segreti

# La baseline usa cookie Secure per la produzione HTTPS. Solo localhost è HTTP.
app.config["SESSION_COOKIE_SECURE"] = False

if __name__ == "__main__":
    print("Quiz Università (solo locale): http://127.0.0.1:5000")
    print("Usa Ctrl+C per arrestare il server. Non usare questo avviatore su Internet.")
    app.run(host="127.0.0.1", port=5000, debug=False)
