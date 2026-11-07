import { GROUP_COLORS, normalizeDomain, countTabs } from '../lib/core.js';

const $ = (id) => document.getElementById(id);
const COLOR_HEX = { grey: '#8a93a3', blue: '#3b82f6', red: '#ef4444', yellow: '#eab308', green: '#22c55e', pink: '#ec4899', purple: '#a855f7', cyan: '#06b6d4', orange: '#f97316' };
let settings = null;
let hasGroups = true;
let statusTimer = 0;

async function send(type, payload = {}) {
  const res = await chrome.runtime.sendMessage({ type, ...payload });
  if (!res?.ok) throw new Error(res?.error ?? 'No response');
  return res.result;
}

function el(tag, props = {}, ...children) {
  const e = document.createElement(tag);
  Object.assign(e, props);
  e.append(...children);
  return e;
}

function flash(target, text, ok = true) {
  const node = $(target);
  node.className = `small ${ok ? 'ok' : 'error'}`;
  node.textContent = text;
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => { node.textContent = ''; }, 3000);
}

async function save(patch) {
  try {
    settings = await send('saveSettings', { settings: { ...settings, ...patch } });
    renderSettings();
    flash('saveStatus', 'Saved');
  } catch (err) {
    flash('saveStatus', `Could not save: ${err.message}`, false);
  }
}

function renderSettings() {
  for (const id of ['duplicateBadge', 'ignoreHash', 'autoSuspend', 'autoGroupBySite', 'autosave']) $(id).checked = settings[id];
  $('duplicateOnOpen').value = settings.duplicateOnOpen;
  $('suspendAfterMinutes').value = String(settings.suspendAfterMinutes);
  $('autoGroupMin').value = String(settings.autoGroupMin);

  const never = $('neverList');
  never.replaceChildren();
  for (const d of settings.neverSuspend) {
    const rm = el('button', { type: 'button', textContent: '×', title: `Remove ${d}` });
    rm.setAttribute('aria-label', `Remove ${d}`);
    rm.addEventListener('click', () => save({ neverSuspend: settings.neverSuspend.filter((x) => x !== d) }));
    never.append(el('li', {}, d, rm));
  }

  const rules = $('ruleList');
  rules.replaceChildren();
  for (const r of settings.groupRules) {
    const dot = el('span', { className: 'dot' });
    dot.style.background = COLOR_HEX[r.color];
    const rm = el('button', { type: 'button', className: 'remove', textContent: '×', title: 'Remove rule' });
    rm.setAttribute('aria-label', `Remove rule for ${r.domain}`);
    rm.addEventListener('click', () => save({ groupRules: settings.groupRules.filter((x) => x.domain !== r.domain) }));
    rules.append(el('li', {}, dot, el('span', { className: 'd', textContent: `${r.domain} → ${r.title}` }), rm));
  }
}

