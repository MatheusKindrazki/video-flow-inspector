# Video Flow Inspector

MCP server that analyzes video recordings of UI flows to detect issues, regressions, and anomalies. It extracts keyframes from videos, sends them to a vision-capable LLM (Gemini Flash or GPT-4o), and returns a structured analysis with a timeline of events, detected issues, hypotheses, and recommended next actions.

## What it does

Given a video recording of a user interacting with an application, Video Flow Inspector:

1. Downloads or validates the video file
2. Extracts keyframes at configurable intervals using ffmpeg
3. Sends the keyframes to a vision LLM for analysis
4. Normalizes and validates the provider response
5. Returns a structured JSON report with:
   - **Summary** of what happened in the flow
   - **Timeline** of user actions with timestamps
   - **Detected issues** sorted by severity (crashes, UI glitches, regressions, etc.)
   - **Hypotheses** about root causes
   - **Recommended actions** prioritized by impact
   - **Next best action** to take immediately
   - **Confidence score** for the overall analysis

## Prerequisites

- **Node.js** >= 20
- **ffmpeg** installed and available in PATH
- At least one API key:
  - **Google Gemini** (recommended) - `GEMINI_API_KEY`
  - **OpenAI GPT-4o** (fallback) - `OPENAI_API_KEY`

### Installing ffmpeg

```bash
# macOS
brew install ffmpeg

# Ubuntu/Debian
sudo apt install ffmpeg

# Verify installation
ffmpeg -version
```

## Quick Start

```bash
# Clone and install
npm install

# Configure environment
cp .env.example .env
# Edit .env and add your API key(s)

# Build
npm run build

# Run as MCP server (stdio transport)
npm start
```

## Configuration

All configuration is done via environment variables. Copy `.env.example` to `.env` and set your values.

| Variable | Default | Description |
|---|---|---|
| `GEMINI_API_KEY` | — | Google Gemini API key |
| `OPENAI_API_KEY` | — | OpenAI API key |
| `ANTHROPIC_API_KEY` | — | Anthropic API key (future use) |
| `DEFAULT_PROVIDER` | `gemini` | Primary analysis provider (`gemini`, `openai`, `anthropic`) |
| `FALLBACK_PROVIDER` | `openai` | Fallback provider if primary fails |
| `MAX_KEYFRAMES` | `20` | Maximum number of frames sent after adaptive selection |
| `KEYFRAME_INTERVAL_SECONDS` | `2` | Seconds between keyframe extractions |
| `FRAME_CHANGE_THRESHOLD` | `0.15` | Change score at which a candidate is treated as relevant |
| `FRAME_SAFETY_INTERVAL_MS` | `3000` | Maximum target gap between selected frames |
| `GEMINI_MODEL` | `gemini-3.1-flash-lite` | Economical Gemini analysis model |
| `GEMINI_ESCALATION_ENABLED` | `false` | Re-run once with Flash for low-confidence or serious results |
| `GEMINI_ESCALATION_MODEL` | `gemini-3.5-flash` | Model used for the optional escalation |
| `GEMINI_ESCALATION_CONFIDENCE_THRESHOLD` | `0.5` | Escalate when all reported hypothesis confidence is below this value |
| `GEMINI_ESCALATION_ON_CRITICAL` | `true` | Escalate when a critical or major issue is found |
| `GEMINI_TIMEOUT_REDUCE_FRAMES` | `true` | Retry timeouts once with a reduced image payload when possible |
| `MAX_OUTPUT_TOKENS` | `8192` | Bounded Gemini response token limit |
| `MAX_VIDEO_SIZE_MB` | `150` | Maximum video file size in MB |
| `MAX_VIDEO_DURATION_SECONDS` | `300` | Maximum video duration in seconds |
| `LOG_LEVEL` | `info` | Logging level (`debug`, `info`, `warn`, `error`) |

## MCP Integration

## Adaptive cost pipeline

