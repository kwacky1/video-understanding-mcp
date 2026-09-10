import { mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";
import { rm } from "node:fs/promises";

import {
  validateInputPath,
  validateOutputDirectory,
} from "../src/path-policy.js";

const tempPaths: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  tempPaths.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(
    tempPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("validateInputPath", () => {
  it("accepts a regular file within an allowed root", async () => {
    const root = await makeTempDir("vu-root-");
    const file = join(root, "video.mp4");
    await writeFile(file, "fixture");

    const result = await validateInputPath(file, [root], 100);

    expect(result.path).toBe(await realpath(file));
    expect(result.sizeBytes).toBe(7);
    expect(result.pathHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("rejects relative paths", async () => {
    await expect(validateInputPath("video.mp4", ["/tmp"], 100)).rejects.toMatchObject(
      { code: "RELATIVE_PATH" },
    );
  });

  it("rejects files outside allowed roots", async () => {
    const root = await makeTempDir("vu-root-");
    const outside = await makeTempDir("vu-outside-");
    const file = join(outside, "video.mp4");
    await writeFile(file, "fixture");

    await expect(validateInputPath(file, [root], 100)).rejects.toMatchObject({
      code: "PATH_OUTSIDE_ALLOWED_ROOTS",
    });
  });

  describe("validateOutputDirectory", () => {
    it("accepts a directory inside a writable root", async () => {
      const root = await makeTempDir("vu-output-root-");
      const output = join(root, "transcripts");
      await mkdir(output);

      await expect(validateOutputDirectory(output, [root])).resolves.toBe(
        await realpath(output),
      );
    });

    it("rejects relative output directories", async () => {
      await expect(
        validateOutputDirectory("transcripts", ["/tmp"]),
      ).rejects.toMatchObject({ code: "RELATIVE_PATH" });
    });

    it("rejects output directories outside writable roots", async () => {
      const root = await makeTempDir("vu-output-root-");
      const outside = await makeTempDir("vu-output-outside-");

      await expect(
        validateOutputDirectory(outside, [root]),
      ).rejects.toMatchObject({ code: "PATH_OUTSIDE_ALLOWED_ROOTS" });
    });

    it("rejects symlinked output directories that escape writable roots", async () => {
      const root = await makeTempDir("vu-output-root-");
      const outside = await makeTempDir("vu-output-outside-");
      const link = join(root, "linked-output");
      await symlink(outside, link);

      await expect(
        validateOutputDirectory(link, [root]),
      ).rejects.toMatchObject({ code: "PATH_OUTSIDE_ALLOWED_ROOTS" });
    });
  });

  it("reports invalid configured roots distinctly", async () => {
    const root = await makeTempDir("vu-root-");
    const file = join(root, "video.mp4");
    await writeFile(file, "fixture");

    await expect(
      validateInputPath(file, [root, join(root, "missing")], 100),
    ).rejects.toMatchObject({
      code: "INVALID_ROOT_CONFIG",
    });
  });

  it("rejects a symlink that escapes an allowed root", async () => {
    const root = await makeTempDir("vu-root-");
    const outside = await makeTempDir("vu-outside-");
    const outsideFile = join(outside, "video.mp4");
    const link = join(root, "linked-video.mp4");
    await writeFile(outsideFile, "fixture");
    await symlink(outsideFile, link);

    await expect(validateInputPath(link, [root], 100)).rejects.toMatchObject({
      code: "PATH_OUTSIDE_ALLOWED_ROOTS",
    });
  });

  it("rejects oversized files", async () => {
    const root = await makeTempDir("vu-root-");
    const nested = join(root, "nested");
    const file = join(nested, "video.mp4");
    await mkdir(nested);
    await writeFile(file, "too large");

    await expect(validateInputPath(file, [root], 3)).rejects.toMatchObject({
      code: "INPUT_TOO_LARGE",
    });
  });
});
