// Tabwise background script. Everything happens locally with the browser's
// tab APIs; Tabwise makes no network requests.
import {
  sanitizeSettings, findDuplicates, duplicateKey, planGroups, groupFor, colorFor,
  tabsToSuspend, snapshot, fingerprint, sanitizeSessions, countTabs, hostOf,
} from './lib/core.js';

const HAS_GROUPS = !!(chrome.tabGroups && chrome.tabs.group);
const MAX_AUTOSAVES = 5;
const MAX_SESSIONS = 200;

// --------------------------------------------------------------- state -----

let settingsCache = null;
async function getSettings() {
  if (!settingsCache) {
    const { settings } = await chrome.storage.local.get('settings');
    settingsCache = sanitizeSettings(settings);
  }
  return settingsCache;
}
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.settings) {
    settingsCache = null;
    scheduleBadge();
    setupAlarms();
  }
});

async function getSessions() {
  const { sessions = [] } = await chrome.storage.local.get('sessions');
  return sessions;
}
async function setSessions(sessions) {
  await chrome.storage.local.set({ sessions });
}

const allTabs = () => chrome.tabs.query({});

// --------------------------------------------------------- duplicates ------

async function closeDuplicates(windowId) {
  const settings = await getSettings();
  const tabs = windowId ? await chrome.tabs.query({ windowId }) : await allTabs();
  const { close } = findDuplicates(tabs, { ignoreHash: settings.ignoreHash });
  if (close.length) await chrome.tabs.remove(close);
  return close.length;
}

let badgeTimer = 0;
function scheduleBadge() {
  clearTimeout(badgeTimer);
  badgeTimer = setTimeout(updateBadge, 300);
}
async function updateBadge() {
  const settings = await getSettings();
  let text = '';
  if (settings.duplicateBadge) {
    const { close } = findDuplicates(await allTabs(), { ignoreHash: settings.ignoreHash });
    if (close.length) text = String(close.length);
  }
  await chrome.action.setBadgeBackgroundColor({ color: '#c2410c' });
  await chrome.action.setBadgeText({ text });
  await chrome.action.setTitle({ title: text ? `Tabwise: ${text} duplicate tab${text === '1' ? '' : 's'}` : 'Tabwise' });
}

// Tabs created in the last few seconds; only these are treated as "opening a duplicate".
const freshTabs = new Map();

async function maybeSwitchToExisting(tab) {
  const created = freshTabs.get(tab.id);
  if (!created || Date.now() - created > 15_000) return;
  const settings = await getSettings();
  if (settings.duplicateOnOpen !== 'switch') return;
  const key = duplicateKey(tab.url, { ignoreHash: settings.ignoreHash });
  if (!key) return;
  const existing = (await allTabs()).find((t) => t.id !== tab.id && duplicateKey(t.url || t.pendingUrl, { ignoreHash: settings.ignoreHash }) === key);
  if (!existing) return;
  freshTabs.delete(tab.id);
  await chrome.tabs.update(existing.id, { active: true });
  await chrome.windows.update(existing.windowId, { focused: true });
  await chrome.tabs.remove(tab.id);
}

// ------------------------------------------------------------ grouping -----

async function findOrCreateGroup(windowId, title, color, tabIds) {
  const existing = (await chrome.tabGroups.query({ windowId, title }))[0];
  if (existing) {
    await chrome.tabs.group({ groupId: existing.id, tabIds });
    return existing.id;
  }
  const groupId = await chrome.tabs.group({ tabIds, createProperties: { windowId } });
  await chrome.tabGroups.update(groupId, { title, color: color || colorFor(title), collapsed: false });
  return groupId;
}

async function groupWindow(windowId) {
  if (!HAS_GROUPS) throw new Error('This browser does not support tab groups');
  const settings = await getSettings();
  const tabs = (await chrome.tabs.query({ windowId })).filter((t) => t.groupId === -1 || t.groupId === undefined);
  const plan = planGroups(tabs, settings.groupRules, 2);
  for (const g of plan) await findOrCreateGroup(windowId, g.title, g.color, g.tabIds);
  return plan.length;
}

async function groupAll() {
  const windows = await chrome.windows.getAll({ windowTypes: ['normal'] });
  let n = 0;
  for (const w of windows) n += await groupWindow(w.id);
  return n;
}

async function ungroupWindow(windowId) {
  if (!HAS_GROUPS) return 0;
  const tabs = (await chrome.tabs.query({ windowId })).filter((t) => t.groupId > -1);
  if (tabs.length) await chrome.tabs.ungroup(tabs.map((t) => t.id));
  return tabs.length;
}

