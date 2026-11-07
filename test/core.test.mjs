import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  sanitizeSettings, normalizeDomain, domainMatches, duplicateKey, findDuplicates, groupFor,
  planGroups, tabsToSuspend, searchTabs, snapshot, sanitizeSessions, fingerprint, colorFor, GROUP_COLORS,
} from '../src/lib/core.js';

let nextId = 1;
const tab = (url, extra = {}) => ({ id: nextId++, url, title: extra.title ?? url, windowId: 1, index: 0, active: false, pinned: false, lastAccessed: 0, groupId: -1, ...extra });

test('normalizeDomain', () => {
  assert.equal(normalizeDomain('https://www.GitHub.com/foo'), 'github.com');
  assert.equal(normalizeDomain('mail.example.com:443'), 'mail.example.com');
  assert.equal(normalizeDomain('*.example.org'), '*.example.org');
  assert.equal(normalizeDomain('not a domain'), '');
  assert.equal(normalizeDomain(null), '');
});

test('domainMatches covers subdomains but not lookalikes', () => {
  assert.ok(domainMatches('www.github.com', 'github.com'));
  assert.ok(domainMatches('gist.github.com', 'github.com'));
  assert.ok(domainMatches('gist.github.com', '*.github.com'));
  assert.ok(!domainMatches('notgithub.com', 'github.com'));
  assert.ok(!domainMatches('', 'github.com'));
});

test('sanitizeSettings', () => {
  const s = sanitizeSettings({
    duplicateOnOpen: 'explode', suspendAfterMinutes: 7, autoGroupMin: 100, autoSuspend: false,
    neverSuspend: ['https://mail.google.com/x', 'bad domain', 'mail.google.com'],
    groupRules: [{ domain: 'github.com', title: 'Code', color: 'green' }, { domain: 'github.com', title: 'dup' }, { domain: '??' }, { domain: 'gitlab.com', color: 'neon' }],
  });
  assert.equal(s.duplicateOnOpen, 'nothing');
  assert.equal(s.suspendAfterMinutes, 60);
  assert.equal(s.autoGroupMin, 4);
  assert.equal(s.autoSuspend, false);
  assert.deepEqual(s.neverSuspend, ['mail.google.com']);
  assert.deepEqual(s.groupRules, [{ domain: 'github.com', title: 'Code', color: 'green' }, { domain: 'gitlab.com', title: 'gitlab.com', color: 'blue' }]);
});

test('duplicateKey normalises hashes and trailing slashes, ignores browser pages', () => {
  assert.equal(duplicateKey('https://a.com/page#x'), duplicateKey('https://a.com/page/'));
  assert.notEqual(duplicateKey('https://a.com/page#x', { ignoreHash: false }), duplicateKey('https://a.com/page#y', { ignoreHash: false }));
  assert.notEqual(duplicateKey('https://a.com/page?id=1'), duplicateKey('https://a.com/page?id=2'));
  assert.equal(duplicateKey('chrome://newtab/'), null);
  assert.equal(duplicateKey('about:blank'), null);
  assert.equal(duplicateKey(''), null);
});

test('findDuplicates keeps the active, then pinned, then most recent tab', () => {
  const a1 = tab('https://a.com/', { lastAccessed: 10 });
  const a2 = tab('https://a.com/', { lastAccessed: 50 });
  const a3 = tab('https://a.com/#top', { active: true });
  const b1 = tab('https://b.com/x', { pinned: true });
  const b2 = tab('https://b.com/x', { lastAccessed: 99 });
  const c = tab('https://c.com/');
  const { close, sets } = findDuplicates([a1, a2, a3, b1, b2, c]);
  assert.deepEqual(close.sort(), [a1.id, a2.id, b2.id].sort());
  assert.equal(sets.find((s) => s.keep === a3.id).close.length, 2);
  assert.equal(sets.find((s) => s.keep === b1.id).close[0], b2.id);
  // Pinned duplicates are never closed.
  const p1 = tab('https://p.com/', { pinned: true, lastAccessed: 1 });
  const p2 = tab('https://p.com/', { pinned: true, lastAccessed: 2 });
  assert.deepEqual(findDuplicates([p1, p2]).close, []);
});

