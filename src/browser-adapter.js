/**
 * Translates between the live browser bookmark tree and the canonical model.
 *
 * The central problem: native bookmark IDs are per-profile and meaningless
 * across browsers ("5" in Chrome is unrelated to "5" in Firefox). So we keep
 * our own UUID per bookmark and a persistent nativeId <-> uuid map, rebuilding
 * the map by content match the first time we meet an unknown tree.
 */

import { emptyStore, identityKey, isRoot, MENU_SHIM_TITLE, validate } from './model.js';

const api = globalThis.browser ?? globalThis.chrome;

/* ------------------------------------------------------------------ *
 * Root detection
 * ------------------------------------------------------------------ */

/**
 * Chromium: '1' bar, '2' other, '3' mobile — stable across versions.
 * Firefox: 'toolbar_____', 'menu________', 'unfiled_____', 'mobile______'.
 * We detect by probing rather than by user-agent sniffing, which is wrong
 * under forks (Brave, Vivaldi, LibreWolf, Zen).
 */
export async function detectRoots() {
  const [tree] = await api.bookmarks.getTree();
  const kids = tree.children || [];
  const byId = Object.fromEntries(kids.map((k) => [k.id, k]));

  if (byId['toolbar_____'] || byId['menu________']) {
    return {
      flavour: 'firefox',
      toolbar: 'toolbar_____',
      menu: 'menu________',
      unfiled: 'unfiled_____',
      mobile: 'mobile______',
    };
  }
  return {
    flavour: 'chromium',
    toolbar: kids[0]?.id ?? '1',
    menu: null, // materialised as a folder under unfiled
    unfiled: kids[1]?.id ?? '2',
    mobile: kids[2]?.id ?? '3',
  };
}

/**
 * Chromium has no menu root. Find — or create — the folder that stands in for
 * it, so a Firefox menu bookmark has somewhere to land.
 */
async function menuShimId(roots, { create }) {
  if (roots.menu) return roots.menu;
  const kids = await api.bookmarks.getChildren(roots.unfiled);
  const found = kids.find((k) => !k.url && k.title === MENU_SHIM_TITLE);
  if (found) return found.id;
  if (!create) return roots.unfiled;
  const made = await api.bookmarks.create({
    parentId: roots.unfiled,
    title: MENU_SHIM_TITLE,
  });
  return made.id;
}

/* ------------------------------------------------------------------ *
 * Read: native tree -> canonical store
 * ------------------------------------------------------------------ */

/**
 * @param {object} roots  from detectRoots()
 * @param {Map<string,string>} map  nativeId -> uuid, mutated in place
 */
export async function readTree(roots, map) {
  const [tree] = await api.bookmarks.getTree();
  const store = emptyStore();
  const shim = roots.menu ? null : await menuShimId(roots, { create: false });

  const rootOf = new Map([
    [roots.toolbar, 'toolbar'],
    [roots.unfiled, 'unfiled'],
    [roots.mobile, 'mobile'],
  ]);
  if (roots.menu) rootOf.set(roots.menu, 'menu');
  else if (shim && shim !== roots.unfiled) rootOf.set(shim, 'menu');

  const walk = (node, canonicalParent) => {
    for (const [i, child] of (node.children || []).entries()) {
      // The menu shim folder is a root, not a node: descend without emitting.
      if (rootOf.has(child.id)) { walk(child, rootOf.get(child.id)); continue; }

      let uuid = map.get(child.id);
      if (!uuid) { uuid = crypto.randomUUID(); map.set(child.id, uuid); }

      store.nodes[uuid] = {
        type: child.url ? 'bookmark' : 'folder',
        title: child.title || '',
        url: child.url || undefined,
        parent: canonicalParent,
        index: i,
        dateAdded: child.dateAdded || Date.now(),
        modifiedAt: child.dateGroupModified || child.dateAdded || Date.now(),
      };
      if (!child.url) walk(child, uuid);
    }
  };

  for (const [nativeRoot, canonical] of rootOf) {
    let sub;
    try { [sub] = await api.bookmarks.getSubTree(nativeRoot); } catch { continue; }
    walk(sub, canonical);
  }

  return validate(store);
}

/* ------------------------------------------------------------------ *
 * Identity bootstrap
 * ------------------------------------------------------------------ */

/**
 * First time this browser meets an existing remote store, no UUIDs line up.
 * Pair local and remote nodes by content so we adopt the shared UUID instead
 * of duplicating every single bookmark — the failure mode that makes naive
 * sync tools notorious.
 */