Candidates are over-sampled from the video, then selected locally using a byte-bucket visual-change signature, relevance threshold, temporal safety sampling, and first/last anchors. Discarded images are deleted before any base64 payload is created. This is intentionally a best-effort, dependency-free heuristic rather than local vision analysis.

Gemini defaults to `gemini-3.1-flash-lite`. Escalation is opt-in and happens at most once, from Flash-Lite to `gemini-3.5-flash`, before cross-provider fallback. Permanent 4xx errors are not retried; transient errors, rate limits, and timeouts are. Malformed JSON is repaired locally before a request is retried.

Token pricing (USD per million tokens; Google Gemini pricing confirmed 2026-07-26):

| Model | Input | Output | Source |
|---|---:|---:|---|
| `gemini-3.1-flash-lite` | $0.25 | $1.50 | confirmed |
| `gemini-3.5-flash` | $1.50 | $9.00 | confirmed |

Responses retain `keyframes_analyzed` and `cost_estimate_usd` for compatibility. `cost_estimate_usd` equals `metadata.cost.total_cost_usd`. Additional metadata is additive:

```json
{
  "frames": { "candidates": 24, "analyzed": 12, "discarded": 12, "selection_strategy": "adaptive(...)" },
  "usage": { "input_tokens": 1200, "output_tokens": 300 },
  "cost": { "input_cost_usd": 0.0003, "output_cost_usd": 0.00045, "total_cost_usd": 0.00075, "pricing_source": "confirmed" },
  "escalation": { "triggered": false },
  "retries": { "attempts": 1, "json_repaired": false, "frames_reduced": false }
}
```

### Claude Desktop

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "video-flow-inspector": {
      "command": "node",
      "args": ["/absolute/path/to/video-flow-inspector/dist/index.js"],
      "env": {
        "GEMINI_API_KEY": "your-gemini-api-key"
      }
    }
  }
}
```

### Claude Code

Add to your project's `.mcp.json`:

```json
{
  "mcpServers": {
    "video-flow-inspector": {
      "command": "node",
      "args": ["/absolute/path/to/video-flow-inspector/dist/index.js"],
      "env": {
        "GEMINI_API_KEY": "your-gemini-api-key"
      }
    }
  }
}
```

## Tool: analyze_video_flow

### Input

| Parameter | Type | Required | Description |
|---|---|---|---|
| `video_url` | `string` (URL) | One of `video_url` or `video_file_path` | URL to download the video from |
| `video_file_path` | `string` | One of `video_url` or `video_file_path` | Local path to the video file |
| `goal` | `string` | Yes (min 5 chars) | What to analyze in the video |
| `app_context` | `string` | No | Context about the app being tested |
| `expected_flow` | `string[]` | No | Expected sequence of steps |
| `environment` | `string` | No | Environment info (staging, prod, etc.) |
| `instructions` | `string` | No | Additional analysis instructions |

Supported video formats: `.mp4`, `.webm`, `.mov`, `.avi`, `.mkv`

### Output

```json
{
  "summary": "User completed login flow. Critical crash detected on form submit.",
  "timeline": [
    {
      "timestamp_ms": 0,
      "frame_index": 0,
      "action": "navigate",
      "element": "Login page",
      "description": "User navigated to the login page",
      "status": "normal"
    }
  ],
  "detected_issues": [
    {
      "id": "ISSUE-001",
      "severity": "critical",
      "type": "crash",
      "title": "App crash on form submit",
      "description": "Application crashes when submitting the login form",
      "timestamp_ms": 4000,
      "frame_index": 2,
      "expected_behavior": "Form submits and dashboard loads",
      "actual_behavior": "White screen appears",
      "evidence": "Frame 2 shows blank screen after submit"
    }
  ],
  "hypotheses": [
    {
      "id": "HYP-001",
      "description": "Null pointer in auth service",
      "confidence": 0.85,
      "supporting_evidence": ["Crash occurs on submit with valid data"],
      "suggested_investigation": "Check auth service null handling"
    }
  ],
  "recommended_actions": [
    {
      "id": "ACTION-001",
      "priority": 1,
      "action": "Fix crash in form submit handler",
      "rationale": "Critical crash affecting all users",
      "type": "fix",
      "estimated_effort": "medium"
    }
  ],
  "next_best_action": { "..." : "same structure as recommended_actions[0]" },
  "confidence": 0.87,
  "metadata": {
    "provider": "gemini",
    "model": "gemini-3.1-flash-lite",
    "video_duration_ms": 10000,
    "keyframes_analyzed": 5,
    "analysis_duration_ms": 8500,
    "cost_estimate_usd": 0.02
  }
}
```

## Example Usage

In Claude Desktop or Claude Code, once the MCP server is connected:

```
Analyze this video recording of our checkout flow and check
if the payment form validation is working correctly.

