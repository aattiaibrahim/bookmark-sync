/**
 * Sync orchestration.
 *
 * One sync pass:
 *   1. read the live tree            -> local
 *   2. read the repo                 -> remote
 *   3. bootstrap shared UUIDs if this browser has not synced before
 *   4. three-way merge against the last-synced snapshot (base)
 *   5. apply the result to the browser, push it to the repo
 *   6. store the result as the new base
 *
 * Passes are serialised through a promise chain: bookmark events arrive in
 * bursts and two overlapping passes would race on the ID map.
 */

import { emptyStore, merge, pruneTombstones } from './model.js';
import { GitHubStore } from './github.js';
import { applyTree, detectRoots, readTree, reconcileIdentity } from './browser-adapter.js';

const api = globalThis.browser ?? globalThis.chrome;

const DEBOUNCE_MS = 4000;
const PERIOD_MIN = 15;

let queue = Promise.resolve();
let timer = null;
let applying = false; // echo guard: our own writes must not retrigger a sync

/* ------------------------------------------------------------------ *
 * Persistence
 * ------------------------------------------------------------------ */

async function loadState() {
  const s = await api.storage.local.get(['config', 'base', 'map']);
  return {
    config: s.config || null,
    base: s.base || emptyStore(),
    map: new Map(s.map || []),
  };
}

async function saveState({ base, map }) {
  await api.storage.local.set({ base, map: [...map] });
}

async function setStatus(patch) {
  const { status = {} } = await api.storage.local.get('status');
  await api.storage.local.set({ status: { ...status, ...patch } });
}

/* ------------------------------------------------------------------ *
 * Sync
 * ------------------------------------------------------------------ */

export async function sync({ reason = 'manual' } = {}) {
  const { config, base, map } = await loadState();
  if (!config?.token) {
    await setStatus({ state: 'unconfigured', message: 'Add a GitHub token in options.' });
    return;
  }

  await setStatus({ state: 'syncing', reason, at: Date.now() });
  const store = new GitHubStore(config);
  const roots = await detectRoots();

  // Up to three attempts: each failure means someone else pushed mid-flight,
  // so we re-read and re-merge rather than overwrite their work.
  for (let attempt = 0; attempt < 3; attempt++) {
    let local = await readTree(roots, map);
    const remote = (await store.read()) || emptyStore();

    // First contact with a non-empty repo: adopt shared UUIDs by content.
    const virgin = !Object.keys(base.nodes).length;
    if (virgin && Object.keys(remote.nodes).length) {
      local = reconcileIdentity(local, remote, map);
    }

    const merged = pruneTombstones(merge(base, local, remote));

    applying = true;
    let stats;
    try {
      stats = await applyTree(merged, local, roots, map);
    } finally {
      applying = false;
    }

    // Re-read so the new base reflects what the browser actually did, not what
    // we asked for. Browsers silently normalise titles and clamp indices.
    const settled = await readTree(roots, map);

    if (await store.write(merged, commitMessage(stats, reason))) {
      await saveState({ base: settled, map });
      await setStatus({
        state: 'ok',
        at: Date.now(),
        message: describe(stats),
        count: Object.keys(merged.nodes).length,
      });
      return stats;
    }
    // Lost the race — loop and merge again against the newer remote.
  }

  await setStatus({ state: 'error', at: Date.now(), message: 'Repo kept changing; will retry.' });
}

function commitMessage(s, reason) {
  const bits = describe(s);
  return `sync(${reason}): ${bits}`;
}

function describe(s) {
  if (!s) return 'no changes';
  const parts = Object.entries(s).filter(([, v]) => v > 0).map(([k, v]) => `${v} ${k}`);
  return parts.length ? parts.join(', ') : 'no changes';
}

/* ------------------------------------------------------------------ *
 * Triggers
 * ------------------------------------------------------------------ */

function schedule(reason) {
  if (applying) return; // our own write, not a user edit
  clearTimeout(timer);
  timer = setTimeout(() => {
    queue = queue.then(() => sync({ reason })).catch((e) => {
      console.error('[bookmark-sync]', e);
      return setStatus({ state: 'error', at: Date.now(), message: String(e.message || e) });
    });
  }, DEBOUNCE_MS);
}

for (const ev of ['onCreated', 'onRemoved', 'onChanged', 'onMoved']) {
  api.bookmarks[ev]?.addListener(() => schedule(ev));
}
// Chromium only; reordering a folder fires nothing else.
api.bookmarks.onChildrenReordered?.addListener(() => schedule('onChildrenReordered'));

api.alarms.create('periodic', { periodInMinutes: PERIOD_MIN });
api.alarms.onAlarm.addListener((a) => { if (a.name === 'periodic') schedule('periodic'); });
api.runtime.onStartup.addListener(() => schedule('startup'));
api.runtime.onInstalled.addListener(() => schedule('installed'));

api.runtime.onMessage.addListener((msg, _sender, respond) => {
  if (msg?.type === 'sync-now') {
    queue = queue.then(() => sync({ reason: 'manual' }))
      .then((s) => respond({ ok: true, stats: s }))
      .catch((e) => respond({ ok: false, error: String(e.message || e) }));
    return true; // async response
  }
});
