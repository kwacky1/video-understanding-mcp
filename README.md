# video-understanding-mcp

Local stdio MCP server for extracting bounded, reproducible evidence from video.

Milestone 1 provides:

- `video_probe`, backed by `ffprobe`
- absolute-path and allowed-root enforcement
- symlink-escape protection
- bounded, cancellable subprocess execution
- content-addressed probe caching
- `vu-doctor` readiness checks for FFmpeg, FFprobe, and whisper.cpp
- synthetic media fixtures and MCP stdio contract tests

## Requirements

- Node.js 22 or newer
- `ffmpeg`
- `ffprobe`
- `whisper-cli` (reported by `vu-doctor`; used from Milestone 2)

## Build and run

```bash
npm install
npm run build
VU_ALLOWED_READ_ROOTS="$HOME/Videos" npm start
```

`VU_ALLOWED_READ_ROOTS` is a path-delimited list. If it is omitted, the server
allows reads only within its current working directory.

Optional configuration:

| Variable | Default | Purpose |
|---|---:|---|
| `VU_ALLOWED_READ_ROOTS` | current directory | Readable filesystem roots |
| `VU_MAX_INPUT_BYTES` | `10737418240` | Maximum accepted input size |
| `VU_FFPROBE_PATH` | `ffprobe` | FFprobe executable |
| `VU_FFMPEG_PATH` | `ffmpeg` | FFmpeg executable |
| `VU_WHISPER_PATH` | `whisper-cli` | whisper.cpp executable |
| `VU_CACHE_DIR` | platform cache directory | Content-addressed cache root |

## Doctor

```bash
npm run doctor
npm run doctor -- --json
```

The doctor exits non-zero until all three executables are ready. Whisper is
reported now so Milestone 2 prerequisites are visible before transcription is
added.
