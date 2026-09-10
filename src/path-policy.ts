import { createHash } from "node:crypto";
import { access, realpath, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { isAbsolute, relative } from "node:path";

import { VideoUnderstandingError } from "./errors.js";

export interface ValidatedInput {
  path: string;
  sizeBytes: number;
  pathHash: string;
}

function isWithinRoot(target: string, root: string): boolean {
  const relation = relative(root, target);
  return relation === "" || (!relation.startsWith("..") && !isAbsolute(relation));
}

async function resolveRoots(allowedRoots: string[]): Promise<string[]> {
  try {
    return await Promise.all(allowedRoots.map((root) => realpath(root)));
  } catch (error) {
    throw new VideoUnderstandingError(
      "INVALID_ROOT_CONFIG",
      "Every configured filesystem root must exist",
      { cause: error },
    );
  }
}

export async function validateInputPath(
  inputPath: string,
  allowedRoots: string[],
  maxInputBytes: number,
): Promise<ValidatedInput> {
  if (inputPath.includes("\0")) {
    throw new VideoUnderstandingError(
      "INVALID_PATH",
      "Input path must not contain NUL bytes",
    );
  }

  if (!isAbsolute(inputPath)) {
    throw new VideoUnderstandingError(
      "RELATIVE_PATH",
      "Input path must be absolute",
    );
  }

  let resolvedPath: string;

  try {
    resolvedPath = await realpath(inputPath);
  } catch (error) {
    throw new VideoUnderstandingError(
      "PATH_NOT_FOUND",
      "Input path does not exist",
      { cause: error },
    );
  }

  const resolvedRoots = await resolveRoots(allowedRoots);

  if (!resolvedRoots.some((root) => isWithinRoot(resolvedPath, root))) {
    throw new VideoUnderstandingError(
      "PATH_OUTSIDE_ALLOWED_ROOTS",
      "Input path resolves outside the configured readable roots",
    );
  }

  const inputStat = await stat(resolvedPath);

  if (!inputStat.isFile()) {
    throw new VideoUnderstandingError(
      "NOT_A_FILE",
      "Input path must resolve to a regular file",
    );
  }

  if (inputStat.size > maxInputBytes) {
    throw new VideoUnderstandingError(
      "INPUT_TOO_LARGE",
      `Input is ${inputStat.size} bytes; maximum is ${maxInputBytes} bytes`,
    );
  }

  return {
    path: resolvedPath,
    sizeBytes: inputStat.size,
    pathHash: createHash("sha256").update(resolvedPath).digest("hex"),
  };
}

export async function validateOutputDirectory(
  outputDirectory: string,
  allowedRoots: string[],
): Promise<string> {
  if (outputDirectory.includes("\0")) {
    throw new VideoUnderstandingError(
      "INVALID_PATH",
      "Output directory must not contain NUL bytes",
    );
  }

  if (!isAbsolute(outputDirectory)) {
    throw new VideoUnderstandingError(
      "RELATIVE_PATH",
      "Output directory must be absolute",
    );
  }

  let resolvedDirectory: string;
  try {
    resolvedDirectory = await realpath(outputDirectory);
  } catch (error) {
    throw new VideoUnderstandingError(
      "OUTPUT_DIRECTORY_NOT_FOUND",
      "Output directory does not exist",
      { cause: error },
    );
  }

  const resolvedRoots = await resolveRoots(allowedRoots);
  if (!resolvedRoots.some((root) => isWithinRoot(resolvedDirectory, root))) {
    throw new VideoUnderstandingError(
      "PATH_OUTSIDE_ALLOWED_ROOTS",
      "Output directory resolves outside the configured writable roots",
    );
  }

  const outputStat = await stat(resolvedDirectory);
  if (!outputStat.isDirectory()) {
    throw new VideoUnderstandingError(
      "NOT_A_DIRECTORY",
      "Output directory must resolve to a directory",
    );
  }

  try {
    await access(resolvedDirectory, constants.W_OK);
  } catch (error) {
    throw new VideoUnderstandingError(
      "OUTPUT_DIRECTORY_NOT_WRITABLE",
      "Output directory is not writable",
      { cause: error },
    );
  }

  return resolvedDirectory;
}
