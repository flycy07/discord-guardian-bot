import crypto from 'node:crypto';
import express from 'express';
import { cfg } from '../config.js';
import { getGuild } from '../store.js';
import { logToGuild } from '../log.js';

const TOKEN_TTL = 15 * 60 * 1000;
/** token -> { guildId, userId, exp } */
const tokens = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [t, v] of tokens) if (v.exp < now) tokens.delete(t);
}, 60_000).unref();

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function page(title, body, extraHead = '') {
  return `<!doctype html><html lang="it"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>${extraHead}
<style>
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#1e1f22;color:#f2f3f5;font-family:system-ui,sans-serif}
main{background:#2b2d31;padding:2rem;border-radius:12px;max-width:380px;width:calc(100% - 2rem);text-align:center}
h1{font-size:1.3rem;margin:0 0 .75rem}p{color:#b5bac1;line-height:1.5}
button{background:#5865f2;color:#fff;border:0;border-radius:8px;padding:.8rem 1.5rem;font-size:1rem;cursor:pointer;margin-top:1rem}
button:hover{background:#4752c4}.ok{color:#57f287}.err{color:#ed4245}
</style></head><body><main>${body}</main></body></html>`;
}

/** Crea un link di verifica personale e monouso per l'utente. */
export function createVerifyLink(guildId, userId) {
  for (const [t, v] of tokens) if (v.guildId === guildId && v.userId === userId) tokens.delete(t);
  const token = crypto.randomBytes(24).toString('hex');
  tokens.set(token, { guildId, userId, exp: Date.now() + TOKEN_TTL });
  return `${cfg.publicUrl}/verify/${token}`;
}

async function verifyTurnstile(response, ip) {
  if (!cfg.turnstileSecret) return true; // captcha non configurato
  if (!response) return false;
  const body = new URLSearchParams({ secret: cfg.turnstileSecret, response });
  if (ip) body.set('remoteip', ip);
  try {
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body });
    return (await res.json()).success === true;
  } catch {
    return false;
  }
}

export function startVerifyServer(client) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.urlencoded({ extended: false, limit: '10kb' }));
  app.use((_req, res, next) => {
    res.set({ 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' });
    next();
  });

  app.get('/', (_req, res) => res.send('ok'));

  app.get('/verify/:token', (req, res) => {
    const t = tokens.get(req.params.token);
    if (!t || t.exp < Date.now()) {
      return res.status(410).send(page('Link scaduto', '<h1 class="err">Link scaduto</h1><p>Torna su Discord e premi di nuovo il pulsante di verifica.</p>'));
    }
    const widget = cfg.turnstileSite
      ? `<div class="cf-turnstile" data-sitekey="${esc(cfg.turnstileSite)}" data-theme="dark"></div>`
      : '';
    const head = cfg.turnstileSite
      ? '<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>'
      : '';
    res.send(
      page(
        'Verifica',
        `<h1>Verifica di essere umano</h1><p>Conferma per accedere al server.</p>
<form method="post" action="/verify/${esc(req.params.token)}">${widget}<button type="submit">Verificami</button></form>`,
        head,
      ),
    );
  });

  app.post('/verify/:token', async (req, res) => {
    const t = tokens.get(req.params.token);
    if (!t || t.exp < Date.now()) {
      return res.status(410).send(page('Link scaduto', '<h1 class="err">Link scaduto</h1><p>Torna su Discord e premi di nuovo il pulsante di verifica.</p>'));
    }
    const ok = await verifyTurnstile(req.body['cf-turnstile-response'], req.ip);
    if (!ok) {
      return res.status(400).send(page('Captcha', '<h1 class="err">Captcha non superato</h1><p>Torna indietro e riprova.</p>'));
    }

    tokens.delete(req.params.token); // monouso
    try {
      const guild = await client.guilds.fetch(t.guildId);
      const member = await guild.members.fetch(t.userId);
      const g = getGuild(guild.id);
      const v = g.verify;
      if (v.verifiedRole) await member.roles.add(v.verifiedRole, 'Verifica completata');
      if (v.unverifiedRole) await member.roles.remove(v.unverifiedRole, 'Verifica completata').catch(() => {});
      await logToGuild(guild, g, {
        title: 'Membro verificato',
        color: 0x57f287,
        description: `${member} (${member.user.tag}) ha completato la verifica.`,
      });
      res.send(page('Verificato', '<h1 class="ok">Verifica completata ✅</h1><p>Puoi tornare su Discord.</p>'));
    } catch (err) {
      console.error('[verifica] errore:', err);
      res.status(500).send(page('Errore', '<h1 class="err">Errore</h1><p>Non sono riuscito ad assegnarti il ruolo. Avvisa lo staff.</p>'));
    }
  });

  app.listen(cfg.port, () => console.log(`[verifica] server in ascolto sulla porta ${cfg.port}`));
}

/** Click sul pulsante del pannello di verifica. */
export async function handleVerifyButton(interaction) {
  const g = getGuild(interaction.guildId);
  const v = g.verify;
  if (!v.enabled) return interaction.reply({ content: 'La verifica non è attiva.', ephemeral: true });
  if (v.verifiedRole && interaction.member.roles.cache.has(v.verifiedRole)) {
    return interaction.reply({ content: 'Sei già verificato ✅', ephemeral: true });
  }
  if (!cfg.publicUrl) {
    return interaction.reply({ content: 'Verifica non configurata (manca PUBLIC_URL). Avvisa lo staff.', ephemeral: true });
  }

  const ageDays = (Date.now() - interaction.user.createdTimestamp) / 86_400_000;
  if (v.minAccountAgeDays > 0 && ageDays < v.minAccountAgeDays) {
    await logToGuild(interaction.guild, g, {
      title: 'Verifica rifiutata: account troppo recente',
      color: 0xed4245,
      description: `${interaction.user} (${interaction.user.tag}) — account di ${ageDays.toFixed(1)} giorni (minimo ${v.minAccountAgeDays}).`,
    });
    return interaction.reply({
      content: `Il tuo account è troppo recente (minimo ${v.minAccountAgeDays} giorni). Contatta lo staff per la verifica manuale.`,
      ephemeral: true,
    });
  }

  const link = createVerifyLink(interaction.guildId, interaction.user.id);
  return interaction.reply({
    content: `🔗 Il tuo link personale (valido 15 minuti, monouso):\n${link}`,
    ephemeral: true,
  });
}

/** Quando entra un nuovo membro assegna il ruolo "non verificato". */
export async function onMemberJoin(member) {
  const g = getGuild(member.guild.id);
  if (!g.verify.enabled || !g.verify.unverifiedRole || member.user.bot) return;
  await member.roles.add(g.verify.unverifiedRole, 'In attesa di verifica').catch((e) => console.warn('[verifica] ruolo non assegnato:', e.message));
}
