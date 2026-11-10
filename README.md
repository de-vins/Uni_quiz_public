# Quiz Università — versione baseline

Webapp per esercitarsi su domande a risposta multipla, suddivise per materia, con **account personali**, salvataggio delle domande, ripasso, ricerca, statistiche, controlli vocali e esportazione PDF. Backend **Flask/Python**, interfaccia HTML/CSS/JavaScript, database **SQLite** delle materie. Per gli account il backend supporta SQLite locale e una configurazione MySQL in produzione.

Questa è la **versione di base**, senza il sistema sperimentale di domande ufficiose e autorizzazioni. Non sono inclusi utenti, dati reali né domande universitarie: lo script di setup genera una materia dimostrativa con domande originali.

## Avvio rapido su Windows (Prompt dei comandi)

Installare **Python 3.10 o successivo** e Git. Poi, dalla cartella in cui si vuole scaricare il progetto:

```bat
git clone https://github.com/de-vins/Uni_quiz_public.git
cd Uni_quiz_public
py -3 -m venv .venv
.venv\Scripts\activate.bat
python -m pip install -r requirements.txt
python setup_local.py
python run_local.py
```

Aprire **http://127.0.0.1:5000/register**, creare un account e accedere. Nel quiz selezionare **Informatica - demo**.

Se il repository pubblico ha un nome diverso, sostituire l'URL e la directory nei primi due comandi. **Non funziona finché il proprietario non crea e pubblica il repository a quell'indirizzo.** In alternativa: scaricare lo ZIP del progetto e aprire il terminale nella cartella estratta, saltando `git clone` e `cd`.

> Il primo avvio richiede accesso a Internet per installare le dipendenze Python. L'esercitazione può poi funzionare in locale. Alcune funzionalità (per esempio il riconoscimento vocale) possono dipendere dal browser o da servizi online.

## Istruzioni complete

Consulta **[INSTALLAZIONE_LOCALE.md](INSTALLAZIONE_LOCALE.md)** per l'installazione su Windows, Linux o macOS, la struttura dei database, i problemi frequenti e le regole di sicurezza.

## Organizzazione del progetto

```text
app.py                    # Flask, autenticazione, API e quiz
app_store.py              # SQLite/MySQL per account, salvataggi e statistiche
run_local.py              # Avvio HTTP solo su 127.0.0.1
setup_local.py            # Segreti locali e 12 quesiti dimostrativi
templates/                # quiz.html, login.html, register.html
static/                   # quiz.js, style.css
data/                     # DB SQLite delle materie (generati/non tracciati)
instance/                 # DB account e PDF (generati/non tracciati)
requirements.txt          # Dipendenze Python
.env.example              # Esempio variabili di ambiente (non sono segreti reali)
```

## Sicurezza e limiti

- Il database dimostrativo viene generato localmente da `setup_local.py`; non sono condivise domande, account o informazioni personali del servizio originale.
- `.env.local`, database, esportazioni e file privati sono ignorati da Git. **Non aggiungerli forzatamente**.
- `run_local.py` è esclusivamente per prove sul PC. In produzione servono HTTPS, segreti gestiti dal server, un web server WSGI e una revisione della sicurezza.
- Non cambiare `PASSWORD_PEPPER` se vuoi continuare a verificare le password registrate nello stesso database applicativo.
- I file principali della baseline (`app.py`, `app_store.py`, HTML, CSS e JS) sono rimasti invariati; gli script e la documentazione rendono possibile l'avvio locale.
- **Licenza non selezionata**: il proprietario dovrà decidere se e con quali condizioni concedere il riutilizzo del codice. Un repository pubblico permette la lettura ma non concede automaticamente una licenza open source.

## Installazione con dati propri

Aggiungere un file `.db` nella cartella `data/` rispettando lo schema illustrato in `INSTALLAZIONE_LOCALE.md`. Non distribuire database di terzi senza avere i diritti necessari.
