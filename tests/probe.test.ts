import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";
import { normaliseProbe } from "../src/probe.js";
import { probeVideo } from "../src/probe.js";

const tempPaths: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("normaliseProbe", () => {
  it("normalises video and audio streams", () => {
    const result = normaliseProbe(
      {
        program_version: { version: "9.0.1" },
        format: { format_name: "mov,mp4", duration: "2.005" },
        streams: [
          {
            index: 0,
            codec_type: "video",
            codec_name: "h264",
            width: 320,
            height: 180,
            time_base: "1/10240",
            avg_frame_rate: "10/1",
          },
          {
            index: 1,
            codec_type: "audio",
            codec_name: "aac",
            sample_rate: "16000",
            channels: 1,
          },
          { index: 2, codec_type: "subtitle", codec_name: "mov_text" },
        ],
      },
      "abc123",
      false,
    );

    expect(result).toMatchObject({
      schema_version: "1.0",
      input_sha256: "abc123",
      duration_ms: 2005,
      container: "mov,mp4",
      ffprobe_version: "9.0.1",
      cache_hit: false,
      streams: [
        {
          index: 0,
          kind: "video",
          codec: "h264",
          width: 320,
          height: 180,
          time_base: "1/10240",
          average_frame_rate: "10/1",
        },
        {
          index: 1,
          kind: "audio",
          codec: "aac",
          sample_rate: 16000,
          channels: 1,
        },
      ],
    });
  });

  it("fails clearly when ffprobe is unavailable", async () => {
    const root = await mkdtemp(join(tmpdir(), "vu-probe-"));
    tempPaths.push(root);
    const file = join(root, "video.mp4");
    await writeFile(file, "not actually media");
    const config = loadConfig(
      {
        VU_ALLOWED_READ_ROOTS: root,
        VU_CACHE_DIR: join(root, "cache"),
        VU_FFPROBE_PATH: "vu-ffprobe-that-does-not-exist",
      },
      root,
    );

    await expect(probeVideo(file, config)).rejects.toMatchObject({
      code: "EXECUTABLE_NOT_FOUND",
    });
  });
});
