import { createHash } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
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

  let resolvedRoots: string[];
  try {
    resolvedRoots = await Promise.all(allowedRoots.map((root) => realpath(root)));
  } catch (error) {
    throw new VideoUnderstandingError(
      "INVALID_ROOT_CONFIG",
      "Every configured readable root must exist",
      { cause: error },
    );
  }

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
