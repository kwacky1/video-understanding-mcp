# video-understanding-mcp

Local stdio MCP server for extracting bounded, reproducible evidence from video.

> Early development: Milestones 1 through 3 provide safe video inspection,
> offline transcription, and timestamp-accurate visual evidence extraction.

The server provides:

- `video_probe`, backed by `ffprobe`
- `video_transcribe`, backed by FFmpeg and whisper.cpp
- `video_extract_frames`, with source-PTS scene and cadence sampling
- timestamped transcript JSON and Markdown written to caller-selected roots
- absolute-path and allowed-root enforcement
- symlink-escape protection
- bounded, cancellable subprocess execution
- content-addressed probe, transcript, and frame caching with retention limits
- `vu-doctor` readiness checks for FFmpeg, FFprobe, and whisper.cpp
- synthetic media fixtures and MCP stdio contract tests

## Requirements

- Node.js 22 or newer
- `ffmpeg`
- `ffprobe`
- `whisper-cli` and a local whisper.cpp GGML model (optional; only needed for
  `video_transcribe`)

### Install whisper.cpp and bootstrap a model

On macOS with Homebrew:

```bash
brew install whisper-cpp
npm run bootstrap:model
export VU_WHISPER_MODEL_PATH="$HOME/.local/share/video-understanding-mcp/models/ggml-large-v3-turbo-q5_0.bin"
```

