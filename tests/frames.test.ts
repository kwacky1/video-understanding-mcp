import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";
import {
  buildCandidateFilter,
  extractFrames,
  parseMetadataFrames,
  selectFrameCandidates,
} from "../src/frames.js";
import type { CandidateFrame } from "../src/frames.js";
import { runCommand } from "../src/subprocess.js";

const tempPaths: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("frame metadata", () => {
  it("parses source PTS and scene scores", () => {
    expect(
      parseMetadataFrames(
        [
          "frame:0    pts:0       pts_time:0",
          "lavfi.scene_score=0.000000",
          "frame:1    pts:2048    pts_time:2",
          "lavfi.scene_score=0.812500",
        ].join("\n"),
      ),
    ).toEqual([
      { pts: 0, ptsTimeSeconds: 0, sceneScore: 0 },
      { pts: 2048, ptsTimeSeconds: 2, sceneScore: 0.8125 },
    ]);
  });

  it("uses select rather than the timestamp-rewriting fps filter", () => {
    const filter = buildCandidateFilter(10, 0.4);
    expect(filter).toContain("select=");
    expect(filter).toContain("mpdecimate");
    expect(filter).not.toContain("fps=");
  });

  it("prioritises scene changes while enforcing the hard cap", () => {
    const candidates: CandidateFrame[] = Array.from(
      { length: 30 },
      (_, index) => ({
        pts: index * 1000,
        ptsTimeSeconds: index,
        sceneScore: index === 17 ? 0.95 : 0,
        reason:
          index === 0
            ? ["first_frame"]
            : index === 17
              ? ["scene_change"]
              : ["cadence"],
      }),
    );

    const selected = selectFrameCandidates(candidates, 24);
    expect(selected).toHaveLength(24);
    expect(selected[0]?.reason).toContain("first_frame");
    expect(selected.some((frame) => frame.pts === 17_000)).toBe(true);
  });

  it("reserves capped capacity for temporal coverage", () => {
    const candidates: CandidateFrame[] = [
      {
        pts: 0,
        ptsTimeSeconds: 0,
        sceneScore: null,
        reason: ["first_frame"],
      },
      ...Array.from({ length: 20 }, (_, index) => ({
        pts: index + 1,
        ptsTimeSeconds: (index + 1) / 10,
        sceneScore: 1 - index / 100,
        reason: ["scene_change"] as CandidateFrame["reason"],
      })),
      ...Array.from({ length: 20 }, (_, index) => ({
        pts: 10_000 + index,
        ptsTimeSeconds: 100 + index * 10,
        sceneScore: 0,
        reason: ["cadence"] as CandidateFrame["reason"],
      })),
    ];

    const selected = selectFrameCandidates(candidates, 24);
    expect(selected).toHaveLength(24);
    expect(
      selected.filter((frame) => frame.reason.includes("cadence")).length,
    ).toBeGreaterThan(0);
  });
});

