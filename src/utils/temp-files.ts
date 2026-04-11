import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const activeDirs: Set<TempDir> = new Set();
let cleanupRegistered = false;

function registerProcessCleanup(): void {
  if (cleanupRegistered) {
    return;
  }
  cleanupRegistered = true;

  const cleanup = () => {
    for (const dir of activeDirs) {
      try {
        // Synchronous best-effort cleanup on exit — fs.rmSync is acceptable here
        // since the process is shutting down and async ops won't complete.
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const fs = require("node:fs");
        fs.rmSync(dir.path, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup; ignore errors on process exit
      }
    }
    activeDirs.clear();
  };

  process.on("exit", cleanup);
  process.on("SIGINT", () => {
    cleanup();
    process.exit(1);
  });
  process.on("SIGTERM", () => {
    cleanup();
    process.exit(0);
  });
}

export class TempDir {
  public readonly path: string;

  constructor(path: string) {
    this.path = path;
    activeDirs.add(this);
    registerProcessCleanup();
  }

  filePath(name: string): string {
    return join(this.path, name);
  }

  async cleanup(): Promise<void> {
    activeDirs.delete(this);
    await rm(this.path, { recursive: true, force: true });
  }
}

export async function createTempDir(prefix = "video-flow-"): Promise<TempDir> {
  const dirPath = await mkdtemp(join(tmpdir(), prefix));
  return new TempDir(dirPath);
}
