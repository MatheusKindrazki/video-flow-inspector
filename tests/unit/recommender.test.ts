import { describe, it, expect } from "vitest";
import { generateRecommendation } from "../../src/recommender/actions.js";
import type { NormalizedAnalysis } from "../../src/normalizer/semantic.js";

// ─── Test Fixtures ──────────────────────────────────────────────────────────

function createAnalysisWithIssues(): NormalizedAnalysis {
  return {
    summary: "Critical crash found during login flow.",
    timeline: [
      {
        timestamp_ms: 0,
        frame_index: 0,
        action: "navigate",
        element: "Login page",
        description: "User opened the login page",
        status: "normal",
      },
      {
        timestamp_ms: 2000,
        frame_index: 1,
        action: "type",
        element: "Email input",
        description: "User typed email address",
        status: "normal",
      },
      {
        timestamp_ms: 4000,
        frame_index: 2,
        action: "click",
        element: "Submit button",
        description: "User clicked submit",
        status: "error",
      },
    ],
    detected_issues: [
      {
        id: "ISSUE-001",
        severity: "critical",
        type: "crash",
        title: "App crash on form submit",
        description: "Application crashes when submitting the login form",
        timestamp_ms: 4000,
        frame_index: 2,
        actual_behavior: "White screen appears after clicking submit",
        evidence: "Frame 2 shows a blank white screen immediately after submit",
      },
      {
        id: "ISSUE-002",
        severity: "minor",
        type: "ui_glitch",
        title: "Button hover state missing",
        description: "Submit button has no visible hover state",
        actual_behavior: "No visual feedback on hover",
        evidence: "Frame 1 shows cursor over button with no style change",
      },
    ],
    hypotheses: [
      {
        id: "HYP-001",
        description: "Unhandled null in auth service",
        confidence: 0.85,
        supporting_evidence: [
          "Crash occurs on submit with valid-looking form data",
        ],
        suggested_investigation: "Check auth service for null pointer handling",
      },
    ],
    recommended_actions: [
      {
        id: "ACTION-001",
        priority: 1,
        action: "Fix crash in form submit handler",
        rationale: "Critical crash affecting all users",
        type: "fix",
        estimated_effort: "medium",
      },
      {
        id: "ACTION-002",
        priority: 2,
        action: "Add hover states to buttons",
        rationale: "Improves user experience feedback",
        type: "fix",
        estimated_effort: "trivial",
      },
    ],
  };
}

function createAnalysisWithoutIssues(): NormalizedAnalysis {
  return {
    summary: "The flow completed successfully with no issues detected.",
    timeline: [
      {
        timestamp_ms: 0,
        frame_index: 0,
        action: "navigate",
        description: "User opened the page",
        status: "normal",
      },
    ],
    detected_issues: [],
    hypotheses: [],
    recommended_actions: [],
  };
}

