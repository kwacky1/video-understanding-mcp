import {
  lstat,
  mkdir,
  readdir,
  rm,
  stat,
  utimes,
} from "node:fs/promises";
import { join, resolve } from "node:path";

export interface CachePolicy {
  cacheDir: string;
  cacheMaxAgeMs: number;
  cacheMaxBytes: number;
}

interface CacheEntry {
  path: string;
  modifiedMs: number;
  sizeBytes: number;
}

export async function enforceCachePolicy(
  policy: CachePolicy,
  preservePaths: string[] = [],
  now = Date.now(),
): Promise<void> {
  await mkdir(policy.cacheDir, { recursive: true, mode: 0o700 });
  const preserved = new Set(preservePaths.map((path) => resolve(path)));
  const entries = await listCacheEntries(policy.cacheDir);
  const cutoff = now - policy.cacheMaxAgeMs;
  const retained: CacheEntry[] = [];

  for (const entry of entries) {
    if (entry.modifiedMs < cutoff && !preserved.has(resolve(entry.path))) {
      await rm(entry.path, { recursive: true, force: true });
    } else {
      retained.push(entry);
    }
  }

  let totalBytes = retained.reduce((sum, entry) => sum + entry.sizeBytes, 0);
  for (const entry of retained.sort(
    (left, right) => left.modifiedMs - right.modifiedMs,
  )) {
    if (totalBytes <= policy.cacheMaxBytes) {
      break;
    }
    if (preserved.has(resolve(entry.path))) {
      continue;
    }
    await rm(entry.path, { recursive: true, force: true });
    totalBytes -= entry.sizeBytes;
  }
}

export async function touchCacheEntry(path: string): Promise<void> {
  const now = new Date();
  try {
    await utimes(path, now, now);
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !("code" in error) ||
      error.code !== "ENOENT"
    ) {
      throw error;
    }
  }
}

async function listCacheEntries(cacheDir: string): Promise<CacheEntry[]> {
  const entries: CacheEntry[] = [];
  for (const stage of await readdir(cacheDir, { withFileTypes: true })) {
    if (!stage.isDirectory() || stage.name.includes(".tmp-")) {
      continue;
    }
    const stagePath = join(cacheDir, stage.name);
    let stageEntries;
    try {
      stageEntries = await readdir(stagePath, { withFileTypes: true });
    } catch (error) {
      if (isMissing(error)) continue;
      throw error;
    }
    for (const item of stageEntries) {
      if (!item.isDirectory() || item.name.includes(".tmp-")) {
        continue;
      }
      const path = join(stagePath, item.name);
      try {
        const [metadata, sizeBytes] = await Promise.all([
          stat(path),
          directorySize(path),
        ]);
        entries.push({ path, modifiedMs: metadata.mtimeMs, sizeBytes });
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
    }
  }
  return entries;
}

async function directorySize(path: string): Promise<number> {
  let total = 0;
  let entries;
  try {
    entries = await readdir(path, { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) return 0;
    throw error;
  }
  for (const entry of entries) {
    const childPath = join(path, entry.name);
    if (entry.isDirectory()) {
      total += await directorySize(childPath);
      continue;
    }
    const metadata = await lstat(childPath);
    if (metadata.isFile()) {
      total += metadata.size;
    }
  }
  return total;
}

function isMissing(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    error.code === "ENOENT"
  );
}
