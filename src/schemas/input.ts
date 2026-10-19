import { z } from "zod";
// ─── AnalyzeVideoFlowInput Schema ──────────────────────────────────────────
export const AnalyzeVideoFlowInputFields = {
  analysis_mode: z.enum(["combined", "bug", "usability"]).default("combined"),
  audio_mode: z.enum(["auto", "required", "ignore"]).default("auto"),
  video_url: z
    .string()
    .url({ message: "video_url must be a valid URL" })
    .optional(),
  video_file_path: z
    .string()
    .min(1, { message: "video_file_path must not be empty" })
    .optional(),
  goal: z
    .string()
    .max(10000).min(5, {
    message: "goal must be at least 5 characters describing what to analyze",
  }),
  app_context: z
    .string()
    .min(1, { message: "app_context must not be empty when provided" })
    .optional(),
  expected_flow: z
    .array(z
    .string()
    .min(1, { message: "Each expected flow step must not be empty" }))
    .min(1, {
    message: "expected_flow must contain at least one step when provided",
  })
    .optional(),
  environment: z
    .string()
    .min(1, { message: "environment must not be empty when provided" })
    .optional(),
  instructions: z
    .string().max(20000)
    .min(1, { message: "instructions must not be empty when provided" })
    .optional(),
};
export const AnalyzeVideoFlowInputSchema = z.object(AnalyzeVideoFlowInputFields)
  .refine((data) => data.video_url !== undefined || data.video_file_path !== undefined, {
  message: "Either video_url or video_file_path must be provided",
  path: ["video_url"],
});
// ─── Inferred Type ──────────────────────────────────────────────────────────
export type AnalyzeVideoFlowInput = z.infer<typeof AnalyzeVideoFlowInputSchema>;
