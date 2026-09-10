import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";

import { VideoUnderstandingError } from "./errors.js";

export async function sha256File(
  path: string,
  signal?: AbortSignal,
): Promise<string> {
  const hash = createHash("sha256");

  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(path);
    const onAbort = () => {
      stream.destroy(
        new VideoUnderstandingError("CANCELLED", "Hashing was cancelled"),
      );
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("error", (error) => {
      signal?.removeEventListener("abort", onAbort);
      reject(error);
    });
    stream.once("end", () => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    });

    if (signal?.aborted) {
      onAbort();
    }
  });

  return hash.digest("hex");
}

export function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
