import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, isAbsolute, join, resolve } from "node:path";

import { VideoUnderstandingError } from "./errors.js";
import { sha256File } from "./hash.js";

export async function executableFingerprint(
  executable: string,
  signal?: AbortSignal,
): Promise<string> {
  return sha256File(await resolveExecutable(executable), signal);
}

export async function resolveExecutable(executable: string): Promise<string> {
  if (
    isAbsolute(executable) ||
    executable.includes("/") ||
    executable.includes("\\")
  ) {
    return resolve(executable);
  }

  const extensions =
    process.platform === "win32"
      ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";")
      : [""];

  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (!directory) continue;
    for (const extension of extensions) {
      const candidate = join(directory, `${executable}${extension}`);
      try {
        await access(candidate, constants.X_OK);
        return candidate;
      } catch {
        // Try the next PATH candidate.
      }
    }
  }

  throw new VideoUnderstandingError(
    "EXECUTABLE_NOT_FOUND",
    `Could not resolve ${executable} from PATH`,
  );
}
