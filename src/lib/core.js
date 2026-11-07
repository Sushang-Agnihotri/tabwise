// Tabwise core: pure functions used by the background script, the UI and the tests.
// No browser APIs in here.

export const GROUP_COLORS = ['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'];
export const SUSPEND_MINUTES = [15, 30, 60, 120, 240, 480];

export const DEFAULT_SETTINGS = Object.freeze({
  version: 1,
  duplicateBadge: true,
  duplicateOnOpen: 'nothing',   // 'nothing' | 'switch' (focus the existing tab and close the new one)
  ignoreHash: true,             // treat page.html#a and page.html#b as duplicates
  autoSuspend: true,
  suspendAfterMinutes: 60,
  neverSuspend: [],             // domains
  groupRules: [],               // [{ domain, title, color }]
  autoGroupBySite: false,
  autoGroupMin: 4,
  autosave: true,
});

const DOMAIN_RE = /^(\*\.)?([a-z0-9-]+\.)*[a-z0-9-]+$/;

export function normalizeDomain(input) {
  if (typeof input !== 'string') return '';
  let d = input.trim().toLowerCase();
  if (d.includes('://')) {
    try { d = new URL(d).hostname; } catch { return ''; }
  }
  d = d.replace(/\/.*$/, '').replace(/:\d+$/, '').replace(/^www\./, '');
  return DOMAIN_RE.test(d) && d.length <= 253 ? d : '';
}

export function sanitizeSettings(input) {
  const s = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
  if (!input || typeof input !== 'object') return s;
  for (const k of ['duplicateBadge', 'ignoreHash', 'autoSuspend', 'autoGroupBySite', 'autosave']) {
    if (typeof input[k] === 'boolean') s[k] = input[k];
  }
  if (['nothing', 'switch'].includes(input.duplicateOnOpen)) s.duplicateOnOpen = input.duplicateOnOpen;
  if (SUSPEND_MINUTES.includes(Number(input.suspendAfterMinutes))) s.suspendAfterMinutes = Number(input.suspendAfterMinutes);
  const min = Number(input.autoGroupMin);
  if (Number.isInteger(min) && min >= 2 && min <= 20) s.autoGroupMin = min;
  if (Array.isArray(input.neverSuspend)) {
    s.neverSuspend = [...new Set(input.neverSuspend.map(normalizeDomain).filter(Boolean))].slice(0, 500);
  }
  if (Array.isArray(input.groupRules)) {
    const seen = new Set();
    for (const r of input.groupRules) {
      const domain = normalizeDomain(r?.domain);
      if (!domain || seen.has(domain)) continue;
      seen.add(domain);
      const title = typeof r.title === 'string' && r.title.trim() ? r.title.trim().slice(0, 40) : domain;
      const color = GROUP_COLORS.includes(r.color) ? r.color : 'blue';
      s.groupRules.push({ domain, title, color });
      if (s.groupRules.length >= 200) break;
    }
  }
  return s;
}

/** Does hostname `host` fall under `pattern` ("example.com" or "*.example.com" both cover subdomains)? */
export function domainMatches(host, pattern) {
  if (!host || !pattern) return false;
  const h = host.toLowerCase().replace(/^www\./, '');
  const p = pattern.replace(/^\*\./, '');
  return h === p || h.endsWith(`.${p}`);
}

export function hostOf(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.hostname.toLowerCase() : '';
  } catch {
    return '';
  }
}

export function isWebUrl(url) {
  return !!hostOf(url);
}

/** The key used to decide whether two tabs show the same page. */
export function duplicateKey(url, { ignoreHash = true } = {}) {
  if (typeof url !== 'string' || !url) return null;
  let u;
  try { u = new URL(url); } catch { return null; }
  if (!['http:', 'https:', 'file:', 'ftp:'].includes(u.protocol)) return null;
  if (ignoreHash) u.hash = '';
  let s = u.href;
  if (s.endsWith('/') && u.pathname !== '/') s = s.slice(0, -1);
  return s;
}

/**
 * Find duplicate tabs. In each set of tabs showing the same page, keep the
 * best one (active > pinned > most recently used) and return the rest.
 */
export function findDuplicates(tabs, options = {}) {
  const groups = new Map();
  for (const t of tabs) {
    const key = duplicateKey(t.url || t.pendingUrl, options);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(t);
  }
  const close = [];
  const sets = [];
  for (const [key, list] of groups) {
    if (list.length < 2) continue;
    const sorted = [...list].sort((a, b) => (b.active - a.active) || (b.pinned - a.pinned) || ((b.lastAccessed || 0) - (a.lastAccessed || 0)) || (a.id - b.id));
    const [keep, ...rest] = sorted;
    sets.push({ key, keep: keep.id, close: rest.map((t) => t.id) });
    close.push(...rest.filter((t) => !t.pinned).map((t) => t.id));
  }
  return { close, sets };
}

/** Group label for a URL: a matching rule, else the site name without "www.". */
export function groupFor(url, rules) {
  const host = hostOf(url);
  if (!host) return null;
  const rule = rules.find((r) => domainMatches(host, r.domain));
  if (rule) return { key: `rule:${rule.domain}`, title: rule.title, color: rule.color, rule: true };
  const site = host.replace(/^www\./, '');
  return { key: `site:${site}`, title: site, color: null, rule: false };
}

