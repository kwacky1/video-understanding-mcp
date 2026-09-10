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
