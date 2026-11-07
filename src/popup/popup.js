import { searchTabs, findDuplicates } from '../lib/core.js';

const $ = (id) => document.getElementById(id);
const IS_CHROMIUM = typeof browser === 'undefined';

async function send(type, payload = {}) {
  const res = await chrome.runtime.sendMessage({ type, ...payload });
  if (!res?.ok) throw new Error(res?.error ?? 'No response');
  return res.result;
}

let state = null;
let tabs = [];
let windowsOrder = [];
let currentWindowId = null;
let currentTabId = null;
let results = [];
let selected = 0;
let dupIds = new Set();

function favicon(tab) {
  if (IS_CHROMIUM && tab.url && /^https?:/.test(tab.url)) {
    const img = document.createElement('img');
    // Served from the browser's local favicon cache: no network request.
    img.src = `${chrome.runtime.getURL('/_favicon/')}?pageUrl=${encodeURIComponent(tab.url)}&size=32`;
    img.alt = '';
    return img;
  }
  if (tab.favIconUrl && tab.favIconUrl.startsWith('data:')) {
    const img = document.createElement('img');
    img.src = tab.favIconUrl;
    img.alt = '';
    return img;
  }
  const ph = document.createElement('span');
  ph.className = 'ph';
  ph.textContent = (tab.title || '?').trim().charAt(0).toUpperCase();
  return ph;
}

function displayUrl(url) {
  try {
    const u = new URL(url);
    return (u.hostname.replace(/^www\./, '') + u.pathname + u.search).replace(/\/$/, '') || url;
  } catch {
    return url || '';
  }
}

function summary() {
  const suspended = tabs.filter((t) => t.discarded).length;
  const parts = [`${tabs.length} tab${tabs.length === 1 ? '' : 's'}`];
  if (windowsOrder.length > 1) parts.push(`${windowsOrder.length} windows`);
  if (suspended) parts.push(`${suspended} suspended`);
  if (dupIds.size) parts.push(`${dupIds.size} duplicate${dupIds.size === 1 ? '' : 's'}`);
  $('summary').textContent = parts.join(' · ');
  $('dupBtn').textContent = dupIds.size ? `Close ${dupIds.size} duplicate${dupIds.size === 1 ? '' : 's'}` : 'No duplicates';
  $('dupBtn').disabled = !dupIds.size;
  $('groupBtn').hidden = !state.hasGroups;
  $('q').placeholder = `Search ${tabs.length} tabs…`;
}

function render() {
  const q = $('q').value.trim();
  const list = $('list');
  list.replaceChildren();
  if (q) {
    results = searchTabs(tabs, q).map((r) => r.tab);
  } else {
    // Current window first, in tab order, then the other windows.
    results = [...tabs].sort((a, b) => (windowsOrder.indexOf(a.windowId) - windowsOrder.indexOf(b.windowId)) || (a.index - b.index));
  }
  if (!results.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = q ? 'No tabs match.' : 'No tabs.';
    list.append(li);
    return;
  }
  selected = Math.min(selected, results.length - 1);
  let lastWindow = null;
  results.forEach((tab, i) => {
    if (!q && windowsOrder.length > 1 && tab.windowId !== lastWindow) {
      lastWindow = tab.windowId;
      const h = document.createElement('li');
      h.className = 'win';
      h.setAttribute('role', 'presentation');
      h.textContent = tab.windowId === currentWindowId ? 'This window' : `Window ${windowsOrder.indexOf(tab.windowId) + 1}`;
      list.append(h);
    }
    const li = document.createElement('li');
    li.className = 'tab';
    if (tab.id === currentTabId) li.classList.add('current');
    if (tab.discarded) li.classList.add('discarded');
    li.setAttribute('role', 'option');
    li.setAttribute('aria-selected', String(i === selected));
    li.dataset.index = String(i);
    const text = document.createElement('div');
    text.className = 'text';
    const title = document.createElement('div');
    title.className = 'title';
    title.textContent = tab.title || displayUrl(tab.url);
    const url = document.createElement('div');
    url.className = 'url';
    url.textContent = displayUrl(tab.url || tab.pendingUrl);
    text.append(title, url);
    li.append(favicon(tab), text);
    const tags = [];
    if (dupIds.has(tab.id)) tags.push(['duplicate', 'dup']);
    if (tab.pinned) tags.push(['pinned', '']);
    if (tab.audible) tags.push(['playing', '']);
    if (tab.discarded) tags.push(['suspended', '']);
    for (const [label, cls] of tags) {
      const s = document.createElement('span');
      s.className = `tag ${cls}`;
      s.textContent = label;
      li.append(s);
    }
    const close = document.createElement('button');
    close.className = 'close';
    close.textContent = '×';
    close.title = 'Close tab';
    close.setAttribute('aria-label', `Close ${tab.title || 'tab'}`);
    close.addEventListener('click', (e) => { e.stopPropagation(); closeTab(tab.id); });
    li.append(close);
    li.addEventListener('click', () => openTab(tab));
    list.append(li);
  });
  list.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
}

