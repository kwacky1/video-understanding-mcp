import { randomUUID } from "node:crypto";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import {
  basename,
  dirname,
  extname,
  join,
} from "node:path";
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
import { runCommand } from "./subprocess.js";

interface RawWhisperSegment {
  offsets?: {
    from?: number;
    to?: number;
  };
  text?: string;
}

interface RawWhisperOutput {
  result?: {
    language?: string;
  };
  transcription?: RawWhisperSegment[];
}

export interface TranscriptSegment extends Record<string, unknown> {
  id: number;
  start_ms: number;
  end_ms: number;
  text: string;
}

export interface TranscriptDocument extends Record<string, unknown> {
  schema_version: "1.0";
  input_sha256: string;
  engine: {
    name: "whisper.cpp";
    model: string;
    model_sha256: string;
  };
  language: string;
  duration_ms: number;
  segments: TranscriptSegment[];
}

export interface VideoTranscribeResult extends TranscriptDocument {
  transcript_json_path: string;
  transcript_markdown_path: string;
  cache_hit: boolean;
}

export interface TranscribeOptions {
  language?: string;
  outputDir: string;
}

const TRANSCRIPT_STAGE = "transcript-v1";
const TRANSCRIPTION_TIMEOUT_MS = 2 * 60 * 60 * 1000;

function canonicalJson(value: Record<string, string>): string {
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(value).sort(([left], [right]) =>
        left.localeCompare(right),
      ),
    ),
  );
}

function modelName(modelPath: string): string {
  return basename(modelPath)
    .replace(/^ggml-/, "")
    .replace(/\.bin$/, "");
}

function timestamp(milliseconds: number): string {
  const hours = Math.floor(milliseconds / 3_600_000);
  const minutes = Math.floor((milliseconds % 3_600_000) / 60_000);
  const seconds = Math.floor((milliseconds % 60_000) / 1_000);
  const millis = milliseconds % 1_000;
  return [hours, minutes, seconds]
    .map((part) => String(part).padStart(2, "0"))
    .join(":")
    .concat(".", String(millis).padStart(3, "0"));
}

export function normaliseWhisperOutput(
  raw: RawWhisperOutput,
  inputSha256: string,
  model: string,
  modelSha256: string,
  requestedLanguage: string,
): TranscriptDocument {
  const segments = (raw.transcription ?? []).map((segment, index) => {
    const startMs = segment.offsets?.from;
    const endMs = segment.offsets?.to;

    if (
      !Number.isSafeInteger(startMs) ||
      !Number.isSafeInteger(endMs) ||
      startMs! < 0 ||
      endMs! < startMs!
    ) {
      throw new VideoUnderstandingError(
        "INVALID_WHISPER_OUTPUT",
        `whisper.cpp returned invalid offsets for segment ${index}`,
      );
    }

    return {
      id: index,
      start_ms: startMs!,
      end_ms: endMs!,
      text: (segment.text ?? "").trim(),
    };
  });

  for (let index = 1; index < segments.length; index += 1) {
    if (segments[index]!.start_ms < segments[index - 1]!.start_ms) {
      throw new VideoUnderstandingError(
        "INVALID_WHISPER_OUTPUT",
        "whisper.cpp returned non-monotonic segment timestamps",
      );
    }
  }

  return {
    schema_version: "1.0",
    input_sha256: inputSha256,
    engine: {
      name: "whisper.cpp",
      model,
      model_sha256: modelSha256,
    },
    language: raw.result?.language ?? requestedLanguage,
    duration_ms: segments.at(-1)?.end_ms ?? 0,
    segments,
  };
}

