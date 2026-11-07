// End-to-end test: loads build/chromium into Chrome and drives real tabs on a
// local test server (all hostnames are mapped to it, so nothing leaves the machine).
//   node e2e/run.mjs            (CHROME_PATH to override the browser)
import http from 'node:http';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const extDir = path.join(root, 'build', 'chromium');
const browserPath = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean).find((p) => existsSync(p));
if (!browserPath) throw new Error('No Chrome/Edge found; set CHROME_PATH');
const shotDir = process.env.SCREENSHOTS;

const server = http.createServer((req, res) => {
  const host = (req.headers.host || '').replace(/:\d+$/, '');
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(`<!doctype html><title>${host}${req.url.split('#')[0]}</title><h1>${host}${req.url}</h1>`);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? '✔' : '✘'} ${name}${detail ? ` — ${detail}` : ''}`);
}
async function waitFor(fn, timeout = 5000) {
  const end = Date.now() + timeout;
  for (;;) {
    const v = await fn().catch(() => false);
    if (v || Date.now() > end) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
}

const browser = await puppeteer.launch({
  executablePath: browserPath,
  headless: true,
  pipe: true,
  enableExtensions: [extDir],
  args: [`--host-resolver-rules=MAP *.test 127.0.0.1:${port}`, '--no-first-run', '--no-default-browser-check'],
});

try {
  const swTarget = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().endsWith('background.js'), { timeout: 15000 });
  const extId = new URL(swTarget.url()).host;
  const sw = await swTarget.worker();
  await waitFor(() => sw.evaluate(() => typeof chrome === 'object' && !!chrome.tabs), 10000);

  // A blank extension page in the first window is used to send messages like the UI does.
  const ui = await browser.newPage();
  await ui.goto(`chrome-extension://${extId}/options/options.html`, { waitUntil: 'load' });
  const send = async (type, payload = {}) => {
    const r = await ui.evaluate((m) => chrome.runtime.sendMessage(m), { type, ...payload });
    if (!r.ok) throw new Error(r.error);
    return r.result;
  };
  const tabsApi = (code, arg) => sw.evaluate(code, arg);
  const windowId = await ui.evaluate(async () => (await chrome.windows.getCurrent()).id);
  const open = async (url, opts = {}) => {
    const t = await tabsApi(async ([u, w, o]) => chrome.tabs.create({ url: u, windowId: w, active: false, ...o }), [url, windowId, opts]);
    await waitFor(() => tabsApi(async (id) => (await chrome.tabs.get(id)).status === 'complete', t.id), 5000);
    return t.id;
  };
  const query = (q) => tabsApi(async (qq) => chrome.tabs.query(qq), q);
  const setSettings = async (patch) => {
    const { settings } = await send('getState');
    return send('saveSettings', { settings: { ...settings, ...patch } });
  };
  const closeTestTabs = async () => {
    const ids = (await query({})).filter((t) => /\.test\//.test(t.url)).map((t) => t.id);
    if (ids.length) await tabsApi(async (i) => chrome.tabs.remove(i), ids);
  };

  // 1. Duplicates
  await open('http://a.test/page');
  await open('http://a.test/page');
  await open('http://a.test/page#section');
  await open('http://b.test/page');
  const badge = await waitFor(async () => {
    const t = await sw.evaluate(() => chrome.action.getBadgeText({}));
    return t === '2' ? t : null;
  }, 3000);
  check('badge shows the number of duplicate tabs', badge === '2', `badge "${badge || await sw.evaluate(() => chrome.action.getBadgeText({}))}"`);
  const closed = await send('closeDuplicates');
  const aTabs = (await query({})).filter((t) => t.url.startsWith('http://a.test/'));
  check('"Close duplicates" leaves exactly one copy of each page', closed === 2 && aTabs.length === 1, `closed ${closed}, ${aTabs.length} left`);

  // 2. Group by site
  await closeTestTabs();
  for (const p of [1, 2, 3]) await open(`http://news.test/${p}`);
  await open('http://other.test/1');
  const made = await send('groupWindow', { windowId });
  const groups = await tabsApi(async (w) => chrome.tabGroups.query({ windowId: w }), windowId);
  const newsGroup = groups.find((g) => g.title === 'news.test');
  const inNews = newsGroup ? (await query({ groupId: newsGroup.id })).length : 0;
  check('"Group by site" groups sites with 2+ tabs only', made === 1 && inNews === 3 && !groups.some((g) => g.title === 'other.test'), `${made} group(s), ${inNews} tabs in news.test`);
  const ungrouped = await send('ungroupWindow', { windowId });
  check('"Ungroup" removes the groups again', ungrouped === 3 && (await tabsApi(async (w) => chrome.tabGroups.query({ windowId: w }), windowId)).length === 0);

  // 3. Group rule applied automatically when a page loads
  await setSettings({ groupRules: [{ domain: 'docs.test', title: 'Docs', color: 'green' }] });
  const docId = await open('http://api.docs.test/intro');
  const docGroup = await waitFor(async () => {
    const t = await tabsApi(async (id) => chrome.tabs.get(id), docId);
    if (t.groupId < 0) return null;
    return tabsApi(async (g) => chrome.tabGroups.get(g), t.groupId);
  }, 4000);
  check('group rule puts matching tabs into the named group', docGroup?.title === 'Docs' && docGroup.color === 'green', JSON.stringify(docGroup && { title: docGroup.title, color: docGroup.color }));

  // 4. Automatic group-by-site
  await setSettings({ autoGroupBySite: true, autoGroupMin: 2 });
  await open('http://shop.test/1');
  const shop2 = await open('http://shop.test/2');
  const shopGroup = await waitFor(async () => {
    const t = await tabsApi(async (id) => chrome.tabs.get(id), shop2);
    return t.groupId > -1 ? tabsApi(async (g) => chrome.tabGroups.get(g), t.groupId) : null;
  }, 4000);
  check('automatic grouping kicks in at the chosen number of tabs', shopGroup?.title === 'shop.test');
  await setSettings({ autoGroupBySite: false, groupRules: [] });

  // 5. Switch to the existing tab when opening a duplicate
  await setSettings({ duplicateOnOpen: 'switch' });
  const existing = await open('http://unique.test/here');
  const before = (await query({})).length;
  await tabsApi(async ([w]) => chrome.tabs.create({ url: 'http://unique.test/here', windowId: w, active: true }), [windowId]);
  const switched = await waitFor(async () => {
    const all = await query({});
    const ex = all.find((t) => t.id === existing);
    return all.length === before && ex?.active ? true : null;
  }, 4000);
  check('opening an already-open page switches to it and closes the new tab', switched);
  await setSettings({ duplicateOnOpen: 'nothing' });

  // 6. Suspend others
  await closeTestTabs();
  const pinned = await open('http://pinned.test/', { pinned: true });
  for (const p of [1, 2, 3]) await open(`http://idle.test/${p}`);
  const suspended = await send('suspendOthers', { windowId });
  const after = await query({ windowId });
  const discarded = after.filter((t) => t.discarded).length;
  const pinnedTab = after.find((t) => t.id === pinned);
  check('"Suspend others" unloads background tabs', suspended === 3 && discarded === 3, `${suspended} suspended`);
  check('pinned tabs are never suspended', pinnedTab && !pinnedTab.discarded);
  const recentNone = await send('suspendNow');
  check('automatic suspending leaves recently used tabs alone', recentNone === 0);

  // 7. Sessions: save, restore (lazily, with groups and pins), autosave, import
  await closeTestTabs();
  await open('http://s1.test/a', { pinned: true });
  const g1 = await open('http://s2.test/b');
  const g2 = await open('http://s2.test/c');
  await tabsApi(async ([ids, w]) => {
    const gid = await chrome.tabs.group({ tabIds: ids, createProperties: { windowId: w } });
    await chrome.tabGroups.update(gid, { title: 'Research', color: 'purple' });
  }, [[g1, g2], windowId]);
  await open('http://s3.test/d');
  const saved = await send('saveSession', { name: 'Test session', windowId });
  const sessions = await send('getSessions');
  check('saving a session stores its web pages', saved.tabs === 4 && sessions[0].name === 'Test session', `${saved.tabs} tabs saved`);

  await closeTestTabs();
  const opened = await send('restoreSession', { id: saved.id });
  const restoredWin = (await sw.evaluate(() => chrome.windows.getAll({ populate: true }))).find((w) => w.tabs.some((t) => t.url === 'http://s3.test/d'));
  const rTabs = restoredWin?.tabs ?? [];
  const rGroups = restoredWin ? await tabsApi(async (w) => chrome.tabGroups.query({ windowId: w }), restoredWin.id) : [];
  const lazy = rTabs.filter((t) => t.discarded).length;
  check('restoring opens every tab in a new window', opened === 4 && rTabs.length === 4, `${rTabs.length} tabs`);
  check('restore brings back pinned tabs and groups', rTabs.some((t) => t.pinned && t.url === 'http://s1.test/a') && rGroups.some((g) => g.title === 'Research' && g.color === 'purple'));
  check('restored background tabs are not loaded until clicked', lazy >= 2, `${lazy} of ${rTabs.length} unloaded`);

  await send('autosaveNow');
  const n1 = (await send('getSessions')).filter((s) => s.auto).length;
  await send('autosaveNow');
  const n2 = (await send('getSessions')).filter((s) => s.auto).length;
  check('autosave stores a snapshot and skips it when nothing changed', n1 === 1 && n2 === 1);

  const imported = await send('importSessions', { sessions: [{ id: 'imp-x', name: 'From file', windows: [{ tabs: [{ url: 'https://ok.test/' }, { url: 'javascript:alert(1)' }] }] }] });
  const imp = (await send('getSessions')).find((s) => s.id === 'imp-x');
  check('import accepts valid sessions and drops unsafe links', imported === 1 && imp.windows[0].tabs.length === 1);

  // 8. Popup: search and switch
  const page = await browser.newPage();
  await page.goto('http://search-target.test/needle-page', { waitUntil: 'load' });
  const firstPage = (await browser.pages())[0];
  await firstPage.bringToFront();
  await firstPage.triggerExtensionAction((await browser.extensions()).get(extId));
  const popupTarget = await browser.waitForTarget((t) => t.url().endsWith('popup/popup.html'), { timeout: 5000 });
  const popup = await popupTarget.asPage();
  await popup.waitForSelector('.tab');
  const total = await popup.$$eval('.tab', (els) => els.length);
  await popup.type('#q', 'needle');
  const hits = await popup.$$eval('.tab .title', (els) => els.map((e) => e.textContent));
  check('popup lists all tabs and search narrows them down', total >= 6 && hits.length === 1 && /needle-page/.test(hits[0]), `${total} tabs, ${hits.length} match`);
  if (shotDir) {
    await popup.click('#q', { clickCount: 3 });
    await popup.keyboard.press('Backspace');
    await new Promise((r) => setTimeout(r, 200));
    await (await popup.$('body')).screenshot({ path: path.join(shotDir, 'popup.png') });
    await popup.type('#q', 'needle');
    await (await popup.$('body')).screenshot({ path: path.join(shotDir, 'popup-search.png') });
  }
  await popup.keyboard.press('Enter');
  const activated = await waitFor(async () => (await query({ url: 'http://search-target.test/*' }))[0]?.active, 3000);
  check('pressing Enter switches to the found tab', activated);

  // 9. Settings page lists sessions
  await ui.reload({ waitUntil: 'load' });
  const listed = await waitFor(async () => ui.$$eval('.session', (els) => els.length), 3000);
  check('settings page shows saved sessions', listed >= 3, `${listed} sessions`);
  if (shotDir) {
    await ui.setViewport({ width: 900, height: 1000 });
    await ui.screenshot({ path: path.join(shotDir, 'settings.png') });
  }

  const swSession = await swTarget.createCDPSession();
  const { usedSize } = await swSession.send('Runtime.getHeapUsage');
  console.log(`\nService worker JS heap: ${(usedSize / 1048576).toFixed(1)} MB`);
} finally {
  await browser.close();
  server.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exitCode = failed.length ? 1 : 0;
