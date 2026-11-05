import { REST, Routes } from 'discord.js';
import { cfg } from './config.js';
import { commands } from './commands/index.js';

if (!cfg.token || !cfg.clientId) {
  console.error('Imposta DISCORD_TOKEN e CLIENT_ID nel file .env');
  process.exit(1);
}

const body = commands.map((c) => c.data.toJSON());
const rest = new REST().setToken(cfg.token);

const route = cfg.guildId
  ? Routes.applicationGuildCommands(cfg.clientId, cfg.guildId)
  : Routes.applicationCommands(cfg.clientId);

await rest.put(route, { body });
console.log(`✅ Registrati ${body.length} comandi ${cfg.guildId ? `nel server ${cfg.guildId}` : 'globali (possono impiegare fino a 1 ora)'}.`);