export function transcriptMarkdown(document: TranscriptDocument): string {
  const lines = [
    "# Video transcript",
    "",
    `- Input SHA-256: \`${document.input_sha256}\``,
    `- Engine: ${document.engine.name}`,
    `- Model: ${document.engine.model}`,
    `- Model SHA-256: \`${document.engine.model_sha256}\``,
    `- Language: ${document.language}`,
    `- Duration: ${timestamp(document.duration_ms)}`,
    "",
    "## Transcript",
    "",
  ];

  for (const segment of document.segments) {
    lines.push(
      `**[${timestamp(segment.start_ms)} --> ${timestamp(segment.end_ms)}]** ${segment.text}`,
      "",
    );
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

export async function transcribeVideo(
  inputPath: string,
  options: TranscribeOptions,
  config: AppConfig,
  signal?: AbortSignal,
): Promise<VideoTranscribeResult> {
  if (!config.whisperModelPath) {
    throw new VideoUnderstandingError(
      "WHISPER_MODEL_NOT_CONFIGURED",
      "Set VU_WHISPER_MODEL_PATH to an absolute local whisper.cpp model path",
    );
  }

  const language = options.language?.trim() || "en";
  const validatedInput = await validateInputPath(
    inputPath,
    config.allowedReadRoots,
    config.maxInputBytes,
  );
  const outputDir = await validateOutputDirectory(
    options.outputDir,
    config.allowedWriteRoots,
  );
  await validateModel(config.whisperModelPath);

  const [inputSha256, modelSha256, whisperFingerprint] = await Promise.all([
    sha256File(validatedInput.path, signal),
    sha256File(config.whisperModelPath, signal),
    executableFingerprint(config.whisperPath, signal),
  ]);
  const model = modelName(config.whisperModelPath);
  const cacheKey = sha256Text(
    [
      inputSha256,
      TRANSCRIPT_STAGE,
      canonicalJson({ language }),
      whisperFingerprint,
      modelSha256,
    ].join("\n"),
  );
  const cacheDirectory = join(config.cacheDir, TRANSCRIPT_STAGE, cacheKey);
  await enforceCachePolicy(config, [cacheDirectory]);
  const cachedJsonPath = join(cacheDirectory, "transcript.json");
  const cachedMarkdownPath = join(cacheDirectory, "transcript.md");

  let document = await readCachedTranscript(
    cachedJsonPath,
    cachedMarkdownPath,
  );
  let cacheHit = document !== undefined;
  if (!document) {
    document = await runTranscription(
      validatedInput.path,
      inputSha256,
      language,
      model,
      modelSha256,
      config,
      signal,
    );
    await writeCache(
      cachedJsonPath,
      cachedMarkdownPath,
      document,
      transcriptMarkdown(document),
    );
    cacheHit = false;
  } else {
    await touchCacheEntry(cacheDirectory);
  }

  const stem = basename(validatedInput.path, extname(validatedInput.path));
  const artefactPrefix = `${stem}.${cacheKey.slice(0, 12)}.transcript`;
  const transcriptJsonPath = join(outputDir, `${artefactPrefix}.json`);
  const transcriptMarkdownPath = join(outputDir, `${artefactPrefix}.md`);
  await Promise.all([
    atomicCopy(cachedJsonPath, transcriptJsonPath),
    atomicCopy(cachedMarkdownPath, transcriptMarkdownPath),
  ]);
  await enforceCachePolicy(config, [cacheDirectory]);

  return {
    ...document,
    transcript_json_path: transcriptJsonPath,
    transcript_markdown_path: transcriptMarkdownPath,
    cache_hit: cacheHit,
  };
}

async function validateModel(path: string): Promise<void> {
  let modelStat;
  try {
    modelStat = await stat(path);
  } catch (error) {
    throw new VideoUnderstandingError(
      "WHISPER_MODEL_NOT_FOUND",
      "Configured whisper.cpp model does not exist",
      { cause: error },
    );
  }

  if (!modelStat.isFile()) {
    throw new VideoUnderstandingError(
      "WHISPER_MODEL_NOT_FOUND",
      "Configured whisper.cpp model must be a regular file",
    );
  }
}

async function readCachedTranscript(
  jsonPath: string,
  markdownPath: string,
): Promise<TranscriptDocument | undefined> {
  try {
    const [json, markdown] = await Promise.all([
      readFile(jsonPath, "utf8"),
      readFile(markdownPath, "utf8"),
    ]);
    const parsed = JSON.parse(json) as
      | TranscriptDocument
      | undefined;
    if (
      parsed?.schema_version !== "1.0" ||
      !Array.isArray(parsed.segments) ||
      parsed.engine?.name !== "whisper.cpp" ||
      markdown.length === 0
    ) {
      return undefined;
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
      "Could not read cached transcript data",
      { cause: error },
    );
  }
}

async function runTranscription(
  inputPath: string,
  inputSha256: string,
  language: string,
  model: string,
  modelSha256: string,
  config: AppConfig,
  signal?: AbortSignal,
): Promise<TranscriptDocument> {
  const scratchDirectory = await mkdtemp(
    join(tmpdir(), `video-understanding-${process.pid}-`),
  );
  const audioPath = join(scratchDirectory, "audio.wav");
  const transcriptPrefix = join(scratchDirectory, "transcript");

  try {
    await runCommand(
      config.ffmpegPath,
      [
        "-nostdin",
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        inputPath,
        "-vn",
        "-map",
        "0:a:0",
        "-ar",
        "16000",
        "-ac",
        "1",
        "-c:a",
        "pcm_s16le",
        "-y",
        audioPath,
      ],
      signal
        ? { signal, timeoutMs: TRANSCRIPTION_TIMEOUT_MS }
        : { timeoutMs: TRANSCRIPTION_TIMEOUT_MS },
    );
    await runCommand(
      config.whisperPath,
      [
        "-m",
        config.whisperModelPath!,
        "-f",
        audioPath,
        "-oj",
        "-of",
        transcriptPrefix,
        "-l",
        language,
      ],
      signal
        ? {
            signal,
            timeoutMs: TRANSCRIPTION_TIMEOUT_MS,
            maxStdoutBytes: 1024 * 1024,
          }
        : {
            timeoutMs: TRANSCRIPTION_TIMEOUT_MS,
            maxStdoutBytes: 1024 * 1024,
          },
    );

    let raw: RawWhisperOutput;
    try {
      raw = JSON.parse(
        await readFile(`${transcriptPrefix}.json`, "utf8"),
      ) as RawWhisperOutput;
    } catch (error) {
      throw new VideoUnderstandingError(
        "INVALID_WHISPER_OUTPUT",
        "whisper.cpp did not produce valid transcript JSON",
        { cause: error },
      );
    }

    return normaliseWhisperOutput(
      raw,
      inputSha256,
      model,
      modelSha256,
      language,
    );
  } finally {
    await rm(scratchDirectory, { recursive: true, force: true });
  }
}

async function writeCache(
  jsonPath: string,
  markdownPath: string,
  document: TranscriptDocument,
  markdown: string,
): Promise<void> {
  await mkdir(dirname(jsonPath), { recursive: true, mode: 0o700 });
  await Promise.all([
    atomicWrite(jsonPath, `${JSON.stringify(document, null, 2)}\n`),
    atomicWrite(markdownPath, markdown),
  ]);
}

async function atomicWrite(path: string, content: string): Promise<void> {
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, content, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporaryPath, path);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

async function atomicCopy(source: string, destination: string): Promise<void> {
  const temporaryPath = `${destination}.${randomUUID()}.tmp`;
  try {
    await copyFile(source, temporaryPath);
    await rename(temporaryPath, destination);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}
