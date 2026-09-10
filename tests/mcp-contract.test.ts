import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { generateFixture } from "../src/generate-fixture.js";

describe("MCP stdio contract", () => {
  let root: string;
  let fixturePath: string;
  let client: Client;
  let transport: StdioClientTransport;
  let stderr = "";
  let outputDir: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "vu-contract-"));
    fixturePath = join(root, "fixture.mp4");
    await generateFixture(fixturePath);
    outputDir = join(root, "output");
    const modelPath = join(root, "ggml-contract-test.bin");
    const whisperPath = join(root, "fake-whisper.sh");
    await mkdir(outputDir);
    await writeFile(modelPath, "contract model");
    await writeFile(
      whisperPath,
      `#!/bin/sh
prefix=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-of" ]; then prefix="$2"; shift 2; else shift; fi
done
cat > "\${prefix}.json" <<'JSON'
{"result":{"language":"en"},"transcription":[{"offsets":{"from":0,"to":2000},"text":"Synthetic fixture transcript."}]}
JSON
`,
    );
    await chmod(whisperPath, 0o755);

    transport = new StdioClientTransport({
      command: process.execPath,
      args: [resolve("dist/server.js")],
      cwd: process.cwd(),
      env: {
        ...getDefaultEnvironment(),
        VU_ALLOWED_READ_ROOTS: root,
        VU_ALLOWED_WRITE_ROOTS: root,
        VU_CACHE_DIR: join(root, "cache"),
        VU_WHISPER_PATH: whisperPath,
        VU_WHISPER_MODEL_PATH: modelPath,
      },
      stderr: "pipe",
    });
    transport.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    client = new Client({
      name: "video-understanding-contract-test",
      version: "1.0.0",
    });
    await client.connect(transport);
  }, 30_000);

  afterAll(async () => {
    await client?.close();
    await rm(root, { recursive: true, force: true });
  });

  it("lists deterministic video tools", async () => {
    const result = await client.listTools();
    expect(result.tools.map((tool) => tool.name)).toEqual([
      "video_probe",
      "video_transcribe",
      "video_extract_frames",
    ]);
    expect(result.tools[0]?.outputSchema).toMatchObject({
      type: "object",
      properties: {
        schema_version: expect.any(Object),
        input_sha256: expect.any(Object),
      },
    });
  });

  it("writes timestamped transcript JSON and Markdown", async () => {
    const result = await client.callTool({
      name: "video_transcribe",
      arguments: {
        path: fixturePath,
        output_dir: outputDir,
        language: "en",
      },
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      schema_version: "1.0",
      duration_ms: 2000,
      language: "en",
      cache_hit: false,
      segments: [
        {
          id: 0,
          start_ms: 0,
          end_ms: 2000,
          text: "Synthetic fixture transcript.",
        },
      ],
      transcript_json_path: expect.stringMatching(/\.json$/),
      transcript_markdown_path: expect.stringMatching(/\.md$/),
    });
  });

  it("uses the content-addressed transcript cache", async () => {
    const result = await client.callTool({
      name: "video_transcribe",
      arguments: {
        path: fixturePath,
        output_dir: outputDir,
        language: "en",
      },
    });

    expect(result.structuredContent).toMatchObject({ cache_hit: true });
  });

  it("returns timestamped frame provenance without inline images by default", async () => {
    const result = await client.callTool({
      name: "video_extract_frames",
      arguments: {
        path: fixturePath,
        output_dir: outputDir,
        interval_seconds: 1,
        scene_threshold: 1,
        max_frames: 2,
      },
    });

    expect(result.isError).not.toBe(true);
    expect(result.content).toHaveLength(1);
    expect(result.structuredContent).toMatchObject({
      schema_version: "1.0",
      sampler: "time_and_scene",
      included_frames: 2,
      included_inline_images: 0,
      frames: [
        expect.objectContaining({
          id: "f0001",
          pts: expect.any(Number),
          pts_time_seconds: expect.any(Number),
          sha256: expect.any(String),
        }),
        expect.any(Object),
      ],
    });
  });

  it("places a timestamp immediately before each requested inline image", async () => {
    const result = await client.callTool({
      name: "video_extract_frames",
      arguments: {
        path: fixturePath,
        output_dir: outputDir,
        interval_seconds: 1,
        scene_threshold: 1,
        max_frames: 2,
        return_inline: true,
      },
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      included_inline_images: 2,
      omitted_inline_images: 0,
      cache_hit: true,
    });
    const content = result.content as Array<Record<string, unknown>>;
    expect(content.map((item) => item.type)).toEqual([
      "text",
      "text",
      "image",
      "text",
      "image",
    ]);
    expect(content[1]).toMatchObject({
      type: "text",
      text: expect.stringMatching(/^f0001 @ \d+\.\d{3}s$/),
    });
  });

  it("probes a generated audio-video fixture", async () => {
    const result = await client.callTool({
      name: "video_probe",
      arguments: { path: fixturePath },
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      schema_version: "1.0",
      duration_ms: 2000,
      cache_hit: expect.any(Boolean),
    });
    const streams = (result.structuredContent as Record<string, unknown>)
      .streams;
    expect(streams).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "video", width: 320, height: 180 }),
        expect.objectContaining({ kind: "audio", sample_rate: 16000 }),
      ]),
    );
  });

  it("uses the content-addressed cache on a repeated call", async () => {
    const result = await client.callTool({
      name: "video_probe",
      arguments: { path: fixturePath },
    });
    expect(result.structuredContent).toMatchObject({ cache_hit: true });
  });

  it("recovers from a corrupt cache entry", async () => {
    const initial = await client.callTool({
      name: "video_probe",
      arguments: { path: fixturePath },
    });
    const inputSha256 = (initial.structuredContent as Record<string, unknown>)
      .input_sha256;
    expect(inputSha256).toEqual(expect.any(String));
    await writeFile(
      join(root, "cache", "probe-v1", String(inputSha256), "ffprobe.json"),
      "{truncated",
    );

    const recovered = await client.callTool({
      name: "video_probe",
      arguments: { path: fixturePath },
    });
    expect(recovered.isError).not.toBe(true);
    expect(recovered.structuredContent).toMatchObject({ cache_hit: false });
  });

  it("returns a tool error for a relative path", async () => {
    const result = await client.callTool({
      name: "video_probe",
      arguments: { path: "fixture.mp4" },
    });
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([
      expect.objectContaining({
        type: "text",
        text: JSON.stringify({
          code: "RELATIVE_PATH",
          message: "Input path must be absolute",
        }),
      }),
    ]);
  });

  it("keeps server diagnostics off protocol stdout", () => {
    expect(stderr).toContain("ready on stdio");
  });
});
