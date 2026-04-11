import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { handleAnalyzeVideoFlow } from "./tools/analyze-video-flow.js";
import { loadConfig } from "./utils/config.js";
import { logger } from "./utils/logger.js";
import { checkFfmpegAvailable } from "./preprocessing/metadata.js";

/**
 * Create and configure the MCP server.
 *
 * - Loads and validates configuration (env vars, provider keys)
 * - Checks ffmpeg/ffprobe availability (logs warning if missing)
 * - Registers the analyze_video_flow tool with Zod input schema
 *
 * @returns A configured McpServer ready to be connected to a transport
 */
export function createServer(): McpServer {
  // ── Load config ───────────────────────────────────────────────────────
  const config = loadConfig();
  logger.info("Configuration loaded", {
    defaultProvider: config.defaultProvider,
    fallbackProvider: config.fallbackProvider,
    maxKeyframes: config.maxKeyframes,
    maxVideoSizeMB: config.maxVideoSizeMB,
    configuredProviders: Object.entries(config.providers)
      .filter(([, cfg]) => cfg !== undefined)
      .map(([name]) => name),
  });

  // ── Check ffmpeg availability (async, non-blocking) ─────────────────
  checkFfmpegAvailable().then((available) => {
    if (available) {
      logger.info("ffmpeg/ffprobe detected on PATH");
    } else {
      logger.warn(
        "ffmpeg/ffprobe NOT found on PATH. Video analysis will fail until ffmpeg is installed.",
      );
    }
  });

  // ── Create MCP server ───────────────────────────────────────────────
  const server = new McpServer({
    name: "video-flow-inspector",
    version: "0.1.0",
  });

  // ── Register analyze_video_flow tool ────────────────────────────────
  server.tool(
    "analyze_video_flow",
    "Analyze a video recording of a UI flow to detect issues, regressions, and anomalies. Accepts a video URL or local file path along with context about the expected user flow. Returns a structured diagnosis including a timeline of events, detected issues with severity levels, root-cause hypotheses, and prioritized recommended actions.",
    {
      video_url: z
        .string()
        .url()
        .optional()
        .describe(
          "URL to download the video from (HTTP/HTTPS). Either video_url or video_file_path must be provided.",
        ),
      video_file_path: z
        .string()
        .optional()
        .describe(
          "Local file path to the video. Either video_url or video_file_path must be provided.",
        ),
      goal: z
        .string()
        .min(5)
        .describe(
          "What the user was trying to accomplish in the video (e.g., 'Complete checkout flow', 'Login with SSO').",
        ),
      app_context: z
        .string()
        .optional()
        .describe(
          "Context about the application being tested (e.g., 'E-commerce React app, production environment').",
        ),
      expected_flow: z
        .array(z.string())
        .optional()
        .describe(
          "Expected sequence of steps (e.g., ['Click login', 'Enter credentials', 'See dashboard']).",
        ),
      environment: z
        .string()
        .optional()
        .describe(
          "Environment info (e.g., 'staging', 'production', 'Chrome 120 / macOS').",
        ),
      instructions: z
        .string()
        .optional()
        .describe(
          "Additional instructions for the analysis (e.g., 'Focus on the payment form validation').",
        ),
    },
    async (args) => {
      return await handleAnalyzeVideoFlow(args);
    },
  );

  logger.info("MCP server created with analyze_video_flow tool registered");

  return server;
}
