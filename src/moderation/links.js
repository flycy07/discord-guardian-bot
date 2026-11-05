import { cfg } from '../config.js';

const OFFICIAL = [
  'discord.com', 'discord.gg', 'discordapp.com', 'discordapp.net', 'discord.media', 'discordstatus.com',
  'steamcommunity.com', 'steampowered.com',
];

const isOfficial = (host) => OFFICIAL.some((d) => host === d || host.endsWith('.' + d));

/** Euristica per domini che imitano Discord/Steam (phishing "nitro gratis"). */
function looksLikePhishing(host) {
  if (isOfficial(host)) return false;
  const lookalike = /d[i1l]sc[o0]rd|dlscord|discorcl|st[e3]{2}mcomm?un[i1]ty|steamcommun[i1]ty/;
  const bait = /(discord|steam).*(nitro|gift|free|promo|airdrop)|(nitro|gift|airdrop).*(discord|steam)/;
  return lookalike.test(host) || bait.test(host);
}

/** @returns {Promise<string|null>} motivo se almeno un link è sospetto. */
export async function findMaliciousLink(urls) {
  const parsed = [];
  for (const u of urls) {
    try {
      parsed.push(new URL(u));
    } catch {
      /* ignora URL non validi */
    }
  }
  for (const url of parsed) {
    if (looksLikePhishing(url.hostname.toLowerCase())) return `dominio sospetto (${url.hostname})`;
  }

  if (cfg.safeBrowsingKey && parsed.length) {
    try {
      const res = await fetch(
        `https://safebrowsing.googleapis.com/v4/threatMatches:find?key=${cfg.safeBrowsingKey}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            client: { clientId: 'discord-guardian-bot', clientVersion: '1.0.0' },
            threatInfo: {
              threatTypes: ['MALWARE', 'SOCIAL_ENGINEERING', 'UNWANTED_SOFTWARE'],
              platformTypes: ['ANY_PLATFORM'],
              threatEntryTypes: ['URL'],
              threatEntries: parsed.slice(0, 10).map((u) => ({ url: u.href })),
            },
          }),
          signal: AbortSignal.timeout(5000),
        },
      );
      const data = await res.json();
      if (data.matches?.length) return `link segnalato da Google Safe Browsing (${data.matches[0].threatType})`;
    } catch (err) {
      console.warn('[SafeBrowsing] errore:', err.message);
    }
  }
  return null;
}
