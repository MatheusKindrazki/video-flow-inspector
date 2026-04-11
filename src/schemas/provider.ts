import { z } from "zod";
import {
  TimelineEventSchema,
  DetectedIssueSchema,
  HypothesisSchema,
  RecommendedActionSchema,
} from "./output.js";

// ─── Provider Name ──────────────────────────────────────────────────────────

export const ProviderNameSchema = z.enum(["gemini", "openai", "anthropic"]);

export type ProviderName = z.infer<typeof ProviderNameSchema>;

// ─── Provider Config ────────────────────────────────────────────────────────

export const ProviderConfigSchema = z.object({
  name: ProviderNameSchema,

  model: z.string().min(1, { message: "model must not be empty" }),

  apiKey: z.string().min(1, { message: "apiKey must not be empty" }),

  maxRetries: z
    .number()
    .int()
    .nonnegative({ message: "maxRetries must be a non-negative integer" })
    .default(3),

  timeoutMs: z
    .number()
    .int()
    .positive({ message: "timeoutMs must be a positive integer" })
    .default(120_000),
});

export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;

// ─── Usage Stats ────────────────────────────────────────────────────────────

export const UsageSchema = z.object({
  input_tokens: z
    .number()
    .int()
    .nonnegative({ message: "input_tokens must be a non-negative integer" }),

  output_tokens: z
    .number()
    .int()
    .nonnegative({ message: "output_tokens must be a non-negative integer" }),
});

export type Usage = z.infer<typeof UsageSchema>;

// ─── Parsed Provider Content ────────────────────────────────────────────────

export const ParsedProviderContentSchema = z.object({
  summary: z.string().min(1, { message: "summary must not be empty" }),

  timeline: z.array(TimelineEventSchema),

  detected_issues: z.array(DetectedIssueSchema),

  hypotheses: z.array(HypothesisSchema),

  recommended_actions: z.array(RecommendedActionSchema),
});

export type ParsedProviderContent = z.infer<typeof ParsedProviderContentSchema>;

// ─── Full Provider Response ─────────────────────────────────────────────────

export const ProviderResponseSchema = z.object({
  raw: z.string().min(1, { message: "raw response must not be empty" }),

  parsed: ParsedProviderContentSchema,

  usage: UsageSchema.optional(),
});

export type ProviderResponse = z.infer<typeof ProviderResponseSchema>;

// ─── App Config ─────────────────────────────────────────────────────────────

export const AppConfigSchema = z.object({
  defaultProvider: ProviderNameSchema,

  fallbackProvider: ProviderNameSchema,

  maxKeyframes: z
    .number()
    .int()
    .positive({ message: "maxKeyframes must be a positive integer" })
    .default(30),

  keyframeIntervalSeconds: z
    .number()
    .positive({ message: "keyframeIntervalSeconds must be positive" })
    .default(1),

  maxVideoSizeMB: z
    .number()
    .positive({ message: "maxVideoSizeMB must be positive" })
    .default(100),

  maxVideoDurationSeconds: z
    .number()
    .positive({ message: "maxVideoDurationSeconds must be positive" })
    .default(300),

  logLevel: z
    .string()
    .min(1, { message: "logLevel must not be empty" })
    .default("info"),

  providers: z.record(
    ProviderNameSchema,
    ProviderConfigSchema.optional()
  ),
});

export type AppConfig = z.infer<typeof AppConfigSchema>;

// ─── Video Metadata ─────────────────────────────────────────────────────────

export const VideoMetadataSchema = z.object({
  duration_ms: z
    .number()
    .int()
    .nonnegative({ message: "duration_ms must be a non-negative integer" }),

  width: z
    .number()
    .int()
    .positive({ message: "width must be a positive integer" }),

  height: z
    .number()
    .int()
    .positive({ message: "height must be a positive integer" }),

  fps: z
    .number()
    .positive({ message: "fps must be positive" }),

  codec: z.string().min(1, { message: "codec must not be empty" }),

  size_bytes: z
    .number()
    .int()
    .nonnegative({ message: "size_bytes must be non-negative" }),

  format: z.string().min(1, { message: "format must not be empty" }),
});

export type VideoMetadata = z.infer<typeof VideoMetadataSchema>;

// ─── Keyframe ───────────────────────────────────────────────────────────────

export const KeyframeSchema = z.object({
  index: z
    .number()
    .int()
    .nonnegative({ message: "index must be a non-negative integer" }),

  timestamp_ms: z
    .number()
    .int()
    .nonnegative({ message: "timestamp_ms must be a non-negative integer" }),

  path: z.string().min(1, { message: "path must not be empty" }),

  base64: z.string().optional(),

  width: z
    .number()
    .int()
    .positive({ message: "width must be a positive integer" }),

  height: z
    .number()
    .int()
    .positive({ message: "height must be a positive integer" }),
});

export type Keyframe = z.infer<typeof KeyframeSchema>;
