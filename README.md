# Discord Guardian Bot

Bot Discord in JavaScript (discord.js v14) con tre moduli:

1. **Moderazione avanzata**: anti-spam/flood, menzioni di massa, inviti non autorizzati, link di phishing e **classificazione AI** dei messaggi (Claude). Sistema di strike con timeout progressivo e log nel canale staff.
2. **Verifica nuovi membri tramite link esterno**: il nuovo arrivato preme un pulsante, riceve un link personale e monouso a una pagina web ospitata dal bot (con captcha Cloudflare Turnstile opzionale). Solo dopo ottiene il ruolo verificato. Controllo opzionale sull'età minima dell'account.
3. **Notifiche social**: avvisa il server quando un creator va in **live su Twitch**, pubblica un **video su YouTube** o scrive un **post su X**.

4. **Dashboard web**: gestisci dal browser i **messaggi di benvenuto** e gli **annunci con embed**, con anteprima dal vivo (vedi la sezione *Dashboard*).

## Requisiti

- Node.js 20 o superiore
- Un server Discord dove sei amministratore
- (opzionale) chiavi API per AI, Twitch, X, Turnstile, Safe Browsing (vedi sotto)

## 1. Creare l'applicazione Discord

1. Vai su <https://discord.com/developers/applications> → **New Application**.
2. Scheda **Bot** → **Reset Token** e copia il token (`DISCORD_TOKEN`).
3. Sempre in **Bot**, attiva i *Privileged Gateway Intents*:
   - **Server Members Intent**
   - **Message Content Intent**
4. Scheda **General Information**: copia l'**Application ID** (`CLIENT_ID`).
5. Scheda **OAuth2 → URL Generator**: scope `bot` e `applications.commands`, permessi:
   *View Channels, Send Messages, Embed Links, Read Message History, Manage Messages, Moderate Members, Manage Roles, Mention Everyone* (serve per menzionare i ruoli nelle notifiche).
   Apri l'URL generato e invita il bot nel server.
6. **Importante**: nelle impostazioni del server → Ruoli, trascina il ruolo del bot **sopra** ai ruoli "verificato" / "non verificato", altrimenti non potrà assegnarli.

## 2. Installazione

```bash
git clone https://github.com/flycy07/discord-guardian-bot.git
cd discord-guardian-bot
npm install
cp .env.example .env     # poi compila il file .env
npm run deploy           # registra i comandi slash
npm start
```

Imposta `GUILD_ID` (ID del tuo server) nel `.env` mentre provi: i comandi compaiono subito. Senza, sono globali e Discord può impiegare fino a un'ora.

## 3. Configurazione (`.env`)

| Variabile | Obbligatoria | A cosa serve |
|---|---|---|
| `DISCORD_TOKEN`, `CLIENT_ID` | sì | Credenziali del bot |
| `GUILD_ID` | no | Registra i comandi solo in quel server (istantaneo) |
| `ANTHROPIC_API_KEY` | no | Attiva la classificazione AI. Senza, restano i controlli anti-spam classici. Chiave da <https://console.anthropic.com> |
| `AI_MODEL` | no | Modello usato (default `claude-haiku-5-5`, veloce ed economico) |
| `SAFE_BROWSING_API_KEY` | no | Controllo link con Google Safe Browsing |
| `PUBLIC_URL` | per verifica e dashboard | URL pubblico del bot, es. `https://bot.tuodominio.it` (su Render: `https://nome-servizio.onrender.com`) |
| `DISCORD_CLIENT_SECRET` | per la dashboard | Developer Portal → OAuth2 → *Client Secret* (serve per il login con Discord) |
| `PORT` | no | Porta del server web (default 3000) |
| `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET` | consigliato | Captcha Cloudflare gratuito per la verifica |
| `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET` | per Twitch | App su <https://dev.twitch.tv/console/apps> |
| `X_BEARER_TOKEN` oppure `X_RSS_BASE` | per X | Vedi nota su X sotto |
| `POLL_SECONDS` | no | Frequenza di controllo notifiche (default 120, minimo 30) |
| `DATA_DIR` | no | Dove salvare i dati (default `data/`) |

