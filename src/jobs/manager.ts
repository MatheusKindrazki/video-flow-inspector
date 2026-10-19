import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

export type AnalysisJobStatus = "queued" | "running" | "completed" | "failed" | "cancelled" | "interrupted";
export interface AnalysisJobSnapshot {
  id: string;
  status: AnalysisJobStatus;
  created_at: string;
  updated_at: string;
  progress?: Record<string, unknown>;
  error?: string;
}
export interface AnalysisJobOptions<I, O> {
  directory: string;
  execute: (input: I, options: { signal: AbortSignal; onProgress: (value: Record<string, unknown>) => void }) => Promise<O>;
  maxConcurrent?: number;
  maxQueued?: number;
  retentionMs?: number;
  maxRetainedJobs?: number;
  maxResultBytes?: number;
}
interface StoredJob<O> { job: AnalysisJobSnapshot; result?: O }
interface Owner { pid: number; token: string }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TERMINAL = new Set<AnalysisJobStatus>(["completed", "failed", "cancelled", "interrupted"]);
const STATUSES = new Set<AnalysisJobStatus>([...TERMINAL, "queued", "running"]);
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const code = (error: unknown): string | undefined => (error as NodeJS.ErrnoException)?.code;
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return code(error) !== "ESRCH"; }
}
function positive(value: number, name: string, allowZero = false): number {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) throw new Error(`Invalid ${name}`);
  return value;
}

/** A bounded local queue. Inputs stay in memory; only snapshots and results are persisted.
 * One writer owns a directory. Restarted work is interrupted, never automatically replayed.
 * Executors must honor AbortSignal; cancelled executions retain their slot until settled.
 */
export class AnalysisJobManager<I, O> {
  private readonly directory: string;
  private readonly execute: AnalysisJobOptions<I, O>["execute"];
  private readonly maxConcurrent: number;
  private readonly maxQueued: number;
  private readonly retentionMs: number;
  private readonly maxRetainedJobs: number;
  private readonly maxResultBytes: number;
  private readonly owner: Owner = { pid: process.pid, token: randomUUID() };
  private readonly records = new Map<string, StoredJob<O>>();
  private readonly inputs = new Map<string, I>();
  private readonly progressUpdates = new Map<string, Record<string, unknown>>();
  private readonly queue: string[] = [];
  private readonly active = new Map<string, { controller: AbortController; task: Promise<void> }>();
  private readonly ready: Promise<void>;
  private operations: Promise<unknown> = Promise.resolve();
  private closing = false;
  private shutdown?: Promise<void>;
  private ownsLock = false;

  constructor(options: AnalysisJobOptions<I, O>) {
    this.directory = resolve(options.directory);
    this.execute = options.execute;
    this.maxConcurrent = positive(options.maxConcurrent ?? 1, "maxConcurrent");
    this.maxQueued = positive(options.maxQueued ?? 4, "maxQueued", true);
    this.retentionMs = positive(options.retentionMs ?? 86_400_000, "retentionMs");
    this.maxRetainedJobs = positive(options.maxRetainedJobs ?? 100, "maxRetainedJobs");
    this.maxResultBytes = positive(options.maxResultBytes ?? 10 * 1024 * 1024, "maxResultBytes");
    this.ready = this.initialize();
    // A manager may be constructed before its first call; prevent an unhandled rejection.
    void this.ready.catch(() => undefined);
  }

  async start(input: I): Promise<AnalysisJobSnapshot> {
    return this.operation(async () => {
      this.assertOpen();
      await this.cleanup();
      if (this.active.size >= this.maxConcurrent && this.queue.length >= this.maxQueued) throw new Error("Analysis queue is full");
      const now = new Date().toISOString();
      const record: StoredJob<O> = { job: { id: randomUUID(), status: "queued", created_at: now, updated_at: now } };
      await this.persist(record);
      this.records.set(record.job.id, record);
      this.inputs.set(record.job.id, input);
      this.queue.push(record.job.id);
      await this.pump();
      return clone(record.job);
    });
  }

  async get(jobId: string): Promise<AnalysisJobSnapshot> {
    this.validateId(jobId);
    return this.operation(async () => { this.assertOpen(); await this.cleanup(); return clone(this.find(jobId).job); });
  }

  async result(jobId: string): Promise<{ job: AnalysisJobSnapshot; result?: O }> {
    this.validateId(jobId);
    return this.operation(async () => { this.assertOpen(); await this.cleanup(); return clone(this.find(jobId)); });
  }

