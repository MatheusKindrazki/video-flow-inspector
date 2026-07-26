import { createTempDir, TempDir } from "../utils/temp-files.js";
import { getConfig } from "../utils/config.js";
import { logger } from "../utils/logger.js";
import { resolveVideoSource } from "../ingestion/validator.js";
import {
  extractVideoMetadata,
  checkFfmpegAvailable,
} from "../preprocessing/metadata.js";
import {
  extractKeyframes,
  loadKeyframesAsBase64,
  computeKeyframeChangeScores,
} from "../preprocessing/keyframe-extractor.js";
import { selectKeyframes, type FrameSelectionOptions } from "../preprocessing/frame-selector.js";
import { calculateCost } from "../analysis/pricing.js";
import { GeminiProvider } from "../analysis/gemini.js";
import { OpenAIProvider } from "../analysis/openai.js";
import { AnalysisProvider, AnalysisContext } from "../analysis/provider.js";
import { normalizeProviderOutput } from "../normalizer/semantic.js";
import { generateRecommendation } from "../recommender/actions.js";
import { VideoFlowError, ProviderError } from "../utils/errors.js";
import type { AppConfig, ProviderName } from "../types/index.js";
import type { Keyframe } from "../analysis/provider.js";

export function selectFramesForAnalysis(keyframes: Keyframe[], options: FrameSelectionOptions, changeScores: number[]) {
  return selectKeyframes(keyframes.map((keyframe, index) => ({ index: keyframe.index, timestamp_ms: keyframe.timestamp_ms, changeScore: changeScores[index] ?? 0 })), options);
}

// ─── Input Type ────────────────────────────────────────────────────────────

interface PipelineInput {
  video_url?: string;
  video_file_path?: string;
  goal: string;
  app_context?: string;
  expected_flow?: string[];
  environment?: string;
  instructions?: string;
}

// ─── Output Type ───────────────────────────────────────────────────────────

interface PipelineOutput {
  summary: string;
  timeline: Array<{
    timestamp_ms: number;
    frame_index: number;
    action: string;
    element?: string;
    description: string;
    screenshot_index?: number;
    status: "normal" | "warning" | "error";
  }>;
  detected_issues: Array<{
    id: string;
    severity: "critical" | "major" | "minor" | "info";
    type: string;
    title: string;
    description: string;
    timestamp_ms?: number;
    frame_index?: number;
    expected_behavior?: string;
    actual_behavior: string;
    evidence: string;
  }>;
  hypotheses: Array<{
    id: string;
    description: string;
    confidence: number;
    supporting_evidence: string[];
    suggested_investigation: string;
  }>;
  recommended_actions: Array<{
    id: string;
    priority: number;
    action: string;
    rationale: string;
    type: "investigate" | "fix" | "test" | "monitor" | "escalate";
    estimated_effort?: string;
  }>;
  next_best_action: {
    id: string;
    priority: number;
    action: string;
    rationale: string;
    type: string;
    estimated_effort?: string;
  };
  confidence: number;
  metadata: {
    provider: string;
    model: string;
    video_duration_ms: number;
    keyframes_analyzed: number;
    analysis_duration_ms: number;
    cost_estimate_usd?: number;
    frames?: { candidates: number; analyzed: number; discarded: number; selection_strategy: string };
    usage?: { input_tokens: number; output_tokens: number };
    cost?: { input_cost_usd: number; output_cost_usd: number; total_cost_usd: number; pricing_source: "confirmed" | "heuristic" };
    escalation?: { triggered: boolean; from_model?: string; to_model?: string; reason?: string };
    retries?: { attempts: number; json_repaired: boolean; frames_reduced: boolean };
  };
  raw_provider_notes?: string;
}

// ─── Provider Factory ──────────────────────────────────────────────────────

/**
 * Create an analysis provider by name.
 * Returns null if the API key is not configured for that provider.
 */
