import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { enforceCachePolicy } from "../src/cache.js";

const tempPaths: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("cache retention", () => {
  it("removes expired entries and evicts least-recently-used entries by size", async () => {
    const root = await mkdtemp(join(tmpdir(), "vu-cache-"));
    tempPaths.push(root);
    const oldEntry = join(root, "probe-v1", "old");
    const recentEntry = join(root, "frames-v1", "recent");
    const newestEntry = join(root, "transcript-v1", "newest");
    await Promise.all([
      mkdir(oldEntry, { recursive: true }),
      mkdir(recentEntry, { recursive: true }),
      mkdir(newestEntry, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(oldEntry, "data"), "old"),
      writeFile(join(recentEntry, "data"), "123456"),
      writeFile(join(newestEntry, "data"), "abcdef"),
    ]);
    const now = Date.now();
    await Promise.all([
      utimes(oldEntry, new Date(now - 20_000), new Date(now - 20_000)),
      utimes(recentEntry, new Date(now - 2_000), new Date(now - 2_000)),
      utimes(newestEntry, new Date(now - 1_000), new Date(now - 1_000)),
    ]);

    await enforceCachePolicy(
      {
        cacheDir: root,
        cacheMaxAgeMs: 10_000,
        cacheMaxBytes: 6,
      },
      [],
      now,
    );

    await expect(readFile(join(oldEntry, "data"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(readFile(join(recentEntry, "data"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(readFile(join(newestEntry, "data"), "utf8")).resolves.toBe(
      "abcdef",
    );
  });

  it("does not evict an active entry", async () => {
    const root = await mkdtemp(join(tmpdir(), "vu-cache-preserve-"));
    tempPaths.push(root);
    const entry = join(root, "frames-v1", "active");
    await mkdir(entry, { recursive: true });
    await writeFile(join(entry, "data"), "larger than policy");

    await enforceCachePolicy(
      {
        cacheDir: root,
        cacheMaxAgeMs: 1,
        cacheMaxBytes: 1,
      },
      [entry],
      Date.now() + 10_000,
    );

    await expect(readFile(join(entry, "data"), "utf8")).resolves.toBe(
      "larger than policy",
    );
  });
});