### Rendere raggiungibile la pagina di verifica

La verifica richiede che `PUBLIC_URL` punti al bot da internet. Opzioni:

- **Hosting con dominio** (Railway, Render, Fly.io, VPS): usa l'URL che ti assegnano e imposta `PORT` come richiesto dalla piattaforma.
- **In locale per provare**: `cloudflared tunnel --url http://localhost:3000` (o `ngrok http 3000`) e metti l'URL ottenuto in `PUBLIC_URL`.

Usa sempre **HTTPS** in produzione. Per il captcha crea un widget Turnstile (modalità *Managed*) e inserisci site key e secret.

## 4. Comandi

Tutti i comandi sono slash command e visibili solo a chi ha i permessi indicati.

### Moderazione (`/mod`, permesso *Moderare i membri*)

| Comando | Descrizione |
|---|---|
| `/mod config` | Imposta `log` (canale staff), `attivo`, `ai`, `max-menzioni`, `spam-messaggi`, `spam-secondi`, `max-link`, `blocca-inviti` |
| `/mod stato` | Mostra la configurazione |
| `/mod strikes utente` | Strike di un utente |
| `/mod azzera utente` | Azzera gli strike |
| `/mod mute utente minuti [motivo]` | Timeout manuale |
| `/mod unmute utente` | Rimuove il timeout |

**Come funziona:** ogni violazione rimuove il messaggio e assegna uno strike. Strike 1 = avviso; 2 = timeout 10 min; 3 = 60 min; 4+ = 24 h. Le violazioni gravi (phishing, minacce, odio) valgono doppio. Gli strike scadono dopo 7 giorni senza violazioni. Chi ha il permesso *Gestire i messaggi* è esente. Se l'AI non risponde, non viene punito nessuno.

Per iniziare: `/mod config log:#log-moderazione`.

### Verifica (`/verifica`, permesso *Gestire il server*)

```
/verifica setup canale:#verifica ruolo-verificato:@Membro ruolo-non-verificato:@Non verificato eta-minima:3
/verifica disabilita
```

Consiglio: configura i permessi in modo che `@everyone` / `@Non verificato` veda solo il canale #verifica e `@Membro` veda il resto del server.

### Notifiche (`/notifiche`, permesso *Gestire il server*)

```
/notifiche aggiungi piattaforma:Twitch creator:nomecanale canale:#live ruolo:@Live
/notifiche aggiungi piattaforma:YouTube creator:@nomehandle canale:#video
/notifiche aggiungi piattaforma:X creator:nomeutente canale:#social
/notifiche lista
/notifiche rimuovi id:abc123
```

Il testo si può personalizzare con l'opzione `messaggio` usando i segnaposto `{nome}`, `{url}`, `{titolo}`.
All'aggiunta vengono memorizzati i contenuti già esistenti: ricevi avvisi solo per quelli **nuovi**.

**YouTube:** usa i feed RSS pubblici, senza chiave API. Se l'@handle non viene risolto, incolla l'ID canale (inizia con `UC`).

**X (Twitter):** l'API ufficiale in lettura è a pagamento o con limiti molto stretti. Hai due strade:
- `X_BEARER_TOKEN` se hai un accesso API che consente di leggere i post;
- `X_RSS_BASE` puntando a un'istanza RSS che gestisci tu (es. RSSHub): il bot richiede `{X_RSS_BASE}/{utente}`.

## 5. Dashboard (benvenuto e annunci)

Aprila su `PUBLIC_URL/dashboard` (es. `https://nome-servizio.onrender.com/dashboard`).

**Configurazione una tantum:**
1. Developer Portal → **OAuth2** → copia il **Client Secret** e mettilo in `DISCORD_CLIENT_SECRET`.
2. Sempre in OAuth2 → **Redirects** → aggiungi `PUBLIC_URL/dashboard/callback` (identico, senza slash finale) e salva.
3. Riavvia il bot.