test('groupFor and planGroups', () => {
  const rules = [{ domain: 'github.com', title: 'Code', color: 'green' }];
  assert.deepEqual(groupFor('https://gist.github.com/x', rules), { key: 'rule:github.com', title: 'Code', color: 'green', rule: true });
  assert.equal(groupFor('https://www.bbc.co.uk/news', rules).title, 'bbc.co.uk');
  assert.equal(groupFor('chrome://settings', rules), null);
  const tabs = [
    tab('https://github.com/a'),
    tab('https://news.site/1'), tab('https://news.site/2'), tab('https://www.news.site/3'),
    tab('https://lonely.site/'),
    tab('https://news.site/pinned', { pinned: true }),
  ];
  const plan = planGroups(tabs, rules, 2);
  assert.deepEqual(plan.map((p) => [p.title, p.tabIds.length]).sort(), [['Code', 1], ['news.site', 3]]);
});

test('colorFor is stable and never grey', () => {
  assert.equal(colorFor('news.site'), colorFor('news.site'));
  for (const s of ['a', 'bb', 'github.com', 'x'.repeat(50)]) assert.ok(GROUP_COLORS.includes(colorFor(s)) && colorFor(s) !== 'grey');
});

test('tabsToSuspend skips active, pinned, audible, excluded and recent tabs', () => {
  const now = 10_000_000;
  const old = now - 61 * 60_000;
  const tabs = [
    tab('https://old.com/', { lastAccessed: old }),
    tab('https://recent.com/', { lastAccessed: now - 5 * 60_000 }),
    tab('https://active.com/', { lastAccessed: old, active: true }),
    tab('https://pinned.com/', { lastAccessed: old, pinned: true }),
    tab('https://music.com/', { lastAccessed: old, audible: true }),
    tab('https://mail.work.com/', { lastAccessed: old }),
    tab('https://already.com/', { lastAccessed: old, discarded: true }),
    tab('chrome://settings/', { lastAccessed: old }),
    tab('https://loading.com/', { lastAccessed: old, status: 'loading' }),
  ];
  const ids = tabsToSuspend(tabs, now, { afterMinutes: 60, neverSuspend: ['work.com'] });
  assert.deepEqual(ids, [tabs[0].id]);
});

test('searchTabs requires every word and ranks title matches first', () => {
  const t1 = tab('https://docs.example.com/guide', { title: 'Getting started guide' });
  const t2 = tab('https://guide.example.com/', { title: 'Example home' });
  const t3 = tab('https://other.com/', { title: 'Unrelated' });
  const r = searchTabs([t1, t2, t3], 'guide');
  assert.deepEqual(r.map((x) => x.tab.id), [t1.id, t2.id]);
  assert.deepEqual(searchTabs([t1, t2, t3], 'guide started').map((x) => x.tab.id), [t1.id]);
  assert.equal(searchTabs([t1, t2, t3], 'nothing-here').length, 0);
  assert.equal(searchTabs([t1, t2, t3], '   ').length, 3);
});

test('snapshot keeps web pages, pins and groups; drops browser pages', () => {
  const groups = new Map([[7, { title: 'Work', color: 'red' }]]);
  const windows = [{ tabs: [
    tab('https://a.com/', { pinned: true }),
    tab('https://b.com/', { groupId: 7 }),
    tab('chrome://newtab/'),
  ] }, { tabs: [tab('chrome://extensions/')] }];
  const snap = snapshot(windows, groups);
  assert.equal(snap.length, 1);
  assert.deepEqual(snap[0].tabs, [
    { url: 'https://a.com/', title: 'https://a.com/', pinned: true },
    { url: 'https://b.com/', title: 'https://b.com/', group: { title: 'Work', color: 'red' } },
  ]);
  assert.equal(fingerprint(snap), fingerprint(snapshot(windows, groups)));
});

test('sanitizeSessions drops unsafe URLs and malformed data', () => {
  const out = sanitizeSessions([
    { id: 'ok-1', name: 'Good', created: 5, windows: [{ tabs: [
      { url: 'https://a.com/', title: 'A', pinned: true, group: { title: 'G', color: 'neon' } },
      { url: 'javascript:alert(1)' },
      { url: 'data:text/html,<script>x</script>' },
    ] }] },
    { name: 'Empty', windows: [{ tabs: [{ url: 'javascript:void 0' }] }] },
    'garbage',
    { id: '../evil', windows: [{ tabs: [{ url: 'https://b.com/' }] }] },
  ]);
  assert.equal(out.length, 2);
  assert.deepEqual(out[0].windows[0].tabs, [{ url: 'https://a.com/', title: 'A', pinned: true, group: { title: 'G', color: 'grey' } }]);
  assert.match(out[1].id, /^imp-/);
  assert.equal(out[1].name, 'Imported session');
  assert.deepEqual(sanitizeSessions('nope'), []);
});
