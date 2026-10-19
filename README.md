# Video Flow Inspector

MCP server for inspecting recordings of UI flows, with synchronized screen/audio evidence and separate bug and usability findings. Supports recordings up to **10 minutes**. Version 0.2 keeps the `analyze_video_flow` tool and adds a bounded, persistent background queue.

This is an evidence-assisted review, not proof of backend correctness, continuous click tracking, accessibility conformance, or root cause. No findings does not mean no problems.

## Requirements and setup

- Node.js >=20
- `ffmpeg` and `ffprobe` on PATH, with JPEG/rawvideo encoding and `libmp3lame` for audio
- Gemini Developer API key or Vertex AI Express API key for audiovisual analysis; the OpenAI adapter supports images only

```sh
npm ci
cp .env.example .env
# Supply environment variables through your MCP client's env or shell.
# The server does not automatically load .env.
npm run build
npm start
```

MCP stdio configuration:

```json
{
  "mcpServers": {
    "video-flow-inspector": {
      "command": "node",
      "args": ["/absolute/path/to/video-flow-inspector/dist/index.js"],
      "env": { "GEMINI_API_KEY": "YOUR_KEY" }
    }
  }
}
```

Model IDs are configurable through `GEMINI_MODEL` / `OPENAI_MODEL`. The inherited Gemini defaults are `gemini-3.1-flash-lite` and optional escalation to `gemini-3.5-flash`. **Availability on your account is not established by unit tests**; configure an accessible multimodal model and validate it before operational use. Anthropic is not implemented.

## Vertex AI Express authentication

For a Vertex Express API key, configure `GEMINI_BACKEND=vertex`, `VERTEX_API_KEY`, `DEFAULT_PROVIDER=gemini` and an accessible `GEMINI_MODEL`. This uses the documented global `aiplatform.googleapis.com/v1/publishers/google/models/{model}:generateContent` endpoint with the `x-goog-api-key` header, not a URL query parameter. Screen/audio payloads and cancellation are preserved. No project/location is needed for Express mode. Standard Vertex project/location ADC authentication is not implemented by this API-key adapter.

The default `GEMINI_BACKEND=gemini` continues to use `GEMINI_API_KEY` with the Gemini Developer API. These credentials/backends are not silently interchangeable. Do not put live keys in repository files or command arguments.

Official reference: https://docs.cloud.google.com/vertex-ai/generative-ai/docs/reference/express-mode/rest/v1/publishers.models/generateContent

## Tools

### `start_video_analysis` (recommended)

Returns a job ID without waiting for analysis.

```json
{
  "video_file_path": "/recordings/checkout.mp4",
  "goal": "Inspect checkout errors and difficulty completing the task",
  "analysis_mode": "combined",
  "audio_mode": "auto",
  "expected_flow": ["Add a product", "Fill shipping details", "Confirm order"]
}
```

Use `video_url` instead of a local path for HTTP(S) downloads. Supported extensions: MP4, MOV, WebM, AVI, MKV. If both sources are supplied, the local file wins, matching previous behavior. Remote URLs are retrieved by the server host, not the MCP client.

Shared input fields:

| Field | Meaning |
|---|---|
| `goal` | Required task/review objective, 5–10,000 characters |
| `app_context`, `expected_flow`, `environment`, `instructions` | Optional task context; expected behavior is supplied context, not observed truth |
| `analysis_mode` | `combined` (default), `bug`, or `usability` |
| `audio_mode` | `auto` (default): analyze available audio; `required`: reject missing/failed audio; `ignore`: explicitly visual-only |

`auto` never silently sends audio to an image-only fallback. If audio is present, a configured Gemini primary/fallback is required. An audio extraction failure in `auto` is reported as partial visual-only analysis for that segment. No intelligible speech is distinguished from confirmed complete transcription.

### `get_video_analysis`

Input: `{ "job_id": "UUID" }`. Returns status and persisted progress.

Statuses: `queued`, `running`, `completed`, `failed`, `cancelled`, `interrupted`. **A completed job can contain a partial analysis**; inspect `quality.complete`, segment status and warnings. Failed jobs expose a sanitized error, not provider URLs or credentials.

### `get_video_analysis_result`

Input: `{ "job_id": "UUID", "section": "summary", "offset": 0, "limit": 25 }`.

