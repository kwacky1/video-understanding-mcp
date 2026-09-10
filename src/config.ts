import { homedir, tmpdir } from "node:os";
import { delimiter, isAbsolute, join, resolve } from "node:path";

export interface AppConfig {
  allowedReadRoots: string[];
  maxInputBytes: number;
  ffprobePath: string;
  ffmpegPath: string;
  whisperPath: string;
  cacheDir: string;
}

const DEFAULT_MAX_INPUT_BYTES = 10 * 1024 * 1024 * 1024;

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

  if (!Number.isSafeInteger(maxInputBytes) || maxInputBytes <= 0) {
    throw new Error("VU_MAX_INPUT_BYTES must be a positive integer");
  }

  for (const root of configuredRoots ?? []) {
    if (!isAbsolute(root)) {
      throw new Error("VU_ALLOWED_READ_ROOTS entries must be absolute paths");
    }
  }

  return {
    allowedReadRoots: (configuredRoots?.length ? configuredRoots : [cwd]).map(
      (root) => resolve(root),
    ),
    maxInputBytes,
    ffprobePath: env.VU_FFPROBE_PATH ?? "ffprobe",
    ffmpegPath: env.VU_FFMPEG_PATH ?? "ffmpeg",
    whisperPath: env.VU_WHISPER_PATH ?? "whisper-cli",
    cacheDir:
      env.VU_CACHE_DIR ??
      (process.platform === "darwin"
        ? join(homedir(), "Library", "Caches", "video-understanding-mcp")
        : join(env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "video-understanding-mcp")),
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