/** Apply group rules and "group by site" to a tab that finished loading. */
async function autoGroup(tab) {
  if (!HAS_GROUPS || tab.pinned || tab.groupId > -1) return;
  const settings = await getSettings();
  const g = groupFor(tab.url, settings.groupRules);
  if (!g) return;
  if (g.rule) {
    await findOrCreateGroup(tab.windowId, g.title, g.color, [tab.id]);
    return;
  }
  if (!settings.autoGroupBySite) return;
  const host = hostOf(tab.url);
  const siblings = (await chrome.tabs.query({ windowId: tab.windowId }))
    .filter((t) => !t.pinned && hostOf(t.url || t.pendingUrl).replace(/^www\./, '') === host.replace(/^www\./, ''));
  const existingGroup = siblings.find((t) => t.groupId > -1);
  if (existingGroup) {
    const group = await chrome.tabGroups.get(existingGroup.groupId).catch(() => null);
    if (group?.title === g.title) { await chrome.tabs.group({ groupId: group.id, tabIds: [tab.id] }); return; }
  }
  const ungrouped = siblings.filter((t) => t.groupId === -1);
  if (ungrouped.length >= settings.autoGroupMin) await findOrCreateGroup(tab.windowId, g.title, null, ungrouped.map((t) => t.id));
}

// ---------------------------------------------------------- suspending -----

async function discard(ids) {
  let n = 0;
  for (const id of ids) {
    try { if (await chrome.tabs.discard(id)) n++; } catch { /* tab busy or closed */ }
  }
  return n;
}

async function autoSuspend() {
  const settings = await getSettings();
  if (!settings.autoSuspend) return 0;
  const ids = tabsToSuspend(await allTabs(), Date.now(), { afterMinutes: settings.suspendAfterMinutes, neverSuspend: settings.neverSuspend });
  return discard(ids);
}

/** Suspend every other tab now (manual action), still skipping pinned, playing and excluded tabs. */
async function suspendOthers(windowId) {
  const settings = await getSettings();
  const tabs = windowId ? await chrome.tabs.query({ windowId }) : await allTabs();
  const ids = tabsToSuspend(tabs, Infinity, { afterMinutes: 0, neverSuspend: settings.neverSuspend });
  return discard(ids);
}

// ------------------------------------------------------------ sessions -----

async function currentSnapshot(windowId) {
  const windows = windowId
    ? [await chrome.windows.get(windowId, { populate: true })]
    : await chrome.windows.getAll({ populate: true, windowTypes: ['normal'] });
  const groups = new Map();
  if (HAS_GROUPS) for (const g of await chrome.tabGroups.query({})) groups.set(g.id, g);
  return snapshot(windows, groups);
}