- `summary` is the default compact result, with quality, metadata and next action.
- `findings`, `transcript`, `timeline`, `segments`, `frames` are independently paginated.
- `limit` is 1–100. A response includes `total` and `next_offset`.
- Responses over 48,000 serialized bytes use lossless `format: json_fragment`. Repeat the same section/offset/limit with `fragment_offset=next_fragment_offset`, concatenate `fragment` strings until the next offset is null, then parse the reconstructed JSON. This also handles a single oversized item.
- The original video's SHA-256 identifies the evidence source; frame IDs and timestamps point into that recording. Extracted JPEGs are temporary, not durable screenshot URLs.

### `cancel_video_analysis`

Input: `{ "job_id": "UUID" }`. Cancels queued work or aborts running subprocesses/provider requests. A cancelled execution retains its queue slot until the underlying work settles. Cancellation cannot undo provider charges already incurred.

### `analyze_video_flow`

The blocking compatibility tool accepts the same inputs and returns the report directly. It shares the same queue as background work. Prefer background jobs for long recordings to avoid client timeout limits.

Core legacy fields remain: `summary`, `timeline`, `detected_issues`, `hypotheses`, `recommended_actions`, `next_best_action`, `confidence`, and `metadata`. Legacy bug issues are derived only from evidence-linked findings. Previously accepted free-text provider issues without validated references are no longer silently promoted.

New fields: `findings`, `transcript`, `segment_summaries`, `evidence_catalog`, `quality`.

**Deprecated numeric confidence:** `confidence` is retained only for schema compatibility and labelled `legacy_uncalibrated_heuristic_not_probability`. It is not an accuracy probability or decision gate. Unverified hypotheses use a zero compatibility placeholder plus `confidence_status: not_calibrated`; zero does not mean a measured probability. Use evidence, basis, coverage and warnings instead.

## How analysis works

1. Validate/download the source, enforce byte/duration limits, inspect streams, hash the original file.
2. Cover the entire recording with 60-second segments and 2-second overlap. A ten-minute recording has 11 segments.
3. Extract candidate JPEGs plus grayscale pixel signatures in one FFmpeg pass. Use actual selected frame PTS, not an inferred uniform timestamp. Reduce candidates using pixel differences and balanced temporal selection; do not compare JPEG compressed bytes as visual evidence.
4. Extract each segment's audio in parallel with its frames. Supply both modalities to Gemini with their absolute clock mapping. Silent recordings need no audio request.
5. Run at most two segments concurrently by default. Each provider request is counted against a shared budget, including retries/escalation. No separate transcription call is required.
6. Validate frame/transcript IDs, unique IDs, segment bounds and temporal support. `observed` requires screen evidence; `reported` requires speech evidence. Malformed/missing findings generate warnings rather than a clean empty success.
7. Refine up to two critical/major or hypothetical findings with a focused five-second interval, denser samples and up to 1600px width. Findings not surfaced in the first pass cannot automatically trigger refinement.
8. Merge overlapping findings conservatively, preserve maximum severity and all cited evidence. Keep later recurrences and distinct same-segment events. Retain referenced overlapping transcript entries.
9. Return prioritized findings, segment summaries and explicit processing/coverage limitations. Global task completion is not inferred from a segment.

A finding includes category (`bug` / `usability`), basis (`observed` / `reported` / `hypothesis`), severity, absolute timestamp, structured evidence references, and a proposed next step. Speech is tagged `model_transcribed`, never human-verified. Media text/speech is untrusted data, not instructions to the analyzer.

## Configuration and resource limits