  async cancel(jobId: string): Promise<AnalysisJobSnapshot> {
    this.validateId(jobId);
    return this.operation(async () => {
      this.assertOpen();
      const record = this.find(jobId);
      if (!TERMINAL.has(record.job.status)) {
        record.job.status = "cancelled";
        record.job.updated_at = new Date().toISOString();
        delete record.result;
        this.inputs.delete(jobId);
        const index = this.queue.indexOf(jobId);
        if (index !== -1) this.queue.splice(index, 1);
        this.active.get(jobId)?.controller.abort();
        await this.persist(record);
      }
      return clone(record.job);
    });
  }

  close(): Promise<void> { return this.shutdown ??= this.finishClose(); }

  private async finishClose(): Promise<void> {
    await this.ready;
    await this.operation(async () => {
      this.closing = true;
      for (const record of this.records.values()) {
        if (!TERMINAL.has(record.job.status)) {
          record.job.status = "interrupted";
          record.job.error = "Server stopped before analysis completed. Start a new job explicitly to retry.";
          record.job.updated_at = new Date().toISOString();
          await this.persist(record);
        }
      }
      this.queue.length = 0;
      this.inputs.clear();
      for (const value of this.active.values()) value.controller.abort();
    });
    // Never release ownership while an old executor could still write into the directory.
    await Promise.allSettled([...this.active.values()].map(value => value.task));
    await this.operations;
    await this.releaseLock();
  }

  private async operation<T>(fn: () => Promise<T>): Promise<T> {
    await this.ready;
    const next = this.operations.then(fn);
    this.operations = next.catch(() => undefined);
    return next;
  }
  private assertOpen(): void { if (this.closing) throw new Error("Analysis job manager is closed"); }
  private validateId(id: string): void { if (!UUID.test(id)) throw new Error("Invalid job id"); }
  private find(id: string): StoredJob<O> { const record = this.records.get(id); if (!record) throw new Error("Analysis job not found or expired"); return record; }
  private async persist(record: StoredJob<O>): Promise<void> {
    const contents = JSON.stringify(record);
    if (Buffer.byteLength(contents) > this.maxResultBytes + 32_768) throw new Error("Analysis result exceeds storage limit");
    const temporary = join(this.directory, `.${record.job.id}.${randomUUID()}.tmp`);
    try { await writeFile(temporary, contents, { flag: "wx", mode: 0o600 }); await rename(temporary, join(this.directory, `${record.job.id}.json`)); }
    finally { await unlink(temporary).catch(() => undefined); }
  }

  private async pump(): Promise<void> {
    while (!this.closing && this.active.size < this.maxConcurrent && this.queue.length) {
      const id = this.queue.shift()!;
      const record = this.find(id);
      const input = this.inputs.get(id)!;
      this.inputs.delete(id);
      record.job.status = "running";
      record.job.updated_at = new Date().toISOString();
      await this.persist(record);
      const controller = new AbortController();
      // Defer execution until the active slot is registered, even for synchronous executors.
      const task = Promise.resolve().then(async () => {
        try {
          const result = await this.execute(input, {
            signal: controller.signal,
            onProgress: (progress) => {
              let safe: Record<string, unknown>;
              try { const json = JSON.stringify(progress); if (!json || Buffer.byteLength(json) > 16_384) return; safe = JSON.parse(json) as Record<string, unknown>; } catch { return; }
              const pending = this.progressUpdates.has(id);
              this.progressUpdates.set(id, safe);
              if (pending) return;
              void this.operation(async () => {
                const latest = this.progressUpdates.get(id);
                this.progressUpdates.delete(id);
                if (!latest || record.job.status !== "running" || this.closing) return;
                record.job.progress = latest;
                record.job.updated_at = new Date().toISOString();
                await this.persist(record);
              }).catch(() => { this.progressUpdates.delete(id); });
            },
          });
          await this.operation(async () => {
            if (record.job.status !== "running" || controller.signal.aborted || this.closing) return;
            const serialized = JSON.stringify(result);
            if (serialized === undefined || Buffer.byteLength(serialized) > this.maxResultBytes) throw new Error("Result exceeds storage limit");
            const completed: StoredJob<O> = {
              job: { ...record.job, status: "completed", updated_at: new Date().toISOString() },
              result: JSON.parse(serialized) as O,
            };
            await this.persist(completed);
            record.result = completed.result;
            record.job = completed.job;
          });
        } catch {
          await this.operation(async () => {
            if (record.job.status !== "running" || this.closing) return;
            delete record.result;
            record.job.status = controller.signal.aborted ? "cancelled" : "failed";
            record.job.error = "Analysis failed. Provider credentials, source URLs and internal errors are not included in job records.";
            record.job.updated_at = new Date().toISOString();
            await this.persist(record);
          }).catch(() => undefined);
        } finally {
          await this.operation(async () => { this.active.delete(id); if (!this.closing) { await this.cleanup(); await this.pump(); } }).catch(() => undefined);
        }
      });
      this.active.set(id, { controller, task });
    }
  }