function formatDate(ms) {
  return new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

async function renderSessions() {
  const sessions = await send('getSessions');
  const ul = $('sessionList');
  ul.replaceChildren();
  $('noSessions').hidden = sessions.length > 0;
  for (const s of sessions) {
    const n = countTabs(s);
    const name = el('span', { className: 'name', textContent: s.name });
    if (s.auto) name.append(el('span', { className: 'badge-auto', textContent: 'auto' }));
    const restore = el('button', { className: 'btn primary', type: 'button', textContent: 'Open' });
    restore.title = 'Open these tabs in new windows. Tabs load when you click them.';
    restore.addEventListener('click', async () => {
      restore.disabled = true;
      try {
        const opened = await send('restoreSession', { id: s.id });
        flash('sessionStatus', `Opened ${opened} tabs`);
      } catch (err) { flash('sessionStatus', err.message, false); } finally { restore.disabled = false; }
    });
    const rename = el('button', { className: 'btn', type: 'button', textContent: 'Rename' });
    rename.addEventListener('click', async () => {
      const next = prompt('Session name', s.name);
      if (next && next.trim()) { await send('renameSession', { id: s.id, name: next }); renderSessions(); }
    });
    const del = el('button', { className: 'btn danger', type: 'button', textContent: 'Delete' });
    del.addEventListener('click', async () => {
      if (!confirm(`Delete "${s.name}" (${n} tabs)? This can't be undone.`)) return;
      await send('deleteSession', { id: s.id });
      renderSessions();
    });
    const list = el('ul');
    for (const w of s.windows) {
      for (const t of w.tabs) {
        const a = el('a', { href: t.url, textContent: t.title || t.url, target: '_blank', rel: 'noopener' });
        list.append(el('li', {}, a));
      }
    }
    const details = el('details', {}, el('summary', { textContent: 'Show tabs' }), list);
    ul.append(el('li', { className: 'session' },
      el('div', { className: 'head' }, name, restore, rename, del),
      el('div', { className: 'meta', textContent: `${formatDate(s.created)} · ${n} tab${n === 1 ? '' : 's'} · ${s.windows.length} window${s.windows.length === 1 ? '' : 's'}` }),
      details));
  }
}

// ------------------------------------------------------------- wiring -----

for (const id of ['duplicateBadge', 'ignoreHash', 'autoSuspend', 'autoGroupBySite', 'autosave']) {
  $(id).addEventListener('change', (e) => save({ [id]: e.target.checked }));
}
$('duplicateOnOpen').addEventListener('change', (e) => save({ duplicateOnOpen: e.target.value }));
$('suspendAfterMinutes').addEventListener('change', (e) => save({ suspendAfterMinutes: Number(e.target.value) }));
$('autoGroupMin').addEventListener('change', (e) => save({ autoGroupMin: Number(e.target.value) }));

$('neverForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const d = normalizeDomain($('neverInput').value);
  if (!d) { flash('saveStatus', 'Enter a site such as mail.example.com', false); return; }
  $('neverInput').value = '';
  save({ neverSuspend: [...settings.neverSuspend, d] });
});

for (const c of GROUP_COLORS) $('ruleColor').append(el('option', { value: c, textContent: c }));
$('ruleColor').value = 'blue';
$('ruleForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const domain = normalizeDomain($('ruleDomain').value);
  const err = $('ruleError');
  if (!domain) { err.textContent = 'Enter a site such as github.com'; err.hidden = false; return; }
  err.hidden = true;
  const title = $('ruleTitle').value.trim() || domain;
  $('ruleDomain').value = '';
  $('ruleTitle').value = '';
  save({ groupRules: [...settings.groupRules.filter((r) => r.domain !== domain), { domain, title, color: $('ruleColor').value }] });
});

$('saveAll').addEventListener('click', async () => {
  try {
    const r = await send('saveSession', { name: '' });
    flash('sessionStatus', `Saved ${r.tabs} tabs`);
    renderSessions();
  } catch (err) { flash('sessionStatus', err.message, false); }
});

$('exportSessions').addEventListener('click', async () => {
  const sessions = await send('getSessions');
  const blob = new Blob([JSON.stringify({ app: 'Tabwise', exportedAt: new Date().toISOString(), sessions }, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: `tabwise-sessions-${new Date().toISOString().slice(0, 10)}.json` });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

$('importFile').addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (!file) return;
  try {
    if (file.size > 20_000_000) throw new Error('File is too large');
    const data = JSON.parse(await file.text());
    const n = await send('importSessions', { sessions: Array.isArray(data) ? data : data.sessions });
    flash('sessionStatus', n ? `Imported ${n} session${n === 1 ? '' : 's'}` : 'No new sessions found in that file');
    renderSessions();
  } catch (err) {
    flash('sessionStatus', `Import failed: ${err.message}`, false);
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.sessions) renderSessions();
});

(async () => {
  $('versionLine').textContent = `Version ${chrome.runtime.getManifest().version}`;
  const st = await send('getState');
  settings = st.settings;
  hasGroups = st.hasGroups;
  if (!hasGroups) {
    for (const id of ['autoGroupBySite', 'ruleDomain', 'ruleTitle', 'ruleColor']) $(id).disabled = true;
    $('noGroups').hidden = false;
  }
  renderSettings();
  renderSessions();
})();
