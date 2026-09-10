import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";
import {
  normaliseWhisperOutput,
  transcriptMarkdown,
  transcribeVideo,
} from "../src/transcribe.js";

const tempPaths: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("whisper transcript normalisation", () => {
  it("normalises timestamped segments and renders Markdown", () => {
    const document = normaliseWhisperOutput(
      {
        result: { language: "en" },
        transcription: [
          { offsets: { from: 0, to: 1250 }, text: " Hello " },
          { offsets: { from: 1250, to: 2480 }, text: "world." },
        ],
      },
      "input-hash",
      "large-v3-turbo-q5_0",
      "model-hash",
      "auto",
    );

    expect(document).toMatchObject({
      schema_version: "1.0",
      language: "en",
      duration_ms: 2480,
      segments: [
        { id: 0, start_ms: 0, end_ms: 1250, text: "Hello" },
        { id: 1, start_ms: 1250, end_ms: 2480, text: "world." },
      ],
    });
    expect(transcriptMarkdown(document)).toContain(
      "**[00:00:01.250 --> 00:00:02.480]** world.",
    );
  });

  it("rejects non-monotonic timestamps", () => {
    expect(() =>
      normaliseWhisperOutput(
        {
          transcription: [
            { offsets: { from: 1000, to: 2000 }, text: "First" },
            { offsets: { from: 500, to: 2500 }, text: "Second" },
          ],
        },
        "input-hash",
        "model",
        "model-hash",
        "en",
      ),
    ).toThrow("non-monotonic");
  });
});

describe("transcribeVideo", () => {
  it("writes timestamped JSON and Markdown and reuses the cache", async () => {
    const root = await mkdtemp(join(tmpdir(), "vu-transcribe-"));
    tempPaths.push(root);
    const inputPath = join(root, "demo.mp4");
    const modelPath = join(root, "ggml-test-model.bin");
    const ffmpegPath = join(root, "fake-ffmpeg.sh");
    const whisperPath = join(root, "fake-whisper.sh");
    const outputDir = join(root, "output");
    await Promise.all([
      writeFile(inputPath, "video bytes"),
      writeFile(modelPath, "model bytes"),
      writeFile(
        ffmpegPath,
        '#!/bin/sh\nfor last do :; done\nprintf "wav" > "$last"\n',
      ),
      writeFile(
        whisperPath,
        `#!/bin/sh
prefix=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-of" ]; then prefix="$2"; shift 2; else shift; fi
done
cat > "\${prefix}.json" <<'JSON'
{"result":{"language":"en"},"transcription":[{"offsets":{"from":0,"to":1000},"text":"Cached speech."}]}
JSON
`,
      ),
    ]);
    await mkdir(outputDir);
    await Promise.all([chmod(ffmpegPath, 0o755), chmod(whisperPath, 0o755)]);

    const config = loadConfig(
      {
        VU_ALLOWED_READ_ROOTS: root,
        VU_ALLOWED_WRITE_ROOTS: root,
        VU_CACHE_DIR: join(root, "cache"),
        VU_FFMPEG_PATH: ffmpegPath,
        VU_WHISPER_PATH: whisperPath,
        VU_WHISPER_MODEL_PATH: modelPath,
      },
      root,
    );

    const first = await transcribeVideo(
      inputPath,
      { outputDir, language: "en" },
      config,
    );
    const second = await transcribeVideo(
      inputPath,
      { outputDir, language: "en" },
      config,
    );

    expect(first).toMatchObject({
      cache_hit: false,
      duration_ms: 1000,
      segments: [{ start_ms: 0, end_ms: 1000, text: "Cached speech." }],
    });
    expect(second).toMatchObject({
      cache_hit: true,
      transcript_json_path: first.transcript_json_path,
      transcript_markdown_path: first.transcript_markdown_path,
    });
    expect(
      JSON.parse(await readFile(first.transcript_json_path, "utf8")),
    ).toMatchObject({ schema_version: "1.0", duration_ms: 1000 });
    expect(await readFile(first.transcript_markdown_path, "utf8")).toContain(
      "**[00:00:00.000 --> 00:00:01.000]** Cached speech.",
    );

    const [cacheKey] = await readdir(
      join(root, "cache", "transcript-v1"),
    );
    await unlink(
      join(root, "cache", "transcript-v1", cacheKey!, "transcript.md"),
    );
    const recovered = await transcribeVideo(
      inputPath,
      { outputDir, language: "en" },
      config,
    );
    expect(recovered.cache_hit).toBe(false);
  });
});
