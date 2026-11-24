import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reconcile, sameScene } from '../everything-assets/sync.js';

const layer = (id, text = id) => ({ id, type: 'text', text, x: 0, y: 0 });
const ids = result => result.items.map(item => item.id);

test('reconciliation combines independent edits and newly added layers', () => {
  const a = layer('a'), b = layer('b'), image = layer('image'), note = layer('note');
  const local = [{ ...a, x: 90 }, b, image];
  const remote = [{ ...a, text: 'new' }, note, { ...b, y: 7 }];
  const merged = reconcile([a, b], local, remote);
  assert.equal(merged.copies, 0);
  assert.deepEqual(merged.items, [{ ...a, x: 90, text: 'new' }, note, { ...b, y: 7 }, image]);
});

test('unchanged layers follow deletions and edited layers survive concurrent deletion', () => {
  const a = layer('a'), b = layer('b'), c = layer('c');
  for (const [left, right] of [[[b, { ...c, text: 'keep' }], [a, b]], [[a, b], [b, { ...c, text: 'keep' }]]]) {
    const merged = reconcile([a, b, c], left, right);
    assert.deepEqual(ids(merged), ['b', 'c']);
    assert.equal(merged.items[1].text, 'keep');
    assert.equal(merged.copies, 0);
  }
});

test('same-property conflicts preserve both complete versions, and replay is stable', () => {
  const a = layer('a');
  const left = [{ ...a, text: 'mine' }], right = [{ ...a, text: 'theirs' }];
  const merged = reconcile([a], left, right);
  assert.equal(merged.copies, 1);
  assert.deepEqual(merged.items[0], right[0]);
  assert.equal(merged.items[1].text, 'mine');
  assert.notEqual(merged.items[1].id, 'a');
  assert.deepEqual(reconcile(right, merged.items, merged.items), { items: merged.items, copies: 0 });
});

test('one-sided reorder survives unrelated edits and remote insertions', () => {
  const a = layer('a'), b = layer('b'), c = layer('c');
  const remote = [a, { ...b, y: 20 }, layer('new'), c];
  const merged = reconcile([a, b, c], [c, a, b], remote);
  assert.deepEqual(ids(merged), ['c', 'a', 'b', 'new']);
  assert.equal(merged.items[2].y, 20);
  assert.ok(sameScene(merged.items, merged.items.map(item => ({ ...item }))));
  assert.ok(!sameScene(merged.items, [...merged.items].reverse()));
});

test('layers added to a stale empty board sit above the already saved layers', () => {
  const remote = {id: 'r', type: 'shape'};
  const local = {id: 'l', type: 'text'};
  assert.deepEqual(reconcile([], [local], [remote]).items, [remote, local]);
});
