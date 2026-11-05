import { SlashCommandBuilder, PermissionFlagsBits, ChannelType } from 'discord.js';
import crypto from 'node:crypto';
import { getGuild, save } from '../store.js';
import { platformReady, resolveTwitch, resolveYouTube, resolveX } from '../notifications/notifier.js';

const LABEL = { twitch: 'Twitch', youtube: 'YouTube', x: 'X' };

export const data = new SlashCommandBuilder()
  .setName('notifiche')
  .setDescription('Notifiche social: live Twitch, video YouTube, post su X')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .setDMPermission(false)
  .addSubcommand((s) =>
    s
      .setName('aggiungi')
      .setDescription('Segui un creator')
      .addStringOption((o) =>
        o
          .setName('piattaforma')
          .setDescription('Piattaforma')
          .setRequired(true)
          .addChoices({ name: 'Twitch', value: 'twitch' }, { name: 'YouTube', value: 'youtube' }, { name: 'X (Twitter)', value: 'x' }),
      )
      .addStringOption((o) => o.setName('creator').setDescription('Nome utente, @handle o link (YouTube: anche ID canale UC...)').setRequired(true))
      .addChannelOption((o) =>
        o.setName('canale').setDescription('Canale dove inviare gli avvisi').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement).setRequired(true),
      )
      .addRoleOption((o) => o.setName('ruolo').setDescription('Ruolo da menzionare'))
      .addStringOption((o) => o.setName('messaggio').setDescription('Testo personalizzato. Segnaposto: {nome} {url} {titolo}').setMaxLength(500)),
  )
  .addSubcommand((s) =>
    s
      .setName('rimuovi')
      .setDescription('Smetti di seguire un creator')
      .addStringOption((o) => o.setName('id').setDescription('ID mostrato da /notifiche lista').setRequired(true)),
  )
  .addSubcommand((s) => s.setName('lista').setDescription('Mostra i creator seguiti'));

export async function execute(i) {
  const g = getGuild(i.guildId);
  const subs = g.notify.subs;
  const sub = i.options.getSubcommand();

  if (sub === 'lista') {
    if (!subs.length) return i.reply({ content: 'Nessun creator seguito. Usa `/notifiche aggiungi`.', ephemeral: true });
    const lines = subs.map((s) => `\`${s.id}\` · **${LABEL[s.platform]}** ${s.display} → <#${s.channelId}>${s.roleId ? ` (<@&${s.roleId}>)` : ''}`);
    return i.reply({ content: lines.join('\n'), ephemeral: true, allowedMentions: { parse: [] } });
  }

  if (sub === 'rimuovi') {
    const id = i.options.getString('id').trim();
    const idx = subs.findIndex((s) => s.id === id);
    if (idx === -1) return i.reply({ content: 'ID non trovato. Controlla con `/notifiche lista`.', ephemeral: true });
    const [removed] = subs.splice(idx, 1);
    save();
    return i.reply({ content: `✅ Rimosso **${removed.display}** (${LABEL[removed.platform]}).`, ephemeral: true });
  }

  // aggiungi
  const platform = i.options.getString('piattaforma');
  if (!platformReady[platform]()) {
    const hint = platform === 'twitch'
      ? 'Imposta `TWITCH_CLIENT_ID` e `TWITCH_CLIENT_SECRET` nel `.env`.'
      : 'Imposta `X_BEARER_TOKEN` oppure `X_RSS_BASE` nel `.env`.';
    return i.reply({ content: `❌ ${LABEL[platform]} non è configurato. ${hint}`, ephemeral: true });
  }
  await i.deferReply({ ephemeral: true });

  const input = i.options.getString('creator');
  let resolved = null;
  try {
    resolved = platform === 'twitch' ? await resolveTwitch(input) : platform === 'youtube' ? await resolveYouTube(input) : await resolveX(input);
  } catch (err) {
    return i.editReply(`❌ Errore nel contattare ${LABEL[platform]}: ${err.message}`);
  }
  if (!resolved) {
    const extra = platform === 'youtube' ? ' Se usi l\'@handle e non funziona, incolla l\'ID canale (inizia con `UC`).' : '';
    return i.editReply(`❌ Creator non trovato su ${LABEL[platform]}.${extra}`);
  }

  if (subs.some((s) => s.platform === platform && s.ident === resolved.ident && s.channelId === i.options.getChannel('canale').id)) {
    return i.editReply('Questo creator è già seguito in quel canale.');
  }

  const entry = {
    id: crypto.randomBytes(3).toString('hex'),
    platform,
    ident: resolved.ident,
    display: resolved.display,
    channelId: i.options.getChannel('canale').id,
    roleId: i.options.getRole('ruolo')?.id ?? null,
    message: i.options.getString('messaggio') ?? null,
    state: {},
  };
  subs.push(entry);
  save();
  return i.editReply(`✅ Segui **${entry.display}** su ${LABEL[platform]} → <#${entry.channelId}>. ID: \`${entry.id}\`\nGli avvisi partono dai **prossimi** contenuti (live/video/post già esistenti non vengono notificati).`);
}
