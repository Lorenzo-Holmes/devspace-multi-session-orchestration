import assert from 'node:assert/strict';
import { cpus, tmpdir } from 'node:os';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { DAG_SHAPES, FIXED_NOW, FULL_SIZES, makeTasks, percentiles } from './fixtures.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const [mode = 'smoke', output] = process.argv.slice(2);
const report = { schemaVersion: 1, status: 'FAIL', scope: 'actual CoordinatorStore API; other subsystem adapters are not implemented',
  environment: { node: process.version, platform: process.platform, arch: process.arch, nativeABI: process.versions.modules,
    cpuModel: cpus()[0]?.model ?? 'unknown', logicalCpus: cpus().length },
  requestedDatasetSizes: FULL_SIZES, cases: [],
  notCovered: ['session lookup/list/events/health', 'coordinator manager ready discovery', 'file-intent conflict scans',
    'watchdog scan/reconciliation/list', 'automation poll/list/ack', 'integration list/status/evidence',
    'handoff reads', 'supervisor summary/timeline/output bounds', 'workspace registry'],
  instrumentation: { rowsScanned: 'unavailable', sqliteQueryCount: 'unavailable', latencyUnit: 'milliseconds',
    memory: 'sampled process RSS/heap, not native peak', timing: 'API latency excludes serialization; serialization measured separately' } };
const fileSize = async path => stat(path).then(s => s.size, error => { if (error.code === 'ENOENT') return 0; throw error; });
try {
  assert.ok(['smoke', 'full'].includes(mode), 'Use smoke or full');
  const compiled = join(root, 'dist/coordinator-store.js');
  const present = await stat(compiled).then(s => s.isFile(), error => { if (error.code === 'ENOENT') return false; throw error; });
  if (!present) {
    report.status = 'ENVIRONMENT_SKIP'; report.reason = 'Built dist/coordinator-store.js is absent; run the canonical build first';
  } else {
    let CoordinatorStore;
    try { ({ CoordinatorStore } = await import(pathToFileURL(compiled).href)); }
    catch (error) {
      if (error.code !== 'ERR_MODULE_NOT_FOUND' && error.code !== 'MODULE_NOT_FOUND') throw error;
      report.status = 'ENVIRONMENT_SKIP'; report.reason = 'A compiled-runtime dependency is missing';
    }
    if (CoordinatorStore) {
      const sizes = mode === 'full' ? FULL_SIZES.tasks : [100];
      const samples = mode === 'full' ? 100 : 30;
      for (const size of sizes) for (const shape of DAG_SHAPES) {
        const state = await mkdtemp(join(tmpdir(), 'devspace-benchmark-'));
        let store;
        try {
          store = new CoordinatorStore(state);
          const tasks = makeTasks(size, shape), project = 'isolated-benchmark-project';
          store.createPlan(project, tasks, FIXED_NOW);
          for (const [operation, run] of [
            ['list', () => { const rows = store.listTasks(project, 500); assert.equal(rows.length, Math.min(500, size)); return rows; }],
            ['lookup', () => { const task = store.getTask(tasks.at(-1).id); assert.equal(task.id, tasks.at(-1).id); return task; }],
            ['dependency-resolution', () => { const rows = store.dependencyStates(tasks.at(-1).id); assert.equal(rows.length, tasks.at(-1).dependencies.length); return rows; }],
          ]) {
            for (let i = 0; i < 3; i++) run();
            const latency = [], serialization = [], rss = [], heap = [], payload = [];
            for (let i = 0; i < samples; i++) {
              const started = performance.now(), value = run(); latency.push(performance.now() - started);
              const encodedAt = performance.now(), encoded = JSON.stringify(value); serialization.push(performance.now() - encodedAt);
              payload.push(Buffer.byteLength(encoded)); const memory = process.memoryUsage(); rss.push(memory.rss); heap.push(memory.heapUsed);
            }
            report.cases.push({ operation, shape, datasetRows: size, latency: percentiles(latency), serialization: percentiles(serialization),
              maxPayloadBytes: Math.max(...payload), maxObservedRssBytes: Math.max(...rss), maxObservedHeapBytes: Math.max(...heap),
              databaseBytes: await fileSize(join(state, 'devspace.sqlite')), walBytes: await fileSize(join(state, 'devspace.sqlite-wal')),
              rowsScanned: null, sqliteQueryCount: null });
          }
        } finally { try { store?.close(); } finally { await rm(state, { recursive: true, force: true }); } }
      }
      report.status = 'PASS';
    }
  }
} catch (error) { report.status = 'FAIL'; report.reason = error.message; }
if (output) await writeFile(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify(report));
process.exitCode = report.status === 'PASS' ? 0 : report.status === 'ENVIRONMENT_SKIP' ? 2 : 1;
