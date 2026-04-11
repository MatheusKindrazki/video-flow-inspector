import { z } from "zod";
import { logger } from "../utils/logger.js";
import { NormalizationError } from "../utils/errors.js";

// ─── Lenient Zod Schemas ───────────────────────────────────────────────────
//
// These schemas are intentionally more lenient than the canonical output
// schemas in ../schemas/output.ts. LLM providers sometimes return slightly
// off-schema data (e.g. floats for integers, extra fields, missing optionals).
// We use .safeParse() on each item and discard invalid ones rather than
// rejecting the entire analysis.

const TimelineEventSchema = z.object({
  timestamp_ms: z.number(),
  frame_index: z.number(),
  action: z.string(),
  element: z.string().optional(),
  description: z.string(),
  screenshot_index: z.number().optional(),
  status: z.enum(["normal", "warning", "error"]),
});

const DetectedIssueSchema = z.object({
  id: z.string(),
  severity: z.enum(["critical", "major", "minor", "info"]),
  type: z.enum([
    "crash",
    "regression",
    "ui_glitch",
    "flow_deviation",
    "performance",
    "accessibility",
    "data_error",
    "unknown",
  ]),
  title: z.string(),
  description: z.string(),
  timestamp_ms: z.number().optional(),
  frame_index: z.number().optional(),
  expected_behavior: z.string().optional(),
  actual_behavior: z.string(),
  evidence: z.string(),
});

const HypothesisSchema = z.object({
  id: z.string(),
  description: z.string(),
  confidence: z.number().min(0).max(1),
  supporting_evidence: z.array(z.string()),
  suggested_investigation: z.string(),
});

const RecommendedActionSchema = z.object({
  id: z.string(),
  priority: z.number().int().min(1),
  action: z.string(),
  rationale: z.string(),
  type: z.enum(["investigate", "fix", "test", "monitor", "escalate"]),
  estimated_effort: z
    .enum(["trivial", "small", "medium", "large"])
    .optional(),
});

// ─── Exported Types ────────────────────────────────────────────────────────

export type TimelineEvent = z.infer<typeof TimelineEventSchema>;
export type DetectedIssue = z.infer<typeof DetectedIssueSchema>;
export type Hypothesis = z.infer<typeof HypothesisSchema>;
export type RecommendedAction = z.infer<typeof RecommendedActionSchema>;

// ─── Provider Result Interface ─────────────────────────────────────────────

interface ProviderParsedResult {
  summary: string;
  timeline: unknown[];
  detected_issues: unknown[];
  hypotheses: unknown[];
  recommended_actions: unknown[];
}

// ─── Normalized Output ─────────────────────────────────────────────────────

export interface NormalizedAnalysis {
  summary: string;
  timeline: TimelineEvent[];
  detected_issues: DetectedIssue[];
  hypotheses: Hypothesis[];
  recommended_actions: RecommendedAction[];
}

// ─── Severity Ordering ─────────────────────────────────────────────────────

const SEVERITY_ORDER: Record<string, number> = {
  critical: 0,
  major: 1,
  minor: 2,
  info: 3,
};

// ─── Helpers ───────────────────────────────────────────────────────────────

/**
 * Validate an array of unknown items against a Zod schema.
 * Returns only the items that pass validation; logs warnings for invalid ones.
 */
function validateArray<T>(
  items: unknown[],
  schema: z.ZodType<T>,
  label: string,
): T[] {
  const valid: T[] = [];

  for (let i = 0; i < items.length; i++) {
    const result = schema.safeParse(items[i]);
    if (result.success) {
      valid.push(result.data);
    } else {
      logger.warn(`Invalid ${label} at index ${i}, skipping`, {
        errors: result.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      });
    }
  }

  return valid;
}

// ─── Main Normalizer ───────────────────────────────────────────────────────

/**
 * Normalize and validate provider output.
 *
 * Strategy:
 * 1. Validate each field against its Zod schema
 * 2. For arrays, validate each item individually -- keep valid items, log warnings for invalid ones
 * 3. Ensure minimum structure (empty arrays are ok, missing summary is not)
 * 4. Sort timeline by timestamp_ms
 * 5. Sort detected_issues by severity (critical first)
 * 6. Sort recommended_actions by priority
 * 7. Throw NormalizationError only if the result is fundamentally unusable (no summary)
 */
export function normalizeProviderOutput(
  raw: ProviderParsedResult,
): NormalizedAnalysis {
  logger.debug("Starting normalization of provider output");

  // 1. Validate summary -- this is the only hard requirement
  const summary =
    typeof raw.summary === "string" ? raw.summary.trim() : "";

  if (!summary) {
    throw new NormalizationError(
      "Provider output has no usable summary",
      { raw_summary: raw.summary },
    );
  }

  // 2. Validate arrays leniently (keep valid items, discard invalid ones)
  const timeline = validateArray(
    Array.isArray(raw.timeline) ? raw.timeline : [],
    TimelineEventSchema,
    "timeline event",
  );

  const detectedIssues = validateArray(
    Array.isArray(raw.detected_issues) ? raw.detected_issues : [],
    DetectedIssueSchema,
    "detected issue",
  );

  const hypotheses = validateArray(
    Array.isArray(raw.hypotheses) ? raw.hypotheses : [],
    HypothesisSchema,
    "hypothesis",
  );

  const recommendedActions = validateArray(
    Array.isArray(raw.recommended_actions) ? raw.recommended_actions : [],
    RecommendedActionSchema,
    "recommended action",
  );

  // 3. Log how many items survived validation
  logger.info("Normalization complete", {
    timeline_count: timeline.length,
    issues_count: detectedIssues.length,
    hypotheses_count: hypotheses.length,
    actions_count: recommendedActions.length,
    original_timeline_count: raw.timeline?.length ?? 0,
    original_issues_count: raw.detected_issues?.length ?? 0,
    original_hypotheses_count: raw.hypotheses?.length ?? 0,
    original_actions_count: raw.recommended_actions?.length ?? 0,
  });

  // 4. Sort timeline by timestamp_ms (ascending)
  timeline.sort((a, b) => a.timestamp_ms - b.timestamp_ms);

  // 5. Sort detected_issues by severity (critical first)
  detectedIssues.sort((a, b) => {
    const aOrder = SEVERITY_ORDER[a.severity] ?? 99;
    const bOrder = SEVERITY_ORDER[b.severity] ?? 99;
    return aOrder - bOrder;
  });

  // 6. Sort recommended_actions by priority (1 = highest)
  recommendedActions.sort((a, b) => a.priority - b.priority);

  return {
    summary,
    timeline,
    detected_issues: detectedIssues,
    hypotheses,
    recommended_actions: recommendedActions,
  };
}
