# Installazione locale passo per passo

La guida riguarda la **baseline** di Quiz Università, non il branch sperimentale delle autorizzazioni.

## 1. Requisiti

- Windows 10/11, Linux o macOS
- Python **3.10+** (in Windows controlla con `py -3 --version`; in alternativa `python --version`)
- Un terminale e un browser aggiornato
- Connessione Internet per la prima installazione dei pacchetti
- Git **solo se** vuoi scaricare/clonare il codice dal repository; non necessario per usare lo ZIP

## 2. Installazione su Windows con CMD

Apri il Prompt dei comandi nella cartella del progetto, poi:

```bat
py -3 -m venv .venv
.venv\Scripts\activate.bat
python -m pip install --upgrade pip
python -m pip install -r requirements.txt
python setup_local.py
python run_local.py
```

Ora apri `http://127.0.0.1:5000/register`, registra un account e accedi da `http://127.0.0.1:5000/login`. Seleziona **Informatica - demo** dal menu della materia.

Per fermare il server: `Ctrl+C`. Per riavviarlo in un nuovo terminale:

```bat
cd PERCORSO\DELLA\CARTELLA\PROGETTO
.venv\Scripts\activate.bat
python run_local.py
```

Nel Prompt dei comandi Windows si usa il percorso reale della cartella; il comando `cd ~/Downloads` è tipico di shell Unix e non funziona in CMD.

## 3. Installazione su Linux/macOS

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install -r requirements.txt
python setup_local.py
python run_local.py
```

Apri lo stesso indirizzo locale: `http://127.0.0.1:5000`.

## 4. Cosa crea la preparazione locale

`python setup_local.py` genera, **solo se non esistono già**:

- `.env.local`: segreti casuali **persistenti** per la firma delle sessioni, il pepper delle password e il rate limiting;
- `data/demo_informatica.db`: SQLite dimostrativo con **12 domande originali** e 4 risposte ciascuna.

Al primo avvio l'applicazione crea inoltre `instance/app.db` per utenti, hash delle password, preferenze e statistiche. Potrebbero comparire altri file in `instance/` durante l'utilizzo.

**Non eliminare `.env.local`** se vuoi conservare accesso agli utenti del tuo `instance/app.db`: cambiando `PASSWORD_PEPPER` le password già registrate non saranno più verificabili. Esegui backup locali di entrambi i file se vuoi conservare i progressi.

Lo script `run_local.py` usa esclusivamente il database applicativo SQLite della copia locale, si mette in ascolto su `127.0.0.1` e modifica la policy del cookie **solo per questa sessione HTTP locale**. Non cambia la configurazione di produzione nel file `app.py`.

## 5. Come aggiungere una materia personale

L'app scopre automaticamente i file `.db` nella directory `data/`, purché corrispondano allo schema atteso. Il database dimostrativo usa:

| Tabella | Colonne principali | Significato |
|---|---|---|
| `meta` | `key`, `value` | nome materia: record `subject` |
| `questions` | `id`, `testo`, `immagine`, `is_saved`, `source` | quesiti (ID interi unici) |
| `answers` | `id`, `domanda_id`, `testo`, `immagine`, `corretta` | opzioni; `corretta=1` per la risposta esatta |
| `db_sources` | `db_key`, `q_from`, `q_to`, `source`, `note` | intervalli e fonti delle domande |

Per creare una materia da zero puoi esaminare `setup_local.py`. Se copi un database di terzi, verifica formato, compatibilità e diritti di distribuzione. Non inserire dati personali nel repository pubblico.

## 6. Soluzione ai problemi comuni

- **`py` o `python` non riconosciuto**: installa Python da python.org e abilita l'accesso da terminale; riapri CMD.
- **`ModuleNotFoundError: flask` / `sqlalchemy`**: attiva `.venv` e riesegui `python -m pip install -r requirements.txt`.
- **`PASSWORD_PEPPER non impostato`**: usa `python run_local.py`, non `python app.py`, dopo aver eseguito `python setup_local.py`.
- **Login non rimane attivo su localhost**: il file originale richiede cookie HTTPS. Avvia con `python run_local.py`, che abilita i cookie HTTP solo in locale.
- **Nessuna materia disponibile**: verifica che sia presente `data/demo_informatica.db` (o un database compatibile); altrimenti riesegui `python setup_local.py`.
- **Porta 5000 occupata**: arresta il processo che la utilizza o modifica la porta in `run_local.py` e nel browser.
- **Non riesci più ad accedere dopo aver cambiato le chiavi**: ripristina `.env.local` usato in fase di registrazione; ricreare chiavi casuali non recupera le password esistenti.
- **Problemi con il microfono**: il controllo vocale dipende dal browser e dalle sue autorizzazioni; non è garantito offline.

## 7. Distribuzione e privacy

Questa procedura avvia un server di **sviluppo locale**, non destinato a Internet. La pubblicazione online richiede un deployment WSGI/HTTPS e una verifica delle misure di sicurezza. Il repository non contiene utenti reali, segreti, backup o database delle materie originali.
