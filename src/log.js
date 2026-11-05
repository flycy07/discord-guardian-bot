import { EmbedBuilder } from 'discord.js';

/** Invia un embed nel canale di log del server (se configurato). */
export async function logToGuild(guild, settings, { title, description, color = 0x5865f2, fields = [] }) {
  const id = settings.mod.logChannel;
  if (!id) return;
  const channel = await guild.channels.fetch(id).catch(() => null);
  if (!channel?.isTextBased()) return;
  const embed = new EmbedBuilder()
    .setTitle(title)
    .setDescription(String(description).slice(0, 3500))
    .setColor(color)
    .setTimestamp();
  if (fields.length) embed.addFields(fields.map((f) => ({ ...f, value: String(f.value).slice(0, 1000) })));
  await channel.send({ embeds: [embed], allowedMentions: { parse: [] } }).catch(() => {});
}
