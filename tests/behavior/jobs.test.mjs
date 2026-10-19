import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AnalysisJobManager } from '../../dist/jobs/manager.js';

const tick = () => new Promise(resolve => setTimeout(resolve, 10));
async function until(fn) { for (let i = 0; i < 100; i++) { const value = await fn(); if (value) return value; await tick(); } throw new Error('Timed out'); }
async function directory(t) { const dir = await mkdtemp(join(tmpdir(), 'vfi-jobs-test-')); t.after(() => rm(dir, { recursive: true, force: true })); return dir; }

test('completes, persists progress/result privately, never persists input, and retrieves after restart', async t => {
  const dir = await directory(t);
  const manager = new AnalysisJobManager({ directory: dir, execute: async (input, { onProgress }) => { onProgress({ stage: 'analysis', completed: 1 }); return { answer: input.value }; } });
  const job = await manager.start({ value: 42, source: 'SECRET_URL_TOKEN' });
  await until(async () => (await manager.get(job.id)).status === 'completed');
  assert.deepEqual((await manager.result(job.id)).result, { answer: 42 });
  const persisted = await readFile(join(dir, `${job.id}.json`), 'utf8');
  assert.equal(persisted.includes('SECRET_URL_TOKEN'), false);
  assert.equal((await stat(join(dir, `${job.id}.json`))).mode & 0o777, 0o600);
  assert.equal((await stat(dir)).mode & 0o777, 0o700);
  await manager.close();
  const restarted = new AnalysisJobManager({ directory: dir, execute: async () => { throw new Error('must not replay'); } });
  assert.deepEqual((await restarted.result(job.id)).result, { answer: 42 });
  await restarted.close();
});

test('bounds queue and does not release a cancelled running slot until executor settles', async t => {
  const dir = await directory(t); let release; let calls = 0; let firstSignal;
  const pending = new Promise(resolve => { release = resolve; });
  const manager = new AnalysisJobManager({ directory: dir, maxConcurrent: 1, maxQueued: 1, execute: async (_input, { signal }) => { calls++; if (calls === 1) { firstSignal = signal; await pending; } return calls; } });
  const first = await manager.start({});
  await until(() => calls === 1);
  const second = await manager.start({});
  await assert.rejects(manager.start({}), /queue is full/i);
  assert.equal((await manager.cancel(first.id)).status, 'cancelled');
  assert.equal(firstSignal.aborted, true);
  await tick(); assert.equal(calls, 1);
  assert.equal((await manager.get(second.id)).status, 'queued');
  release();
  await until(async () => (await manager.get(second.id)).status === 'completed');
  assert.equal((await manager.result(first.id)).result, undefined);
  assert.equal(calls, 2);
  await manager.close();
});

test('cancels queued jobs without executing them and sanitizes executor failures', async t => {
  const dir = await directory(t); let release;
  const pending = new Promise(resolve => { release = resolve; }); let calls = 0;
  const manager = new AnalysisJobManager({ directory: dir, execute: async () => { calls++; await pending; throw new Error('API_KEY=SECRET https://signed-url/token'); } });
  const first = await manager.start({}); await until(() => calls === 1);
  const queued = await manager.start({}); await manager.cancel(queued.id); release();
  const failed = await until(async () => { const value = await manager.get(first.id); return value.status === 'failed' && value; });
  assert.equal(failed.error.includes('SECRET'), false);
  assert.equal(calls, 1); assert.equal((await manager.get(queued.id)).status, 'cancelled');
  await manager.close();
});

test('rejects invalid job IDs and refuses a second live directory owner', async t => {
  const dir = await directory(t);
  const manager = new AnalysisJobManager({ directory: dir, execute: async () => 1 });
  await assert.rejects(manager.get('../../outside'), /invalid job id/i);
  const job = await manager.start({});
  const second = new AnalysisJobManager({ directory: dir, execute: async () => 2 });
  await assert.rejects(second.get(job.id), /already owned/i);
  await manager.close();
});

