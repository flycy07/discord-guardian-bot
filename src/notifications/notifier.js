import { EmbedBuilder } from 'discord.js';
import { XMLParser } from 'fast-xml-parser';
import { cfg } from '../config.js';
import { allGuilds, save } from '../store.js';

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
const UA = 'Mozilla/5.0 (compatible; DiscordGuardianBot/1.0)';
// Senza timeout una richiesta appesa bloccherebbe per sempre il ciclo (running resta true):
// il bot non invierebbe più nessuna notifica fino al riavvio.
const TIMEOUT = 10_000;
const asArray = (x) => (x == null ? [] : [].concat(x));

export const DEFAULT_MESSAGES = {
  twitch: '🔴 **{nome}** è in diretta su Twitch! {url}',
  youtube: '📺 **{nome}** ha pubblicato un nuovo video: {titolo}\n{url}',
  x: '🐦 **{nome}** ha scritto un nuovo post: {url}',
};

export const platformReady = {
  twitch: () => Boolean(cfg.twitchId && cfg.twitchSecret),
  youtube: () => true,
  x: () => Boolean(cfg.xBearer || cfg.xRssBase),
};

/* ------------------------------ Twitch ------------------------------ */

let twitchAuth = { token: null, exp: 0 };

async function twitchToken(force = false) {
  if (!force && twitchAuth.token && Date.now() < twitchAuth.exp) return twitchAuth.token;
  const res = await fetch('https://id.twitch.tv/oauth2/token', {
    method: 'POST',
    signal: AbortSignal.timeout(TIMEOUT),
    body: new URLSearchParams({
      client_id: cfg.twitchId,
      client_secret: cfg.twitchSecret,
      grant_type: 'client_credentials',
    }),
  });
  if (!res.ok) throw new Error(`Twitch auth ${res.status}`);
  const j = await res.json();
  twitchAuth = { token: j.access_token, exp: Date.now() + (j.expires_in - 300) * 1000 };
  return twitchAuth.token;
}

async function twitchApi(path, retry = true) {
  const res = await fetch(`https://api.twitch.tv/helix${path}`, {
    headers: { 'Client-Id': cfg.twitchId, Authorization: `Bearer ${await twitchToken()}` },
    signal: AbortSignal.timeout(TIMEOUT),
  });
  if (res.status === 401 && retry) {
    await twitchToken(true);
    return twitchApi(path, false);
  }
  if (!res.ok) throw new Error(`Twitch API ${res.status}`);
  return res.json();
}