const newId = () => `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

async function saveSession(name, windowId) {
  const windows = await currentSnapshot(windowId);
  if (!windows.length) throw new Error('No web pages to save');
  const session = { id: newId(), name: (name || '').trim().slice(0, 80) || `Session ${new Date().toLocaleString()}`, created: Date.now(), auto: false, windows };
  const sessions = await getSessions();
  sessions.unshift(session);
  await setSessions(sessions.slice(0, MAX_SESSIONS));
  return { id: session.id, tabs: countTabs(session) };
}

async function autosave() {
  const settings = await getSettings();
  if (!settings.autosave) return;
  const windows = await currentSnapshot();
  if (!windows.length) return;
  const fp = fingerprint(windows);
  const { lastAutosave } = await chrome.storage.local.get('lastAutosave');
  if (fp === lastAutosave) return;
  const sessions = await getSessions();
  const manual = sessions.filter((s) => !s.auto);
  const autos = sessions.filter((s) => s.auto);
  autos.unshift({ id: newId(), name: 'Autosave', created: Date.now(), auto: true, windows });
  await setSessions([...autos.slice(0, MAX_AUTOSAVES), ...manual].sort((a, b) => b.created - a.created));
  await chrome.storage.local.set({ lastAutosave: fp });
}

async function restoreSession(id, { lazy = true } = {}) {
  const session = (await getSessions()).find((s) => s.id === id);
  if (!session) throw new Error('Session not found');
  let opened = 0;
  for (const w of session.windows) {
    const [first, ...rest] = w.tabs;
    const win = await chrome.windows.create({ url: first.url, focused: true });
    const created = [{ id: win.tabs[0].id, saved: first }];
    if (first.pinned) await chrome.tabs.update(win.tabs[0].id, { pinned: true });
    for (const t of rest) {
      const props = { windowId: win.id, url: t.url, active: false, pinned: !!t.pinned };
      let tab;
      try {
        // Firefox can create tabs without loading them; Chromium loads then we discard.
        tab = await chrome.tabs.create(lazy && typeof browser !== 'undefined' ? { ...props, discarded: !t.pinned } : props);
      } catch {
        tab = await chrome.tabs.create(props);
      }
      created.push({ id: tab.id, saved: t });
    }
    opened += created.length;
    if (HAS_GROUPS) {
      const byGroup = new Map();
      for (const c of created) {
        if (!c.saved.group || c.saved.pinned) continue;
        const k = `${c.saved.group.title}|${c.saved.group.color}`;
        if (!byGroup.has(k)) byGroup.set(k, { ...c.saved.group, ids: [] });
        byGroup.get(k).ids.push(c.id);
      }
      for (const g of byGroup.values()) {
        const groupId = await chrome.tabs.group({ tabIds: g.ids, createProperties: { windowId: win.id } });
        await chrome.tabGroups.update(groupId, { title: g.title, color: g.color });
      }
    }
    if (lazy) await discard(created.slice(1).filter((c) => !c.saved.pinned).map((c) => c.id));
  }
  return opened;
}

// ------------------------------------------------------------ messages -----

async function handle(msg, sender) {
  if (sender.id !== chrome.runtime.id || (sender.url && !sender.url.startsWith(chrome.runtime.getURL('')))) {
    throw new Error('Untrusted sender');
  }
  switch (msg?.type) {
    case 'getState': {
      const settings = await getSettings();
      const tabs = await allTabs();
      const { close } = findDuplicates(tabs, { ignoreHash: settings.ignoreHash });
      return { settings, duplicates: close.length, hasGroups: HAS_GROUPS };
    }
    case 'closeDuplicates': return closeDuplicates(msg.windowId);
    case 'groupWindow': return groupWindow(msg.windowId);
    case 'groupAll': return groupAll();
    case 'ungroupWindow': return ungroupWindow(msg.windowId);
    case 'suspendOthers': return suspendOthers(msg.windowId);
    case 'suspendNow': return autoSuspend();
    case 'saveSession': return saveSession(msg.name, msg.windowId);
    case 'restoreSession': return restoreSession(msg.id, { lazy: msg.lazy !== false });
    case 'getSessions': return getSessions();
    case 'deleteSession': await setSessions((await getSessions()).filter((s) => s.id !== msg.id)); return true;
    case 'renameSession': {
      const sessions = await getSessions();
      const s = sessions.find((x) => x.id === msg.id);
      if (s && typeof msg.name === 'string' && msg.name.trim()) { s.name = msg.name.trim().slice(0, 80); s.auto = false; }
      await setSessions(sessions);
      return true;
    }
    case 'importSessions': {
      const imported = sanitizeSessions(msg.sessions);
      const sessions = await getSessions();
      const ids = new Set(sessions.map((s) => s.id));
      const fresh = imported.filter((s) => !ids.has(s.id));
      await setSessions([...fresh, ...sessions].slice(0, MAX_SESSIONS));
      return fresh.length;
    }
    case 'saveSettings': {
      const settings = sanitizeSettings(msg.settings);
      await chrome.storage.local.set({ settings });
      settingsCache = settings;
      return settings;
    }
    case 'autosaveNow': await autosave(); return true;
    default: throw new Error(`Unknown message ${msg?.type}`);
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handle(msg, sender).then(
    (result) => sendResponse({ ok: true, result }),
    (err) => sendResponse({ ok: false, error: String(err?.message ?? err) }),
  );
  return true;
});

// -------------------------------------------------------------- events -----

chrome.tabs.onCreated.addListener((tab) => {
  freshTabs.set(tab.id, Date.now());
  if (freshTabs.size > 200) freshTabs.delete(freshTabs.keys().next().value);
  scheduleBadge();
});
chrome.tabs.onRemoved.addListener((id) => { freshTabs.delete(id); scheduleBadge(); });
chrome.tabs.onUpdated.addListener((id, info, tab) => {
  if (info.url) {
    scheduleBadge();
    maybeSwitchToExisting(tab).catch(() => {});
  }
  if (info.status === 'complete') autoGroup(tab).catch(() => {});
});

async function setupAlarms() {
  const settings = await getSettings();
  // Check at a fraction of the suspend delay, but never more than every 5 minutes.
  await chrome.alarms.create('suspend', { periodInMinutes: Math.max(5, Math.floor(settings.suspendAfterMinutes / 4)) });
  await chrome.alarms.create('autosave', { periodInMinutes: 10 });
}

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === 'suspend') autoSuspend().catch(() => {});
  if (a.name === 'autosave') autosave().catch(() => {});
});

chrome.runtime.onInstalled.addListener(() => { setupAlarms(); updateBadge(); });
chrome.runtime.onStartup.addListener(() => { setupAlarms(); updateBadge(); });

