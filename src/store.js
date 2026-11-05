import fs from 'node:fs';
import path from 'node:path';
import { cfg } from './config.js';

const FILE = path.resolve(cfg.dataDir, 'db.json');

const DEFAULTS = () => ({
  mod: {
    enabled: true,
    ai: true,
    logChannel: null,
    maxMentions: 5,
    spamMessages: 5,
    spamSeconds: 6,
    maxLinks: 4,
    blockInvites: true,
    strikes: {},
  },
  verify: {
    enabled: false,
    channelId: null,
    verifiedRole: null,
    unverifiedRole: null,
    minAccountAgeDays: 0,
  },
  notify: { subs: [] },
  welcome: {
    enabled: false,
    channelId: null,
    content: 'Benvenuto {utente} su **{server}**! 🎉',
    embed: {
      enabled: true,
      title: 'Benvenuto!',
      description: 'Sei il membro numero {membri}. Leggi le regole e divertiti!',
      color: '#5865f2',
      image: '',
      thumbnailAvatar: true,
      footer: '',
    },
  },
});

let db = { guilds: {} };
try {
  db = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  if (!db.guilds) db.guilds = {};
} catch {
  /* primo avvio: db vuoto */
}

function fill(target, defaults) {
  for (const [k, v] of Object.entries(defaults)) {
    if (!(k in target)) target[k] = v;
    else if (v && typeof v === 'object' && !Array.isArray(v)) fill(target[k], v);
  }
  return target;
}

let timer = null;
export function save() {
  clearTimeout(timer);
  timer = setTimeout(flush, 300);
}

export function flush() {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE + '.tmp', JSON.stringify(db, null, 2));
  fs.renameSync(FILE + '.tmp', FILE);
}

export function getGuild(id) {
  if (!db.guilds[id]) db.guilds[id] = DEFAULTS();
  return fill(db.guilds[id], DEFAULTS());
}

export function allGuilds() {
  return Object.entries(db.guilds).map(([id]) => [id, getGuild(id)]);
}

process.on('SIGINT', () => { flush(); process.exit(0); });
process.on('SIGTERM', () => { flush(); process.exit(0); });
