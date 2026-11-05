const $ = (id) => document.getElementById(id);
let guildId = null;
let me = null;

/* ---------- utilità ---------- */
async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch('/dashboard/api' + path, {
    method,
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'dashboard' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `Errore ${res.status}`), { status: res.status });
  return data;
}

let toastTimer;
function toast(msg, isErr = false) {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'show' + (isErr ? ' err' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = ''), 3500);
}

const fillSelect = (sel, items, selected) => {
  sel.replaceChildren(
    ...items.map((i) => Object.assign(document.createElement('option'), { value: i.id, textContent: i.name, selected: i.id === selected })),
  );
};

/* ---------- anteprima in stile Discord (solo textContent: niente HTML iniettato) ---------- */
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};
const isHttps = (u) => /^https:\/\/\S+$/i.test(u || '');

function renderMessage(target, { content, embed }, subst = (s) => s) {
  target.replaceChildren();
  if (content) {
    const c = el('div', 'content');
    const parts = subst(content).split(/(@NuovoMembro|@everyone|@here|@[\w ]+?(?=\s|$))/);
    parts.forEach((p) => (p.startsWith('@') ? c.append(el('span', 'mention', p)) : c.append(p)));
    target.append(c);
  }
  if (embed) {
    const e = el('div', 'embed');
    e.style.borderLeftColor = embed.color || '#5865f2';
    if (embed.authorName) e.append(el('div', 'author', subst(embed.authorName)));
    if (embed.title) e.append(el('div', 'title', subst(embed.title)));
    if (embed.description) e.append(el('div', 'desc', subst(embed.description)));
    if (embed.fields?.length) {
      const f = el('div', 'fields');
      embed.fields.forEach((x) => {
        const d = el('div', 'f' + (x.inline ? ' inline' : ''));
        d.append(el('b', '', x.name), el('span', '', x.value));
        f.append(d);
      });
      e.append(f);
    }
    if (isHttps(embed.thumbnail)) Object.assign(e.appendChild(el('img', 'thumb')), { src: embed.thumbnail, alt: '' });
    if (isHttps(embed.image)) Object.assign(e.appendChild(el('img', 'big')), { src: embed.image, alt: '' });
    if (embed.footer) e.append(el('div', 'footer', subst(embed.footer)));
    target.append(e);
  }
  if (!content && !embed) target.append(el('span', 'muted', 'Il messaggio è vuoto.'));
}

/* ---------- benvenuto ---------- */
const sampleName = () => me?.username || 'NuovoMembro';
const welcomeSubst = (s) =>
  s.replaceAll('{utente}', '@NuovoMembro').replaceAll('{nome}', sampleName()).replaceAll('{server}', $('guild').selectedOptions[0]?.textContent || 'Server').replaceAll('{membri}', '128');

function collectWelcome() {
  return {
    enabled: $('w-enabled').checked,
    channelId: $('w-channel').value,
    content: $('w-content').value,
    embed: {
      enabled: $('w-embed-enabled').checked,
      title: $('w-title').value,
      description: $('w-description').value,
      color: $('w-color').value,
      image: $('w-image').value,
      thumbnailAvatar: $('w-avatar').checked,
      footer: $('w-footer').value,
    },
  };
}

function updateWelcomePreview() {
  const w = collectWelcome();
  $('w-embed-box').hidden = !w.embed.enabled;
  const embed = w.embed.enabled && (w.embed.title || w.embed.description || w.embed.image)
    ? { ...w.embed, thumbnail: w.embed.thumbnailAvatar ? 'https://cdn.discordapp.com/embed/avatars/0.png' : '' }
    : null;
  renderMessage($('w-preview'), { content: w.content, embed }, welcomeSubst);
}

function fillWelcome(w) {
  $('w-enabled').checked = w.enabled;
  $('w-channel').value = w.channelId || $('w-channel').value;
  $('w-content').value = w.content;
  $('w-embed-enabled').checked = w.embed.enabled;
  $('w-title').value = w.embed.title;
  $('w-description').value = w.embed.description;
  $('w-color').value = w.embed.color;
  $('w-avatar').checked = w.embed.thumbnailAvatar;
  $('w-image').value = w.embed.image;
  $('w-footer').value = w.embed.footer;
  updateWelcomePreview();
}

