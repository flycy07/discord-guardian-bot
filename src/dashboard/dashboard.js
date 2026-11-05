import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { ChannelType, EmbedBuilder, PermissionFlagsBits as P } from 'discord.js';
import { cfg } from '../config.js';
import { getGuild, save } from '../store.js';
import { logToGuild } from '../log.js';
import { buildWelcomeMessage, clip, cleanColor, cleanUrl, sanitizeWelcome } from '../welcome.js';
import { platformReady, resolveTwitch, resolveYouTube, resolveX } from '../notifications/notifier.js';

const RESOLVERS = { twitch: resolveTwitch, youtube: resolveYouTube, x: resolveX };
const MAX_SUBS = 50;

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const INDEX_HTML = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
const SESSION_TTL = 12 * 3600 * 1000;
const TEXT_TYPES = [ChannelType.GuildText, ChannelType.GuildAnnouncement];

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const cleanOrigin = (u) => String(u ?? '').trim().replace(/\/+$/, '');

/**
 * Il redirect_uri deve essere identico a quello che il browser sta usando e a quello
 * registrato nel Developer Portal: PUBLIC_URL può essere vecchio, avere uno spazio in
 * coda o uno schema diverso dal dominio reale, e in quel caso Discord risponde
 * "URI di reindirizzamento OAuth2 non valido". Perciò lo ricaviamo dalla richiesta,
 * usando PUBLIC_URL solo come ripiego.
 */
const requestOrigin = (req) => {
  const proto = String(req.headers['x-forwarded-proto'] ?? req.protocol ?? 'http').split(',')[0].trim() || 'http';
  const host = String(req.headers['x-forwarded-host'] ?? req.headers.host ?? '').split(',')[0].trim();
  return /^[a-z0-9.-]+(:\d+)?$/i.test(host) ? `${proto}://${host}` : cleanOrigin(cfg.publicUrl);
};
const redirectUri = (req) => `${requestOrigin(req)}/dashboard/callback`;

/** sessionId -> { user, exp, lastSend } (in memoria: al riavvio si rifà il login) */
const sessions = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions) if (s.exp < now) sessions.delete(id);
}, 10 * 60_000).unref();

