// Build Tabwise for Chromium (Chrome, Edge, Brave) and Firefox.
//   node scripts/build.mjs            assemble build/<target> and dist/*.zip
//   node scripts/build.mjs --no-zip
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipDirectory } from './zip.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const noZip = process.argv.includes('--no-zip');

function manifest(target) {
  const m = {
    manifest_version: 3,
    name: 'Tabwise – Smart Tab Manager',
    short_name: 'Tabwise',
    version: pkg.version,
    description: 'Search all your tabs, close duplicates, group by site, suspend idle tabs and save sessions. Private and offline.',
    homepage_url: 'https://github.com/Sushang-Agnihotri/tabwise',
    icons: { 16: 'icons/icon-16.png', 32: 'icons/icon-32.png', 48: 'icons/icon-48.png', 128: 'icons/icon-128.png' },
    action: { default_title: 'Tabwise', default_popup: 'popup/popup.html', default_icon: { 16: 'icons/icon-16.png', 32: 'icons/icon-32.png' } },
    options_ui: { page: 'options/options.html', open_in_tab: true },
    commands: { _execute_action: { suggested_key: { default: 'Alt+Shift+T' }, description: 'Open tab search' } },
    permissions: target === 'chromium'
      ? ['tabs', 'tabGroups', 'storage', 'alarms', 'favicon']
      : ['tabs', 'storage', 'alarms'],
  };
  if (target === 'chromium') {
    m.background = { service_worker: 'background.js', type: 'module' };
    m.minimum_chrome_version = '121'; // tab.lastAccessed
  } else {
    m.background = { scripts: ['background.js'], type: 'module' };
    m.browser_specific_settings = {
      gecko: { id: 'tabwise@free-tools-ecosystem', strict_min_version: '128.0', data_collection_permissions: { required: ['none'] } },
    };
  }
  return m;
}

console.log(`Building Tabwise ${pkg.version}`);
await mkdir(path.join(root, 'dist'), { recursive: true });
for (const target of ['chromium', 'firefox']) {
  const out = path.join(root, 'build', target);
  await rm(out, { recursive: true, force: true });
  await cp(path.join(root, 'src'), out, { recursive: true });
  await cp(path.join(root, 'LICENSE'), path.join(out, 'LICENSE'));
  await writeFile(path.join(out, 'manifest.json'), JSON.stringify(manifest(target), null, 2));
  console.log(`✔ build/${target}`);
  if (!noZip) {
    const name = `tabwise-${pkg.version}-${target}.zip`;
    const { files, bytes } = await zipDirectory(out, path.join(root, 'dist', name));
    console.log(`✔ dist/${name} (${files} files, ${(bytes / 1024).toFixed(0)} KB)`);
  }
}