The bootstrap script downloads the official
[`ggml-large-v3-turbo-q5_0.bin`](https://huggingface.co/ggerganov/whisper.cpp/blob/main/ggml-large-v3-turbo-q5_0.bin)
model and verifies its Git LFS SHA-256 digest,
`394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2`,
before reporting the configuration value. A failed checksum leaves no accepted
model. Pass a different destination directory when required:

```bash
npm run bootstrap:model -- /absolute/model/directory
```

The server never downloads a model or makes any other network request while
processing media.

## Build and run

```bash
git clone https://github.com/kwacky1/video-understanding-mcp.git
cd video-understanding-mcp
npm install
npm run build
VU_ALLOWED_READ_ROOTS="$HOME/Videos" \
VU_ALLOWED_WRITE_ROOTS="$HOME/Documents/transcripts" \
VU_WHISPER_MODEL_PATH="$HOME/.local/share/video-understanding-mcp/models/ggml-large-v3-turbo-q5_0.bin" \
npm start
```

`VU_ALLOWED_READ_ROOTS` is a path-delimited list. If it is omitted, the server
allows reads only within its current working directory.

Optional configuration:

| Variable | Default | Purpose |
|---|---:|---|
| `VU_ALLOWED_READ_ROOTS` | current directory | Readable filesystem roots |
| `VU_ALLOWED_WRITE_ROOTS` | readable roots | Writable transcript roots |
| `VU_MAX_INPUT_BYTES` | `10737418240` | Maximum accepted input size |
| `VU_FFPROBE_PATH` | `ffprobe` | FFprobe executable |
| `VU_FFMPEG_PATH` | `ffmpeg` | FFmpeg executable |
| `VU_WHISPER_PATH` | `whisper-cli` | whisper.cpp executable |
| `VU_WHISPER_MODEL_PATH` | none | Absolute path to a local GGML model |
| `VU_CACHE_DIR` | platform cache directory | Content-addressed cache root (`~/Library/Caches` on macOS, `%LOCALAPPDATA%\video-understanding-mcp\Cache` on Windows, `$XDG_CACHE_HOME` or `~/.cache` elsewhere) |
| `VU_CACHE_MAX_AGE_DAYS` | `14` | Maximum cache entry age |
| `VU_CACHE_MAX_BYTES` | `5368709120` | Maximum total cache size with LRU eviction |

Both root variables are path-delimited lists (`:` on macOS/Linux, `;` on
Windows). Output directories must already exist, resolve inside a configured
writable root, and be writable.

## Windows setup

The server runs natively on Windows 10/11 without WSL. Frame extraction and
probing only need FFmpeg; transcription is optional.

1. Install Node.js 22 or newer and FFmpeg (which includes `ffprobe`):

   ```powershell
   winget install --id OpenJS.NodeJS.LTS -e
   winget install --id Gyan.FFmpeg -e
   ```

   winget adds `ffmpeg.exe` and `ffprobe.exe` to
   `%LOCALAPPDATA%\Microsoft\WinGet\Links`. Open a new terminal so the updated
   `PATH` is picked up.

2. Build and check readiness:

   ```powershell
   git clone https://github.com/kwacky1/video-understanding-mcp.git
   cd video-understanding-mcp
   npm install
   npm run build
   npm run doctor
   ```

   `whisper.cpp` is reported as `OPTIONAL` when it is not installed; the
   doctor only fails when FFmpeg or FFprobe are missing. The
   `bootstrap:model` script needs a POSIX shell, so skip it on Windows unless
   you are using Git Bash or WSL.

3. Optionally generate a short synthetic clip to confirm frame extraction:

   ```powershell
   node dist\generate-fixture.js "$env:USERPROFILE\Videos\vu-fixture.mp4"
   ```

### Copilot CLI configuration on Windows

Add the server to `%USERPROFILE%\.copilot\mcp-config.json`. Use absolute
paths, escape backslashes in JSON, and point the FFmpeg variables at the
executables so the server does not depend on the MCP host's `PATH`:

```json
{
  "mcpServers": {
    "video-understanding": {
      "type": "local",
      "command": "node",
      "args": ["C:\\Users\\you\\video-understanding-mcp\\dist\\server.js"],
      "env": {
        "VU_ALLOWED_READ_ROOTS": "C:\\Users\\you\\Videos",
        "VU_ALLOWED_WRITE_ROOTS": "C:\\Users\\you\\Videos\\frames",
        "VU_FFMPEG_PATH": "C:\\Users\\you\\AppData\\Local\\Microsoft\\WinGet\\Links\\ffmpeg.exe",
        "VU_FFPROBE_PATH": "C:\\Users\\you\\AppData\\Local\\Microsoft\\WinGet\\Links\\ffprobe.exe"
      },
      "tools": ["*"]
    }
  }
}
```

If you manage Node with nvm-windows and the active version is older than 22,
set `command` to the absolute path of a newer `node.exe` instead of `node`.
Create the writable output directory before calling `video_extract_frames`.
Separate multiple roots with `;`.

## Transcription

`video_transcribe` accepts:

```json
{
  "path": "/absolute/path/demo.mp4",
  "output_dir": "/absolute/path/transcripts",
  "language": "en"
}
```

It extracts the first audio stream to a temporary 16 kHz mono WAV, runs
`whisper-cli` locally, and removes scratch files on success, failure, or
cancellation. The result includes timestamped segments and durable
`transcript_json_path` and `transcript_markdown_path` values.

The transcript cache key includes the input SHA-256, transcription schema,
canonical parameters, whisper executable fingerprint, and model SHA-256.
Repeating the same call reuses cached transcript artefacts and returns
`cache_hit: true`; changing the input, language, model, or executable
configuration invalidates the cache.

## Timestamped frame extraction

`video_extract_frames` accepts:

```json
{
  "path": "/absolute/path/demo.mp4",
  "output_dir": "/absolute/path/evidence",
  "interval_seconds": 10,
  "scene_threshold": 0.4,
  "max_frames": 24,
  "return_inline": false
}
```

The sampler combines the first frame, source-time cadence, scene changes, and
FFmpeg `mpdecimate` near-duplicate removal. It never uses the timestamp-
rewriting `fps` filter. The server records every selected frame's source PTS,
timebase, duration, selection reason, and SHA-256 in a durable
`provenance.json` file.

`max_frames` cannot exceed 24. Inline images are disabled by default; when
requested, no more than four JPEG thumbnails are returned and their longest
edge is at most 512 pixels. Full extracted frames remain in the durable output
directory.

All cache stages are pruned to the configured age and total-size limits. Recent
cache hits update the entry timestamp used for least-recently-used eviction.

## Doctor

```bash
npm run doctor
npm run doctor -- --json
```

The doctor exits non-zero when FFmpeg or FFprobe is not ready. whisper.cpp is
optional: when it is missing the doctor reports it as `OPTIONAL` and still
exits zero, and only `video_transcribe` is unavailable.

## Licence

[MIT](LICENSE)