Use the analyze_video_flow tool with:
- video_file_path: /path/to/checkout-recording.mp4
- goal: Verify payment form validation and error handling
- expected_flow:
  - User fills in shipping info
  - User proceeds to payment
  - User enters invalid card number
  - Error message appears
  - User corrects card number
  - Payment succeeds
```

## Architecture

The analysis pipeline follows this sequence:

```
Input Validation --> Video Ingestion --> Keyframe Extraction --> LLM Analysis --> Normalization --> Recommendation
     (Zod)         (download/validate)     (ffmpeg)           (Gemini/GPT-4o)    (sort/filter)    (next action)
```

1. **Input validation** - Zod schema validates the tool input
2. **Video ingestion** - Downloads from URL or validates local file
3. **Keyframe extraction** - Uses ffmpeg to extract frames at configured intervals
4. **LLM analysis** - Sends keyframes + prompt to the configured vision model
5. **Normalization** - Validates, filters, and sorts the provider response
6. **Recommendation** - Determines the next best action and confidence score

## Supported Providers

| Provider | Model | Best For |
|---|---|---|
| **Google Gemini** (default) | `gemini-3.1-flash-lite` | Fast, cost-effective analysis with strong vision |
| **OpenAI** (fallback) | `gpt-4o` | High-quality analysis, good as fallback |
| **Anthropic** (future) | `claude-sonnet-4-6-20250514` | Reserved for future use |

## Development

```bash
# Install dependencies
npm install

# Run in development mode (with tsx)
npm run dev

# Run tests
npm test

# Run tests in watch mode
npm run test:watch

# Type check
npm run lint

# Build for production
npm run build

# Clean build artifacts
npm run clean
```

### Project Structure

```
src/
  schemas/        # Zod schemas for input/output validation
  ingestion/      # Video download and file validation
  preprocessing/  # Keyframe extraction and video metadata
  analysis/       # LLM provider interface and prompt building
  normalizer/     # Provider response normalization and sorting
  recommender/    # Next-best-action generation and confidence scoring
  utils/          # Logger, error classes, config, temp files
  types/          # Shared TypeScript interfaces
tests/
  unit/           # Unit tests for individual modules
  integration/    # Integration tests (require ffmpeg + API keys)
```

## Cost Estimates

Typical cost per analysis (varies by video length and provider):

| Scenario | Provider | Keyframes | Estimated Cost |
|---|---|---|---|
| Short flow (10s video) | Gemini Flash | 5 | ~$0.01-0.02 |
| Medium flow (30s video) | Gemini Flash | 15 | ~$0.03-0.05 |
| Long flow (60s video) | Gemini Flash | 20 | ~$0.04-0.08 |
| Short flow (10s video) | GPT-4o | 5 | ~$0.05-0.10 |
| Medium flow (30s video) | GPT-4o | 15 | ~$0.15-0.25 |
| Long flow (60s video) | GPT-4o | 20 | ~$0.20-0.35 |

Costs are primarily driven by the number of images (keyframes) sent to the vision model. Gemini Flash is significantly cheaper for this use case.