function createProvider(
  name: ProviderName,
  config: AppConfig,
): AnalysisProvider | null {
  const providerConfig = config.providers[name];

  if (!providerConfig || !providerConfig.apiKey) {
    logger.debug(`Provider "${name}" has no API key configured, skipping`, {
      provider: name,
    });
    return null;
  }

  switch (name) {
    case "gemini":
      return new GeminiProvider(
        providerConfig.apiKey,
        providerConfig.model,
        providerConfig.maxRetries,
        providerConfig.timeoutMs,
        {
          escalationModel: config.gemini.escalationModel,
          escalationEnabled: config.gemini.escalationEnabled,
          escalationConfidenceThreshold: config.gemini.escalationConfidenceThreshold,
          escalationOnCritical: config.gemini.escalationOnCritical,
          maxOutputTokens: config.gemini.maxOutputTokens,
          timeoutReduceFrames: config.gemini.timeoutReduceFrames,
        },
      );

    case "openai":
      return new OpenAIProvider(
        providerConfig.apiKey,
        providerConfig.model,
        providerConfig.maxRetries,
        providerConfig.timeoutMs,
      );

    case "anthropic":
      // Anthropic provider not yet implemented
      logger.warn("Anthropic provider is not yet implemented", {
        provider: name,
      });
      return null;

    default:
      logger.warn(`Unknown provider: "${name}"`, { provider: name });
      return null;
  }
}

// ─── Main Pipeline ─────────────────────────────────────────────────────────

/**
 * Execute the full analysis pipeline.
 *
 * Steps:
 * 1. Check ffmpeg availability
 * 2. Create temp directory
 * 3. Resolve video source (download if URL)
 * 4. Extract video metadata
 * 5. Extract keyframes
 * 6. Load keyframes as base64
 * 7. Create provider (primary or fallback)
 * 8. Run analysis
 * 9. Normalize output
 * 10. Generate recommendation
 * 11. Assemble final output
 * 12. Cleanup temp dir
 *
 * If primary provider fails, try fallback provider.
 * Always cleanup temp dir, even on error.
 */
