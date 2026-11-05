import { SlashCommandBuilder, PermissionFlagsBits, ChannelType, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';
import { getGuild, save } from '../store.js';
import { cfg } from '../config.js';

export const data = new SlashCommandBuilder()
  .setName('verifica')
  .setDescription('Verifica dei nuovi membri tramite link esterno')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .setDMPermission(false)
  .addSubcommand((s) =>
    s
      .setName('setup')
      .setDescription('Attiva la verifica e pubblica il pannello')
      .addChannelOption((o) =>
        o.setName('canale').setDescription('Canale dove pubblicare il pannello').addChannelTypes(ChannelType.GuildText).setRequired(true),
      )
      .addRoleOption((o) => o.setName('ruolo-verificato').setDescription('Ruolo dato dopo la verifica').setRequired(true))
      .addRoleOption((o) => o.setName('ruolo-non-verificato').setDescription('Ruolo dato all\'ingresso e tolto dopo la verifica'))
      .addIntegerOption((o) => o.setName('eta-minima').setDescription('Età minima dell\'account in giorni (0 = nessun limite)').setMinValue(0).setMaxValue(365)),
  )
  .addSubcommand((s) => s.setName('disabilita').setDescription('Disattiva la verifica'));

export async function execute(i) {
  const g = getGuild(i.guildId);
  const sub = i.options.getSubcommand();

  if (sub === 'disabilita') {
    g.verify.enabled = false;
    save();
    return i.reply({ content: '✅ Verifica disattivata.', ephemeral: true });
  }

  const channel = i.options.getChannel('canale');
  const verified = i.options.getRole('ruolo-verificato');
  const unverified = i.options.getRole('ruolo-non-verificato');
  const minAge = i.options.getInteger('eta-minima') ?? 0;

  const botTop = i.guild.members.me.roles.highest.position;
  for (const role of [verified, unverified].filter(Boolean)) {
    if (role.managed || role.position >= botTop) {
      return i.reply({
        content: `❌ Non posso gestire il ruolo **${role.name}**: nelle impostazioni del server sposta il ruolo del bot **sopra** a questo ruolo.`,
        ephemeral: true,
      });
    }
  }

  g.verify = {
    enabled: true,
    channelId: channel.id,
    verifiedRole: verified.id,
    unverifiedRole: unverified?.id ?? null,
    minAccountAgeDays: minAge,
  };
  save();

  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle('✅ Verifica')
    .setDescription('Premi il pulsante per ricevere il tuo link personale di verifica. Aprilo, conferma di essere umano e otterrai l\'accesso al server.');
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('verify:start').setLabel('Verificami').setStyle(ButtonStyle.Success),
  );
  await channel.send({ embeds: [embed], components: [row] });

  const warnings = [];
  if (!cfg.publicUrl) warnings.push('⚠️ `PUBLIC_URL` non è impostato nelle variabili d\'ambiente: il link di verifica non funzionerà.');
  if (!cfg.turnstileSite || !cfg.turnstileSecret) warnings.push('ℹ️ Cloudflare Turnstile non configurato: la verifica è un semplice click, facilmente aggirabile dai bot.');
  return i.reply({ content: `✅ Verifica attiva, pannello pubblicato in ${channel}.\n${warnings.join('\n')}`, ephemeral: true });
}
