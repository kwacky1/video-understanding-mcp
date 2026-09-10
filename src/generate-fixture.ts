#!/usr/bin/env node
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { loadConfig } from "./config.js";
import { errorMessage } from "./errors.js";
import { runCommand } from "./subprocess.js";

export async function generateFixture(outputPath: string): Promise<void> {
  const config = loadConfig();
  const target = resolve(outputPath);
  await mkdir(dirname(target), { recursive: true });
  await runCommand(
    config.ffmpegPath,
    [
      "-nostdin",
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=320x180:rate=10:duration=2",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=1000:sample_rate=16000:duration=2",
      "-shortest",
      "-c:v",
      "mpeg4",
      "-c:a",
      "aac",
      "-y",
      target,
    ],
    { timeoutMs: 30_000 },
  );
}

async function main(): Promise<void> {
  const outputPath = process.argv[2];

  if (!outputPath) {
    throw new Error("Usage: vu-generate-fixture <absolute-or-relative-output.mp4>");
  }

  await generateFixture(outputPath);
  process.stdout.write(`${resolve(outputPath)}\n`);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error: unknown) => {
    process.stderr.write(`vu-generate-fixture: ${errorMessage(error)}\n`);
    process.exitCode = 1;
  });
}