/**
 * Plan "group by site" for one window: returns [{ title, color, tabIds }] for
 * every site (or rule) with at least `min` ungrouped, unpinned web tabs.
 * Rule matches are grouped even when there is only one tab.
 */
export function planGroups(tabs, rules, min = 2) {
  const buckets = new Map();
  for (const t of tabs) {
    if (t.pinned) continue;
    const g = groupFor(t.url || t.pendingUrl, rules);
    if (!g) continue;
    if (!buckets.has(g.key)) buckets.set(g.key, { ...g, tabIds: [] });
    buckets.get(g.key).tabIds.push(t.id);
  }
  return [...buckets.values()].filter((b) => b.tabIds.length >= (b.rule ? 1 : min));
}

/** Pick a stable colour for a site name so the same site keeps its colour. */
export function colorFor(title) {
  let h = 0;
  for (const c of title) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return GROUP_COLORS[1 + (h % (GROUP_COLORS.length - 1))];
}

/** Tabs that may be suspended now. */
export function tabsToSuspend(tabs, now, { afterMinutes, neverSuspend = [] }) {
  const limit = afterMinutes * 60_000;
  return tabs.filter((t) => !t.active && !t.pinned && !t.audible && !t.discarded
    && t.status !== 'loading'
    && isWebUrl(t.url)
    && typeof t.lastAccessed === 'number' && now - t.lastAccessed >= limit
    && !neverSuspend.some((d) => domainMatches(hostOf(t.url), d)))
    .map((t) => t.id);
}

/**
 * Search tabs by title and URL. Every word in the query must match.
 * Title matches outrank URL matches; matches at word starts rank higher.
 */
export function searchTabs(tabs, query) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return tabs.map((t) => ({ tab: t, score: 0 }));
  const out = [];
  for (const t of tabs) {
    const title = (t.title || '').toLowerCase();
    const url = (t.url || t.pendingUrl || '').toLowerCase().replace(/^https?:\/\/(www\.)?/, '');
    let score = 0;
    let ok = true;
    for (const w of words) {
      const ti = title.indexOf(w);
      const ui = url.indexOf(w);
      if (ti === -1 && ui === -1) { ok = false; break; }
      if (ti !== -1) score += 10 + (ti === 0 || /[\s\-_:|.([]/.test(title[ti - 1]) ? 5 : 0);
      if (ui !== -1) score += 4 + (ui === 0 ? 3 : 0);
    }
    // Ties go to the most recently used tab.
    if (ok) out.push({ tab: t, score: score + (t.lastAccessed || 0) / 1e15 });
  }
  return out.sort((a, b) => b.score - a.score);
}

/** Turn browser windows/tabs into a storable session. */
export function snapshot(windows, groupsById = new Map()) {
  const out = [];
  for (const w of windows) {
    const tabs = (w.tabs || [])
      .filter((t) => duplicateKey(t.url || t.pendingUrl, { ignoreHash: false }))
      .map((t) => {
        const g = t.groupId > -1 ? groupsById.get(t.groupId) : null;
        const tab = { url: t.url || t.pendingUrl, title: (t.title || '').slice(0, 300) };
        if (t.pinned) tab.pinned = true;
        if (g) tab.group = { title: g.title || '', color: g.color || 'grey' };
        return tab;
      });
    if (tabs.length) out.push({ tabs });
  }
  return out;
}

export function countTabs(session) {
  return session.windows.reduce((n, w) => n + w.tabs.length, 0);
}

/** A stable fingerprint of a snapshot, to skip autosaves when nothing changed. */
export function fingerprint(windows) {
  return windows.map((w) => w.tabs.map((t) => t.url).join('\n')).join('\n--\n');
}

/** Validate sessions from an imported file. Unsafe URLs (javascript:, data:, etc.) are dropped. */
export function sanitizeSessions(input) {
  if (!Array.isArray(input)) return [];
  const out = [];
  for (const s of input.slice(0, 500)) {
    if (!s || !Array.isArray(s.windows)) continue;
    const windows = [];
    for (const w of s.windows.slice(0, 50)) {
      if (!w || !Array.isArray(w.tabs)) continue;
      const tabs = [];
      for (const t of w.tabs.slice(0, 1000)) {
        if (!t || !duplicateKey(t.url, { ignoreHash: false })) continue;
        const tab = { url: String(t.url).slice(0, 4000), title: typeof t.title === 'string' ? t.title.slice(0, 300) : '' };
        if (t.pinned === true) tab.pinned = true;
        if (t.group && typeof t.group.title === 'string') {
          tab.group = { title: t.group.title.slice(0, 40), color: GROUP_COLORS.includes(t.group.color) ? t.group.color : 'grey' };
        }
        tabs.push(tab);
      }
      if (tabs.length) windows.push({ tabs });
    }
    if (!windows.length) continue;
    out.push({
      id: typeof s.id === 'string' && /^[\w-]{1,64}$/.test(s.id) ? s.id : `imp-${Date.now().toString(36)}-${out.length}`,
      name: typeof s.name === 'string' && s.name.trim() ? s.name.trim().slice(0, 80) : 'Imported session',
      created: Number.isFinite(s.created) ? s.created : Date.now(),
      auto: s.auto === true,
      windows,
    });
  }
  return out;
}