async function load() {
  const [win] = await Promise.all([chrome.windows.getCurrent()]);
  currentWindowId = win.id;
  tabs = await chrome.tabs.query({});
  currentTabId = tabs.find((t) => t.active && t.windowId === currentWindowId)?.id ?? null;
  const ids = [...new Set(tabs.map((t) => t.windowId))];
  windowsOrder = [currentWindowId, ...ids.filter((id) => id !== currentWindowId)];
  state = await send('getState');
  dupIds = new Set(findDuplicates(tabs, { ignoreHash: state.settings.ignoreHash }).close);
  summary();
  render();
}

async function openTab(tab) {
  await chrome.tabs.update(tab.id, { active: true });
  if (tab.windowId !== currentWindowId) await chrome.windows.update(tab.windowId, { focused: true });
  window.close();
}

async function closeTab(id) {
  await chrome.tabs.remove(id);
  await load();
}

async function action(btn, type, payload, done) {
  btn.disabled = true;
  try {
    const n = await send(type, payload);
    await load();
    $('summary').textContent = done(n);
  } catch (err) {
    $('summary').textContent = err.message;
  } finally {
    btn.disabled = false;
    setTimeout(summary, 2500); // back to the tab counts after showing the result
  }
}

$('q').addEventListener('input', () => { selected = 0; render(); });
$('q').addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') { selected = Math.min(selected + 1, results.length - 1); render(); e.preventDefault(); }
  else if (e.key === 'ArrowUp') { selected = Math.max(selected - 1, 0); render(); e.preventDefault(); }
  else if (e.key === 'Enter' && results[selected]) { openTab(results[selected]); e.preventDefault(); }
  else if ((e.key === 'Delete' || (e.key === 'Backspace' && (e.ctrlKey || e.metaKey))) && results[selected]) {
    closeTab(results[selected].id);
    e.preventDefault();
  }
});

$('dupBtn').addEventListener('click', (e) => action(e.currentTarget, 'closeDuplicates', {}, (n) => `Closed ${n} duplicate tab${n === 1 ? '' : 's'}`));
$('groupBtn').addEventListener('click', (e) => action(e.currentTarget, 'groupWindow', { windowId: currentWindowId }, (n) => (n ? `Created or updated ${n} group${n === 1 ? '' : 's'}` : 'Nothing to group (needs 2+ tabs from a site)')));
$('suspendBtn').addEventListener('click', (e) => action(e.currentTarget, 'suspendOthers', { windowId: currentWindowId }, (n) => `Suspended ${n} tab${n === 1 ? '' : 's'}`));
$('saveBtn').addEventListener('click', () => { $('saveForm').hidden = false; $('sessionName').focus(); });
$('saveCancel').addEventListener('click', () => { $('saveForm').hidden = true; $('q').focus(); });
$('saveForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const r = await send('saveSession', { name: $('sessionName').value, windowId: currentWindowId });
    $('saveForm').hidden = true;
    $('sessionName').value = '';
    $('summary').textContent = `Saved ${r.tabs} tab${r.tabs === 1 ? '' : 's'}. Find it under Sessions.`;
  } catch (err) {
    $('summary').textContent = err.message;
  }
});
$('settingsBtn').addEventListener('click', () => { chrome.runtime.openOptionsPage(); window.close(); });
$('sessionsBtn').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('options/options.html#sessions') });
  window.close();
});

load().catch((err) => { $('summary').textContent = `Error: ${err.message}`; });
