import { describe, expect, it } from "vitest";

import { runCommand } from "../src/subprocess.js";

describe("runCommand", () => {
  it("reports missing executables clearly", async () => {
    await expect(
      runCommand("vu-command-that-does-not-exist", [], { timeoutMs: 1_000 }),
    ).rejects.toMatchObject({
      code: "EXECUTABLE_NOT_FOUND",
    });
  });

  it("supports cancellation", async () => {
    const controller = new AbortController();
    const command = runCommand(
      process.execPath,
      ["-e", "setTimeout(() => {}, 10000)"],
      { signal: controller.signal, timeoutMs: 20_000 },
    );
    controller.abort();

    await expect(command).rejects.toMatchObject({ code: "CANCELLED" });
  });
});
