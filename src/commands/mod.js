import { SlashCommandBuilder, PermissionFlagsBits, ChannelType } from 'discord.js';
import { getGuild, save } from '../store.js';
import { logToGuild } from '../log.js';

export const data = new SlashCommandBuilder()
  .setName('mod')
  .setDescription('Gestione della moderazione automatica')
  .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
  .setDMPermission(false)
  .addSubcommand((s) =>
    s
      .setName('config')
      .setDescription('Modifica le impostazioni di moderazione')
      .addBooleanOption((o) => o.setName('attivo').setDescription('Attiva/disattiva la moderazione automatica'))
      .addBooleanOption((o) => o.setName('ai').setDescription('Attiva/disattiva il controllo AI dei messaggi'))
      .addChannelOption((o) =>
        o.setName('log').setDescription('Canale dei log di moderazione').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
      )
      .addIntegerOption((o) => o.setName('max-menzioni').setDescription('Menzioni massime per messaggio').setMinValue(2).setMaxValue(50))
      .addIntegerOption((o) => o.setName('spam-messaggi').setDescription('Messaggi che fanno scattare l\'anti-flood').setMinValue(3).setMaxValue(30))
      .addIntegerOption((o) => o.setName('spam-secondi').setDescription('Finestra di tempo per l\'anti-flood (secondi)').setMinValue(2).setMaxValue(60))
      .addIntegerOption((o) => o.setName('max-link').setDescription('Link massimi per messaggio').setMinValue(1).setMaxValue(20))
      .addBooleanOption((o) => o.setName('blocca-inviti').setDescription('Blocca gli inviti ad altri server')),
  )
  .addSubcommand((s) => s.setName('stato').setDescription('Mostra le impostazioni attuali'))
  .addSubcommand((s) =>
    s
      .setName('strikes')
      .setDescription('Mostra gli strike di un utente')
      .addUserOption((o) => o.setName('utente').setDescription('Utente').setRequired(true)),
  )
  .addSubcommand((s) =>
    s
      .setName('azzera')
      .setDescription('Azzera gli strike di un utente')
      .addUserOption((o) => o.setName('utente').setDescription('Utente').setRequired(true)),
  )
  .addSubcommand((s) =>
    s
      .setName('mute')
      .setDescription('Metti in timeout un utente')
      .addUserOption((o) => o.setName('utente').setDescription('Utente').setRequired(true))
      .addIntegerOption((o) => o.setName('minuti').setDescription('Durata in minuti').setRequired(true).setMinValue(1).setMaxValue(40320))
      .addStringOption((o) => o.setName('motivo').setDescription('Motivo').setMaxLength(200)),
  )
  .addSubcommand((s) =>
    s
      .setName('unmute')
      .setDescription('Rimuovi il timeout a un utente')
      .addUserOption((o) => o.setName('utente').setDescription('Utente').setRequired(true)),
  );

export async function execute(i) {
  const g = getGuild(i.guildId);
  const m = g.mod;
  const sub = i.options.getSubcommand();

  if (sub === 'config') {
    const map = {
      attivo: 'enabled', ai: 'ai', 'max-menzioni': 'maxMentions', 'spam-messaggi': 'spamMessages',
      'spam-secondi': 'spamSeconds', 'max-link': 'maxLinks', 'blocca-inviti': 'blockInvites',
    };
    let changed = 0;
    for (const [opt, key] of Object.entries(map)) {
      const v = i.options.get(opt)?.value;
      if (v !== undefined) { m[key] = v; changed++; }
    }
    const log = i.options.getChannel('log');
    if (log) { m.logChannel = log.id; changed++; }
    save();
    return i.reply({ content: changed ? `✅ ${changed} impostazion${changed === 1 ? 'e aggiornata' : 'i aggiornate'}.` : 'Nessuna modifica: specifica almeno un\'opzione.', ephemeral: true });
  }

  if (sub === 'stato') {
    return i.reply({
      ephemeral: true,
      content:
        `**Moderazione automatica:** ${m.enabled ? 'attiva' : 'disattivata'}\n` +
        `**Controllo AI:** ${m.ai ? 'attivo' : 'disattivato'}\n` +
        `**Canale log:** ${m.logChannel ? `<#${m.logChannel}>` : 'non impostato'}\n` +
        `**Anti-flood:** ${m.spamMessages} messaggi in ${m.spamSeconds}s\n` +
        `**Max menzioni:** ${m.maxMentions} · **Max link:** ${m.maxLinks}\n` +
        `**Blocco inviti:** ${m.blockInvites ? 'sì' : 'no'}`,
    });
  }

  const user = i.options.getUser('utente');

  if (sub === 'strikes') {
    const s = m.strikes[user.id];
    return i.reply({ content: s ? `${user} ha **${s.count}** strike (ultimo <t:${Math.floor(s.last / 1000)}:R>).` : `${user} non ha strike.`, ephemeral: true, allowedMentions: { parse: [] } });
  }

  if (sub === 'azzera') {
    delete m.strikes[user.id];
    save();
    return i.reply({ content: `✅ Strike di ${user} azzerati.`, ephemeral: true, allowedMentions: { parse: [] } });
  }

  const member = await i.guild.members.fetch(user.id).catch(() => null);
  if (!member) return i.reply({ content: 'Utente non presente nel server.', ephemeral: true });
  if (!member.moderatable) return i.reply({ content: 'Non posso moderare questo utente (ruolo più alto del mio o permessi mancanti).', ephemeral: true });

  if (sub === 'mute') {
    const minutes = i.options.getInteger('minuti');
    const reason = i.options.getString('motivo') ?? 'Nessun motivo';
    await member.timeout(minutes * 60_000, `${i.user.tag}: ${reason}`);
    await logToGuild(i.guild, g, { title: 'Mute manuale', color: 0xfee75c, description: `${member} per ${minutes} min da ${i.user}.\n**Motivo:** ${reason}` });
    return i.reply({ content: `🔇 ${member} in timeout per ${minutes} minuti.`, ephemeral: true, allowedMentions: { parse: [] } });
  }

  if (sub === 'unmute') {
    await member.timeout(null, `Rimosso da ${i.user.tag}`);
    await logToGuild(i.guild, g, { title: 'Unmute', color: 0x57f287, description: `${member} da ${i.user}.` });
    return i.reply({ content: `🔊 Timeout rimosso a ${member}.`, ephemeral: true, allowedMentions: { parse: [] } });
  }
}
