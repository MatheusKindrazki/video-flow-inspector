import {
  NormalizedAnalysis,
  RecommendedAction,
  DetectedIssue,
} from "../normalizer/semantic.js";

// ─── Types ─────────────────────────────────────────────────────────────────

export interface AnalysisRecommendation {
  next_best_action: RecommendedAction;
  confidence: number; // 0-1 overall confidence in the analysis
}

// ─── Severity Mapping ──────────────────────────────────────────────────────

const SEVERITY_TO_ACTION_TYPE: Record<string, RecommendedAction["type"]> = {
  critical: "fix",
  major: "fix",
  minor: "investigate",
  info: "monitor",
};

const SEVERITY_TO_EFFORT: Record<string, RecommendedAction["estimated_effort"]> = {
  critical: "large",
  major: "medium",
  minor: "small",
  info: "trivial",
};

// ─── Confidence Bounds ─────────────────────────────────────────────────────

const CONFIDENCE_MIN = 0.1;
const CONFIDENCE_MAX = 0.95;

function clampConfidence(value: number): number {
  return Math.min(CONFIDENCE_MAX, Math.max(CONFIDENCE_MIN, value));
}

// ─── Default Action Generator ──────────────────────────────────────────────

/**
 * Generate a default action when provider didn't supply one.
 *
 * Uses the highest-severity issue to determine the action type and priority.
 * If no issues exist, returns a generic "investigate manually" action.
 */
function generateDefaultAction(issues: DetectedIssue[]): RecommendedAction {
  if (issues.length === 0) {
    return {
      id: "default-investigate",
      priority: 1,
      action: "Investigate manually — automated analysis found no specific issues",
      rationale:
        "No issues were detected by the automated analysis. Manual review is recommended to verify that the flow works as expected and to catch any subtle issues the analysis may have missed.",
      type: "investigate",
      estimated_effort: "small",
    };
  }

  // Issues are already sorted by severity (critical first) from the normalizer
  const topIssue = issues[0];

  const actionType =
    SEVERITY_TO_ACTION_TYPE[topIssue.severity] ?? "investigate";
  const effort =
    SEVERITY_TO_EFFORT[topIssue.severity] ?? "medium";

  return {
    id: `default-${actionType}-${topIssue.id}`,
    priority: 1,
    action: `${capitalize(actionType)} ${topIssue.severity} issue: ${topIssue.title}`,
    rationale: `${topIssue.description}. Evidence: ${topIssue.evidence}`,
    type: actionType,
    estimated_effort: effort,
  };
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ─── Confidence Calculator ─────────────────────────────────────────────────

/**
 * Calculate overall confidence in the analysis.
 *
 * Factors:
 * - 0.9 base if issues found with clear evidence
 * - -0.1 per hypothesis with confidence < 0.5
 * - +0.05 per timeline event (max +0.2 bonus)
 * - 0.5 base if no issues found (could mean no issues or missed them)
 * - Never below 0.1, never above 0.95
 */
function calculateConfidence(analysis: NormalizedAnalysis): number {
  const { detected_issues, hypotheses, timeline } = analysis;

  // Determine base confidence
  let confidence: number;

  if (detected_issues.length > 0) {
    // Issues found — check if they have clear evidence
    const issuesWithEvidence = detected_issues.filter(
      (issue) => issue.evidence && issue.evidence.trim().length > 0,
    );
    const evidenceRatio =
      detected_issues.length > 0
        ? issuesWithEvidence.length / detected_issues.length
        : 0;

    // Base of 0.9 scaled by evidence quality
    confidence = 0.9 * evidenceRatio + 0.5 * (1 - evidenceRatio);
  } else {
    // No issues found — lower base confidence (could have missed things)
    confidence = 0.5;
  }

  // Penalty for low-confidence hypotheses: -0.1 per hypothesis with confidence < 0.5
  const lowConfidenceHypotheses = hypotheses.filter(
    (h) => h.confidence < 0.5,
  );
  confidence -= lowConfidenceHypotheses.length * 0.1;

  // Bonus for timeline coverage: +0.05 per event, max +0.2
  const timelineBonus = Math.min(timeline.length * 0.05, 0.2);
  confidence += timelineBonus;

  return clampConfidence(confidence);
}

// ─── Main Recommendation Generator ─────────────────────────────────────────

/**
 * Determine the next best action and overall confidence.
 *
 * Logic:
 * 1. If there are recommended_actions from the provider, pick priority 1
 * 2. If no recommended_actions, generate a default based on detected_issues
 * 3. Calculate confidence based on evidence quality, hypotheses, and timeline
 * 4. If absolutely nothing was found, return a generic "investigate manually" action
 */
export function generateRecommendation(
  analysis: NormalizedAnalysis,
): AnalysisRecommendation {
  let nextBestAction: RecommendedAction;

  if (analysis.recommended_actions.length > 0) {
    // Actions are already sorted by priority from the normalizer (1 = highest)
    nextBestAction = analysis.recommended_actions[0];
  } else {
    // No provider-supplied actions — generate a default
    nextBestAction = generateDefaultAction(analysis.detected_issues);
  }

  const confidence = calculateConfidence(analysis);

  return {
    next_best_action: nextBestAction,
    confidence: Math.round(confidence * 100) / 100, // round to 2 decimal places
  };
}