export function reconcileIdentity(local, remote, map) {
  const remoteByKey = new Map();
  for (const id of Object.keys(remote.nodes)) {
    const k = identityKey(remote, id);
    if (k && !remoteByKey.has(k)) remoteByKey.set(k, id);
  }

  const rename = new Map(); // localUuid -> remoteUuid
  // Shallowest first, so a folder is adopted before the paths beneath it are
  // computed against the old identity.
  const order = Object.keys(local.nodes).sort(
    (a, b) => depth(local, a) - depth(local, b)
  );

  for (const localId of order) {
    if (remote.nodes[localId]) continue; // already shared
    const k = identityKey(local, localId);
    const remoteId = k && remoteByKey.get(k);
    if (!remoteId || rename.has(localId)) continue;
    rename.set(localId, remoteId);
    remoteByKey.delete(k);
  }

  if (!rename.size) return local;

  const out = emptyStore();
  out.updatedAt = local.updatedAt;
  const sub = (id) => rename.get(id) || id;
  for (const [id, n] of Object.entries(local.nodes)) {
    out.nodes[sub(id)] = { ...n, parent: isRoot(n.parent) ? n.parent : sub(n.parent) };
  }
  for (const [id, ts] of Object.entries(local.tombstones)) out.tombstones[sub(id)] = ts;

  for (const [nativeId, uuid] of map) if (rename.has(uuid)) map.set(nativeId, rename.get(uuid));
  return validate(out);
}

function depth(store, id) {
  let d = 0, cur = store.nodes[id]?.parent;
  const seen = new Set();
  while (cur && !isRoot(cur) && !seen.has(cur)) { seen.add(cur); d++; cur = store.nodes[cur]?.parent; }
  return d;
}

/* ------------------------------------------------------------------ *
 * Write: canonical store -> native tree
 * ------------------------------------------------------------------ */

/**
 * Apply `target` to the live tree, doing the minimum number of operations.
 * Returns a summary for logging.
 *
 * Order matters: create folders top-down (a child needs its parent to exist),
 * then move/update, then delete bottom-up (removing a folder in Chromium
 * requires removeTree and would take live children with it).
 */
export async function applyTree(target, current, roots, map) {
  const stats = { created: 0, updated: 0, moved: 0, removed: 0 };
  const uuidToNative = new Map([...map].map(([n, u]) => [u, n]));
  const nativeParent = async (canonicalParent) => {
    if (canonicalParent === 'menu' && !roots.menu) return menuShimId(roots, { create: true });
    if (isRoot(canonicalParent)) return roots[canonicalParent] ?? roots.unfiled;
    return uuidToNative.get(canonicalParent);
  };

  const order = Object.keys(target.nodes).sort(
    (a, b) => depth(target, a) - depth(target, b)
  );

  // Creates and updates, shallowest first.
  for (const uuid of order) {
    const want = target.nodes[uuid];
    const nativeId = uuidToNative.get(uuid);
    const parentId = await nativeParent(want.parent);
    if (!parentId) continue; // parent not materialised yet; next pass catches it

    if (!nativeId || !current.nodes[uuid]) {
      const made = await api.bookmarks.create({
        parentId,
        title: want.title,
        url: want.url,
        index: want.index,
      });
      map.set(made.id, uuid);
      uuidToNative.set(uuid, made.id);
      stats.created++;
      continue;
    }

    const have = current.nodes[uuid];
    if (have.title !== want.title || have.url !== want.url) {
      const changes = { title: want.title };
      if (want.url) changes.url = want.url;
      await api.bookmarks.update(nativeId, changes);
      stats.updated++;
    }
    if (have.parent !== want.parent || have.index !== want.index) {
      await api.bookmarks.move(nativeId, { parentId, index: want.index });
      stats.moved++;
    }
  }

  // Deletes, deepest first.
  const gone = Object.keys(current.nodes)
    .filter((uuid) => !target.nodes[uuid])
    .sort((a, b) => depth(current, b) - depth(current, a));

  for (const uuid of gone) {
    const nativeId = uuidToNative.get(uuid);
    if (!nativeId) continue;
    try {
      if (current.nodes[uuid].type === 'folder') await api.bookmarks.removeTree(nativeId);
      else await api.bookmarks.remove(nativeId);
      stats.removed++;
    } catch { /* already gone */ }
    map.delete(nativeId);
  }

  return stats;
}