**Accesso:** login con Discord. Vedi solo i server in cui c'è il bot **e** hai il permesso *Gestire il server* (verificato in tempo reale a ogni operazione).

**Cosa puoi fare:**
- **Benvenuto**: attiva/disattiva, scegli il canale, scrivi il testo e un embed opzionale (titolo, descrizione, colore, immagine, footer, avatar del membro). Segnaposto: `{utente}` `{nome}` `{server}` `{membri}`. Il pulsante *Invia anteprima nel canale* manda il messaggio usando te come nuovo membro.
- **Annunci**: scegli canale, menzione (nessuna, `@everyone`, `@here` o un ruolo), testo e embed completo (titolo con link, descrizione, colore, autore, immagine, miniatura, footer, fino a 5 campi). Ogni annuncio viene registrato nel canale log.

Le sessioni restano in memoria: dopo un riavvio del bot devi rifare il login.

## 6. Hosting su Render

Non serve il file `.env`: le variabili si inseriscono nel pannello di Render.

1. Su <https://render.com> → **New → Web Service** → collega la repo `discord-guardian-bot`.
2. Impostazioni:
   - **Runtime**: Node
   - **Build Command**: `npm install`
   - **Start Command**: `node src/deploy-commands.js && node src/index.js`
3. Scheda **Environment** → aggiungi le variabili della tabella sopra (almeno `DISCORD_TOKEN`, `CLIENT_ID`). `PORT` lo imposta Render da solo: non toccarlo.
4. Dopo il primo deploy copia l'URL del servizio (`https://….onrender.com`), mettilo in `PUBLIC_URL` e salva (il servizio si riavvia). Usa lo stesso URL per il Redirect della dashboard.

**Attenzione ai limiti del piano gratuito** (controlla le condizioni attuali sul sito di Render):
- Un Web Service gratuito va in **sospensione dopo un periodo senza richieste HTTP**: il bot risulterà offline finché qualcuno non riapre l'URL. Per tenerlo sempre attivo serve un piano a pagamento oppure un servizio esterno che richiami periodicamente `PUBLIC_URL` (es. UptimeRobot).
- Il filesystem è **temporaneo**: `data/db.json` (impostazioni, strike, iscrizioni social, benvenuto) si perde a ogni deploy o riavvio. Per conservarlo aggiungi un **Disk** persistente (piani a pagamento), montalo ad esempio su `/var/data` e imposta `DATA_DIR=/var/data`.

## 7. Altri modi di avvio

- **pm2**: `npm i -g pm2 && pm2 start src/index.js --name guardian && pm2 save`
- **Docker**: `docker build -t guardian . && docker run -d --env-file .env -p 3000:3000 -v guardian-data:/data guardian`

I dati sono in `data/db.json`: su hosting con disco effimero monta un volume persistente, altrimenti vengono persi a ogni deploy.

## Privacy e limiti

- Con la moderazione AI attiva, il testo dei messaggi che superano i filtri base viene inviato all'API di Anthropic per la classificazione. Informa i membri nelle regole del server e, se non vuoi questo comportamento, lascia vuoto `ANTHROPIC_API_KEY` o usa `/mod config ai:False`.
- L'AI può sbagliare: tieni attivo il canale di log, controlla le sanzioni e usa `/mod azzera` per correggere i falsi positivi.
- Il captcha Turnstile riduce i bot ma non sostituisce la moderazione umana.
- Il bot non banna mai in automatico: dopo 5 strike segnala solo nel log di valutare un ban.

## Struttura

```
src/
  index.js                 avvio bot
  deploy-commands.js       registrazione comandi slash
  commands/                /mod, /verifica, /notifiche
  moderation/              anti-spam, AI, controllo link
  verification/            pulsante + server web di verifica
  notifications/           Twitch, YouTube, X
  dashboard/               dashboard web (login Discord, API, pagine in public/)
  welcome.js               messaggi di benvenuto
  store.js                 salvataggio JSON
```