| Variable | Default | Meaning |
|---|---:|---|
| `DEFAULT_PROVIDER` / `FALLBACK_PROVIDER` | `gemini` / `openai` | Audio-incompatible fallback is skipped |
| `MAX_VIDEO_DURATION_SECONDS` | 600 | Configurable up to a hard ceiling of 600 |
| `MAX_VIDEO_SIZE_MB` | 150 | Input/download cap, configurable 1–1024 MB |
| `MAX_KEYFRAMES` | 20 | **Per segment**, including refinement; 4–80 |
| `KEYFRAME_INTERVAL_SECONDS` | 2 | Legacy interval; overview candidate sampling uses one quarter of it (minimum 0.25s) |
| `FRAME_CHANGE_THRESHOLD` | 0.15 | Grayscale change relevance threshold |
| `FRAME_SAFETY_INTERVAL_MS` | 3000 | Target sampling gap before budget reduction; not a guaranteed gap |
| `SEGMENT_SECONDS` | 60 | 10–120 seconds |
| `SEGMENT_OVERLAP_SECONDS` | 2 | 0–5 seconds |
| `SEGMENT_CONCURRENCY` | 2 | 1–4 segments per active job |
| `MAX_REFINEMENTS` | 2 | 0–4 focused follow-up segments |
| `MAX_PROVIDER_CALLS` | 32 | 1–100 actual adapter calls across all segments/retries |
| `ANALYSIS_DEADLINE_MS` | 900000 | Total deadline, 1,000–1,800,000 ms |
| `MAX_OUTPUT_TOKENS` | 8192 | Gemini response budget per call |
| `GEMINI_ESCALATION_ENABLED` | false | Optional model escalation; can add latency/cost |
| `GEMINI_MAX_RETRIES` / `OPENAI_MAX_RETRIES` | 3 | Total adapter attempts per call path |
| `GEMINI_TIMEOUT_MS` / `OPENAI_TIMEOUT_MS` | 120000 | Per-attempt timeout |
| `ANALYSIS_JOBS_DIR` | `~/.video-flow-inspector/jobs` | Private persisted local reports |
| `LOG_LEVEL` | info | debug/info/warn/error |

The queue runs **one job** at a time and allows four waiting jobs. Results expire after 24 hours during subsequent queue operations, with at most 100 retained jobs and 10 MiB per result. TTL is not a background deletion guarantee: files remain until the next queue operation or deliberate cleanup. Use a separate jobs directory for each concurrently running MCP server; a live second writer is refused.

Jobs survive restart for retrieval, but running/queued jobs become **interrupted**. They are **not automatically replayed**, preventing accidental paid calls. Start a new job explicitly to retry; step-level automatic resume and a cross-request inference cache are not implemented. Reading a completed job reuses the stored result without another provider call.

## Privacy, cost and interpretation

- Selected screens and available audio leave the host for the configured provider. Obtain recording consent and use permitted provider/tenant accounts. Prefer `audio_mode=ignore` when speech must not be sent.
- Inputs/credentials are not persisted in job records. Reports/progress may still contain sensitive UI text and speech. Directories are 0700 and files 0600; this is local access control, **not encryption**.
- Temporary extracted media is removed on completion/error/cancellation and best-effort orderly exit. A hard crash can leave temporary media requiring deliberate cleanup.
- Cost/token metadata aggregates successful provider responses. Failed attempts may still be billable. Historical configured rates are not a live billing reconciliation, and audiovisual estimates are labelled heuristic. The request budget is not a hard dollar spending limit.
- Twenty frames **per segment** improves coverage but can cost more than the previous twenty-frame whole-video pass. Neither speedup nor real-world detection accuracy is claimed without measurement.
- Screen sampling can miss short events, cursor clicks, tiny text and audio/video alignment errors. A pause alone is not confusion, and a blank screen alone is not a crash. Actual maximum sample gap and segment failures are included in metadata.
- This server does not reproduce the bug, inspect backend logs/DOM, compare a baseline automatically, or establish causality. Recommendations need human review.

## Development and validation

```sh
npm run lint
npm run build
npm test                 # Existing Vitest unit/integration/benchmark suite
npm run test:behavior    # Node's built-in runner, MCP protocol + jobs + orchestration
```

Behavior tests use explicit synthetic providers and never make paid API calls. The real-media test generates a ten-minute FFmpeg fixture and checks seek offsets, pixel signatures and audio extraction; it is skipped with an explicit reason if FFmpeg is unavailable. CI installs FFmpeg and runs both suites on Node 20/22.

Before claiming operational readiness, separately validate a consented real UI recording with speech using an accessible model. Measure end-to-end latency, per-stage time, actual usage/cost, false positives, missed known events, timestamp accuracy and cancellation. A successful build, generated-media test or mocked MCP response is not proof of model quality or deployment.

Implementation work: `01a153b8-d2c8-7370-b0b0-f5cb2e9b6c6d`. No client activation or merge is performed by this change.
