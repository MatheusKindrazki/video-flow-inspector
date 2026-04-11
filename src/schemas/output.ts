import { z } from "zod";

// ─── Shared Enums ───────────────────────────────────────────────────────────

export const ActionTypeSchema = z.enum([
  "click",
  "type",
  "navigate",
  "scroll",
  "wait",
  "error",
  "transition",
]);

export const EventStatusSchema = z.enum(["normal", "warning", "error"]);

export const IssueSeveritySchema = z.enum([
  "critical",
  "major",
  "minor",
  "info",
]);

export const IssueTypeSchema = z.enum([
  "crash",
  "regression",
  "ui_glitch",
  "flow_deviation",
  "performance",
  "accessibility",
  "data_error",
  "unknown",
]);

export const ActionCategorySchema = z.enum([
  "investigate",
  "fix",
  "test",
  "monitor",
  "escalate",
]);

export const EffortEstimateSchema = z.enum([
  "trivial",
  "small",
  "medium",
  "large",
]);

// ─── Timeline Event ─────────────────────────────────────────────────────────

export const TimelineEventSchema = z.object({
  timestamp_ms: z
    .number()
    .int()
    .nonnegative({ message: "timestamp_ms must be a non-negative integer" }),

  frame_index: z
    .number()
    .int()
    .nonnegative({ message: "frame_index must be a non-negative integer" }),

  action: ActionTypeSchema,

  element: z.string().optional(),

  description: z
    .string()
    .min(1, { message: "description must not be empty" }),

  screenshot_index: z
    .number()
    .int()
    .nonnegative({
      message: "screenshot_index must be a non-negative integer",
    })
    .optional(),

  status: EventStatusSchema,
});

export type TimelineEvent = z.infer<typeof TimelineEventSchema>;

// ─── Detected Issue ─────────────────────────────────────────────────────────

export const DetectedIssueSchema = z.object({
  id: z.string().min(1, { message: "id must not be empty" }),

  severity: IssueSeveritySchema,

  type: IssueTypeSchema,

  title: z.string().min(1, { message: "title must not be empty" }),

  description: z
    .string()
    .min(1, { message: "description must not be empty" }),

  timestamp_ms: z
    .number()
    .int()
    .nonnegative({ message: "timestamp_ms must be a non-negative integer" })
    .optional(),

  frame_index: z
    .number()
    .int()
    .nonnegative({ message: "frame_index must be a non-negative integer" })
    .optional(),

  expected_behavior: z.string().optional(),

  actual_behavior: z
    .string()
    .min(1, { message: "actual_behavior must not be empty" }),

  evidence: z.string().min(1, { message: "evidence must not be empty" }),
});

export type DetectedIssue = z.infer<typeof DetectedIssueSchema>;

// ─── Hypothesis ─────────────────────────────────────────────────────────────

export const HypothesisSchema = z.object({
  id: z.string().min(1, { message: "id must not be empty" }),

  description: z
    .string()
    .min(1, { message: "description must not be empty" }),

  confidence: z
    .number()
    .min(0, { message: "confidence must be between 0 and 1" })
    .max(1, { message: "confidence must be between 0 and 1" }),

  supporting_evidence: z
    .array(z.string().min(1, { message: "Evidence item must not be empty" }))
    .min(1, {
      message: "At least one piece of supporting evidence is required",
    }),

  suggested_investigation: z
    .string()
    .min(1, { message: "suggested_investigation must not be empty" }),
});

export type Hypothesis = z.infer<typeof HypothesisSchema>;

// ─── Recommended Action ─────────────────────────────────────────────────────

export const RecommendedActionSchema = z.object({
  id: z.string().min(1, { message: "id must not be empty" }),

  priority: z
    .number()
    .int()
    .positive({ message: "priority must be a positive integer (1 = highest)" }),

  action: z.string().min(1, { message: "action must not be empty" }),

  rationale: z.string().min(1, { message: "rationale must not be empty" }),

  type: ActionCategorySchema,

  estimated_effort: EffortEstimateSchema.optional(),
});

export type RecommendedAction = z.infer<typeof RecommendedActionSchema>;

// ─── Analysis Metadata ──────────────────────────────────────────────────────

export const AnalysisMetadataSchema = z.object({
  provider: z.string().min(1, { message: "provider must not be empty" }),

  model: z.string().min(1, { message: "model must not be empty" }),

  video_duration_ms: z
    .number()
    .int()
    .nonnegative({
      message: "video_duration_ms must be a non-negative integer",
    }),

  keyframes_analyzed: z
    .number()
    .int()
    .nonnegative({
      message: "keyframes_analyzed must be a non-negative integer",
    }),

  analysis_duration_ms: z
    .number()
    .int()
    .nonnegative({
      message: "analysis_duration_ms must be a non-negative integer",
    }),

  cost_estimate_usd: z
    .number()
    .nonnegative({ message: "cost_estimate_usd must be non-negative" })
    .optional(),
});

export type AnalysisMetadata = z.infer<typeof AnalysisMetadataSchema>;

// ─── Full Analysis Output ───────────────────────────────────────────────────

export const AnalyzeVideoFlowOutputSchema = z.object({
  summary: z.string().min(1, { message: "summary must not be empty" }),

  timeline: z.array(TimelineEventSchema),

  detected_issues: z.array(DetectedIssueSchema),

  hypotheses: z.array(HypothesisSchema),

  recommended_actions: z
    .array(RecommendedActionSchema)
    .min(1, { message: "At least one recommended action is required" }),

  next_best_action: RecommendedActionSchema,

  confidence: z
    .number()
    .min(0, { message: "confidence must be between 0 and 1" })
    .max(1, { message: "confidence must be between 0 and 1" }),

  metadata: AnalysisMetadataSchema,

  raw_provider_notes: z.string().optional(),
});

export type AnalyzeVideoFlowOutput = z.infer<
  typeof AnalyzeVideoFlowOutputSchema
>;
