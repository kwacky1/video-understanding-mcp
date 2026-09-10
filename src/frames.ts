import { randomUUID } from "node:crypto";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { tmpdir } from "node:os";

import type { AppConfig } from "./config.js";
import { enforceCachePolicy, touchCacheEntry } from "./cache.js";
import { VideoUnderstandingError } from "./errors.js";
import { executableFingerprint } from "./executable.js";
import { sha256File, sha256Text } from "./hash.js";
import {
  validateInputPath,
  validateOutputDirectory,
} from "./path-policy.js";
import { probeVideo } from "./probe.js";
import { runCommand } from "./subprocess.js";

export interface ExtractFramesOptions {
  outputDir: string;
  intervalSeconds?: number;
  sceneThreshold?: number;
  maxFrames?: number;
  returnInline?: boolean;
}

export interface FrameProvenance extends Record<string, unknown> {
  id: string;
  path: string;
  pts: number;
  pts_time_seconds: number;
  duration_seconds: number;
  coverage_start_ms: number;
  coverage_end_ms: number;
  reason: Array<"first_frame" | "cadence" | "scene_change">;
  scene_score: number | null;
  sha256: string;
}

export interface VideoExtractFramesResult extends Record<string, unknown> {
  schema_version: "1.0";
  input_sha256: string;
  sampler: "time_and_scene";
  parameters: {
    interval_seconds: number;
    scene_threshold: number;
    max_frames: number;
  };
  source_time_base: string;
  frames: FrameProvenance[];
  provenance_path: string;
  included_frames: number;
  omitted_frames: number;
  included_inline_images: number;
  omitted_inline_images: number;
  cache_hit: boolean;
}

export interface InlineFrame {
  frameId: string;
  data: string;
  mimeType: "image/jpeg";
}

export interface CandidateFrame {
  pts: number;
  ptsTimeSeconds: number;
  sceneScore: number | null;
  reason: Array<"first_frame" | "cadence" | "scene_change">;
}

interface ExtractedFrame extends CandidateFrame {
  fileName: string;
  durationSeconds: number;
  sha256: string;
}

interface CachedFrameDocument {
  schema_version: "1.0";
  input_sha256: string;
  sampler: "time_and_scene";
  parameters: VideoExtractFramesResult["parameters"];
  source_time_base: string;
  frames: ExtractedFrame[];
  omitted_frames: number;
}

interface MetadataFrame {
  pts: number;
  ptsTimeSeconds: number;
  sceneScore: number | null;
}

const FRAME_STAGE = "frames-v1";
const FRAME_EXTRACTION_TIMEOUT_MS = 2 * 60 * 60 * 1000;
const DEFAULT_INTERVAL_SECONDS = 10;
const DEFAULT_SCENE_THRESHOLD = 0.4;
const DEFAULT_MAX_FRAMES = 24;
const HARD_MAX_FRAMES = 24;
const INLINE_FRAME_LIMIT = 4;

export function buildCandidateFilter(
  intervalSeconds: number,
  sceneThreshold: number,
): string {
  return [
    `select='eq(n\\,0)+gte(t-prev_selected_t\\,${intervalSeconds})+gt(scene\\,${sceneThreshold})'`,
    "mpdecimate",
    "metadata=print:file='pipe\\:1'",
  ].join(",");
}

export function selectFrameCandidates(
  candidates: CandidateFrame[],
  maxFrames: number,
): CandidateFrame[] {
  if (candidates.length <= maxFrames) {
    return candidates;
  }

  const selected = new Map<number, CandidateFrame>();
  const first = candidates[0];
  if (first) selected.set(first.pts, first);

  const sceneSlots = Math.ceil(Math.max(0, maxFrames - 1) / 2);
  const scenes = candidates
    .slice(1)
    .filter((candidate) => candidate.reason.includes("scene_change"))
    .sort(
      (left, right) =>
        (right.sceneScore ?? 0) - (left.sceneScore ?? 0) ||
        left.ptsTimeSeconds - right.ptsTimeSeconds,
    );
  for (const scene of scenes.slice(0, sceneSlots)) {
    selected.set(scene.pts, scene);
  }

  const remaining = candidates.filter(
    (candidate) => !selected.has(candidate.pts),
  );
  const slots = maxFrames - selected.size;
  for (let slot = 0; slot < slots; slot += 1) {
    const index = Math.floor(((slot + 1) * remaining.length) / (slots + 1));
    const candidate = remaining[Math.min(index, remaining.length - 1)];
    if (candidate) selected.set(candidate.pts, candidate);
  }

  for (const candidate of remaining) {
    if (selected.size >= maxFrames) break;
    selected.set(candidate.pts, candidate);
  }

  return [...selected.values()].sort(
    (left, right) => left.ptsTimeSeconds - right.ptsTimeSeconds,
  );
}