const readCookie = (req, name) => {
  const raw = (req.headers.cookie ?? '').match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`))?.[1];
  if (raw === undefined) return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
};
const getSession = (req) => {
  const s = sessions.get(readCookie(req, 'gd_session') ?? '');
  return s && s.exp > Date.now() ? s : null;
};
const cookieOpts = (req, maxAge) => ({
  httpOnly: true,
  sameSite: 'lax',
  secure: requestOrigin(req).startsWith('https://'),
  maxAge,
  path: '/dashboard',
});

/** Pagina d'errore del login: dice sempre quale URL di redirect è stato usato. */
function loginErrorPage(res, status, title, message, uri = '') {
  return res
    .status(status)
    .type('html')
    .send(
      `<!doctype html><html lang="it"><head><meta charset="utf-8"><title>${esc(title)}</title></head><body>
<h1>${esc(title)}</h1><p>${esc(message)}</p>
${uri ? `<p>URL di reindirizzamento usato:<br><code>${esc(uri)}</code></p>` : ''}
<p><a href="/dashboard/login">Riprova il login</a> · <a href="/dashboard">Torna alla dashboard</a></p>
</body></html>`,
    );
}

function textChannel(guild, id, member = null) {
  const ch = guild.channels.cache.get(String(id ?? ''));
  if (!ch || !TEXT_TYPES.includes(ch.type)) return null;
  if (!ch.permissionsFor(guild.members.me)?.has([P.ViewChannel, P.SendMessages, P.EmbedLinks])) return null;
  if (member && !ch.permissionsFor(member)?.has([P.ViewChannel, P.SendMessages])) return null;
  return ch;
}

function buildAnnouncementEmbed(input = {}) {
  const title = clip(input.title, 256);
  const description = clip(input.description, 3000);
  const image = cleanUrl(input.image);
  const fields = (Array.isArray(input.fields) ? input.fields : [])
    .slice(0, 5)
    .map((f) => ({ name: clip(f?.name, 100), value: clip(f?.value, 300), inline: Boolean(f?.inline) }))
    .filter((f) => f.name && f.value);
  if (!title && !description && !image && !fields.length) return null;

  const eb = new EmbedBuilder().setColor(cleanColor(input.color));
  if (title) eb.setTitle(title);
  if (title && cleanUrl(input.url)) eb.setURL(cleanUrl(input.url));
  if (description) eb.setDescription(description);
  if (image) eb.setImage(image);
  if (cleanUrl(input.thumbnail)) eb.setThumbnail(cleanUrl(input.thumbnail));
  if (clip(input.authorName, 200)) eb.setAuthor({ name: clip(input.authorName, 200) });
  if (clip(input.footer, 200)) eb.setFooter({ text: clip(input.footer, 200) });
  if (fields.length) eb.addFields(fields);
  return eb;
}

export function mountDashboard(app, client) {
  const r = express.Router();

  r.use((_req, res, next) => {
    res.set(
      'Content-Security-Policy',
      "default-src 'none'; script-src 'self'; style-src 'self'; img-src https: data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
    );
    next();
  });

  r.get('/', (req, res) => res.type('html').send(INDEX_HTML.replace('{{redirect_uri}}', esc(redirectUri(req)))));
  r.use('/static', express.static(PUBLIC, { index: false }));

  /* ---------- login con Discord (OAuth2) ---------- */
  r.get('/login', (req, res) => {
    if (!cfg.clientId || !cfg.clientSecret) {
      return res.status(503).send('Dashboard non configurata: imposta CLIENT_ID e DISCORD_CLIENT_SECRET nelle variabili d\'ambiente.');
    }
    const redirect = redirectUri(req);
    const state = crypto.randomBytes(16).toString('hex');
    res.cookie('gd_state', state, cookieOpts(req, 10 * 60_000));
    // salviamo l'URL esatto usato qui, così lo scambio del codice manda lo stesso valore
    res.cookie('gd_redirect', redirect, cookieOpts(req, 10 * 60_000));
    const url = new URL('https://discord.com/oauth2/authorize');
    url.search = new URLSearchParams({
      client_id: cfg.clientId,
      redirect_uri: redirect,
      response_type: 'code',
      scope: 'identify',
      state,
    }).toString();
    res.redirect(url.toString());
  });

  r.get('/callback', async (req, res) => {
    const { code, state } = req.query;
    if (typeof req.query.error === 'string') {
      const desc = req.query.error === 'access_denied' ? 'Hai rifiutato l\'accesso su Discord.' : String(req.query.error_description ?? req.query.error);
      return loginErrorPage(res, 400, 'Accesso annullato', desc);
    }
    const expectedState = readCookie(req, 'gd_state');
    if (typeof code !== 'string' || typeof state !== 'string' || !expectedState || state !== expectedState) {
      return loginErrorPage(res, 400, 'Richiesta non valida', 'Il link di login è scaduto o è stato aperto in un\'altra finestra. Riprova dalla dashboard.');
    }
    const savedRedirect = readCookie(req, 'gd_redirect');
    const redirect = savedRedirect && /^https?:\/\/[^/]+\/dashboard\/callback$/.test(savedRedirect) ? savedRedirect : redirectUri(req);
    res.clearCookie('gd_state', { path: '/dashboard' });
    res.clearCookie('gd_redirect', { path: '/dashboard' });
    try {
      const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
        method: 'POST',
        body: new URLSearchParams({
          client_id: cfg.clientId,
          client_secret: cfg.clientSecret,
          grant_type: 'authorization_code',
          code,
          redirect_uri: redirect,
        }),
      });
      if (!tokenRes.ok) {
        let detail = `HTTP ${tokenRes.status}`;
        try {
          const j = await tokenRes.json();
          detail = [j.error, j.error_description].filter(Boolean).join(': ') || detail;
        } catch {
          /* risposta non JSON */
        }
        console.error(`[dashboard] scambio del codice fallito (${tokenRes.status}): ${detail}`);
        if (/redirect_uri/i.test(detail)) {
          return loginErrorPage(
            res,
            502,
            'URL di reindirizzamento non registrato',
            'Discord ha rifiutato questo URL. Aggiungilo identico (stesso schema, host e porta, senza slash finale) in Developer Portal → OAuth2 → Redirects e riprova.',
            redirect,
          );
        }
        return loginErrorPage(res, 502, 'Login non riuscito', `Discord ha rifiutato il codice di accesso: ${detail}. Controlla CLIENT_ID, DISCORD_CLIENT_SECRET e l'URL di redirect, poi riprova.`, redirect);
      }
      const { access_token } = await tokenRes.json();
      const meRes = await fetch('https://discord.com/api/users/@me', { headers: { Authorization: `Bearer ${access_token}` } });
      if (!meRes.ok) throw new Error(`utente ${meRes.status}`);
      const me = await meRes.json();

      const sid = crypto.randomBytes(32).toString('hex');
      sessions.set(sid, {
        user: {
          id: me.id,
          username: me.global_name || me.username,
          avatarUrl: me.avatar ? `https://cdn.discordapp.com/avatars/${me.id}/${me.avatar}.png?size=64` : null,
        },
        exp: Date.now() + SESSION_TTL,
        lastSend: 0,
      });
      res.cookie('gd_session', sid, cookieOpts(req, SESSION_TTL));
      res.redirect('/dashboard');
    } catch (err) {
      console.error('[dashboard] login fallito:', err.message);
      loginErrorPage(res, 502, 'Login non riuscito', `Non sono riuscito a completare il login: ${err.message}. Riprova.`, redirect);
    }
  });

  r.get('/logout', (req, res) => {
    sessions.delete(readCookie(req, 'gd_session') ?? '');
    res.clearCookie('gd_session', { path: '/dashboard' });
    res.redirect('/dashboard');
  });

  /* ---------- API ---------- */
  const api = express.Router();
  api.use(express.json({ limit: '100kb' }));

  api.use((req, res, next) => {
    const s = getSession(req);
    if (!s) return res.status(401).json({ error: 'Non autenticato' });
    // protezione CSRF: le richieste che modificano dati devono arrivare dalla nostra pagina
    if (req.method !== 'GET' && req.get('x-requested-with') !== 'dashboard') {
      return res.status(403).json({ error: 'Richiesta non valida' });
    }
    req.session = s;
    next();
  });

  api.get('/me', (req, res) => res.json({ user: req.session.user }));

  api.get('/guilds', async (req, res) => {
    const out = [];
    await Promise.all(
      [...client.guilds.cache.values()].slice(0, 100).map(async (g) => {
        const m = await g.members.fetch(req.session.user.id).catch(() => null);
        if (m?.permissions.has(P.ManageGuild)) out.push({ id: g.id, name: g.name, icon: g.iconURL({ size: 64 }) });
      }),
    );
    res.json({ guilds: out.sort((a, b) => a.name.localeCompare(b.name)) });
  });

  // tutto quello che segue riguarda un singolo server: verifica i permessi in tempo reale
  api.use('/guilds/:id', async (req, res, next) => {
    const guild = client.guilds.cache.get(req.params.id);
    if (!guild) return res.status(404).json({ error: 'Server non trovato (il bot è presente?)' });
    const member = await guild.members.fetch(req.session.user.id).catch(() => null);
    if (!member?.permissions.has(P.ManageGuild)) return res.status(403).json({ error: 'Ti serve il permesso "Gestire il server"' });
    req.guild = guild;
    req.member = member;
    next();
  });

  const throttle = (req, res, next) => {
    if (Date.now() - req.session.lastSend < 3000) return res.status(429).json({ error: 'Aspetta qualche secondo tra un invio e l\'altro' });
    req.session.lastSend = Date.now();
    next();
  };

  api.get('/guilds/:id', (req, res) => {
    const { guild } = req;
    const channels = [...guild.channels.cache.values()]
      .filter((c) => TEXT_TYPES.includes(c.type) && c.permissionsFor(guild.members.me)?.has([P.ViewChannel, P.SendMessages]))
      .sort((a, b) => a.rawPosition - b.rawPosition)
      .map((c) => ({ id: c.id, name: `#${c.name}` }));
    const roles = [...guild.roles.cache.values()]
      .filter((x) => !x.managed && x.id !== guild.id)
      .sort((a, b) => b.position - a.position)
      .map((x) => ({ id: x.id, name: x.name }));
    res.json({ name: guild.name, channels, roles, welcome: getGuild(guild.id).welcome });
  });

  api.put('/guilds/:id/welcome', (req, res) => {
    const w = sanitizeWelcome(req.body);
    if (w.enabled && !textChannel(req.guild, w.channelId)) {
      return res.status(400).json({ error: 'Scegli un canale valido dove il bot può scrivere' });
    }
    Object.assign(getGuild(req.guild.id).welcome, w);
    save();
    res.json({ ok: true });
  });

  api.post('/guilds/:id/welcome/test', throttle, async (req, res) => {
    const w = sanitizeWelcome(req.body);
    const ch = textChannel(req.guild, w.channelId, req.member);
    if (!ch) return res.status(400).json({ error: 'Scegli un canale valido dove puoi scrivere' });
    const msg = buildWelcomeMessage(req.member, w);
    if (!msg.content && !msg.embeds.length) return res.status(400).json({ error: 'Il messaggio è vuoto' });
    try {
      await ch.send(msg); // l'anteprima usa te come "nuovo membro"
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: `Invio non riuscito: ${err.message}` });
    }
  });

  api.post('/guilds/:id/announce', throttle, async (req, res) => {
    const { guild, member } = req;
    const ch = textChannel(guild, req.body.channelId, member);
    if (!ch) return res.status(400).json({ error: 'Scegli un canale valido dove puoi scrivere' });

    let prefix = '';
    const allowed = { parse: [], roles: [], users: [] };
    const mention = String(req.body.mention ?? 'none');
    if (mention === 'everyone' || mention === 'here') {
      if (!member.permissions.has(P.MentionEveryone)) return res.status(403).json({ error: 'Non hai il permesso di menzionare @everyone/@here' });
      prefix = `@${mention} `;
      allowed.parse = ['everyone'];
    } else if (mention.startsWith('role:')) {
      const role = guild.roles.cache.get(mention.slice(5));
      if (!role) return res.status(400).json({ error: 'Ruolo non trovato' });
      if (!role.mentionable && !member.permissions.has(P.MentionEveryone)) return res.status(403).json({ error: 'Quel ruolo non è menzionabile' });
      prefix = `<@&${role.id}> `;
      allowed.roles = [role.id];
    }

    const text = clip(req.body.content, 1800);
    let embed = null;
    try {
      embed = buildAnnouncementEmbed(req.body.embed);
    } catch (err) {
      return res.status(400).json({ error: `Embed non valido: ${err.message}` });
    }
    const content = `${prefix}${text}`.trim();
    if (!content && !embed) return res.status(400).json({ error: 'Scrivi un testo o compila l\'embed' });

    try {
      const sent = await ch.send({ content: content || undefined, embeds: embed ? [embed] : [], allowedMentions: allowed });
      await logToGuild(guild, getGuild(guild.id), {
        title: 'Annuncio inviato dalla dashboard',
        description: `${member} ha pubblicato un annuncio in ${ch}.\n[Vai al messaggio](${sent.url})`,
      });
      res.json({ ok: true, url: sent.url });
    } catch (err) {
      res.status(400).json({ error: `Invio non riuscito: ${err.message}` });
    }
  });

  /* ---------- notifiche social ---------- */
  const publicSub = (s) => ({ id: s.id, platform: s.platform, display: s.display, channelId: s.channelId, roleId: s.roleId, message: s.message });
  const validRole = (guild, id) => (id && guild.roles.cache.has(String(id)) && String(id) !== guild.id ? String(id) : null);

  api.get('/guilds/:id/notifications', (req, res) => {
    const ready = Object.fromEntries(Object.entries(platformReady).map(([k, fn]) => [k, fn()]));
    res.json({ subs: getGuild(req.guild.id).notify.subs.map(publicSub), ready });
  });

  api.post('/guilds/:id/notifications', throttle, async (req, res) => {
    const { guild } = req;
    const subs = getGuild(guild.id).notify.subs;
    const platform = String(req.body.platform ?? '');
    if (!RESOLVERS[platform]) return res.status(400).json({ error: 'Piattaforma non valida' });
    if (!platformReady[platform]()) return res.status(400).json({ error: 'Piattaforma non configurata sul bot (mancano le chiavi API nelle variabili d\'ambiente)' });
    const ch = textChannel(guild, req.body.channelId);
    if (!ch) return res.status(400).json({ error: 'Scegli un canale valido dove il bot può scrivere' });
    const creator = clip(req.body.creator, 200);
    if (!creator) return res.status(400).json({ error: 'Inserisci il nome del creator' });
    if (subs.length >= MAX_SUBS) return res.status(400).json({ error: `Limite di ${MAX_SUBS} creator raggiunto` });

    let resolved;
    try {
      resolved = await RESOLVERS[platform](creator);
    } catch (err) {
      return res.status(502).json({ error: `Errore nel contattare la piattaforma: ${err.message}` });
    }
    if (!resolved) return res.status(404).json({ error: 'Creator non trovato' });
    if (subs.some((s) => s.platform === platform && s.ident === resolved.ident && s.channelId === ch.id)) {
      return res.status(409).json({ error: 'Questo creator è già seguito in quel canale' });
    }

    const entry = {
      id: crypto.randomBytes(3).toString('hex'),
      platform,
      ident: resolved.ident,
      display: resolved.display,
      channelId: ch.id,
      roleId: validRole(guild, req.body.roleId),
      message: clip(req.body.message, 500) || null,
      state: {},
    };
    subs.push(entry);
    save();
    res.json({ ok: true, sub: publicSub(entry) });
  });

  api.put('/guilds/:id/notifications/:subId', (req, res) => {
    const sub = getGuild(req.guild.id).notify.subs.find((s) => s.id === req.params.subId);
    if (!sub) return res.status(404).json({ error: 'Creator non trovato' });
    if (req.body.channelId !== undefined) {
      const ch = textChannel(req.guild, req.body.channelId);
      if (!ch) return res.status(400).json({ error: 'Canale non valido o senza permessi per il bot' });
      sub.channelId = ch.id;
    }
    if (req.body.roleId !== undefined) sub.roleId = validRole(req.guild, req.body.roleId);
    if (req.body.message !== undefined) sub.message = clip(req.body.message, 500) || null;
    save();
    res.json({ ok: true, sub: publicSub(sub) });
  });

  api.delete('/guilds/:id/notifications/:subId', (req, res) => {
    const subs = getGuild(req.guild.id).notify.subs;
    const idx = subs.findIndex((s) => s.id === req.params.subId);
    if (idx === -1) return res.status(404).json({ error: 'Creator non trovato' });
    subs.splice(idx, 1);
    save();
    res.json({ ok: true });
  });

  api.use((_req, res) => res.status(404).json({ error: 'Non trovato' }));
  r.use('/api', api);
  app.use('/dashboard', r);
  const missing = [!cfg.clientId && 'CLIENT_ID', !cfg.clientSecret && 'DISCORD_CLIENT_SECRET'].filter(Boolean);
  if (missing.length) {
    console.log(`[dashboard] login disattivato: mancano ${missing.join(', ')}`);
  } else {
    const base = cleanOrigin(cfg.publicUrl) || `http://localhost:${cfg.port}`;
    console.log(`[dashboard] disponibile su ${base}/dashboard`);
    console.log(`[dashboard] URL da registrare nel Developer Portal (OAuth2 → Redirects): ${base}/dashboard/callback`);
  }
}
