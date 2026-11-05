import { Client, GatewayIntentBits, Events } from 'discord.js';
import { cfg } from './config.js';
import { commands } from './commands/index.js';
import { handleMessage } from './moderation/moderation.js';
import { startWebServer, handleVerifyButton, onMemberJoin } from './verification/verification.js';
import { sendWelcome } from './welcome.js';
import { startNotifier } from './notifications/notifier.js';

if (!cfg.token) {
  console.error('Manca DISCORD_TOKEN nel file .env (copia .env.example in .env e compilalo).');
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers, // privileged: abilitalo nel Developer Portal
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent, // privileged: abilitalo nel Developer Portal
  ],
});

const byName = new Map(commands.map((c) => [c.data.name, c]));

client.once(Events.ClientReady, (c) => {
  console.log(`✅ Online come ${c.user.tag} in ${c.guilds.cache.size} server`);
  startNotifier(client);
});

client.on(Events.MessageCreate, (msg) => handleMessage(msg).catch((e) => console.error('[mod]', e)));
client.on(Events.GuildMemberAdd, (m) => {
  onMemberJoin(m).catch((e) => console.error('[join]', e));
  sendWelcome(m).catch((e) => console.error('[benvenuto]', e));
});

client.on(Events.InteractionCreate, async (i) => {
  try {
    if (i.isChatInputCommand()) {
      await byName.get(i.commandName)?.execute(i);
    } else if (i.isButton() && i.customId === 'verify:start') {
      await handleVerifyButton(i);
    }
  } catch (err) {
    console.error('[interaction]', err);
    const msg = { content: '❌ Si è verificato un errore.', ephemeral: true };
    if (i.deferred || i.replied) await i.editReply(msg).catch(() => {});
    else await i.reply(msg).catch(() => {});
  }
});

if (cfg.publicUrl) startWebServer(client);
else console.warn('[web] PUBLIC_URL non impostato: verifica e dashboard non vengono avviate.');

client.login(cfg.token);