export async function extractFrames(
  inputPath: string,
  options: ExtractFramesOptions,
  config: AppConfig,
  signal?: AbortSignal,
): Promise<{ result: VideoExtractFramesResult; inlineFrames: InlineFrame[] }> {
  const parameters = normaliseParameters(options);
  const validatedInput = await validateInputPath(
    inputPath,
    config.allowedReadRoots,
    config.maxInputBytes,
  );
  const outputDir = await validateOutputDirectory(
    options.outputDir,
    config.allowedWriteRoots,
  );
  const [probe, ffmpegFingerprint] = await Promise.all([
    probeVideo(validatedInput.path, config, signal),
    executableFingerprint(config.ffmpegPath, signal),
  ]);
  const videoStream = probe.streams.find((stream) => stream.kind === "video");
  if (!videoStream) {
    throw new VideoUnderstandingError(
      "VIDEO_STREAM_NOT_FOUND",
      "Input does not contain a video stream",
    );
  }
  const sourceTimeBase = String(videoStream.time_base ?? "0/0");
  const averageFrameRate = String(videoStream.average_frame_rate ?? "0/0");
  const cacheKey = sha256Text(
    [
      probe.input_sha256,
      FRAME_STAGE,
      canonicalJson(parameters),
      ffmpegFingerprint,
    ].join("\n"),
  );
  const cacheDirectory = join(config.cacheDir, FRAME_STAGE, cacheKey);
  const cacheDocumentPath = join(cacheDirectory, "provenance.json");
  await enforceCachePolicy(config, [cacheDirectory]);

  let document = await readCachedFrames(cacheDocumentPath, cacheDirectory, {
    inputSha256: probe.input_sha256,
    parameters,
    sourceTimeBase,
  });
  let cacheHit = document !== undefined;
  if (!document) {
    await rm(cacheDirectory, { recursive: true, force: true });
    document = await runFrameExtraction(
      validatedInput.path,
      probe.input_sha256,
      parameters,
      sourceTimeBase,
      averageFrameRate,
      cacheDirectory,
      config,
      signal,
    );
    cacheHit = false;
  } else {
    await touchCacheEntry(cacheDirectory);
  }

  const stem = basename(validatedInput.path, extname(validatedInput.path));
  const durableDirectory = join(
    outputDir,
    `${stem}.${cacheKey.slice(0, 12)}.frames`,
  );
  const requestedInline = options.returnInline === true;
  const includedInlineImages = requestedInline
    ? Math.min(INLINE_FRAME_LIMIT, document.frames.length)
    : 0;
  const result = await materialiseDurableOutput(
    durableDirectory,
    cacheDirectory,
    document,
    {
      includedInlineImages,
      omittedInlineImages: requestedInline
        ? Math.max(0, document.frames.length - includedInlineImages)
        : document.frames.length,
      cacheHit,
    },
    config,
    signal,
  );
  const inlineFrames = requestedInline
    ? await createInlineFrames(
        result.frames.slice(0, INLINE_FRAME_LIMIT),
        config,
        signal,
      )
    : [];
  await enforceCachePolicy(config, [cacheDirectory]);

  return { result, inlineFrames };
}

