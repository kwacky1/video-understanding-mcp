import { homedir, tmpdir } from "node:os";
import { delimiter, isAbsolute, join, resolve } from "node:path";

export interface AppConfig {
  allowedReadRoots: string[];
  allowedWriteRoots: string[];
  maxInputBytes: number;
  ffprobePath: string;
  ffmpegPath: string;
  whisperPath: string;
  whisperModelPath: string | undefined;
  cacheDir: string;
  cacheMaxAgeMs: number;
  cacheMaxBytes: number;
}

const DEFAULT_MAX_INPUT_BYTES = 10 * 1024 * 1024 * 1024;
const DEFAULT_CACHE_MAX_AGE_DAYS = 14;
const DEFAULT_CACHE_MAX_BYTES = 5 * 1024 * 1024 * 1024;

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
): AppConfig {
  const configuredRoots = env.VU_ALLOWED_READ_ROOTS?.split(delimiter)
    .map((root) => root.trim())
    .filter(Boolean);
  const maxInputBytes = Number(
    env.VU_MAX_INPUT_BYTES ?? DEFAULT_MAX_INPUT_BYTES,
  );
  const cacheMaxAgeDays = Number(
    env.VU_CACHE_MAX_AGE_DAYS ?? DEFAULT_CACHE_MAX_AGE_DAYS,
  );
  const cacheMaxBytes = Number(
    env.VU_CACHE_MAX_BYTES ?? DEFAULT_CACHE_MAX_BYTES,
  );

  if (!Number.isSafeInteger(maxInputBytes) || maxInputBytes <= 0) {
    throw new Error("VU_MAX_INPUT_BYTES must be a positive integer");
  }
  if (!Number.isFinite(cacheMaxAgeDays) || cacheMaxAgeDays <= 0) {
    throw new Error("VU_CACHE_MAX_AGE_DAYS must be greater than zero");
  }
  if (!Number.isSafeInteger(cacheMaxBytes) || cacheMaxBytes <= 0) {
    throw new Error("VU_CACHE_MAX_BYTES must be a positive integer");
  }

  for (const root of configuredRoots ?? []) {
    if (!isAbsolute(root)) {
      throw new Error("VU_ALLOWED_READ_ROOTS entries must be absolute paths");
    }
  }

  const allowedReadRoots = (
    configuredRoots?.length ? configuredRoots : [cwd]
  ).map((root) => resolve(root));
  const configuredWriteRoots = env.VU_ALLOWED_WRITE_ROOTS?.split(delimiter)
    .map((root) => root.trim())
    .filter(Boolean);

  for (const root of configuredWriteRoots ?? []) {
    if (!isAbsolute(root)) {
      throw new Error("VU_ALLOWED_WRITE_ROOTS entries must be absolute paths");
    }
  }

  if (env.VU_WHISPER_MODEL_PATH && !isAbsolute(env.VU_WHISPER_MODEL_PATH)) {
    throw new Error("VU_WHISPER_MODEL_PATH must be an absolute path");
  }

  return {
    allowedReadRoots,
    allowedWriteRoots: (
      configuredWriteRoots?.length ? configuredWriteRoots : allowedReadRoots
    ).map((root) => resolve(root)),
    maxInputBytes,
    ffprobePath: env.VU_FFPROBE_PATH ?? "ffprobe",
    ffmpegPath: env.VU_FFMPEG_PATH ?? "ffmpeg",
    whisperPath: env.VU_WHISPER_PATH ?? "whisper-cli",
    whisperModelPath: env.VU_WHISPER_MODEL_PATH
      ? resolve(env.VU_WHISPER_MODEL_PATH)
      : undefined,
    cacheDir:
      env.VU_CACHE_DIR ??
      (process.platform === "darwin"
        ? join(homedir(), "Library", "Caches", "video-understanding-mcp")
        : join(env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "video-understanding-mcp")),
    cacheMaxAgeMs: cacheMaxAgeDays * 24 * 60 * 60 * 1000,
    cacheMaxBytes,
  };
}

export function minimalChildEnv(
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const childEnv: NodeJS.ProcessEnv = {};

  for (const key of ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "SYSTEMROOT"]) {
    if (env[key] !== undefined) {
      childEnv[key] = env[key];
    }
  }

  childEnv.TMPDIR ??= tmpdir();
  return childEnv;
}
