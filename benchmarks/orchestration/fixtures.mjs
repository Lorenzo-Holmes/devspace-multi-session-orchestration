import assert from 'node:assert/strict';

export const FULL_SIZES = Object.freeze({ sessions: [100, 1000, 10000], tasks: [100, 1000, 10000],
  fileIntents: [1000, 10000, 100000], alerts: [1000, 10000], dueWork: [1000, 10000],
  integrations: [100, 1000, 10000], handoffs: [100, 1000, 10000] });
export const DAG_SHAPES = Object.freeze(['linear', 'wide', 'fan-in', 'fan-out']);
export const FIXED_NOW = '2026-01-01T00:00:00.000Z';
function count(value) { assert.ok(Number.isSafeInteger(value) && value > 0 && value <= 100000, 'Dataset size must be 1..100000'); }
export function makeTasks(size, shape) {
  count(size); assert.ok(DAG_SHAPES.includes(shape), 'Unknown DAG shape');
  const id = index => 'bench_task_' + String(index).padStart(6, '0');
  const width = Math.ceil(Math.sqrt(size));
  return Array.from({ length: size }, (_, index) => ({ id: id(index), name: 'task-' + index,
    description: 'Deterministic isolated scalability fixture', priority: index % 7,
    dependencies: shape === 'linear' ? (index ? [id(index - 1)] : [])
      : shape === 'wide' ? (index >= width ? [id(index - width)] : [])
      : shape === 'fan-in' ? (index === size - 1 ? Array.from({ length: index }, (_, i) => id(i)) : [])
      : (index ? [id(0)] : []) }));
}
// Workload descriptors, not undocumented production table rows. Adapters must use supported APIs.
export function makeWorkload(domain, size, { projects = 1, worktrees = 1, overlap = false } = {}) {
  count(size); count(projects); count(worktrees); assert.ok(Object.hasOwn(FULL_SIZES, domain), 'Unknown domain');
  return Array.from({ length: size }, (_, index) => ({ id: 'bench_' + domain + '_' + index,
    projectIndex: index % projects, worktreeIndex: index % worktrees,
    ...(domain === 'fileIntents' ? { path: overlap ? 'src/shared.ts' : 'src/file-' + index + '.ts' } : {}) }));
}
export function percentiles(samples) {
  assert.ok(Array.isArray(samples) && samples.length > 0 && samples.every(v => Number.isFinite(v) && v >= 0), 'Nonempty finite samples required');
  const values = [...samples].sort((a, b) => a - b);
  const at = p => values[Math.max(0, Math.ceil(values.length * p) - 1)];
  return { samples: values.length, p50: at(0.5), p95: at(0.95), p99: at(0.99), max: values.at(-1) };
}
