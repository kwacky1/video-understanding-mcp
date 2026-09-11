import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { AppConfig } from "./config.js";
import { enforceCachePolicy, touchCacheEntry } from "./cache.js";
import { VideoUnderstandingError } from "./errors.js";
import { sha256File } from "./hash.js";
import { validateInputPath } from "./path-policy.js";
import { runCommand } from "./subprocess.js";

interface RawProbeStream {
  index?: number;
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  time_base?: string;
  avg_frame_rate?: string;
  sample_rate?: string;
  channels?: number;
}

interface RawProbe {
  format?: {
    format_name?: string;
    duration?: string;
  };
  streams?: RawProbeStream[];
  program_version?: {
    version?: string;
  };
}

export interface VideoProbeResult extends Record<string, unknown> {
  schema_version: "1.0";
  input_sha256: string;
  duration_ms: number;
  container: string;
  streams: Array<Record<string, string | number>>;
  ffprobe_version: string;
  cache_hit: boolean;
}

function durationMs(rawDuration: string | undefined): number {
  const seconds = Number(rawDuration);
  return Number.isFinite(seconds) ? Math.round(seconds * 1000) : 0;
}

export function normaliseProbe(
  raw: RawProbe,
  inputSha256: string,
  cacheHit: boolean,
): VideoProbeResult {
  const streams: Array<Record<string, string | number>> = [];

  for (const stream of raw.streams ?? []) {
    if (stream.codec_type === "video") {
      streams.push({
        index: stream.index ?? 0,
        kind: "video",
        codec: stream.codec_name ?? "unknown",
        width: stream.width ?? 0,
        height: stream.height ?? 0,
        time_base: stream.time_base ?? "0/0",
        average_frame_rate: stream.avg_frame_rate ?? "0/0",
      });
      continue;
    }

    if (stream.codec_type === "audio") {
      streams.push({
        index: stream.index ?? 0,
        kind: "audio",
        codec: stream.codec_name ?? "unknown",
        sample_rate: Number(stream.sample_rate ?? 0),
        channels: stream.channels ?? 0,
      });
    }
  }

  return {
    schema_version: "1.0",
    input_sha256: inputSha256,
    duration_ms: durationMs(raw.format?.duration),
    container: raw.format?.format_name ?? "unknown",
    streams,
    ffprobe_version: raw.program_version?.version ?? "unknown",
    cache_hit: cacheHit,
  };
}

export async function probeVideo(
  inputPath: string,
  config: AppConfig,
  signal?: AbortSignal,
): Promise<VideoProbeResult> {
  const validated = await validateInputPath(
    inputPath,
    config.allowedReadRoots,
    config.maxInputBytes,
  );
  const inputSha256 = await sha256File(validated.path, signal);
  const cachePath = join(config.cacheDir, "probe-v1", inputSha256, "ffprobe.json");
  await enforceCachePolicy(config, [dirname(cachePath)]);
  let raw: RawProbe;
  let cacheHit = false;

  try {
    const cached = await readFile(cachePath, "utf8");
    try {
      raw = JSON.parse(cached) as RawProbe;
    } catch {
      raw = await runProbe(validated.path, config, signal);
      await writeProbeCache(cachePath, raw);
      return normaliseProbe(raw, inputSha256, false);
    }
    cacheHit = true;
    await touchCacheEntry(dirname(cachePath));
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !("code" in error) ||
      error.code !== "ENOENT"
    ) {
      throw new VideoUnderstandingError(
        "CACHE_READ_FAILED",
        "Could not read cached probe data",
        { cause: error },
      );
    }

    raw = await runProbe(validated.path, config, signal);
    await writeProbeCache(cachePath, raw);
  }

  return normaliseProbe(raw, inputSha256, cacheHit);
}

async function runProbe(
  path: string,
  config: AppConfig,
  signal?: AbortSignal,
): Promise<RawProbe> {
  const commandOptions = signal
    ? { signal, timeoutMs: 30_000 }
    : { timeoutMs: 30_000 };
  const { stdout } = await runCommand(
    config.ffprobePath,
    [
      "-v",
      "error",
      "-show_program_version",
      "-show_format",
      "-show_streams",
      "-of",
      "json",
      path,
    ],
    commandOptions,
  );

  try {
    return JSON.parse(stdout) as RawProbe;
  } catch (error) {
    throw new VideoUnderstandingError(
      "INVALID_FFPROBE_OUTPUT",
      "ffprobe returned invalid JSON",
      { cause: error },
    );
  }
}

async function writeProbeCache(cachePath: string, raw: RawProbe): Promise<void> {
  const cacheDirectory = dirname(cachePath);
  const temporaryPath = `${cachePath}.${randomUUID()}.tmp`;
  await mkdir(cacheDirectory, { recursive: true, mode: 0o700 });

  try {
    await writeFile(temporaryPath, `${JSON.stringify(raw, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporaryPath, cachePath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}