export async function resolveTwitch(input) {
  const login = input
    .trim()
    .replace(/^https?:\/\/(www\.)?twitch\.tv\//i, '')
    .replace(/^@/, '')
    .split(/[/?]/)[0]
    .toLowerCase();
  if (!/^\w{3,25}$/.test(login)) return null;
  const { data } = await twitchApi(`/users?login=${encodeURIComponent(login)}`);
  if (!data?.[0]) return null;
  return { ident: data[0].login, display: data[0].display_name };
}

async function checkTwitch(sub, client) {
  const { data } = await twitchApi(`/streams?user_login=${encodeURIComponent(sub.ident)}`);
  const stream = data?.[0];
  if (!stream) {
    sub.state.streamId = null;
    return;
  }
  if (sub.state.streamId === stream.id) return;
  const first = sub.state.streamId === undefined; // primo controllo: non notificare una live già in corso
  sub.state.streamId = stream.id;
  if (first) return;

  const url = `https://twitch.tv/${sub.ident}`;
  const embed = new EmbedBuilder()
    .setColor(0x9146ff)
    .setTitle(stream.title || 'In diretta!')
    .setURL(url)
    .setAuthor({ name: stream.user_name })
    .addFields({ name: 'Gioco', value: stream.game_name || '—', inline: true })
    .setImage(stream.thumbnail_url.replace('{width}', '1280').replace('{height}', '720') + `?t=${Date.now()}`);
  await announce(client, sub, { url, titolo: stream.title, embed });
}

/* ------------------------------ YouTube ------------------------------ */

export async function resolveYouTube(input) {
  const s = input.trim();
  let channelId = s.match(/(UC[\w-]{22})/)?.[1];
  if (!channelId) {
    const handle = s
      .replace(/^https?:\/\/(www\.|m\.)?youtube\.com\//i, '')
      .replace(/^@/, '')
      .split(/[/?]/)[0];
    if (!handle) return null;
    const res = await fetch(`https://www.youtube.com/@${encodeURIComponent(handle)}`, {
      headers: { 'User-Agent': UA, 'Accept-Language': 'en', Cookie: 'CONSENT=YES+1; SOCS=CAI' },
      signal: AbortSignal.timeout(TIMEOUT),
    });
    if (!res.ok) return null;
    const html = await res.text();
    // Il primo "channelId" della pagina è spesso un canale correlato (es. @MrBeast
    // finiva su Beast Philanthropy): l'ID del canale richiesto sta in canonical/externalId.
    channelId =
      html.match(/<link rel="canonical" href="https:\/\/www\.youtube\.com\/channel\/(UC[\w-]{22})"/)?.[1] ||
      html.match(/"externalId":"(UC[\w-]{22})"/)?.[1] ||
      html.match(/\/channel\/(UC[\w-]{22})/)?.[1] ||
      html.match(/channel_id=(UC[\w-]{22})/)?.[1] ||
      html.match(/"channelId":"(UC[\w-]{22})"/)?.[1];
  }
  if (!channelId) return null;
  const feed = await fetchYouTubeFeed(channelId).catch(() => null);
  if (!feed) return null;
  return { ident: channelId, display: String(feed.title ?? channelId) };
}

async function fetchYouTubeFeed(channelId) {
  const res = await fetch(`https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`, {
    headers: { 'User-Agent': UA },
    signal: AbortSignal.timeout(TIMEOUT),
  });
  if (!res.ok) throw new Error(`YouTube feed ${res.status}`);
  return parser.parse(await res.text()).feed;
}

async function checkYouTube(sub, client) {
  const feed = await fetchYouTubeFeed(sub.ident);
  const entries = asArray(feed.entry);
  const ids = entries.map((e) => e['yt:videoId']);
  if (!sub.state.seen) {
    sub.state.seen = ids; // primo controllo: memorizza senza notificare
    return;
  }
  const fresh = entries.filter((e) => !sub.state.seen.includes(e['yt:videoId'])).reverse();
  sub.state.seen = [...new Set([...ids, ...sub.state.seen])].slice(0, 50);
  for (const e of fresh) {
    const url = asArray(e.link)[0]?.['@_href'] ?? `https://www.youtube.com/watch?v=${e['yt:videoId']}`;
    await announce(client, sub, { url, titolo: String(e.title ?? '') }); // solo link: Discord mostra il player
  }
}

/* ------------------------------ X (Twitter) ------------------------------ */

export async function resolveX(input) {
  const user = input
    .trim()
    .replace(/^https?:\/\/(www\.)?(x|twitter)\.com\//i, '')
    .replace(/^@/, '')
    .split(/[/?]/)[0];
  if (!/^\w{1,15}$/.test(user)) return null;
  return { ident: user, display: `@${user}` };
}

async function xApi(path) {
  const res = await fetch(`https://api.x.com/2${path}`, {
    headers: { Authorization: `Bearer ${cfg.xBearer}` },
    signal: AbortSignal.timeout(TIMEOUT),
  });
  if (!res.ok) throw new Error(`X API ${res.status}`);
  return res.json();
}

async function checkX(sub, client) {
  const postUrl = (id) => `https://x.com/${sub.ident}/status/${id}`;

  if (cfg.xBearer) {
    if (!sub.state.userId) {
      const j = await xApi(`/users/by/username/${encodeURIComponent(sub.ident)}`);
      if (!j.data?.id) throw new Error('utente X non trovato');
      sub.state.userId = j.data.id;
    }
    const since = sub.state.sinceId ? `&since_id=${sub.state.sinceId}` : '';
    const j = await xApi(`/users/${sub.state.userId}/tweets?max_results=5&exclude=retweets,replies${since}`);
    const tweets = asArray(j.data);
    if (!tweets.length) return;
    const newest = tweets.reduce((a, b) => (BigInt(a.id) > BigInt(b.id) ? a : b)).id;
    const first = !sub.state.sinceId;
    sub.state.sinceId = newest;
    if (first) return;
    for (const t of [...tweets].sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1))) {
      await announce(client, sub, { url: postUrl(t.id), titolo: t.text, embed: tweetEmbed(sub, t.text, postUrl(t.id)) });
    }
    return;
  }

  // Fallback: feed RSS (RSSHub / Nitter)
  const res = await fetch(`${cfg.xRssBase}/${encodeURIComponent(sub.ident)}`, {
    headers: { 'User-Agent': UA },
    signal: AbortSignal.timeout(TIMEOUT),
  });
  if (!res.ok) throw new Error(`X RSS ${res.status}`);
  const items = asArray(parser.parse(await res.text())?.rss?.channel?.item)
    .map((i) => ({ id: String(i.link ?? i.guid ?? '').match(/status\/(\d+)/)?.[1], text: String(i.title ?? '') }))
    .filter((i) => i.id);
  const ids = items.map((i) => i.id);
  if (!sub.state.seen) {
    sub.state.seen = ids;
    return;
  }
  const fresh = items.filter((i) => !sub.state.seen.includes(i.id)).reverse();
  sub.state.seen = [...new Set([...ids, ...sub.state.seen])].slice(0, 50);
  for (const t of fresh) {
    await announce(client, sub, { url: postUrl(t.id), titolo: t.text, embed: tweetEmbed(sub, t.text, postUrl(t.id)) });
  }
}

const tweetEmbed = (sub, text, url) =>
  new EmbedBuilder().setColor(0x111111).setAuthor({ name: sub.display }).setDescription(text.slice(0, 1000)).setURL(url).setTitle('Apri il post');

/* ------------------------------ invio ------------------------------ */

async function announce(client, sub, { url, titolo = '', embed = null }) {
  const channel = await client.channels.fetch(sub.channelId).catch(() => null);
  if (!channel?.isTextBased()) throw new Error(`canale ${sub.channelId} non raggiungibile`);
  const template = sub.message || DEFAULT_MESSAGES[sub.platform];
  const text = template.replaceAll('{nome}', sub.display).replaceAll('{url}', url).replaceAll('{titolo}', titolo);
  const content = `${sub.roleId ? `<@&${sub.roleId}> ` : ''}${text}`.slice(0, 1900);
  await channel.send({
    content,
    embeds: embed ? [embed] : [],
    allowedMentions: { roles: sub.roleId ? [sub.roleId] : [], users: [] },
  });
}

/* ------------------------------ ciclo di controllo ------------------------------ */

const checkers = { twitch: checkTwitch, youtube: checkYouTube, x: checkX };
let running = false;

async function tick(client) {
  if (running) return;
  running = true;
  try {
    for (const [, g] of allGuilds()) {
      for (const sub of g.notify.subs) {
        if (!platformReady[sub.platform]()) continue;
        sub.state ??= {};
        try {
          await checkers[sub.platform](sub, client);
        } catch (err) {
          console.warn(`[notifiche] ${sub.platform}/${sub.ident}: ${err.message}`);
        }
      }
    }
    save();
  } finally {
    running = false;
  }
}

export function startNotifier(client) {
  setTimeout(() => tick(client), 5000);
  setInterval(() => tick(client), cfg.pollSeconds * 1000);
  console.log(`[notifiche] controllo ogni ${cfg.pollSeconds}s`);
}
