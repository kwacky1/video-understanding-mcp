import { spawn } from "node:child_process";

import { minimalChildEnv } from "./config.js";
import { VideoUnderstandingError } from "./errors.js";

export interface RunCommandOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
  env?: NodeJS.ProcessEnv;
}

export interface CommandResult {
  stdout: string;
  stderr: string;
}

const DEFAULT_OUTPUT_LIMIT = 4 * 1024 * 1024;

export function runCommand(
  executable: string,
  args: string[],
  options: RunCommandOptions = {},
): Promise<CommandResult> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const maxStdoutBytes = options.maxStdoutBytes ?? DEFAULT_OUTPUT_LIMIT;
  const maxStderrBytes = options.maxStderrBytes ?? 64 * 1024;

  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(
        new VideoUnderstandingError("CANCELLED", "Command was cancelled"),
      );
      return;
    }

    const child = spawn(executable, args, {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: options.env ?? minimalChildEnv(),
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let terminationReason: VideoUnderstandingError | undefined;
    let killTimer: NodeJS.Timeout | undefined;

    const terminate = (reason: VideoUnderstandingError) => {
      if (terminationReason) {
        return;
      }

      terminationReason = reason;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 2_000);
      killTimer.unref();
    };

    const timeout = setTimeout(
      () =>
        terminate(
          new VideoUnderstandingError(
            "COMMAND_TIMEOUT",
            `Command exceeded ${timeoutMs}ms`,
          ),
        ),
      timeoutMs,
    );
    timeout.unref();

    const onAbort = () =>
      terminate(
        new VideoUnderstandingError("CANCELLED", "Command was cancelled"),
      );
    options.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxStdoutBytes) {
        terminate(
          new VideoUnderstandingError(
            "STDOUT_LIMIT",
            `Command stdout exceeded ${maxStdoutBytes} bytes`,
          ),
        );
        return;
      }
      stdoutChunks.push(chunk);
    });

    child.stderr.on("data", (chunk: Buffer) => {
      const remaining = maxStderrBytes - stderrBytes;
      if (remaining > 0) {
        stderrChunks.push(chunk.subarray(0, remaining));
      }
      stderrBytes += chunk.length;
    });

    child.once("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      options.signal?.removeEventListener("abort", onAbort);
      const errorCode =
        "code" in error && (error.code === "ENOENT" || error.code === "EACCES")
          ? "EXECUTABLE_NOT_FOUND"
          : "SPAWN_FAILED";
      reject(
        new VideoUnderstandingError(
          errorCode,
          `Could not start ${executable}: ${error.message}`,
          { cause: error },
        ),
      );
    });

    child.once("close", (code, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      options.signal?.removeEventListener("abort", onAbort);

      if (terminationReason) {
        reject(terminationReason);
        return;
      }

      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      const stderr = Buffer.concat(stderrChunks).toString("utf8");

      if (code !== 0) {
        const detail = stderr.trim() || `terminated by ${signal ?? "unknown signal"}`;
        reject(
          new VideoUnderstandingError(
            "COMMAND_FAILED",
            `${executable} exited with code ${code ?? "null"}: ${detail}`,
          ),
        );
        return;
      }

      resolve({ stdout, stderr });
    });
  });
}
