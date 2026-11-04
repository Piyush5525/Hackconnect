import test from 'node:test';
import assert from 'node:assert/strict';
import { appendHistory, reconstruct, trim, MAX_ENTRIES } from '../lib/history.mjs';
import { replayEvents, stateAt } from '../lib/judging.mjs';

const entry = (path, content, kind = 'edit', n = 0) => ({ id: `e${n}`, path, content, actor: 'Ann', kind, createdAt: 1000 + n });

test('patch history reconstructs every point in time exactly', () => {
  const list = []; const expected = []; const files = {}; let n = 0;
  const paths = ['a.js', 'b.js', 'c/d.md'];
  for (let i = 0; i < 300; i++) {
    const path = paths[i % 3]; const prev = files[path] ?? ''; const pos = Math.floor((i * 7) % (prev.length + 1));
    files[path] = i % 11 === 0 ? prev.slice(0, pos) : prev.slice(0, pos) + `line ${i}\n` + prev.slice(pos);
    appendHistory(list, entry(path, files[path], 'edit', n++)); expected.push({ ...files });
  }
  for (const k of [0, 1, 2, 39, 40, 41, 120, 299]) assert.deepEqual(reconstruct(list, k), expected[k], `state at ${k}`);
  assert.ok(list.some((e) => e.patch) && list.some((e) => e.content !== undefined), 'mix of patches and checkpoints');
  assert.deepEqual(stateAt(list, 150), expected[150]);
});

test('patches keep storage small for big files', () => {
  const list = []; let text = 'x'.repeat(50_000); appendHistory(list, entry('big.txt', text));
  for (let i = 0; i < 30; i++) { text = text.slice(0, 100 + i) + 'ab' + text.slice(100 + i); appendHistory(list, entry('big.txt', text, 'edit', i + 1)); }
  assert.ok(JSON.stringify(list).length < 50_000 * 2, `stored ${JSON.stringify(list).length} bytes for 31 saves of a 50 KB file`);
  assert.equal(reconstruct(list)['big.txt'] === text, true);
});

test('paste markers still work on patch entries and legacy entries', () => {
  const list = []; appendHistory(list, entry('a.js', 'const a = 1;\n')); appendHistory(list, entry('a.js', 'const a = 1;\n' + 'p'.repeat(900), 'edit', 1)); appendHistory(list, entry('a.js', 'const a = 1;\n' + 'p'.repeat(900) + 'x', 'edit', 2));
  const ev = replayEvents(list); assert.deepEqual(ev.map((e) => e.paste), [false, true, false]); assert.equal(ev[1].size, 913);
  const legacy = [{ path: 'a.js', content: 'x', actor: 'A', kind: 'file_created', createdAt: 1 }, { path: 'a.js', content: 'x'.repeat(900), actor: 'A', kind: 'edit', createdAt: 2 }];
  assert.equal(replayEvents(legacy)[1].paste, true); assert.equal(stateAt(legacy, 1)['a.js'].length, 900);
});

test('trimming old history keeps the remaining entries reconstructable', () => {
  const list = []; const files = {}; const snapshots = [];
  for (let i = 0; i < 200; i++) { const path = i % 2 ? 'a.txt' : 'b.txt'; files[path] = (files[path] ?? '') + `edit ${i}\n`; appendHistory(list, entry(path, files[path], 'edit', i)); snapshots.push({ ...files }); }
  trim(list, 50); assert.equal(list.length, 50);
  for (const k of [0, 10, 49]) assert.deepEqual(reconstruct(list, k), Object.fromEntries(Object.entries(snapshots[150 + k]).filter(([p]) => list.slice(0, k + 1).some((e) => e.path === p))), `after trim, point ${k}`);
  assert.deepEqual(reconstruct(list), snapshots[199]);
  assert.ok(MAX_ENTRIES >= 20000);
});