export async function analyzeVideoFlow(
  input: PipelineInput,
): Promise<PipelineOutput> {
  const startTime = Date.now();
  let tempDir: TempDir | null = null;

  try {
    // ── Step 1: Check ffmpeg ──────────────────────────────────────────
    logger.info("Pipeline started", { goal: input.goal });

    const ffmpegAvailable = await checkFfmpegAvailable();
    if (!ffmpegAvailable) {
      throw new VideoFlowError(
        "ffmpeg/ffprobe is not installed or not found on PATH. Please install ffmpeg and try again.",
        "FFMPEG_NOT_FOUND",
      );
    }

    // ── Step 2: Create temp directory ─────────────────────────────────
    tempDir = await createTempDir("video-flow-");
    logger.debug("Temp directory created", { path: tempDir.path });

    // ── Step 3: Load config ───────────────────────────────────────────
    const config = getConfig();

    // ── Step 4: Resolve video source ──────────────────────────────────
    const videoSource = await resolveVideoSource(
      {
        video_url: input.video_url,
        video_file_path: input.video_file_path,
      },
      tempDir.path,
      config.maxVideoSizeMB,
    );

    logger.info("Video source resolved", {
      filePath: videoSource.filePath,
      sizeBytes: videoSource.sizeBytes,
      wasDownloaded: videoSource.wasDownloaded,
    });

    // ── Step 5: Extract video metadata ────────────────────────────────
    const metadata = await extractVideoMetadata(videoSource.filePath);

    logger.info("Video metadata extracted", {
      duration_ms: metadata.duration_ms,
      width: metadata.width,
      height: metadata.height,
      fps: metadata.fps,
      codec: metadata.codec,
    });

    // Check video duration limit
    const maxDurationMs = config.maxVideoDurationSeconds * 1000;
    if (metadata.duration_ms > maxDurationMs) {
      throw new VideoFlowError(
        `Video duration (${(metadata.duration_ms / 1000).toFixed(1)}s) exceeds maximum allowed (${config.maxVideoDurationSeconds}s)`,
        "VIDEO_TOO_LONG",
        {
          duration_ms: metadata.duration_ms,
          max_duration_ms: maxDurationMs,
        },
      );
    }

    // ── Step 6: Extract keyframes ─────────────────────────────────────
    const keyframeOutputDir = tempDir.filePath("keyframes");
    // Create keyframes subdirectory
    const { mkdir } = await import("node:fs/promises");
    await mkdir(keyframeOutputDir, { recursive: true });

    const keyframes = await extractKeyframes(
      videoSource.filePath,
      metadata.duration_ms,
      {
        intervalSeconds: Math.max(0.5, config.keyframeIntervalSeconds / 2),
        maxFrames: config.maxKeyframes * 2,
        outputDir: keyframeOutputDir,
      },
    );

    const changeScores = await computeKeyframeChangeScores(keyframes);
    const selection = selectFramesForAnalysis(keyframes, {
      maxFrames: config.maxKeyframes,
      changeThreshold: config.frameSelection.changeThreshold,
      safetyIntervalMs: config.frameSelection.safetyIntervalMs,
      minFrames: 2,
    }, changeScores);
    const selectedIndexes = new Set(selection.selected.map((frame) => frame.index));
    const selectedKeyframes = keyframes.filter((frame) => selectedIndexes.has(frame.index));
    const discardedKeyframes = keyframes.filter((frame) => !selectedIndexes.has(frame.index));
    const { unlink } = await import("node:fs/promises");
    await Promise.all(discardedKeyframes.map(async (frame) => unlink(frame.path).catch(() => undefined)));

    logger.info("Keyframes adaptively selected", { candidates: keyframes.length, selected: selectedKeyframes.length, discarded: discardedKeyframes.length, strategy: selection.strategy });

    // ── Step 7: Load keyframes as base64 ──────────────────────────────
    const keyframesWithBase64 = await loadKeyframesAsBase64(selectedKeyframes);

    logger.info("Keyframes loaded as base64", {
      count: keyframesWithBase64.length,
    });

    // ── Step 8: Create provider and run analysis ──────────────────────
    const analysisContext: AnalysisContext = {
      goal: input.goal,
      app_context: input.app_context,
      expected_flow: input.expected_flow,
      environment: input.environment,
      instructions: input.instructions,
      keyframes: keyframesWithBase64,
      video_duration_ms: metadata.duration_ms,
    };

    let providerResult = await runAnalysisWithFallback(
      analysisContext,
      config,
    );

    // ── Step 9: Normalize output ──────────────────────────────────────
    const normalized = normalizeProviderOutput({
      summary: providerResult.result.summary,
      timeline: providerResult.result.timeline,
      detected_issues: providerResult.result.detected_issues,
      hypotheses: providerResult.result.hypotheses,
      recommended_actions: providerResult.result.recommended_actions,
    });

    // ── Step 10: Generate recommendation ──────────────────────────────
    const recommendation = generateRecommendation(normalized);

    // ── Step 11: Assemble final output ────────────────────────────────
    const analysisDurationMs = Date.now() - startTime;
    const cost = calculateCost(providerResult.model, providerResult.result.usage);

    const output: PipelineOutput = {
      summary: normalized.summary,
      timeline: normalized.timeline,
      detected_issues: normalized.detected_issues,
      hypotheses: normalized.hypotheses,
      recommended_actions: normalized.recommended_actions,
      next_best_action: recommendation.next_best_action,
      confidence: recommendation.confidence,
      metadata: {
        provider: providerResult.providerName,
        model: providerResult.model,
        video_duration_ms: metadata.duration_ms,
        keyframes_analyzed: keyframesWithBase64.length,
        analysis_duration_ms: analysisDurationMs,
        frames: { candidates: keyframes.length, analyzed: keyframesWithBase64.length, discarded: discardedKeyframes.length, selection_strategy: selection.strategy },
        usage: providerResult.result.usage ?? { input_tokens: cost.input_tokens, output_tokens: cost.output_tokens },
        cost,
        escalation: providerResult.result.meta?.escalation ?? { triggered: false },
        retries: providerResult.result.meta?.retries ?? { attempts: 1, json_repaired: false, frames_reduced: false },
        cost_estimate_usd: cost.total_cost_usd,
      },
      raw_provider_notes: providerResult.result.raw,
    };

    logger.info("Pipeline completed successfully", {
      duration_ms: analysisDurationMs,
      provider: providerResult.providerName,
      issues_found: normalized.detected_issues.length,
      confidence: recommendation.confidence,
    });

    return output;
  } catch (error) {
    const analysisDurationMs = Date.now() - startTime;

    if (error instanceof VideoFlowError) {
      logger.error("Pipeline failed with known error", {
        code: error.code,
        message: error.message,
        details: error.details,
        duration_ms: analysisDurationMs,
      });
      throw error;
    }

    const message =
      error instanceof Error ? error.message : String(error);

    logger.error("Pipeline failed with unexpected error", {
      error: message,
      duration_ms: analysisDurationMs,
    });

    throw new VideoFlowError(
      `Pipeline failed: ${message}`,
      "PIPELINE_ERROR",
      {
        original_error: message,
        duration_ms: analysisDurationMs,
      },
    );
  } finally {
    // ── Step 12: Cleanup ──────────────────────────────────────────────
    if (tempDir) {
      try {
        await tempDir.cleanup();
        logger.debug("Temp directory cleaned up");
      } catch (cleanupError) {
        logger.warn("Failed to cleanup temp directory", {
          error: String(cleanupError),
          path: tempDir.path,
        });
      }
    }
  }
}

