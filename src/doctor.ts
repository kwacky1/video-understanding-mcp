#!/usr/bin/env node
import { pathToFileURL } from "node:url";

import { loadConfig } from "./config.js";
import { errorMessage } from "./errors.js";
import { runCommand } from "./subprocess.js";

interface DoctorCheck {
  name: string;
  executable: string;
  ready: boolean;
  version?: string;
  error?: string;
}

async function checkExecutable(
  name: string,
  executable: string,
  args: string[],
): Promise<DoctorCheck> {
  try {
    const result = await runCommand(executable, args, {
      timeoutMs: 5_000,
      maxStdoutBytes: 128 * 1024,
      maxStderrBytes: 128 * 1024,
    });
    const output = `${result.stdout}\n${result.stderr}`.trim();
    return {
      name,
      executable,
      ready: true,
      version: output.split(/\r?\n/, 1)[0] || "available",
    };
  } catch (error) {
    return { name, executable, ready: false, error: errorMessage(error) };
  }
}

export async function runDoctor(): Promise<DoctorCheck[]> {
  const config = loadConfig();
  return Promise.all([
    checkExecutable("ffmpeg", config.ffmpegPath, ["-version"]),
    checkExecutable("ffprobe", config.ffprobePath, ["-version"]),
    checkExecutable("whisper.cpp", config.whisperPath, ["--help"]),
  ]);
}

async function main(): Promise<void> {
  const checks = await runDoctor();
  const asJson = process.argv.includes("--json");

  if (asJson) {
    process.stdout.write(`${JSON.stringify({ checks }, null, 2)}\n`);
  } else {
    for (const check of checks) {
      const detail = check.ready ? check.version : check.error;
      process.stdout.write(
        `${check.ready ? "READY" : "MISSING"} ${check.name}: ${detail}\n`,
      );
    }
  }

  if (checks.some((check) => !check.ready)) {
    process.exitCode = 1;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error: unknown) => {
    process.stderr.write(`vu-doctor: ${errorMessage(error)}\n`);
    process.exitCode = 1;
  });
}
