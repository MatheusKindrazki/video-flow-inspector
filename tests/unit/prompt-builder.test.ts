import { describe, it, expect } from "vitest";
import {
  buildSystemPrompt,
  buildUserPrompt,
  buildOutputSchemaPrompt,
} from "../../src/analysis/prompt-builder.js";
import type { AnalysisContext } from "../../src/analysis/provider.js";

function createMinimalContext(
  overrides?: Partial<AnalysisContext>
): AnalysisContext {
  return {
    goal: "Verify the login flow works correctly",
    keyframes: [
      {
        index: 0,
        timestamp_ms: 0,
        path: "/tmp/frame-0.jpg",
        width: 1920,
        height: 1080,
      },
      {
        index: 1,
        timestamp_ms: 2000,
        path: "/tmp/frame-1.jpg",
        width: 1920,
        height: 1080,
      },
    ],
    video_duration_ms: 5000,
    ...overrides,
  };
}

describe("buildSystemPrompt", () => {
  it("should return a non-empty string", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toBeTruthy();
    expect(typeof prompt).toBe("string");
    expect(prompt.length).toBeGreaterThan(100);
  });

  it("should contain key instructions about JSON output", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("JSON");
    expect(prompt).toContain("QA engineer");
  });

  it("should mention issue detection categories", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("Crashes");
    expect(prompt).toContain("UI glitches");
    expect(prompt).toContain("Performance");
  });
});

describe("buildUserPrompt", () => {
  it("should include the goal in the output", () => {
    const context = createMinimalContext();
    const prompt = buildUserPrompt(context);

    expect(prompt).toContain("Verify the login flow works correctly");
    expect(prompt).toContain("## Analysis Goal");
  });

  it("should include expected_flow steps when provided", () => {
    const context = createMinimalContext({
      expected_flow: [
        "User opens login page",
        "User enters credentials",
        "User clicks submit",
        "Dashboard loads",
      ],
    });

    const prompt = buildUserPrompt(context);

    expect(prompt).toContain("## Expected Flow");
    expect(prompt).toContain("1. User opens login page");
    expect(prompt).toContain("2. User enters credentials");
    expect(prompt).toContain("3. User clicks submit");
    expect(prompt).toContain("4. Dashboard loads");
  });

  it("should not include expected_flow section when not provided", () => {
    const context = createMinimalContext();
    const prompt = buildUserPrompt(context);

    expect(prompt).not.toContain("## Expected Flow");
  });

  it("should include frame count info", () => {
    const context = createMinimalContext();
    const prompt = buildUserPrompt(context);

    expect(prompt).toContain("Number of keyframes: 2");
    expect(prompt).toContain("Frame 0");
    expect(prompt).toContain("Frame 1");
  });

  it("should include video duration info", () => {
    const context = createMinimalContext({ video_duration_ms: 10000 });
    const prompt = buildUserPrompt(context);

    expect(prompt).toContain("10.0s");
    expect(prompt).toContain("10000ms");
  });

  it("should include app_context when provided", () => {
    const context = createMinimalContext({
      app_context: "React Native iOS app v2.3.1",
    });
    const prompt = buildUserPrompt(context);

    expect(prompt).toContain("## Application Context");
    expect(prompt).toContain("React Native iOS app v2.3.1");
  });

  it("should include environment when provided", () => {
    const context = createMinimalContext({
      environment: "staging",
    });
    const prompt = buildUserPrompt(context);

    expect(prompt).toContain("## Environment");
    expect(prompt).toContain("staging");
  });

  it("should include instructions when provided", () => {
    const context = createMinimalContext({
      instructions: "Focus on accessibility issues",
    });
    const prompt = buildUserPrompt(context);

    expect(prompt).toContain("## Additional Instructions");
    expect(prompt).toContain("Focus on accessibility issues");
  });

  it("should include keyframe resolution details", () => {
    const context = createMinimalContext();
    const prompt = buildUserPrompt(context);

    expect(prompt).toContain("1920x1080");
  });
});

describe("buildOutputSchemaPrompt", () => {
  it("should return a non-empty string", () => {
    const prompt = buildOutputSchemaPrompt();
    expect(prompt).toBeTruthy();
    expect(typeof prompt).toBe("string");
    expect(prompt.length).toBeGreaterThan(50);
  });

  it("should contain JSON schema description", () => {
    const prompt = buildOutputSchemaPrompt();
    expect(prompt).toContain("summary");
    expect(prompt).toContain("timeline");
    expect(prompt).toContain("detected_issues");
    expect(prompt).toContain("hypotheses");
    expect(prompt).toContain("recommended_actions");
  });

  it("should describe enum values for action types", () => {
    const prompt = buildOutputSchemaPrompt();
    expect(prompt).toContain("click");
    expect(prompt).toContain("navigate");
    expect(prompt).toContain("scroll");
  });

  it("should describe severity levels", () => {
    const prompt = buildOutputSchemaPrompt();
    expect(prompt).toContain("critical");
    expect(prompt).toContain("major");
    expect(prompt).toContain("minor");
    expect(prompt).toContain("info");
  });

  it("should mention the output format heading", () => {
    const prompt = buildOutputSchemaPrompt();
    expect(prompt).toContain("## Required Output Format");
  });
});
