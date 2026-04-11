import { describe, it, expect } from "vitest";
import { normalizeProviderOutput } from "../../src/normalizer/semantic.js";
import { NormalizationError } from "../../src/utils/errors.js";

// ─── Test Fixtures ──────────────────────────────────────────────────────────

function createValidProviderOutput() {
  return {
    summary: "User completed the login flow. A minor UI glitch was detected on the dashboard.",
    timeline: [
      {
        timestamp_ms: 2000,
        frame_index: 1,
        action: "navigate",
        element: "Login page",
        description: "User navigated to the login page",
        status: "normal" as const,
      },
      {
        timestamp_ms: 0,
        frame_index: 0,
        action: "click",
        element: "Start button",
        description: "User clicked the start button",
        status: "normal" as const,
      },
      {
        timestamp_ms: 5000,
        frame_index: 3,
        action: "type",
        element: "Email input",
        description: "User typed email address",
        status: "normal" as const,
      },
    ],
    detected_issues: [
      {
        id: "ISSUE-002",
        severity: "minor" as const,
        type: "ui_glitch" as const,
        title: "Dashboard text overlap",
        description: "Text overlaps with the sidebar on narrow screens",
        actual_behavior: "Text is cut off and overlaps",
        evidence: "Visible in frame 5 at 8000ms",
      },
      {
        id: "ISSUE-001",
        severity: "critical" as const,
        type: "crash" as const,
        title: "App crash on submit",
        description: "Application crashes when user submits the form",
        actual_behavior: "White screen of death after clicking submit",
        evidence: "Visible in frame 4 at 6000ms",
      },
    ],
    hypotheses: [
      {
        id: "HYP-001",
        description: "Null pointer in form validation",
        confidence: 0.8,
        supporting_evidence: ["Crash occurs immediately after form submit"],
        suggested_investigation: "Check form validation handler for null checks",
      },
    ],
    recommended_actions: [
      {
        id: "ACTION-002",
        priority: 2,
        action: "Fix CSS overflow in dashboard sidebar",
        rationale: "Text overlap causes readability issues",
        type: "fix" as const,
        estimated_effort: "small" as const,
      },
      {
        id: "ACTION-001",
        priority: 1,
        action: "Fix crash in form submit handler",
        rationale: "Critical crash affecting all users",
        type: "fix" as const,
        estimated_effort: "medium" as const,
      },
    ],
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("normalizeProviderOutput", () => {
  it("should normalize valid provider output correctly", () => {
    const raw = createValidProviderOutput();
    const result = normalizeProviderOutput(raw);

    expect(result.summary).toBe(raw.summary);
    expect(result.timeline).toHaveLength(3);
    expect(result.detected_issues).toHaveLength(2);
    expect(result.hypotheses).toHaveLength(1);
    expect(result.recommended_actions).toHaveLength(2);
  });

  it("should throw NormalizationError when summary is missing", () => {
    const raw = createValidProviderOutput();
    (raw as any).summary = "";

    expect(() => normalizeProviderOutput(raw)).toThrow(NormalizationError);
    expect(() => normalizeProviderOutput(raw)).toThrow(
      "Provider output has no usable summary"
    );
  });

  it("should throw NormalizationError when summary is not a string", () => {
    const raw = createValidProviderOutput();
    (raw as any).summary = null;

    expect(() => normalizeProviderOutput(raw)).toThrow(NormalizationError);
  });

  it("should throw NormalizationError when summary is only whitespace", () => {
    const raw = createValidProviderOutput();
    (raw as any).summary = "   ";

    expect(() => normalizeProviderOutput(raw)).toThrow(NormalizationError);
  });

  it("should filter out invalid timeline items instead of throwing", () => {
    const raw = createValidProviderOutput();
    raw.timeline.push({
      timestamp_ms: 3000,
      frame_index: 2,
      action: "click",
      element: "Button",
      description: "Valid item",
      status: "normal",
    });
    // Add an invalid item (missing required fields)
    (raw.timeline as any[]).push({
      timestamp_ms: "not-a-number",
      action: "invalid_action",
    });

    const result = normalizeProviderOutput(raw);
    // The valid items pass, the invalid one gets filtered
    expect(result.timeline).toHaveLength(4);
  });

  it("should accept empty arrays", () => {
    const raw = {
      summary: "No issues found in the video flow.",
      timeline: [],
      detected_issues: [],
      hypotheses: [],
      recommended_actions: [],
    };

    const result = normalizeProviderOutput(raw);

    expect(result.summary).toBe("No issues found in the video flow.");
    expect(result.timeline).toHaveLength(0);
    expect(result.detected_issues).toHaveLength(0);
    expect(result.hypotheses).toHaveLength(0);
    expect(result.recommended_actions).toHaveLength(0);
  });

  it("should sort timeline by timestamp_ms ascending", () => {
    const raw = createValidProviderOutput();
    const result = normalizeProviderOutput(raw);

    // Original order: 2000, 0, 5000 -> sorted: 0, 2000, 5000
    expect(result.timeline[0].timestamp_ms).toBe(0);
    expect(result.timeline[1].timestamp_ms).toBe(2000);
    expect(result.timeline[2].timestamp_ms).toBe(5000);
  });

  it("should sort detected_issues by severity (critical first)", () => {
    const raw = createValidProviderOutput();
    const result = normalizeProviderOutput(raw);

    // Original order: minor, critical -> sorted: critical, minor
    expect(result.detected_issues[0].severity).toBe("critical");
    expect(result.detected_issues[0].id).toBe("ISSUE-001");
    expect(result.detected_issues[1].severity).toBe("minor");
    expect(result.detected_issues[1].id).toBe("ISSUE-002");
  });

  it("should sort recommended_actions by priority ascending", () => {
    const raw = createValidProviderOutput();
    const result = normalizeProviderOutput(raw);

    // Original order: priority 2, priority 1 -> sorted: 1, 2
    expect(result.recommended_actions[0].priority).toBe(1);
    expect(result.recommended_actions[0].id).toBe("ACTION-001");
    expect(result.recommended_actions[1].priority).toBe(2);
    expect(result.recommended_actions[1].id).toBe("ACTION-002");
  });

  it("should handle non-array fields gracefully by treating them as empty", () => {
    const raw = {
      summary: "Analysis complete.",
      timeline: "not an array" as any,
      detected_issues: null as any,
      hypotheses: undefined as any,
      recommended_actions: 42 as any,
    };

    const result = normalizeProviderOutput(raw);

    expect(result.timeline).toHaveLength(0);
    expect(result.detected_issues).toHaveLength(0);
    expect(result.hypotheses).toHaveLength(0);
    expect(result.recommended_actions).toHaveLength(0);
  });

  it("should trim whitespace from summary", () => {
    const raw = createValidProviderOutput();
    raw.summary = "  Trimmed summary.  ";

    const result = normalizeProviderOutput(raw);
    expect(result.summary).toBe("Trimmed summary.");
  });

  it("should preserve all valid fields in timeline events", () => {
    const raw = createValidProviderOutput();
    const result = normalizeProviderOutput(raw);

    const firstEvent = result.timeline[0]; // timestamp_ms: 0 after sorting
    expect(firstEvent.frame_index).toBe(0);
    expect(firstEvent.action).toBe("click");
    expect(firstEvent.element).toBe("Start button");
    expect(firstEvent.description).toBe("User clicked the start button");
    expect(firstEvent.status).toBe("normal");
  });

  it("should sort multiple severity levels correctly", () => {
    const raw = {
      summary: "Multiple issues found.",
      timeline: [],
      detected_issues: [
        {
          id: "I-1",
          severity: "info" as const,
          type: "unknown" as const,
          title: "Info issue",
          description: "Low priority",
          actual_behavior: "Minor observation",
          evidence: "Frame 1",
        },
        {
          id: "I-2",
          severity: "major" as const,
          type: "regression" as const,
          title: "Major issue",
          description: "Important regression",
          actual_behavior: "Broken feature",
          evidence: "Frame 3",
        },
        {
          id: "I-3",
          severity: "critical" as const,
          type: "crash" as const,
          title: "Critical crash",
          description: "App crash",
          actual_behavior: "White screen",
          evidence: "Frame 5",
        },
        {
          id: "I-4",
          severity: "minor" as const,
          type: "ui_glitch" as const,
          title: "Minor glitch",
          description: "Small visual issue",
          actual_behavior: "Pixel misalignment",
          evidence: "Frame 2",
        },
      ],
      hypotheses: [],
      recommended_actions: [],
    };

    const result = normalizeProviderOutput(raw);

    expect(result.detected_issues.map((i) => i.severity)).toEqual([
      "critical",
      "major",
      "minor",
      "info",
    ]);
  });
});
