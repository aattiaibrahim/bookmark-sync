#!/usr/bin/env node
/**
 * Safari bridge (macOS only).
 *
 * Safari has no bookmarks extension API — it is the one major browser that
 * never implemented it — so there is no extension to write. Instead we read
 * and write ~/Library/Safari/Bookmarks.plist directly.
 *
 * The payoff: iCloud already watches that file. Anything written here
 * propagates to Safari on iPhone, iPad and other Macs for free, with no
 * iCloud-for-Windows client anywhere in the chain.
 *
 * Two hard requirements:
 *   1. Full Disk Access for whatever runs this (Terminal, or `node` itself).
 *      ~/Library/Safari is TCC-protected; without it you get EPERM.
 *   2. Safari must be closed when writing. Safari holds the bookmark tree in
 *      memory and rewrites the file on quit, which would silently discard
 *      whatever we wrote. We refuse rather than race it.
 *
 * Usage:
 *   node safari-sync.mjs            # sync
 *   node safari-sync.mjs --dry-run  # report what would change, touch nothing
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, copyFile, mkdir } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { emptyStore, isRoot, merge, pruneTombstones, validate } from '../src/model.js';
import { GitHubStore } from '../src/github.js';

const exec = promisify(execFile);

const PLIST = join(homedir(), 'Library', 'Safari', 'Bookmarks.plist');
const STATE_DIR = join(homedir(), '.bookmark-sync');
const STATE = join(STATE_DIR, 'safari-state.json');
const CONFIG = join(STATE_DIR, 'config.json');
const BACKUPS = join(STATE_DIR, 'backups');

const DRY = process.argv.includes('--dry-run');

/* ------------------------------------------------------------------ *
 * plist I/O, via plutil
 * ------------------------------------------------------------------ */

async function readPlist() {
  try {
    const { stdout } = await exec('plutil', ['-convert', 'json', '-o', '-', PLIST], {
      maxBuffer: 64 * 1024 * 1024,
    });
    return JSON.parse(stdout);
  } catch (e) {
    if (e.code === 'EACCES' || /Operation not permitted|EPERM/i.test(String(e.stderr || e))) {
      throw new Error(
        'Cannot read Bookmarks.plist. Grant Full Disk Access to your terminal ' +
        '(System Settings > Privacy & Security > Full Disk Access), then retry.'
      );
    }
    throw e;
  }
}