function createAnalysisWithoutActionsButWithIssues(): NormalizedAnalysis {
  return {
    summary: "Issues found but no actions recommended by provider.",
    timeline: [],
    detected_issues: [
      {
        id: "ISSUE-001",
        severity: "major",
        type: "regression",
        title: "Feature regression in checkout",
        description: "Checkout button no longer works",
        actual_behavior: "Nothing happens when clicking checkout",
        evidence: "Frame 3 shows no navigation after click",
      },
    ],
    hypotheses: [],
    recommended_actions: [],
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("generateRecommendation", () => {
  it("should return the highest priority action when issues exist", () => {
    const analysis = createAnalysisWithIssues();
    const result = generateRecommendation(analysis);

    expect(result.next_best_action).toBeDefined();
    expect(result.next_best_action.priority).toBe(1);
    expect(result.next_best_action.id).toBe("ACTION-001");
    expect(result.next_best_action.action).toBe(
      "Fix crash in form submit handler"
    );
    expect(result.next_best_action.type).toBe("fix");
  });

  it("should return a generic investigate action when no issues exist", () => {
    const analysis = createAnalysisWithoutIssues();
    const result = generateRecommendation(analysis);

    expect(result.next_best_action).toBeDefined();
    expect(result.next_best_action.type).toBe("investigate");
    expect(result.next_best_action.action).toContain("Investigate");
    expect(result.next_best_action.priority).toBe(1);
  });

  it("should generate a default action based on top issue when no recommended_actions from provider", () => {
    const analysis = createAnalysisWithoutActionsButWithIssues();
    const result = generateRecommendation(analysis);

    expect(result.next_best_action).toBeDefined();
    expect(result.next_best_action.type).toBe("fix");
    expect(result.next_best_action.action).toContain("major");
    expect(result.next_best_action.action).toContain(
      "Feature regression in checkout"
    );
  });

  it("should have confidence > 0.5 when issues with evidence are found", () => {
    const analysis = createAnalysisWithIssues();
    const result = generateRecommendation(analysis);

    expect(result.confidence).toBeGreaterThan(0.5);
  });

  it("should have confidence approximately 0.5 when no issues found and minimal timeline", () => {
    const analysis = createAnalysisWithoutIssues();
    const result = generateRecommendation(analysis);

    // Base 0.5 + timeline bonus (1 event * 0.05 = 0.05) = 0.55
    expect(result.confidence).toBeGreaterThanOrEqual(0.5);
    expect(result.confidence).toBeLessThanOrEqual(0.75);
  });

  it("should clamp confidence to minimum 0.1", () => {
    const analysis: NormalizedAnalysis = {
      summary: "Very uncertain analysis.",
      timeline: [],
      detected_issues: [],
      hypotheses: [
        {
          id: "HYP-1",
          description: "Low confidence hypothesis 1",
          confidence: 0.1,
          supporting_evidence: ["Weak evidence"],
          suggested_investigation: "Check more",
        },
        {
          id: "HYP-2",
          description: "Low confidence hypothesis 2",
          confidence: 0.2,
          supporting_evidence: ["Weak evidence"],
          suggested_investigation: "Check more",
        },
        {
          id: "HYP-3",
          description: "Low confidence hypothesis 3",
          confidence: 0.1,
          supporting_evidence: ["Weak evidence"],
          suggested_investigation: "Check more",
        },
        {
          id: "HYP-4",
          description: "Low confidence hypothesis 4",
          confidence: 0.1,
          supporting_evidence: ["Weak evidence"],
          suggested_investigation: "Check more",
        },
        {
          id: "HYP-5",
          description: "Low confidence hypothesis 5",
          confidence: 0.1,
          supporting_evidence: ["Weak evidence"],
          suggested_investigation: "Check more",
        },
      ],
      recommended_actions: [],
    };

    const result = generateRecommendation(analysis);
    // Base 0.5, minus 5 * 0.1 = 0.0, clamped to 0.1
    expect(result.confidence).toBeGreaterThanOrEqual(0.1);
  });

  it("should clamp confidence to maximum 0.95", () => {
    const analysis: NormalizedAnalysis = {
      summary: "Very clear analysis with lots of evidence.",
      timeline: Array.from({ length: 20 }, (_, i) => ({
        timestamp_ms: i * 1000,
        frame_index: i,
        action: "click" as const,
        description: `Action ${i}`,
        status: "normal" as const,
      })),
      detected_issues: [
        {
          id: "ISSUE-001",
          severity: "critical",
          type: "crash",
          title: "Clear crash",
          description: "Obvious crash with strong evidence",
          actual_behavior: "App crashed",
          evidence: "Very clear evidence visible in multiple frames",
        },
      ],
      hypotheses: [],
      recommended_actions: [
        {
          id: "ACTION-001",
          priority: 1,
          action: "Fix the crash",
          rationale: "Critical issue",
          type: "fix",
        },
      ],
    };

    const result = generateRecommendation(analysis);
    expect(result.confidence).toBeLessThanOrEqual(0.95);
  });

  it("should always return confidence between 0.1 and 0.95", () => {
    // Test multiple scenarios
    const scenarios: NormalizedAnalysis[] = [
      createAnalysisWithIssues(),
      createAnalysisWithoutIssues(),
      createAnalysisWithoutActionsButWithIssues(),
    ];

    for (const analysis of scenarios) {
      const result = generateRecommendation(analysis);
      expect(result.confidence).toBeGreaterThanOrEqual(0.1);
      expect(result.confidence).toBeLessThanOrEqual(0.95);
    }
  });

  it("should return confidence rounded to 2 decimal places", () => {
    const analysis = createAnalysisWithIssues();
    const result = generateRecommendation(analysis);

    const decimalPlaces = result.confidence.toString().split(".")[1]?.length ?? 0;
    expect(decimalPlaces).toBeLessThanOrEqual(2);
  });
});