test('recovers orphaned records as interrupted, without replaying or storing inputs', async t => {
  const dir = await directory(t); const id = randomUUID(); const now = new Date().toISOString();
  await writeFile(join(dir, `${id}.json`), JSON.stringify({ job: { id, status: 'running', created_at: now, updated_at: now } }));
  await writeFile(join(dir, '.owner.lock'), JSON.stringify({ pid: 2147483647, token: randomUUID() }));
  let calls = 0;
  const manager = new AnalysisJobManager({ directory: dir, execute: async () => { calls++; } });
  assert.equal((await manager.get(id)).status, 'interrupted');
  assert.equal(calls, 0);
  await manager.close();
});

test('expires only terminal jobs during operations', async t => {
  const dir = await directory(t); const id = randomUUID(); const old = new Date(Date.now() - 60_000).toISOString();
  await writeFile(join(dir, `${id}.json`), JSON.stringify({ job: { id, status: 'completed', created_at: old, updated_at: old }, result: 1 }));
  const manager = new AnalysisJobManager({ directory: dir, retentionMs: 1000, execute: async () => 1 });
  await assert.rejects(manager.get(id), /not found/i);
  await assert.rejects(stat(join(dir, `${id}.json`)), { code: 'ENOENT' });
  await manager.close();
});

test('rejects oversized results without persisting payload or an apparently successful status', async t => {
  const dir = await directory(t);
  const manager = new AnalysisJobManager({ directory: dir, maxResultBytes: 16, execute: async () => ({ payload: 'PRIVATE'.repeat(100) }) });
  const job = await manager.start({});
  await until(async () => (await manager.get(job.id)).status === 'failed');
  const value = await manager.result(job.id);
  assert.equal(value.result, undefined);
  assert.equal((await readFile(join(dir, `${job.id}.json`), 'utf8')).includes('PRIVATE'), false);
  await manager.close();
});

test('close propagates abort, records interruption, and never replays queued work after restart', async t => {
  const dir = await directory(t); let started = false; let aborted = false;
  const manager = new AnalysisJobManager({ directory: dir, execute: async (_input, { signal }) => { started = true; await new Promise(resolve => signal.addEventListener('abort', () => { aborted = true; resolve(); }, { once: true })); return 'not saved'; } });
  const running = await manager.start({}); await until(() => started);
  const queued = await manager.start({});
  await manager.close(); assert.equal(aborted, true);
  const restarted = new AnalysisJobManager({ directory: dir, execute: async () => { throw new Error('must not execute'); } });
  assert.equal((await restarted.get(running.id)).status, 'interrupted');
  assert.equal((await restarted.get(queued.id)).status, 'interrupted');
  assert.equal((await restarted.result(running.id)).result, undefined);
  await restarted.close();
});

test('bounds retained terminal records and protects returned snapshots from caller mutations', async t => {
  const dir = await directory(t);
  const manager = new AnalysisJobManager({ directory: dir, maxRetainedJobs: 2, execute: async () => ({ ok: true }) });
  const ids = [];
  for (let i = 0; i < 5; i++) { const job = await manager.start({}); ids.push(job.id); await until(async () => (await manager.get(job.id)).status === 'completed'); }
  await assert.rejects(manager.get(ids[0]), /not found/i);
  const snapshot = await manager.get(ids.at(-1)); snapshot.status = 'failed';
  assert.equal((await manager.get(ids.at(-1))).status, 'completed');
  await manager.close();
});
test('concurrent close calls share settlement and directory-lock release',async t=>{
 const dir=await directory(t);let release;let entered;
 const started=new Promise(r=>entered=r);const wait=new Promise(r=>release=r);
 const m=new AnalysisJobManager({directory:dir,execute:async()=>{entered();await wait;return 1;}});await m.start({});await started;
 const a=m.close();const b=m.close();assert.strictEqual(a,b);release();await Promise.all([a,b]);
 const replacement=new AnalysisJobManager({directory:dir,execute:async()=>2});const job=await replacement.start({});assert.ok(job.id);await replacement.close();
});
