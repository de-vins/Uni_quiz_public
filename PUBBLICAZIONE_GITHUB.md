# Pubblicare SOLO la baseline in un repository pubblico separato

**Non modificare la visibilità di `Uni_quiz_baseline`**: contiene anche il branch privato di sviluppo. GitHub non offre permessi di visibilità separati per branch dello stesso repository.

## 1. Crea un secondo repository

Su GitHub: `+` → **New repository**.

- Owner: `de-vins`
- Repository name suggerito: `Uni_quiz_public`
- Visibility: **Public**
- README: **Off**
- .gitignore: **No .gitignore**
- License: **No license** (scegli successivamente una licenza se vuoi permettere il riutilizzo)

Premi **Create repository**. Non inserire dati o segreti reali.

## 2. Pubblica il contenuto dello ZIP pubblico

1. Scarica `quiz_universita_pubblico_baseline.zip`.
2. Estrai lo ZIP in una **cartella nuova** sul PC, separata dalla cartella `quiz-universita` con lo storico Git privato.
3. Apri **CMD** nella cartella estratta (quella che contiene `app.py` e `README.md`).
4. Lancia, uno alla volta:

```bat
git init -b main
git add .
git status
git ls-files
git commit -m "Baseline pubblica con guida installazione locale"
git remote add origin https://github.com/de-vins/Uni_quiz_public.git
git push -u origin main
```

Nel risultato di `git ls-files` **non devono comparire** `.env.local`, file `*.db`, `instance/app.db`, `.venv/`, password o altri dati reali. I file `*.db` non devono essere presenti neanche nella cronologia pubblica.

**Non usare** `git push --all`, `git push --mirror`, `git push --tags` o il bundle dello storico privato per questo repository: renderebbero più facile pubblicare materiale non destinato alla condivisione.

Se preferisci cambiare nome al repository pubblico, sostituisci `Uni_quiz_public` nell'URL remoto e nel primo comando di installazione del README.

## 3. Verifica

Apri il repository pubblico e controlla che:

- esista **solo `main`**, con `app.py`, `app_store.py`, `static/`, `templates/` e documentazione;
- README mostri le istruzioni Windows/Linux;
- non compaiano l'interfaccia delle autorizzazioni, la gestione ufficiose o i branch privati;
- non siano presenti database, log, segreti o dati degli utenti.

`Uni_quiz_baseline` resta privato e indipendente. GitHub non sincronizza automaticamente i due repository: le modifiche al repository privato non verranno pubblicate da sole.
