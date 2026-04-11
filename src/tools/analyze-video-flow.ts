import { z } from "zod";
import { AnalyzeVideoFlowInputSchema } from "../schemas/input.js";
import { analyzeVideoFlow } from "../orchestrator/pipeline.js";
import { logger } from "../utils/logger.js";
import { VideoFlowError } from "../utils/errors.js";

// ─── Tool Definition ───────────────────────────────────────────────────────

/**
 * MCP tool definition for analyze_video_flow.
 * Used for reference and documentation; the actual registration uses
 * Zod schemas directly via server.tool().
 */
export const analyzeVideoFlowTool = {
  name: "analyze_video_flow",
  description:
    "Analyze a video recording of a UI flow to detect issues, regressions, and anomalies. Returns a structured diagnosis with timeline, detected issues, hypotheses, and recommended actions.",
  inputSchema: {
    type: "object" as const,
    properties: {
      video_url: {
        type: "string",
        description:
          "URL to download the video from (HTTP/HTTPS). Either video_url or video_file_path must be provided.",
      },
      video_file_path: {
        type: "string",
        description:
          "Local file path to the video. Either video_url or video_file_path must be provided.",
      },
      goal: {
        type: "string",
        description:
          "What the user was trying to accomplish in the video (e.g., 'Complete checkout flow', 'Login with SSO'). Minimum 5 characters.",
      },
      app_context: {
        type: "string",
        description:
          "Context about the application being tested (e.g., 'E-commerce React app, production environment').",
      },
      expected_flow: {
        type: "array",
        items: { type: "string" },
        description:
          "Expected sequence of steps (e.g., ['Click login', 'Enter credentials', 'See dashboard']).",
      },
      environment: {
        type: "string",
        description:
          "Environment info (e.g., 'staging', 'production', 'Chrome 120 / macOS').",
      },
      instructions: {
        type: "string",
        description:
          "Additional instructions for the analysis (e.g., 'Focus on the payment form validation').",
      },
    },
    required: ["goal"],
  },
};

// ─── Tool Handler ──────────────────────────────────────────────────────────

/**
 * Handle the analyze_video_flow tool call.
 *
 * 1. Validates input with Zod schema
 * 2. Calls the analyzeVideoFlow pipeline
 * 3. Returns result as JSON text content
 * 4. On validation error, returns isError: true with helpful message
 * 5. On pipeline error, returns isError: true with error details
 */
export async function handleAnalyzeVideoFlow(
  args: Record<string, unknown>,
): Promise<{
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}> {
  // ── Validate input ──────────────────────────────────────────────────
  const parseResult = AnalyzeVideoFlowInputSchema.safeParse(args);

  if (!parseResult.success) {
    const issues = parseResult.error.issues.map((issue) => ({
      path: issue.path.join("."),
      message: issue.message,
    }));

    logger.warn("Tool input validation failed", { issues });

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              error: "Input validation failed",
              details: issues,
              hint: "Ensure 'goal' is at least 5 characters and either 'video_url' or 'video_file_path' is provided.",
            },
            null,
            2,
          ),
        },
      ],
      isError: true,
    };
  }

  const input = parseResult.data;

  // ── Run pipeline ────────────────────────────────────────────────────
  try {
    logger.info("Tool handler: starting analysis", {
      goal: input.goal,
      has_video_url: !!input.video_url,
      has_video_file_path: !!input.video_file_path,
      has_expected_flow: !!input.expected_flow,
    });

    const result = await analyzeVideoFlow(input);

    logger.info("Tool handler: analysis completed", {
      issues_found: result.detected_issues.length,
      confidence: result.confidence,
      duration_ms: result.metadata.analysis_duration_ms,
    });

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  } catch (error) {
    if (error instanceof VideoFlowError) {
      logger.error("Tool handler: pipeline error", {
        code: error.code,
        message: error.message,
        details: error.details,
      });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                error: error.message,
                code: error.code,
                details: error.details,
              },
              null,
              2,
            ),
          },
        ],
        isError: true,
      };
    }

    const message =
      error instanceof Error ? error.message : String(error);

    logger.error("Tool handler: unexpected error", { error: message });

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              error: "An unexpected error occurred during video analysis",
              message,
            },
            null,
            2,
          ),
        },
      ],
      isError: true,
    };
  }
}