  private async cleanup(): Promise<void> {
    const terminal = [...this.records.values()].filter(record => TERMINAL.has(record.job.status) && !this.active.has(record.job.id))
      .sort((a, b) => a.job.updated_at.localeCompare(b.job.updated_at));
    let excess = Math.max(0, this.records.size - this.maxRetainedJobs);
    for (const record of terminal) {
      if (Date.now() - Date.parse(record.job.updated_at) >= this.retentionMs || excess > 0) {
        await unlink(join(this.directory, `${record.job.id}.json`)).catch(error => { if (code(error) !== "ENOENT") throw error; });
        this.records.delete(record.job.id);
        if (excess > 0) excess--;
      }
    }
  }

  private async readOwner(): Promise<Owner | null> {
    try {
      const owner = JSON.parse(await readFile(join(this.directory, ".owner.lock"), "utf8")) as Owner;
      if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0 || typeof owner.token !== "string") throw new Error("Invalid owner lock; manual recovery required");
      return owner;
    } catch (error) { if (code(error) === "ENOENT") return null; throw error; }
  }
  private async claimLock(): Promise<void> {
    const lock = join(this.directory, ".owner.lock");
    const claim = async () => {
      const file = await open(lock, "wx", 0o600);
      try { await file.writeFile(JSON.stringify(this.owner)); this.ownsLock = true; } finally { await file.close(); }
    };
    try { await lstat(join(this.directory, ".recovery.lock")); throw new Error("Directory ownership recovery in progress; manual recovery required if its process stopped"); }
    catch (error) { if (code(error) !== "ENOENT") throw error; }
    try { await claim(); return; } catch (error) { if (code(error) !== "EEXIST") throw error; }
    const owner = await this.readOwner();
    if (owner && alive(owner.pid)) throw new Error("Analysis directory is already owned by a live server; configure a different directory");
    // Serialize stale takeover so two recoverers cannot unlink a newly claimed live lock.
    const recoveryPath = join(this.directory, ".recovery.lock");
    let recovery;
    try { recovery = await open(recoveryPath, "wx", 0o600); }
    catch { throw new Error("Directory ownership recovery in progress; retry later"); }
    try {
      await recovery.writeFile(JSON.stringify(this.owner));
      const current = await this.readOwner();
      if (current && alive(current.pid)) throw new Error("Analysis directory is already owned by a live server");
      await unlink(lock).catch(error => { if (code(error) !== "ENOENT") throw error; });
      try { await claim(); } catch { throw new Error("Analysis directory is already owned by another server"); }
    } finally { await recovery.close(); await unlink(recoveryPath).catch(() => undefined); }
  }
  private async releaseLock(): Promise<void> {
    if (!this.ownsLock) return;
    const owner = await this.readOwner();
    if (owner?.token === this.owner.token) await unlink(join(this.directory, ".owner.lock"));
    this.ownsLock = false;
  }
  private async initialize(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const info = await lstat(this.directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Analysis directory must be a real directory");
    await chmod(this.directory, 0o700);
    await this.claimLock();
    try {
      for (const name of await readdir(this.directory)) {
        if (!name.endsWith(".json") || !UUID.test(name.slice(0, -5))) continue;
        const path = join(this.directory, name);
        const info = await lstat(path);
        if (!info.isFile() || info.isSymbolicLink() || info.size > this.maxResultBytes + 32_768) throw new Error("Unsafe or oversized analysis record");
        await chmod(path, 0o600);
        let record: StoredJob<O>;
        try { record = JSON.parse(await readFile(path, "utf8")) as StoredJob<O>; }
        catch { throw new Error("Invalid persisted analysis record"); }
        if (record?.job?.id !== name.slice(0, -5) || !STATUSES.has(record.job.status) || !Number.isFinite(Date.parse(record.job.created_at)) || !Number.isFinite(Date.parse(record.job.updated_at))) throw new Error("Invalid persisted analysis record");
        if (!TERMINAL.has(record.job.status)) {
          record.job.status = "interrupted";
          record.job.updated_at = new Date().toISOString();
          record.job.error = "Previous server stopped before analysis completed. Start a new job explicitly to retry.";
          delete record.result;
          await this.persist(record);
        }
        this.records.set(record.job.id, record);
      }
      // Remove incomplete atomic writes only after acquiring exclusive directory ownership.
      for (const name of await readdir(this.directory)) {
        const match = /^\.([0-9a-f-]+)\.([0-9a-f-]+)\.tmp$/i.exec(name);
        if (match && UUID.test(match[1]) && UUID.test(match[2])) await unlink(join(this.directory, name));
      }
      await this.cleanup();
    } catch (error) { await this.releaseLock(); throw error; }
  }
}