describe("extractFrames", () => {
  it("captures a VFR scene cut with source-PTS provenance and reuses the cache", async () => {
    const root = await mkdtemp(join(tmpdir(), "vu-frames-"));
    tempPaths.push(root);
    const inputPath = join(root, "vfr-scenes.mkv");
    const outputDir = join(root, "output");
    await runCommand(
      "ffmpeg",
      [
        "-nostdin",
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        "color=c=red:s=320x180:r=5:d=2",
        "-f",
        "lavfi",
        "-i",
        "color=c=blue:s=320x180:r=15:d=2",
        "-filter_complex",
        "[0:v][1:v]concat=n=2:v=1:a=0[v]",
        "-map",
        "[v]",
        "-fps_mode",
        "vfr",
        "-c:v",
        "ffv1",
        "-y",
        inputPath,
      ],
      { timeoutMs: 30_000 },
    );
    await mkdir(outputDir);
    const config = loadConfig(
      {
        VU_ALLOWED_READ_ROOTS: root,
        VU_ALLOWED_WRITE_ROOTS: root,
        VU_CACHE_DIR: join(root, "cache"),
      },
      root,
    );

    const first = await extractFrames(
      inputPath,
      {
        outputDir,
        intervalSeconds: 10,
        sceneThreshold: 0.2,
        maxFrames: 24,
        returnInline: true,
      },
      config,
    );
    const second = await extractFrames(
      inputPath,
      {
        outputDir,
        intervalSeconds: 10,
        sceneThreshold: 0.2,
        maxFrames: 24,
      },
      config,
    );
    const [frameCacheKey] = await readdir(join(root, "cache", "frames-v1"));
    const cacheProvenancePath = join(
      root,
      "cache",
      "frames-v1",
      frameCacheKey!,
      "provenance.json",
    );
    const mismatchedProvenance = JSON.parse(
      await readFile(cacheProvenancePath, "utf8"),
    ) as {
      input_sha256: string;
      source_time_base: string;
      parameters: {
        interval_seconds: number;
        scene_threshold: number;
        max_frames: number;
      };
    };
    mismatchedProvenance.input_sha256 = "mismatched-input";
    mismatchedProvenance.source_time_base = "1/1";
    mismatchedProvenance.parameters.interval_seconds = 999;
    await writeFile(
      cacheProvenancePath,
      `${JSON.stringify(mismatchedProvenance, null, 2)}\n`,
    );
    const recovered = await extractFrames(
      inputPath,
      {
        outputDir,
        intervalSeconds: 10,
        sceneThreshold: 0.2,
        maxFrames: 24,
      },
      config,
    );

    expect(first.result.cache_hit).toBe(false);
    expect(second.result.cache_hit).toBe(true);
    expect(recovered.result).toMatchObject({
      cache_hit: false,
      input_sha256: first.result.input_sha256,
      source_time_base: first.result.source_time_base,
      parameters: first.result.parameters,
    });
    expect(first.result.frames[0]?.reason).toContain("first_frame");
    const sceneFrame = first.result.frames.find((frame) =>
      frame.reason.includes("scene_change"),
    );
    expect(sceneFrame?.pts_time_seconds).toBeCloseTo(2, 1);
    expect(sceneFrame?.duration_seconds).toBeGreaterThan(0.01);
    expect(sceneFrame!.coverage_end_ms).toBeGreaterThan(
      sceneFrame!.coverage_start_ms + 10,
    );
    const [numerator, denominator] = first.result.source_time_base
      .split("/")
      .map(Number);
    for (const frame of first.result.frames) {
      expect(frame.pts * (numerator! / denominator!)).toBeCloseTo(
        frame.pts_time_seconds,
        5,
      );
      await expect(access(frame.path)).resolves.toBeUndefined();
    }
    expect(first.inlineFrames).toHaveLength(2);
    expect(
      Buffer.from(first.inlineFrames[0]!.data, "base64").subarray(0, 2),
    ).toEqual(
      Buffer.from([0xff, 0xd8]),
    );
    expect(
      JSON.parse(await readFile(first.result.provenance_path, "utf8")),
    ).toMatchObject({
      schema_version: "1.0",
      source_time_base: first.result.source_time_base,
    });
  }, 30_000);

  it("deduplicates static cadence samples and never exceeds max_frames", async () => {
    const root = await mkdtemp(join(tmpdir(), "vu-frames-cap-"));
    tempPaths.push(root);
    const staticPath = join(root, "static.mkv");
    const changingPath = join(root, "changing.mkv");
    const outputDir = join(root, "output");
    await mkdir(outputDir);
    await Promise.all([
      runCommand(
        "ffmpeg",
        [
          "-nostdin",
          "-hide_banner",
          "-loglevel",
          "error",
          "-f",
          "lavfi",
          "-i",
          "color=c=green:s=160x90:r=10:d=5",
          "-c:v",
          "ffv1",
          "-y",
          staticPath,
        ],
        { timeoutMs: 30_000 },
      ),
      runCommand(
        "ffmpeg",
        [
          "-nostdin",
          "-hide_banner",
          "-loglevel",
          "error",
          "-f",
          "lavfi",
          "-i",
          "testsrc2=s=160x90:r=10:d=5",
          "-c:v",
          "ffv1",
          "-y",
          changingPath,
        ],
        { timeoutMs: 30_000 },
      ),
    ]);
    const config = loadConfig(
      {
        VU_ALLOWED_READ_ROOTS: root,
        VU_ALLOWED_WRITE_ROOTS: root,
        VU_CACHE_DIR: join(root, "cache"),
      },
      root,
    );

    const staticResult = await extractFrames(
      staticPath,
      {
        outputDir,
        intervalSeconds: 0.25,
        sceneThreshold: 1,
        maxFrames: 24,
      },
      config,
    );
    const cappedResult = await extractFrames(
      changingPath,
      {
        outputDir,
        intervalSeconds: 0.1,
        sceneThreshold: 1,
        maxFrames: 6,
        returnInline: true,
      },
      config,
    );

    expect(staticResult.result.frames).toHaveLength(1);
    expect(cappedResult.result.frames).toHaveLength(6);
    expect(cappedResult.result.omitted_frames).toBeGreaterThan(0);
    expect(cappedResult.inlineFrames).toHaveLength(4);
    expect(cappedResult.result.included_inline_images).toBe(4);
    expect(cappedResult.result.omitted_inline_images).toBe(2);
    for (const inlineFrame of cappedResult.inlineFrames) {
      const dimensions = jpegDimensions(
        Buffer.from(inlineFrame.data, "base64"),
      );
      expect(Math.max(dimensions.width, dimensions.height)).toBeLessThanOrEqual(
        512,
      );
    }
  }, 30_000);

  it("rejects a durable output symlink that escapes the write root", async () => {
    const root = await mkdtemp(join(tmpdir(), "vu-frames-symlink-"));
    tempPaths.push(root);
    const inputPath = join(root, "fixture.mkv");
    const outputDir = join(root, "output");
    const escapeDir = join(root, "escape");
    await Promise.all([mkdir(outputDir), mkdir(escapeDir)]);
    await runCommand(
      "ffmpeg",
      [
        "-nostdin",
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        "testsrc2=s=64x64:r=2:d=1",
        "-c:v",
        "ffv1",
        "-y",
        inputPath,
      ],
      { timeoutMs: 30_000 },
    );
    const config = loadConfig(
      {
        VU_ALLOWED_READ_ROOTS: root,
        VU_ALLOWED_WRITE_ROOTS: outputDir,
        VU_CACHE_DIR: join(root, "cache"),
      },
      root,
    );
    const first = await extractFrames(inputPath, { outputDir }, config);
    const durableDirectory = first.result.provenance_path.replace(
      /\/provenance\.json$/,
      "",
    );
    await rm(durableDirectory, { recursive: true });
    await symlink(escapeDir, durableDirectory);

    await expect(
      extractFrames(inputPath, { outputDir }, config),
    ).rejects.toMatchObject({ code: "PATH_OUTSIDE_ALLOWED_ROOTS" });
    expect(await readdir(escapeDir)).toEqual([]);
  }, 30_000);

  it("removes extraction scratch data when cancelled", async () => {
    const root = await mkdtemp(join(tmpdir(), "vu-frames-cancel-"));
    tempPaths.push(root);
    const inputPath = join(root, "fixture.mkv");
    const outputDir = join(root, "output");
    const fakeFfmpeg = join(root, "slow-ffmpeg.sh");
    await runCommand(
      "ffmpeg",
      [
        "-nostdin",
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        "color=c=black:s=64x64:r=1:d=1",
        "-c:v",
        "ffv1",
        "-y",
        inputPath,
      ],
      { timeoutMs: 30_000 },
    );
    const { chmod } = await import("node:fs/promises");
    await mkdir(outputDir);
    await writeFile(fakeFfmpeg, "#!/bin/sh\nsleep 10\n");
    await chmod(fakeFfmpeg, 0o755);
    const config = loadConfig(
      {
        VU_ALLOWED_READ_ROOTS: root,
        VU_ALLOWED_WRITE_ROOTS: root,
        VU_CACHE_DIR: join(root, "cache"),
        VU_FFMPEG_PATH: fakeFfmpeg,
      },
      root,
    );
    const before = new Set(
      (await readdir(tmpdir())).filter((name) =>
        name.startsWith(`video-understanding-${process.pid}-`),
      ),
    );
    const controller = new AbortController();
    const extraction = extractFrames(
      inputPath,
      { outputDir },
      config,
      controller.signal,
    );
    setTimeout(() => controller.abort(), 100);

    await expect(extraction).rejects.toMatchObject({ code: "CANCELLED" });
    const after = (await readdir(tmpdir())).filter(
      (name) =>
        name.startsWith(`video-understanding-${process.pid}-`) &&
        !before.has(name),
    );
    expect(after).toEqual([]);
  }, 30_000);
});

function jpegDimensions(data: Buffer): { width: number; height: number } {
  let offset = 2;
  while (offset + 8 < data.length) {
    if (data[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = data[offset + 1]!;
    const length = data.readUInt16BE(offset + 2);
    if (marker === 0xc0 || marker === 0xc2) {
      return {
        height: data.readUInt16BE(offset + 5),
        width: data.readUInt16BE(offset + 7),
      };
    }
    offset += 2 + length;
  }
  throw new Error("JPEG dimensions were not found");
}
