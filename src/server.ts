#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { ContentBlock } from "@modelcontextprotocol/sdk/types.js";
import { pathToFileURL } from "node:url";
import { z } from "zod";

import { loadConfig } from "./config.js";
import { errorMessage } from "./errors.js";
import { VideoUnderstandingError } from "./errors.js";
import { stderrLogger } from "./logger.js";
import { extractFrames } from "./frames.js";
import { probeVideo } from "./probe.js";
import { transcribeVideo } from "./transcribe.js";

export function createServer() {
  const config = loadConfig();
  const server = new McpServer({
    name: "video-understanding-mcp",
    version: "0.1.0",
  });

  server.registerTool(
    "video_probe",
    {
      title: "Probe local video",
      description:
        "Inspect a local media file with ffprobe and return normalised metadata. The path must be absolute and inside an allowed read root.",
      inputSchema: {
        path: z.string().describe("Absolute path to a local media file"),
      },
      outputSchema: {
        schema_version: z.literal("1.0"),
        input_sha256: z.string(),
        duration_ms: z.number(),
        container: z.string(),
        streams: z.array(z.record(z.string(), z.union([z.string(), z.number()]))),
        ffprobe_version: z.string(),
        cache_hit: z.boolean(),
      },
    },
    async ({ path }, extra) => {
      try {
        const result = await probeVideo(path, config, extra.signal);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          structuredContent: result,
        };
      } catch (error) {
        const payload = {
          code:
            error instanceof VideoUnderstandingError
              ? error.code
              : "UNEXPECTED_ERROR",
          message: errorMessage(error),
        };
        return {
          content: [{ type: "text", text: JSON.stringify(payload) }],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    "video_transcribe",
    {
      title: "Transcribe local video",
      description:
        "Transcribe the first audio stream of a local media file with whisper.cpp. Processing is offline and writes timestamped JSON and Markdown into an allowed output directory.",
      inputSchema: {
        path: z.string().describe("Absolute path to a local media file"),
        output_dir: z
          .string()
          .describe(
            "Existing absolute directory for durable transcript files; the server does not create it",
          ),
        language: z
          .string()
          .default("en")
          .describe("Whisper language code, or auto for detection"),
      },
      outputSchema: {
        schema_version: z.literal("1.0"),
        input_sha256: z.string(),
        engine: z.object({
          name: z.literal("whisper.cpp"),
          model: z.string(),
          model_sha256: z.string(),
        }),
        language: z.string(),
        duration_ms: z.number(),
        segments: z.array(
          z.object({
            id: z.number(),
            start_ms: z.number(),
            end_ms: z.number(),
            text: z.string(),
          }),
        ),
        transcript_json_path: z.string(),
        transcript_markdown_path: z.string(),
        cache_hit: z.boolean(),
      },
    },
    async ({ path, output_dir, language }, extra) => {
      try {
        const result = await transcribeVideo(
          path,
          { outputDir: output_dir, language },
          config,
          extra.signal,
        );
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          structuredContent: result,
        };
      } catch (error) {
        const payload = {
          code:
            error instanceof VideoUnderstandingError
              ? error.code
              : "UNEXPECTED_ERROR",
          message: errorMessage(error),
        };
        return {
          content: [{ type: "text", text: JSON.stringify(payload) }],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    "video_extract_frames",
    {
      title: "Extract timestamped video frames",
      description:
        "Extract bounded visual evidence using source-time cadence, scene changes, and near-duplicate removal. Writes JPEG frames and provenance into an allowed output directory.",
      inputSchema: {
        path: z.string().describe("Absolute path to a local media file"),
        output_dir: z
          .string()
          .describe(
            "Existing absolute directory for durable frame files; the server creates a content-addressed child directory",
          ),
        interval_seconds: z.number().positive().default(10),
        scene_threshold: z.number().min(0).max(1).default(0.4),
        max_frames: z.number().int().min(1).max(24).default(24),
        return_inline: z.boolean().default(false),
      },
      outputSchema: {
        schema_version: z.literal("1.0"),
        input_sha256: z.string(),
        sampler: z.literal("time_and_scene"),
        parameters: z.object({
          interval_seconds: z.number(),
          scene_threshold: z.number(),
          max_frames: z.number(),
        }),
        source_time_base: z.string(),
        frames: z.array(
          z.object({
            id: z.string(),
            path: z.string(),
            pts: z.number(),
            pts_time_seconds: z.number(),
            duration_seconds: z.number(),
            coverage_start_ms: z.number(),
            coverage_end_ms: z.number(),
            reason: z.array(
              z.enum(["first_frame", "cadence", "scene_change"]),
            ),
            scene_score: z.number().nullable(),
            sha256: z.string(),
          }),
        ),
        provenance_path: z.string(),
        included_frames: z.number(),
        omitted_frames: z.number(),
        included_inline_images: z.number(),
        omitted_inline_images: z.number(),
        cache_hit: z.boolean(),
      },
    },
    async (
      {
        path,
        output_dir,
        interval_seconds,
        scene_threshold,
        max_frames,
        return_inline,
      },
      extra,
    ) => {
      try {
        const { result, inlineFrames } = await extractFrames(
          path,
          {
            outputDir: output_dir,
            intervalSeconds: interval_seconds,
            sceneThreshold: scene_threshold,
            maxFrames: max_frames,
            returnInline: return_inline,
          },
          config,
          extra.signal,
        );
        const content: ContentBlock[] = [
          {
            type: "text" as const,
            text: [
              `Extracted ${result.included_frames} frames; omitted ${result.omitted_frames}.`,
              `Provenance: ${result.provenance_path}`,
              ...result.frames.map(
                (frame) =>
                  `${frame.id} ${frame.pts_time_seconds.toFixed(3)}s ${frame.path}`,
              ),
            ].join("\n"),
          },
        ];
        for (const inlineFrame of inlineFrames) {
          const metadata = result.frames.find(
            (frame) => frame.id === inlineFrame.frameId,
          )!;
          content.push({
            type: "text",
            text: `${metadata.id} @ ${metadata.pts_time_seconds.toFixed(3)}s`,
          });
          content.push({
            type: "image",
            data: inlineFrame.data,
            mimeType: inlineFrame.mimeType,
          });
        }
        return {
          content,
          structuredContent: result,
        };
      } catch (error) {
        const payload = {
          code:
            error instanceof VideoUnderstandingError
              ? error.code
              : "UNEXPECTED_ERROR",
          message: errorMessage(error),
        };
        return {
          content: [{ type: "text", text: JSON.stringify(payload) }],
          isError: true,
        };
      }
    },
  );

  return server;
}

async function main(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  stderrLogger.info("ready on stdio");
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error: unknown) => {
    stderrLogger.error(errorMessage(error));
    process.exitCode = 1;
  });
}
