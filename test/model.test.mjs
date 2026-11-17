import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyStore, merge, normaliseUrl, validate } from '../src/model.js';

const bm = (title, url, parent = 'toolbar', index = 0, modifiedAt = 100) =>
  ({ type: 'bookmark', title, url, parent, index, dateAdded: 1, modifiedAt });
const folder = (title, parent = 'toolbar', index = 0, modifiedAt = 100) =>
  ({ type: 'folder', title, parent, index, dateAdded: 1, modifiedAt });

const store = (nodes, tombstones = {}) => ({ version: 1, updatedAt: 0, nodes, tombstones });

test('addition on one side survives', () => {
  const base = store({});
  const a = store({ x: bm('A', 'https://a.com') });
  const b = store({});
  const out = merge(base, a, b);
  assert.equal(out.nodes.x.title, 'A');
});

test('additions on both sides both survive', () => {
  const base = store({});
  const a = store({ x: bm('A', 'https://a.com') });
  const b = store({ y: bm('B', 'https://b.com') });
  const out = merge(base, a, b);
  assert.deepEqual(Object.keys(out.nodes).sort(), ['x', 'y']);
});

test('deletion is not resurrected by the other side', () => {
  const base = store({ x: bm('A', 'https://a.com') });
  const a = store({}, { x: 500 });          // deleted here
  const b = store({ x: bm('A', 'https://a.com') }); // untouched there
  const out = merge(base, a, b);
  assert.equal(out.nodes.x, undefined, 'deleted bookmark came back');
});

test('an edit newer than the delete wins over it', () => {
  const base = store({ x: bm('A', 'https://a.com') });
  const a = store({}, { x: 500 });
  const b = store({ x: bm('A renamed', 'https://a.com', 'toolbar', 0, 900) });
  const out = merge(base, a, b);
  assert.equal(out.nodes.x.title, 'A renamed');
});

test('concurrent rename and move keep both changes', () => {
  const base = store({ f: folder('F'), x: bm('A', 'https://a.com', 'toolbar') });
  const a = store({ f: folder('F'), x: bm('Renamed', 'https://a.com', 'toolbar', 0, 200) });
  const b = store({ f: folder('F'), x: bm('A', 'https://a.com', 'f', 0, 300) });
  const out = merge(base, a, b);
  assert.equal(out.nodes.x.title, 'Renamed', 'rename lost');
  assert.equal(out.nodes.x.parent, 'f', 'move lost');
});

test('conflicting edits to the same field resolve last-writer-wins', () => {
  const base = store({ x: bm('A', 'https://a.com') });
  const a = store({ x: bm('From A', 'https://a.com', 'toolbar', 0, 200) });
  const b = store({ x: bm('From B', 'https://a.com', 'toolbar', 0, 900) });
  assert.equal(merge(base, a, b).nodes.x.title, 'From B');
});

test('orphaned node is rehomed rather than dropped', () => {
  const out = validate(store({ x: bm('A', 'https://a.com', 'missing-folder') }));
  assert.equal(out.nodes.x.parent, 'unfiled');
});

test('folder cycle is broken, not fatal', () => {
  const out = validate(store({
    f1: { ...folder('F1'), parent: 'f2' },
    f2: { ...folder('F2'), parent: 'f1' },
  }));
  const parents = [out.nodes.f1.parent, out.nodes.f2.parent];
  assert.ok(parents.includes('unfiled'), 'cycle not broken');
});

test('sibling indices come out dense and ordered', () => {
  const out = validate(store({
    x: bm('X', 'https://x.com', 'toolbar', 7),
    y: bm('Y', 'https://y.com', 'toolbar', 3),
    z: bm('Z', 'https://z.com', 'toolbar', 99),
  }));
  assert.deepEqual([out.nodes.y.index, out.nodes.x.index, out.nodes.z.index], [0, 1, 2]);
});

test('merge is commutative on the resulting node set', () => {
  const base = store({ x: bm('A', 'https://a.com') });
  const a = store({ x: bm('A2', 'https://a.com', 'toolbar', 0, 200), y: bm('Y', 'https://y.com') });
  const b = store({ x: bm('A3', 'https://a.com', 'toolbar', 0, 300), z: bm('Z', 'https://z.com') });
  assert.deepEqual(
    Object.keys(merge(base, a, b).nodes).sort(),
    Object.keys(merge(base, b, a).nodes).sort()
  );
});

test('empty merge is a no-op, not a wipe', () => {
  const base = store({ x: bm('A', 'https://a.com') });
  const out = merge(base, store({ x: bm('A', 'https://a.com') }), emptyStore());
  assert.equal(out.nodes.x.title, 'A', 'a fresh device wiped the remote');
});

test('url normalisation ignores noise but keeps query strings', () => {
  // Root-path trailing slash is stripped: example.com and example.com/ are
  // the same page, and pairing them is the whole point of this function.
  assert.equal(normaliseUrl('https://WWW.Example.com/#frag'), 'https://example.com');
  assert.equal(normaliseUrl('https://example.com'), normaliseUrl('https://example.com/'));
  // Deeper paths keep their slash, and query strings are always significant.
  assert.equal(normaliseUrl('https://x.com/a/'), 'https://x.com/a/');
  assert.equal(normaliseUrl('https://x.com/a?b=1'), 'https://x.com/a?b=1');
});
