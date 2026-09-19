import assert from 'node:assert/strict';
import test from 'node:test';
import { DAG_SHAPES, FULL_SIZES, makeTasks, makeWorkload, percentiles } from './fixtures.mjs';
for (const shape of DAG_SHAPES) test('deterministic acyclic DAG: ' + shape, () => {
  const tasks = makeTasks(100, shape), seen = new Set();
  assert.deepEqual(tasks, makeTasks(100, shape));
  for (const task of tasks) { assert.ok(task.dependencies.every(id => seen.has(id))); seen.add(task.id); }
  if (shape === 'fan-in') assert.equal(tasks.at(-1).dependencies.length, 99);
  if (shape === 'fan-out') assert.equal(tasks.filter(task => task.dependencies.includes(tasks[0].id)).length, 99);
});
test('full dataset plan includes every requested cardinality', () => {
  assert.deepEqual(FULL_SIZES.fileIntents, [1000, 10000, 100000]);
  assert.deepEqual(FULL_SIZES.tasks, [100, 1000, 10000]);
  for (const domain of Object.keys(FULL_SIZES)) assert.equal(makeWorkload(domain, 100).length, 100);
});
test('100000 distinct intents, dense overlap and project/worktree distributions are reproducible', () => {
  const disjoint = makeWorkload('fileIntents', 100000, { projects: 10, worktrees: 100 });
  assert.equal(new Set(disjoint.map(item => item.path)).size, 100000);
  assert.equal(new Set(disjoint.map(item => item.projectIndex)).size, 10);
  assert.equal(new Set(disjoint.map(item => item.worktreeIndex)).size, 100);
  assert.equal(new Set(makeWorkload('fileIntents', 1000, { overlap: true }).map(item => item.path)).size, 1);
});
test('nearest-rank percentiles do not mutate samples', () => {
  const samples = Array.from({ length: 100 }, (_, i) => 100 - i);
  assert.deepEqual(percentiles(samples), { samples: 100, p50: 50, p95: 95, p99: 99, max: 100 });
  assert.equal(samples[0], 100);
  assert.throws(() => percentiles([])); assert.throws(() => percentiles([NaN]));
});
test('invalid and oversized fixtures fail before allocation', () => {
  for (const size of [0, -1, 1.5, NaN, 100001]) assert.throws(() => makeTasks(size, 'linear'));
  assert.throws(() => makeTasks(1, 'unknown'));
  assert.throws(() => makeWorkload('unknown', 100));
});
