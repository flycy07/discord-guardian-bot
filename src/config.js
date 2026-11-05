import 'dotenv/config';

const e = process.env;

export const cfg = {
  token: e.DISCORD_TOKEN,
  clientId: e.CLIENT_ID,
  guildId: e.GUILD_ID || null,

  anthropicKey: e.ANTHROPIC_API_KEY || null,
  aiModel: e.AI_MODEL || 'claude-haiku-5-5',
  safeBrowsingKey: e.SAFE_BROWSING_API_KEY || null,

  publicUrl: (e.PUBLIC_URL || '').replace(/\/+$/, ''),
  clientSecret: e.DISCORD_CLIENT_SECRET || null, // per il login della dashboard
  port: Number(e.PORT) || 3000,
  turnstileSite: e.TURNSTILE_SITE_KEY || null,
  turnstileSecret: e.TURNSTILE_SECRET || null,

  twitchId: e.TWITCH_CLIENT_ID || null,
  twitchSecret: e.TWITCH_CLIENT_SECRET || null,
  xBearer: e.X_BEARER_TOKEN || null,
  xRssBase: (e.X_RSS_BASE || '').replace(/\/+$/, '') || null,
  pollSeconds: Math.max(30, Number(e.POLL_SECONDS) || 120),

  dataDir: e.DATA_DIR || 'data',
};