async function writePlist(obj) {
  await mkdir(BACKUPS, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  await copyFile(PLIST, join(BACKUPS, `Bookmarks-${stamp}.plist`));

  const tmp = join(tmpdir(), `bookmarks-${randomUUID()}.json`);
  await writeFile(tmp, JSON.stringify(obj));
  // binary1 is the format Safari itself writes; xml1 also loads but Safari
  // rewrites it on next quit, producing pointless churn.
  await exec('plutil', ['-convert', 'binary1', tmp, '-o', PLIST]);
}

async function safariRunning() {
  try {
    await exec('pgrep', ['-x', 'Safari']);
    return true;
  } catch {
    return false; // pgrep exits non-zero when nothing matches
  }
}

/* ------------------------------------------------------------------ *
 * plist tree <-> canonical store
 * ------------------------------------------------------------------ */

const LEAF = 'WebBookmarkTypeLeaf';
const LIST = 'WebBookmarkTypeList';

// Safari's roots are identified by Title on the top-level lists. It has no
// "unfiled" or "mobile" root, so those become folders under the menu.
const SAFARI_ROOT_TITLES = { BookmarksBar: 'toolbar', BookmarksMenu: 'menu' };
const SHIM_TITLES = { unfiled: 'Other Bookmarks', mobile: 'Mobile Bookmarks' };

function toStore(plist) {
  const store = emptyStore();

  const walk = (children, canonicalParent) => {
    let i = 0;
    for (const child of children || []) {
      if (child.WebBookmarkType !== LEAF && child.WebBookmarkType !== LIST) continue;

      const uuid = child.WebBookmarkUUID || randomUUID();
      const isLeaf = child.WebBookmarkType === LEAF;
      const title = isLeaf
        ? child.URIDictionary?.title || child.URLString || ''
        : child.Title || '';

      store.nodes[uuid] = {
        type: isLeaf ? 'bookmark' : 'folder',
        title,
        url: isLeaf ? child.URLString : undefined,
        parent: canonicalParent,
        index: i++,
        dateAdded: Date.now(),
        modifiedAt: Date.now(),
      };
      if (!isLeaf) walk(child.Children, uuid);
    }
  };

  for (const top of plist.Children || []) {
    const canonical = SAFARI_ROOT_TITLES[top.Title];
    if (!canonical) continue; // Reading List and friends: left strictly alone
    // A shim folder at the top of the menu is a canonical root, not a folder.
    const kids = [];
    for (const child of top.Children || []) {
      const shim = Object.entries(SHIM_TITLES).find(
        ([, t]) => t === child.Title && child.WebBookmarkType === LIST
      );
      if (canonical === 'menu' && shim) walk(child.Children, shim[0]);
      else kids.push(child);
    }
    walk(kids, canonical);
  }

  return validate(store);
}

function toPlist(store, original) {
  // Deep-clone the original so everything we do not model — Reading List,
  // WebBookmarkFileVersion, Safari's private keys — survives untouched.
  const out = JSON.parse(JSON.stringify(original));

  const childrenOf = (parentId) =>
    Object.entries(store.nodes)
      .filter(([, n]) => n.parent === parentId)
      .sort((a, b) => a[1].index - b[1].index);

  const build = (parentId) =>
    childrenOf(parentId).map(([uuid, n]) =>
      n.type === 'bookmark'
        ? {
            WebBookmarkType: LEAF,
            WebBookmarkUUID: uuid.toUpperCase(),
            URLString: n.url,
            URIDictionary: { title: n.title },
          }
        : {
            WebBookmarkType: LIST,
            WebBookmarkUUID: uuid.toUpperCase(),
            Title: n.title,
            Children: build(uuid),
          }
    );

  const makeList = (title, children) => ({
    WebBookmarkType: LIST,
    WebBookmarkUUID: randomUUID().toUpperCase(),
    Title: title,
    Children: children,
  });

  for (const top of out.Children || []) {
    const canonical = SAFARI_ROOT_TITLES[top.Title];
    if (!canonical) continue;
    if (canonical === 'toolbar') {
      top.Children = build('toolbar');
    } else {
      const shims = Object.entries(SHIM_TITLES)
        .map(([root, title]) => {
          const kids = build(root);
          return kids.length ? makeList(title, kids) : null;
        })
        .filter(Boolean);
      top.Children = [...build('menu'), ...shims];
    }
  }

  return out;
}

/* ------------------------------------------------------------------ *
 * Main
 * ------------------------------------------------------------------ */

async function loadJson(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); } catch { return fallback; }
}

async function main() {
  const config = await loadJson(CONFIG, null);
  if (!config?.token) {
    console.error(`No config. Create ${CONFIG}:\n` +
      JSON.stringify({ token: 'github_pat_...', owner: 'you', repo: 'bookmarks' }, null, 2));
    process.exit(1);
  }

  const plist = await readPlist();
  const local = toStore(plist);
  const base = await loadJson(STATE, emptyStore());

  const store = new GitHubStore(config);
  const remote = (await store.read()) || emptyStore();
  const merged = pruneTombstones(merge(base, local, remote));

  const before = Object.keys(local.nodes).length;
  const after = Object.keys(merged.nodes).length;
  const changed = JSON.stringify(sortedNodes(local)) !== JSON.stringify(sortedNodes(merged));

  if (DRY) {
    console.log(`[dry-run] Safari has ${before} bookmarks, merge yields ${after}.`);
    console.log(changed ? '[dry-run] Safari would be rewritten.' : '[dry-run] Safari already current.');
    return;
  }

  if (changed) {
    if (await safariRunning()) {
      console.error(
        'Safari is running. It would overwrite our changes when it quits.\n' +
        'Quit Safari and rerun (or let the launchd agent run it at logout).'
      );
      process.exit(2);
    }
    await writePlist(toPlist(merged, plist));
    console.log(`Safari updated: ${before} -> ${after} bookmarks. Backup in ${BACKUPS}.`);
  } else {
    console.log('Safari already current.');
  }

  if (await store.write(merged, `sync(safari): ${after} bookmarks`)) {
    await mkdir(STATE_DIR, { recursive: true });
    // Re-read so base matches what actually landed on disk.
    await writeFile(STATE, JSON.stringify(changed ? toStore(await readPlist()) : local));
    console.log('Pushed to GitHub. iCloud will carry this to your iPhone.');
  } else {
    console.error('Remote moved during sync; rerun to merge again.');
    process.exit(3);
  }
}

function sortedNodes(s) {
  return Object.entries(s.nodes)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([id, n]) => [id, n.title, n.url, n.parent, n.index]);
}

main().catch((e) => { console.error(e.message || e); process.exit(1); });
