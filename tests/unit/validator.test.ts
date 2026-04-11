import { describe, it, expect } from "vitest";
import { AnalyzeVideoFlowInputSchema } from "../../src/schemas/input.js";
import { validateVideoFile } from "../../src/ingestion/validator.js";
import { VideoValidationError } from "../../src/utils/errors.js";

// ─── Input Schema Validation ────────────────────────────────────────────────

describe("AnalyzeVideoFlowInputSchema", () => {
  it("should accept valid input with video_url", () => {
    const input = {
      video_url: "https://example.com/video.mp4",
      goal: "Verify the login flow works correctly",
    };

    const result = AnalyzeVideoFlowInputSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.video_url).toBe("https://example.com/video.mp4");
      expect(result.data.goal).toBe("Verify the login flow works correctly");
    }
  });

  it("should accept valid input with video_file_path", () => {
    const input = {
      video_file_path: "/tmp/recording.mp4",
      goal: "Check for UI glitches during checkout",
    };

    const result = AnalyzeVideoFlowInputSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.video_file_path).toBe("/tmp/recording.mp4");
    }
  });

  it("should accept valid input with both video_url and video_file_path", () => {
    const input = {
      video_url: "https://example.com/video.mp4",
      video_file_path: "/tmp/recording.mp4",
      goal: "Analyze the signup flow",
    };

    const result = AnalyzeVideoFlowInputSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.video_url).toBe("https://example.com/video.mp4");
      expect(result.data.video_file_path).toBe("/tmp/recording.mp4");
    }
  });

  it("should reject input with neither video_url nor video_file_path", () => {
    const input = {
      goal: "Analyze a flow",
    };

    const result = AnalyzeVideoFlowInputSchema.safeParse(input);
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((i) => i.message);
      expect(messages).toContain(
        "Either video_url or video_file_path must be provided"
      );
    }
  });

  it("should reject input with goal too short", () => {
    const input = {
      video_url: "https://example.com/video.mp4",
      goal: "hi",
    };

    const result = AnalyzeVideoFlowInputSchema.safeParse(input);
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join("."));
      expect(paths).toContain("goal");
    }
  });

  it("should accept valid input with all optional fields", () => {
    const input = {
      video_url: "https://example.com/video.mp4",
      goal: "Verify the complete onboarding flow",
      app_context: "E-commerce checkout page on iOS Safari",
      expected_flow: [
        "User sees product page",
        "User taps Add to Cart",
        "User proceeds to checkout",
        "User completes payment",
      ],
      environment: "staging",
      instructions: "Pay special attention to the payment form validation",
    };

    const result = AnalyzeVideoFlowInputSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.app_context).toBe(
        "E-commerce checkout page on iOS Safari"
      );
      expect(result.data.expected_flow).toHaveLength(4);
      expect(result.data.environment).toBe("staging");
      expect(result.data.instructions).toBe(
        "Pay special attention to the payment form validation"
      );
    }
  });

  it("should reject invalid video_url format", () => {
    const input = {
      video_url: "not-a-valid-url",
      goal: "Analyze the flow",
    };

    const result = AnalyzeVideoFlowInputSchema.safeParse(input);
    expect(result.success).toBe(false);
  });

  it("should reject empty expected_flow array", () => {
    const input = {
      video_url: "https://example.com/video.mp4",
      goal: "Analyze the flow",
      expected_flow: [],
    };

    const result = AnalyzeVideoFlowInputSchema.safeParse(input);
    expect(result.success).toBe(false);
  });
});

// ─── validateVideoFile ─────────────────────────────────────────────────────

describe("validateVideoFile", () => {
  it("should throw VideoValidationError for non-existent file", async () => {
    await expect(
      validateVideoFile("/tmp/does-not-exist-ever-12345.mp4", 100)
    ).rejects.toThrow(VideoValidationError);

    await expect(
      validateVideoFile("/tmp/does-not-exist-ever-12345.mp4", 100)
    ).rejects.toThrow("Video file does not exist or is not readable");
  });

  it("should throw VideoValidationError for invalid extension", async () => {
    // The extension check happens before the file existence check
    await expect(
      validateVideoFile("/tmp/some-file.txt", 100)
    ).rejects.toThrow(VideoValidationError);

    await expect(
      validateVideoFile("/tmp/some-file.txt", 100)
    ).rejects.toThrow("Unsupported video file extension");
  });

  it("should throw VideoValidationError for .pdf extension", async () => {
    await expect(
      validateVideoFile("/tmp/document.pdf", 100)
    ).rejects.toThrow(VideoValidationError);
  });

  it("should throw VideoValidationError for file with no extension", async () => {
    // extname("noext") returns "" which is not in ALLOWED_EXTENSIONS
    await expect(
      validateVideoFile("/tmp/noext", 100)
    ).rejects.toThrow(VideoValidationError);
  });
});