// ─── Analysis with Fallback ────────────────────────────────────────────────

interface ProviderRunResult {
  providerName: string;
  model: string;
  result: {
    raw: string;
    summary: string;
    timeline: unknown[];
    detected_issues: unknown[];
    hypotheses: unknown[];
    recommended_actions: unknown[];
    usage?: {
      input_tokens: number;
      output_tokens: number;
    };
    meta?: {
      retries: { attempts: number; json_repaired: boolean; frames_reduced: boolean };
      escalation: { triggered: boolean; from_model?: string; to_model?: string; reason?: string };
    };
  };
}

/**
 * Run analysis with primary provider, falling back to the fallback provider
 * if the primary fails.
 */
async function runAnalysisWithFallback(
  context: AnalysisContext,
  config: AppConfig,
): Promise<ProviderRunResult> {
  // Try primary provider
  const primaryProvider = createProvider(config.defaultProvider, config);
  const primaryConfig = config.providers[config.defaultProvider];

  if (primaryProvider && primaryConfig) {
    try {
      logger.info("Running analysis with primary provider", {
        provider: config.defaultProvider,
        model: primaryConfig.model,
      });

      const result = await primaryProvider.analyze(context);

      return {
        providerName: config.defaultProvider,
        model: result.meta?.escalation.to_model ?? primaryConfig.model,
        result,
      };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error);

      logger.warn("Primary provider failed, attempting fallback", {
        primary_provider: config.defaultProvider,
        fallback_provider: config.fallbackProvider,
        error: message,
      });
    }
  } else {
    logger.warn("Primary provider not available, attempting fallback", {
      primary_provider: config.defaultProvider,
      fallback_provider: config.fallbackProvider,
    });
  }

  // Try fallback provider (only if different from primary)
  if (config.fallbackProvider !== config.defaultProvider) {
    const fallbackProvider = createProvider(config.fallbackProvider, config);
    const fallbackConfig = config.providers[config.fallbackProvider];

    if (fallbackProvider && fallbackConfig) {
      try {
        logger.info("Running analysis with fallback provider", {
          provider: config.fallbackProvider,
          model: fallbackConfig.model,
        });

        const result = await fallbackProvider.analyze(context);

        return {
          providerName: config.fallbackProvider,
          model: result.meta?.escalation.to_model ?? fallbackConfig.model,
          result,
        };
      } catch (error) {
        const message =
          error instanceof Error ? error.message : String(error);

        logger.error("Fallback provider also failed", {
          fallback_provider: config.fallbackProvider,
          error: message,
        });

        throw new ProviderError(
          `Both primary (${config.defaultProvider}) and fallback (${config.fallbackProvider}) providers failed. Last error: ${message}`,
          {
            primary_provider: config.defaultProvider,
            fallback_provider: config.fallbackProvider,
          },
        );
      }
    }
  }

  // No providers available at all
  throw new ProviderError(
    "No analysis provider available. Ensure at least one provider API key is configured.",
    {
      default_provider: config.defaultProvider,
      fallback_provider: config.fallbackProvider,
      configured_providers: Object.entries(config.providers)
        .filter(([, cfg]) => cfg !== undefined)
        .map(([name]) => name),
    },
  );
}