async function materialiseDurableOutput(
  durableDirectory: string,
  cacheDirectory: string,
  document: CachedFrameDocument,
  status: {
    includedInlineImages: number;
    omittedInlineImages: number;
    cacheHit: boolean;
  },
  config: AppConfig,
  signal?: AbortSignal,
): Promise<VideoExtractFramesResult> {
  await validateExistingDurableOutput(durableDirectory, document, config);
  const temporaryDirectory = `${durableDirectory}.tmp-${randomUUID()}`;
  await mkdir(temporaryDirectory, { mode: 0o700 });
  try {
    const frames = await Promise.all(
      document.frames.map(async (frame, index) => {
        throwIfCancelled(signal);
        await copyFile(
          join(cacheDirectory, frame.fileName),
          join(temporaryDirectory, frame.fileName),
        );
        return {
          id: `f${String(index + 1).padStart(4, "0")}`,
          path: join(durableDirectory, frame.fileName),
          pts: frame.pts,
          pts_time_seconds: frame.ptsTimeSeconds,
          duration_seconds: frame.durationSeconds,
          coverage_start_ms: Math.round(frame.ptsTimeSeconds * 1000),
          coverage_end_ms: Math.round(
            (frame.ptsTimeSeconds + frame.durationSeconds) * 1000,
          ),
          reason: frame.reason,
          scene_score: frame.sceneScore,
          sha256: frame.sha256,
        } satisfies FrameProvenance;
      }),
    );
    const result: VideoExtractFramesResult = {
      schema_version: "1.0",
      input_sha256: document.input_sha256,
      sampler: "time_and_scene",
      parameters: document.parameters,
      source_time_base: document.source_time_base,
      frames,
      provenance_path: join(durableDirectory, "provenance.json"),
      included_frames: frames.length,
      omitted_frames: document.omitted_frames,
      included_inline_images: status.includedInlineImages,
      omitted_inline_images: status.omittedInlineImages,
      cache_hit: status.cacheHit,
    };
    await writeFile(
      join(temporaryDirectory, "provenance.json"),
      `${JSON.stringify(result, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    throwIfCancelled(signal);
    await rm(durableDirectory, { recursive: true, force: true });
    await rename(temporaryDirectory, durableDirectory);
    await validateOutputDirectory(
      durableDirectory,
      config.allowedWriteRoots,
    );
    return result;
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

function normaliseParameters(
  options: ExtractFramesOptions,
): VideoExtractFramesResult["parameters"] {
  const intervalSeconds = options.intervalSeconds ?? DEFAULT_INTERVAL_SECONDS;
  const sceneThreshold = options.sceneThreshold ?? DEFAULT_SCENE_THRESHOLD;
  const maxFrames = options.maxFrames ?? DEFAULT_MAX_FRAMES;

  if (!Number.isFinite(intervalSeconds) || intervalSeconds <= 0) {
    throw new VideoUnderstandingError(
      "INVALID_FRAME_PARAMETERS",
      "interval_seconds must be greater than zero",
    );
  }
  if (
    !Number.isFinite(sceneThreshold) ||
    sceneThreshold < 0 ||
    sceneThreshold > 1
  ) {
    throw new VideoUnderstandingError(
      "INVALID_FRAME_PARAMETERS",
      "scene_threshold must be between zero and one",
    );
  }
  if (
    !Number.isSafeInteger(maxFrames) ||
    maxFrames < 1 ||
    maxFrames > HARD_MAX_FRAMES
  ) {
    throw new VideoUnderstandingError(
      "INVALID_FRAME_PARAMETERS",
      `max_frames must be an integer between 1 and ${HARD_MAX_FRAMES}`,
    );
  }

  return {
    interval_seconds: intervalSeconds,
    scene_threshold: sceneThreshold,
    max_frames: maxFrames,
  };
}

async function runFrameExtraction(
  inputPath: string,
  inputSha256: string,
  parameters: VideoExtractFramesResult["parameters"],
  sourceTimeBase: string,
  averageFrameRate: string,
  cacheDirectory: string,
  config: AppConfig,
  signal?: AbortSignal,
): Promise<CachedFrameDocument> {
  const scratchDirectory = await mkdtemp(
    join(tmpdir(), `video-understanding-${process.pid}-`),
  );
  try {
    const candidates = await discoverCandidates(
      inputPath,
      parameters,
      config,
      signal,
    );
    if (candidates.length === 0) {
      throw new VideoUnderstandingError(
        "NO_FRAMES_EXTRACTED",
        "FFmpeg did not find any decodable video frames",
      );
    }
    const selected = selectFrameCandidates(candidates, parameters.max_frames);
    const extracted = await extractSelectedFrames(
      inputPath,
      selected,
      scratchDirectory,
      sourceTimeBase,
      averageFrameRate,
      config,
      signal,
    );
    const document: CachedFrameDocument = {
      schema_version: "1.0",
      input_sha256: inputSha256,
      sampler: "time_and_scene",
      parameters,
      source_time_base: sourceTimeBase,
      frames: extracted,
      omitted_frames: candidates.length - extracted.length,
    };
    await writeFrameCache(cacheDirectory, scratchDirectory, document);
    return document;
  } finally {
    await rm(scratchDirectory, { recursive: true, force: true });
  }
}

async function discoverCandidates(
  inputPath: string,
  parameters: VideoExtractFramesResult["parameters"],
  config: AppConfig,
  signal?: AbortSignal,
): Promise<CandidateFrame[]> {
  const { stdout } = await runCommand(
    config.ffmpegPath,
    [
      "-nostdin",
      "-hide_banner",
      "-loglevel",
      "error",
      "-copyts",
      "-i",
      inputPath,
      "-map",
      "0:v:0",
      "-vf",
      buildCandidateFilter(
        parameters.interval_seconds,
        parameters.scene_threshold,
      ),
      "-fps_mode",
      "passthrough",
      "-f",
      "null",
      "-",
    ],
    commandOptions(signal, 64 * 1024 * 1024),
  );
  const frames = parseMetadataFrames(stdout);

  return frames.map((frame, index) => {
    const reason: CandidateFrame["reason"] = [];
    if (index === 0) reason.push("first_frame");
    const previous = frames[index - 1];
    if (
      index > 0 &&
      frame.sceneScore !== null &&
      frame.sceneScore > parameters.scene_threshold
    ) {
      reason.push("scene_change");
    }
    if (
      index > 0 &&
      (reason.length === 0 ||
        (previous !== undefined &&
          frame.ptsTimeSeconds - previous.ptsTimeSeconds >=
            parameters.interval_seconds))
    ) {
      reason.push("cadence");
    }
    return {
      ...frame,
      sceneScore: index === 0 ? null : frame.sceneScore,
      reason,
    };
  });
}

async function extractSelectedFrames(
  inputPath: string,
  selected: CandidateFrame[],
  scratchDirectory: string,
  sourceTimeBase: string,
  averageFrameRate: string,
  config: AppConfig,
  signal?: AbortSignal,
): Promise<ExtractedFrame[]> {
  const expression = selected
    .map((candidate) => `eq(pts\\,${candidate.pts})`)
    .join("+");
  const outputPattern = join(scratchDirectory, "frame_%06d.jpg");
  const { stderr } = await runCommand(
    config.ffmpegPath,
    [
      "-nostdin",
      "-hide_banner",
      "-loglevel",
      "info",
      "-copyts",
      "-i",
      inputPath,
      "-map",
      "0:v:0",
      "-vf",
      `select='${expression}',showinfo`,
      "-fps_mode",
      "passthrough",
      "-q:v",
      "2",
      "-y",
      outputPattern,
    ],
    {
      ...commandOptions(signal, 1024 * 1024),
      maxStderrBytes: 2 * 1024 * 1024,
    },
  );
  const timings = parseShowinfo(stderr);
  const files = (await readdir(scratchDirectory))
    .filter((file) => /^frame_\d+\.jpg$/.test(file))
    .sort();
  if (files.length !== selected.length || timings.length !== selected.length) {
    throw new VideoUnderstandingError(
      "FRAME_EXTRACTION_MISMATCH",
      `Expected ${selected.length} frames but FFmpeg produced ${files.length} images and ${timings.length} timestamp records`,
    );
  }
  const recoveredDurations = timings.some(
    (timing) => timing.durationSeconds <= 0,
  )
    ? await recoverFrameDurations(inputPath, selected, config, signal)
    : new Map<number, number>();
  const fallbackDuration =
    inverseRateSeconds(averageFrameRate) || timeBaseSeconds(sourceTimeBase);

  return Promise.all(
    selected.map(async (candidate, index) => {
      const sourceFile = join(scratchDirectory, files[index]!);
      const fileName = frameFileName(candidate.pts);
      const destination = join(scratchDirectory, fileName);
      await rename(sourceFile, destination);
      const timing = timings[index]!;
      if (timing.pts !== candidate.pts) {
        throw new VideoUnderstandingError(
          "FRAME_EXTRACTION_MISMATCH",
          `Expected source PTS ${candidate.pts} but FFmpeg emitted ${timing.pts}`,
        );
      }
      const ptsTimeFromBase = candidate.pts * timeBaseSeconds(sourceTimeBase);
      if (
        Math.abs(ptsTimeFromBase - candidate.ptsTimeSeconds) >
        Math.max(timeBaseSeconds(sourceTimeBase) / 2, 0.000_001)
      ) {
        throw new VideoUnderstandingError(
          "FRAME_TIMESTAMP_MISMATCH",
          `Source PTS ${candidate.pts} does not match pts_time ${candidate.ptsTimeSeconds} in timebase ${sourceTimeBase}`,
        );
      }
      return {
        ...candidate,
        fileName,
        durationSeconds:
          timing.durationSeconds > 0
            ? timing.durationSeconds
            : recoveredDurations.get(candidate.pts) ?? fallbackDuration,
        sha256: await sha256File(destination, signal),
      };
    }),
  );
}

async function recoverFrameDurations(
  inputPath: string,
  selected: CandidateFrame[],
  config: AppConfig,
  signal?: AbortSignal,
): Promise<Map<number, number>> {
  const expression = selected
    .flatMap((candidate) => [
      `eq(pts\\,${candidate.pts})`,
      `eq(prev_pts\\,${candidate.pts})`,
    ])
    .join("+");
  const { stderr } = await runCommand(
    config.ffmpegPath,
    [
      "-nostdin",
      "-hide_banner",
      "-loglevel",
      "info",
      "-copyts",
      "-i",
      inputPath,
      "-map",
      "0:v:0",
      "-vf",
      `select='${expression}',showinfo`,
      "-fps_mode",
      "passthrough",
      "-f",
      "null",
      "-",
    ],
    {
      ...commandOptions(signal, 1024 * 1024),
      maxStderrBytes: 2 * 1024 * 1024,
    },
  );
  const frames = parseShowinfoTimestamps(stderr);
  const durations = new Map<number, number>();
  for (const selectedFrame of selected) {
    const index = frames.findIndex((frame) => frame.pts === selectedFrame.pts);
    const next = index >= 0 ? frames[index + 1] : undefined;
    if (next && next.ptsTimeSeconds > selectedFrame.ptsTimeSeconds) {
      durations.set(
        selectedFrame.pts,
        next.ptsTimeSeconds - selectedFrame.ptsTimeSeconds,
      );
    }
  }
  return durations;
}

export function parseMetadataFrames(output: string): MetadataFrame[] {
  const frames: MetadataFrame[] = [];
  let current: Partial<MetadataFrame> | undefined;
  for (const line of output.split(/\r?\n/)) {
    const header = line.match(
      /^frame:\d+\s+pts:\s*(-?\d+)\s+pts_time:([+-]?(?:\d+(?:\.\d*)?|\.\d+))/,
    );
    if (line.startsWith("frame:") && !header) {
      current = undefined;
      continue;
    }
    if (header) {
      if (
        current?.pts !== undefined &&
        current.ptsTimeSeconds !== undefined
      ) {
        frames.push({
          pts: current.pts,
          ptsTimeSeconds: current.ptsTimeSeconds,
          sceneScore: current.sceneScore ?? null,
        });
      }
      current = {
        pts: Number(header[1]),
        ptsTimeSeconds: Number(header[2]),
        sceneScore: null,
      };
      continue;
    }
    const scene = line.match(/^lavfi\.scene_score=([+-]?\d+(?:\.\d+)?)/);
    if (scene && current) {
      current.sceneScore = Number(scene[1]);
    }
  }
  if (current?.pts !== undefined && current.ptsTimeSeconds !== undefined) {
    frames.push({
      pts: current.pts,
      ptsTimeSeconds: current.ptsTimeSeconds,
      sceneScore: current.sceneScore ?? null,
    });
  }
  if (
    frames.some(
      (frame) =>
        !Number.isSafeInteger(frame.pts) ||
        !Number.isFinite(frame.ptsTimeSeconds),
    )
  ) {
    throw new VideoUnderstandingError(
      "INVALID_FFMPEG_OUTPUT",
      "FFmpeg returned invalid source frame metadata",
    );
  }
  return frames;
}

function parseShowinfo(
  output: string,
): Array<{ pts: number; durationSeconds: number }> {
  const frames: Array<{ pts: number; durationSeconds: number }> = [];
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(
      /showinfo.*\bn:\s*\d+\s+pts:\s*(-?\d+).*duration_time:([+-]?(?:\d+(?:\.\d*)?|\.\d+))/,
    );
    if (match) {
      frames.push({
        pts: Number(match[1]),
        durationSeconds: Number(match[2]),
      });
    }
  }
  return frames;
}

function parseShowinfoTimestamps(
  output: string,
): Array<{ pts: number; ptsTimeSeconds: number }> {
  const frames: Array<{ pts: number; ptsTimeSeconds: number }> = [];
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(
      /showinfo.*\bn:\s*\d+\s+pts:\s*(-?\d+)\s+pts_time:([+-]?(?:\d+(?:\.\d*)?|\.\d+))/,
    );
    if (match) {
      frames.push({
        pts: Number(match[1]),
        ptsTimeSeconds: Number(match[2]),
      });
    }
  }
  return frames;
}

async function readCachedFrames(
  documentPath: string,
  cacheDirectory: string,
  expected: {
    inputSha256: string;
    parameters: VideoExtractFramesResult["parameters"];
    sourceTimeBase: string;
  },
): Promise<CachedFrameDocument | undefined> {
  try {
    const parsed = JSON.parse(
      await readFile(documentPath, "utf8"),
    ) as CachedFrameDocument;
    if (
      parsed.schema_version !== "1.0" ||
      parsed.sampler !== "time_and_scene" ||
      !Array.isArray(parsed.frames) ||
      !parsed.parameters ||
      parsed.input_sha256 !== expected.inputSha256 ||
      parsed.source_time_base !== expected.sourceTimeBase ||
      canonicalJson(parsed.parameters) !== canonicalJson(expected.parameters)
    ) {
      return undefined;
    }
    for (const frame of parsed.frames) {
      if (!/^f_(?:neg_)?\d+\.jpg$/.test(frame.fileName)) {
        return undefined;
      }
      const framePath = join(cacheDirectory, frame.fileName);
      const metadata = await stat(framePath);
      if (!metadata.isFile() || (await sha256File(framePath)) !== frame.sha256) {
        return undefined;
      }
    }
    return parsed;
  } catch (error) {
    if (
      error instanceof SyntaxError ||
      (error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT")
    ) {
      return undefined;
    }
    throw new VideoUnderstandingError(
      "CACHE_READ_FAILED",
      "Could not read cached frame data",
      { cause: error },
    );
  }
}

async function writeFrameCache(
  cacheDirectory: string,
  sourceDirectory: string,
  document: CachedFrameDocument,
): Promise<void> {
  const parent = dirname(cacheDirectory);
  const temporaryDirectory = join(
    parent,
    `${basename(cacheDirectory)}.tmp-${randomUUID()}`,
  );
  await mkdir(temporaryDirectory, { recursive: true, mode: 0o700 });
  try {
    await Promise.all(
      document.frames.map((frame) =>
        copyFile(
          join(sourceDirectory, frame.fileName),
          join(temporaryDirectory, frame.fileName),
        ),
      ),
    );
    await writeFile(
      join(temporaryDirectory, "provenance.json"),
      `${JSON.stringify(document, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    await mkdir(parent, { recursive: true, mode: 0o700 });
    try {
      await rename(temporaryDirectory, cacheDirectory);
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        (error.code === "EEXIST" || error.code === "ENOTEMPTY")
      ) {
        return;
      }
      throw error;
    }
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

async function createInlineFrames(
  frames: FrameProvenance[],
  config: AppConfig,
  signal?: AbortSignal,
): Promise<InlineFrame[]> {
  const scratchDirectory = await mkdtemp(
    join(tmpdir(), `video-understanding-${process.pid}-inline-`),
  );
  try {
    return await Promise.all(
      frames.map(async (frame, index) => {
        const outputPath = join(scratchDirectory, `inline-${index}.jpg`);
        await runCommand(
          config.ffmpegPath,
          [
            "-nostdin",
            "-hide_banner",
            "-loglevel",
            "error",
            "-i",
            frame.path,
            "-vf",
            "scale=512:512:force_original_aspect_ratio=decrease",
            "-frames:v",
            "1",
            "-q:v",
            "4",
            "-y",
            outputPath,
          ],
          commandOptions(signal, 1024 * 1024),
        );
        return {
          frameId: frame.id,
          data: (await readFile(outputPath)).toString("base64"),
          mimeType: "image/jpeg" as const,
        };
      }),
    );
  } finally {
    await rm(scratchDirectory, { recursive: true, force: true });
  }
}

function canonicalJson(value: Record<string, number>): string {
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(value).sort(([left], [right]) =>
        left.localeCompare(right),
      ),
    ),
  );
}

function frameFileName(pts: number): string {
  const sign = pts < 0 ? "neg_" : "";
  return `f_${sign}${String(Math.abs(pts)).padStart(13, "0")}.jpg`;
}

function timeBaseSeconds(value: string): number {
  const [numerator, denominator] = value.split("/").map(Number);
  if (
    !Number.isFinite(numerator) ||
    !Number.isFinite(denominator) ||
    denominator === 0
  ) {
    return 0;
  }
  return numerator! / denominator!;
}

function inverseRateSeconds(value: string): number {
  const [numerator, denominator] = value.split("/").map(Number);
  if (
    !Number.isFinite(numerator) ||
    !Number.isFinite(denominator) ||
    numerator === 0
  ) {
    return 0;
  }
  return denominator! / numerator!;
}

async function validateExistingDurableOutput(
  durableDirectory: string,
  document: CachedFrameDocument,
  config: AppConfig,
): Promise<void> {
  try {
    await stat(durableDirectory);
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return;
    }
    throw error;
  }

  const resolved = await validateOutputDirectory(
    durableDirectory,
    config.allowedWriteRoots,
  );
  try {
    const existing = JSON.parse(
      await readFile(join(resolved, "provenance.json"), "utf8"),
    ) as Partial<CachedFrameDocument>;
    if (
      existing.input_sha256 !== document.input_sha256 ||
      !existing.parameters ||
      canonicalJson(existing.parameters) !== canonicalJson(document.parameters)
    ) {
      throw new Error("Provenance does not match");
    }
  } catch (error) {
    throw new VideoUnderstandingError(
      "OUTPUT_DIRECTORY_CONFLICT",
      "Durable frame directory already exists without matching provenance",
      { cause: error },
    );
  }
}

function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new VideoUnderstandingError("CANCELLED", "Command was cancelled");
  }
}

function commandOptions(
  signal: AbortSignal | undefined,
  maxStdoutBytes: number,
) {
  return signal
    ? {
        signal,
        timeoutMs: FRAME_EXTRACTION_TIMEOUT_MS,
        maxStdoutBytes,
      }
    : {
        timeoutMs: FRAME_EXTRACTION_TIMEOUT_MS,
        maxStdoutBytes,
      };
}
