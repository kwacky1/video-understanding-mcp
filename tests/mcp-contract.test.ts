import { mkdtemp, rm, writeFile } from "node:fs/promises";
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

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "vu-contract-"));
    fixturePath = join(root, "fixture.mp4");
    await generateFixture(fixturePath);

    transport = new StdioClientTransport({
      command: process.execPath,
      args: [resolve("dist/server.js")],
      cwd: process.cwd(),
      env: {
        ...getDefaultEnvironment(),
        VU_ALLOWED_READ_ROOTS: root,
        VU_CACHE_DIR: join(root, "cache"),
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

  it("lists a deterministic video_probe tool", async () => {
    const result = await client.listTools();
    expect(result.tools.map((tool) => tool.name)).toEqual(["video_probe"]);
    expect(result.tools[0]?.outputSchema).toMatchObject({
      type: "object",
      properties: {
        schema_version: expect.any(Object),
        input_sha256: expect.any(Object),
      },
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
      cache_hit: false,
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