/* ---------- annunci ---------- */
function addFieldRow(f = {}) {
  if (document.querySelectorAll('#a-fields .field-row').length >= 5) return toast('Massimo 5 campi', true);
  const row = el('div', 'field-row');
  const name = Object.assign(el('input'), { placeholder: 'Nome', maxLength: 100, value: f.name || '' });
  const value = Object.assign(el('input'), { placeholder: 'Valore', maxLength: 300, value: f.value || '' });
  const inline = Object.assign(el('input'), { type: 'checkbox', checked: Boolean(f.inline), title: 'Affiancato' });
  const del = Object.assign(el('button', 'btn small', '✕'), { type: 'button' });
  del.addEventListener('click', () => { row.remove(); updateAnnouncePreview(); });
  row.append(name, value, inline, del);
  $('a-fields').append(row);
}

function collectAnnounce() {
  return {
    channelId: $('a-channel').value,
    mention: $('a-mention').value,
    content: $('a-content').value,
    embed: {
      title: $('a-title').value,
      url: $('a-url').value,
      description: $('a-description').value,
      color: $('a-color').value,
      authorName: $('a-author').value,
      image: $('a-image').value,
      thumbnail: $('a-thumbnail').value,
      footer: $('a-footer').value,
      fields: [...document.querySelectorAll('#a-fields .field-row')].map((r) => {
        const [n, v, i] = r.querySelectorAll('input');
        return { name: n.value, value: v.value, inline: i.checked };
      }).filter((f) => f.name && f.value),
    },
  };
}

function updateAnnouncePreview() {
  const a = collectAnnounce();
  const e = a.embed;
  const has = e.title || e.description || e.image || e.fields.length;
  const sel = $('a-mention').selectedOptions[0];
  const prefix = a.mention === 'none' ? '' : a.mention === 'everyone' || a.mention === 'here' ? `@${a.mention} ` : `@${sel.textContent} `;
  renderMessage($('a-preview'), { content: (prefix + a.content).trim(), embed: has ? e : null });
}

/* ---------- caricamento ---------- */
async function loadGuild(id) {
  guildId = id;
  const g = await api(`/guilds/${id}`);
  fillSelect($('w-channel'), g.channels, g.welcome.channelId);
  fillSelect($('a-channel'), g.channels);
  const mention = $('a-mention');
  mention.replaceChildren(
    ...[{ id: 'none', name: 'Nessuno' }, { id: 'everyone', name: '@everyone' }, { id: 'here', name: '@here' }, ...g.roles.map((r) => ({ id: `role:${r.id}`, name: r.name }))]
      .map((i) => Object.assign(document.createElement('option'), { value: i.id, textContent: i.name })),
  );
  fillWelcome(g.welcome);
  $('a-color').value = '#5865f2';
  updateAnnouncePreview();
}

async function init() {
  try {
    me = (await api('/me')).user;
  } catch {
    $('login').hidden = false;
    return;
  }
  const u = $('user');
  u.hidden = false;
  if (me.avatarUrl) Object.assign(u.appendChild(el('img')), { src: me.avatarUrl, alt: '' });
  u.append(me.username);

  const { guilds } = await api('/guilds');
  if (!guilds.length) { $('empty').hidden = false; return; }
  fillSelect($('guild'), guilds);
  $('app').hidden = false;
  await loadGuild(guilds[0].id);
}

/* ---------- eventi ---------- */
document.querySelectorAll('.bar nav button').forEach((b) =>
  b.addEventListener('click', () => {
    document.querySelectorAll('.bar nav button').forEach((x) => x.classList.toggle('active', x === b));
    $('tab-welcome').hidden = b.dataset.tab !== 'welcome';
    $('tab-announce').hidden = b.dataset.tab !== 'announce';
  }),
);

$('guild').addEventListener('change', (e) => loadGuild(e.target.value).catch((err) => toast(err.message, true)));
$('welcome-form').addEventListener('input', updateWelcomePreview);
$('announce-form').addEventListener('input', updateAnnouncePreview);
$('a-add-field').addEventListener('click', () => addFieldRow());

$('welcome-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api(`/guilds/${guildId}/welcome`, { method: 'PUT', body: collectWelcome() });
    toast('Impostazioni salvate ✅');
  } catch (err) { toast(err.message, true); }
});

$('w-test').addEventListener('click', async () => {
  try {
    await api(`/guilds/${guildId}/welcome/test`, { method: 'POST', body: collectWelcome() });
    toast('Anteprima inviata nel canale ✅');
  } catch (err) { toast(err.message, true); }
});

$('announce-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = e.submitter;
  btn.disabled = true;
  try {
    await api(`/guilds/${guildId}/announce`, { method: 'POST', body: collectAnnounce() });
    toast('Annuncio inviato ✅');
  } catch (err) { toast(err.message, true); }
  btn.disabled = false;
});

init().catch((err) => toast(err.message, true));
