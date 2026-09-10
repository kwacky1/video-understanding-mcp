import { delimiter, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { loadConfig, minimalChildEnv } from "../src/config.js";

describe("loadConfig", () => {
  it("defaults readable roots to the current working directory", () => {
    const config = loadConfig({}, "/tmp/project");
    expect(config.allowedReadRoots).toEqual([resolve("/tmp/project")]);
  });

  it("loads multiple configured roots", () => {
    const config = loadConfig(
      {
        VU_ALLOWED_READ_ROOTS: ["/tmp/one", "/tmp/two"].join(delimiter),
      },
      "/tmp/project",
    );
    expect(config.allowedReadRoots).toEqual([
      resolve("/tmp/one"),
      resolve("/tmp/two"),
    ]);
    expect(config.allowedWriteRoots).toEqual([
      resolve("/tmp/one"),
      resolve("/tmp/two"),
    ]);
  });

  it("loads separate writable roots and a model path", () => {
    const config = loadConfig(
      {
        VU_ALLOWED_WRITE_ROOTS: ["/tmp/output-one", "/tmp/output-two"].join(
          delimiter,
        ),
        VU_WHISPER_MODEL_PATH: "/tmp/models/whisper.bin",
      },
      "/tmp/project",
    );

    expect(config.allowedWriteRoots).toEqual([
      resolve("/tmp/output-one"),
      resolve("/tmp/output-two"),
    ]);
    expect(config.whisperModelPath).toBe(
      resolve("/tmp/models/whisper.bin"),
    );
    expect(config.cacheMaxAgeMs).toBe(14 * 24 * 60 * 60 * 1000);
    expect(config.cacheMaxBytes).toBe(5 * 1024 * 1024 * 1024);
  });

  it("rejects an invalid maximum input size", () => {
    expect(() => loadConfig({ VU_MAX_INPUT_BYTES: "unlimited" })).toThrow(
      "VU_MAX_INPUT_BYTES must be a positive integer",
    );
  });

  it("rejects relative allowed roots", () => {
    expect(() =>
      loadConfig({ VU_ALLOWED_READ_ROOTS: `videos${delimiter}/tmp/videos` }),
    ).toThrow("VU_ALLOWED_READ_ROOTS entries must be absolute paths");
  });

  it("rejects relative writable roots", () => {
    expect(() =>
      loadConfig({ VU_ALLOWED_WRITE_ROOTS: `output${delimiter}/tmp/output` }),
    ).toThrow("VU_ALLOWED_WRITE_ROOTS entries must be absolute paths");
  });

  it("rejects a relative model path", () => {
    expect(() =>
      loadConfig({ VU_WHISPER_MODEL_PATH: "models/whisper.bin" }),
    ).toThrow("VU_WHISPER_MODEL_PATH must be an absolute path");
  });

  it("validates cache retention settings", () => {
    expect(() => loadConfig({ VU_CACHE_MAX_AGE_DAYS: "0" })).toThrow(
      "VU_CACHE_MAX_AGE_DAYS must be greater than zero",
    );
    expect(() => loadConfig({ VU_CACHE_MAX_BYTES: "unlimited" })).toThrow(
      "VU_CACHE_MAX_BYTES must be a positive integer",
    );
  });
});

describe("minimalChildEnv", () => {
  it("does not forward unrelated parent secrets", () => {
    const childEnv = minimalChildEnv({
      PATH: "/bin",
      HOME: "/tmp/home",
      SECRET_TOKEN: "do-not-forward",
    });

    expect(childEnv.PATH).toBe("/bin");
    expect(childEnv.HOME).toBe("/tmp/home");
    expect(childEnv.SECRET_TOKEN).toBeUndefined();
  });
});
