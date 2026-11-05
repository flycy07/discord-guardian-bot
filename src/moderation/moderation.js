import { PermissionFlagsBits } from 'discord.js';
import { getGuild, save } from '../store.js';
import { logToGuild } from '../log.js';
import { aiClassify } from './ai.js';
import { findMaliciousLink } from './links.js';

const INVITE_RE = /(?:discord\.gg|discord(?:app)?\.com\/invite)\/[\w-]+/i;
const URL_RE = /https?:\/\/[^\s<>()]+/gi;

const STRIKE_WINDOW = 7 * 24 * 3600 * 1000; // gli strike si azzerano dopo 7 giorni senza violazioni
const TIMEOUT_MINUTES = [0, 0, 10, 60, 1440]; // indice = n. strike (1 = solo avviso, 4+ = 24h)

/** guildId:userId -> [{id, channelId, t, content}] */
const recent = new Map();
setInterval(() => {
  const limit = Date.now() - 30_000;
  for (const [k, list] of recent) {
    const kept = list.filter((e) => e.t > limit);
    if (kept.length) recent.set(k, kept);
    else recent.delete(k);
  }
}, 60_000).unref();

async function evaluate(msg, m) {
  const now = Date.now();
  const key = `${msg.guild.id}:${msg.author.id}`;
  const list = (recent.get(key) ?? []).filter((e) => now - e.t < 30_000);
  list.push({ id: msg.id, channelId: msg.channelId, t: now, content: msg.content });
  recent.set(key, list);

  const burst = list.filter((e) => now - e.t < m.spamSeconds * 1000);
  if (burst.length >= m.spamMessages) {
    return { category: 'spam', severity: 1, reason: `${burst.length} messaggi in ${m.spamSeconds}s`, purge: burst };
  }
  const dup = list.filter((e) => e.content && e.content === msg.content);
  if (msg.content.length > 5 && dup.length >= 3) {
    return { category: 'spam', severity: 1, reason: 'messaggio ripetuto più volte', purge: dup };
  }

  const mentions = msg.mentions.users.size + msg.mentions.roles.size;
  if (mentions >= m.maxMentions) {
    return { category: 'mass-mention', severity: 2, reason: `${mentions} menzioni in un messaggio` };
  }

  if (m.blockInvites && INVITE_RE.test(msg.content)) {
    return { category: 'invito', severity: 1, reason: 'invito ad altro server non autorizzato' };
  }

  const links = msg.content.match(URL_RE) ?? [];
  if (links.length >= m.maxLinks) {
    return { category: 'spam', severity: 1, reason: `troppi link (${links.length})` };
  }
  if (links.length) {
    const bad = await findMaliciousLink(links);
    if (bad) return { category: 'phishing', severity: 3, reason: bad };
  }

  if (m.ai) return aiClassify(msg.content, key);
  return null;
}

export async function handleMessage(msg) {
  if (msg.author.bot || !msg.guild || !msg.member || !msg.content) return;
  const g = getGuild(msg.guild.id);
  if (!g.mod.enabled) return;
  // staff e moderatori sono esenti
  if (msg.member.permissions.has(PermissionFlagsBits.ManageMessages)) return;

  const verdict = await evaluate(msg, g.mod);
  if (!verdict) return;
  await punish(msg, g, verdict);
}

async function punish(msg, g, verdict) {
  const m = g.mod;
  const userId = msg.author.id;

  await msg.delete().catch(() => {});
  if (verdict.purge) {
    const ids = verdict.purge.filter((e) => e.channelId === msg.channelId && e.id !== msg.id).map((e) => e.id);
    if (ids.length) await msg.channel.bulkDelete(ids, true).catch(() => {});
  }

  const s = m.strikes[userId] ?? { count: 0, last: 0 };
  if (Date.now() - s.last > STRIKE_WINDOW) s.count = 0;
  s.count += verdict.severity >= 3 ? 2 : 1;
  s.last = Date.now();
  m.strikes[userId] = s;
  save();

  const minutes = TIMEOUT_MINUTES[Math.min(s.count, TIMEOUT_MINUTES.length - 1)];
  let timedOut = false;
  if (minutes > 0 && msg.member.moderatable) {
    timedOut = await msg.member
      .timeout(minutes * 60_000, `Auto-moderazione: ${verdict.reason}`)
      .then(() => true)
      .catch(() => false);
  }

  const notice = await msg.channel
    .send({
      content:
        `⚠️ ${msg.author}, messaggio rimosso: **${verdict.reason}**. ` +
        `Strike ${s.count}${timedOut ? ` — mute di ${minutes} minuti` : ''}.`,
      allowedMentions: { users: [userId] },
    })
    .catch(() => null);
  if (notice) setTimeout(() => notice.delete().catch(() => {}), 10_000);

  await logToGuild(msg.guild, g, {
    title: `Auto-moderazione: ${verdict.category}`,
    color: verdict.severity >= 3 ? 0xed4245 : 0xfee75c,
    description:
      `**Utente:** ${msg.author} (${msg.author.tag})\n**Canale:** ${msg.channel}\n` +
      `**Motivo:** ${verdict.reason}\n**Strike:** ${s.count}` +
      (timedOut ? `\n**Sanzione:** timeout ${minutes} min` : '') +
      (s.count >= 5 ? '\n⚠️ Recidivo: valuta un ban manuale.' : ''),
    fields: [{ name: 'Messaggio', value: msg.content.slice(0, 900) || '—' }],
  });
}
