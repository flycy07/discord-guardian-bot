import { EmbedBuilder } from 'discord.js';
import { getGuild } from './store.js';

const HEX = /^#?[0-9a-f]{6}$/i;
const HTTPS = /^https:\/\/[^\s]+$/i;

export const clip = (s, n) => String(s ?? '').trim().slice(0, n);
export const cleanUrl = (u) => (HTTPS.test(String(u ?? '').trim()) ? String(u).trim().slice(0, 500) : '');
export const cleanColor = (c) => (HEX.test(String(c ?? '')) ? '#' + String(c).replace('#', '').toLowerCase() : '#5865f2');

/** Sostituisce i segnaposto: {utente} {nome} {server} {membri} */
export function fillTemplate(text, member) {
  return String(text ?? '')
    .replaceAll('{utente}', `<@${member.id}>`)
    .replaceAll('{nome}', member.user.username)
    .replaceAll('{server}', member.guild.name)
    .replaceAll('{membri}', String(member.guild.memberCount));
}

/** Pulisce e limita i dati ricevuti dalla dashboard. */
export function sanitizeWelcome(input = {}) {
  const e = input.embed ?? {};
  return {
    enabled: Boolean(input.enabled),
    channelId: input.channelId ? String(input.channelId).slice(0, 25) : null,
    content: clip(input.content, 1800),
    embed: {
      enabled: Boolean(e.enabled),
      title: clip(e.title, 256),
      description: clip(e.description, 3000),
      color: cleanColor(e.color),
      image: cleanUrl(e.image),
      thumbnailAvatar: Boolean(e.thumbnailAvatar),
      footer: clip(e.footer, 200),
    },
  };
}

export function buildWelcomeMessage(member, w) {
  const content = fillTemplate(w.content, member) || undefined;
  const embeds = [];
  const e = w.embed;
  if (e.enabled && (e.title || e.description || e.image)) {
    const eb = new EmbedBuilder().setColor(e.color);
    if (e.title) eb.setTitle(fillTemplate(e.title, member));
    if (e.description) eb.setDescription(fillTemplate(e.description, member));
    if (e.image) eb.setImage(e.image);
    if (e.thumbnailAvatar) eb.setThumbnail(member.displayAvatarURL({ size: 256 }));
    if (e.footer) eb.setFooter({ text: fillTemplate(e.footer, member) });
    embeds.push(eb);
  }
  return { content, embeds, allowedMentions: { users: [member.id] } };
}

export async function sendWelcome(member) {
  if (member.user.bot) return;
  const w = getGuild(member.guild.id).welcome;
  if (!w.enabled || !w.channelId) return;
  const channel = await member.guild.channels.fetch(w.channelId).catch(() => null);
  if (!channel?.isTextBased()) return;
  const msg = buildWelcomeMessage(member, w);
  if (!msg.content && !msg.embeds.length) return;
  await channel.send(msg);
}
