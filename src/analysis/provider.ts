// ─── Keyframe ──────────────────────────────────────────────────────────────

export interface Keyframe {
  index: number;
  timestamp_ms: number;
  path: string;
  base64?: string;
  width: number;
  height: number;
}

// ─── Analysis Context ──────────────────────────────────────────────────────

export interface AnalysisContext {
  goal: string;
  app_context?: string;
  expected_flow?: string[];
  environment?: string;
  instructions?: string;
  keyframes: Keyframe[];
  video_duration_ms: number;
}

// ─── Provider Analysis Result ──────────────────────────────────────────────

export interface ProviderAnalysisResult {
  raw: string;
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
    estimated_effort?: "trivial" | "small" | "medium" | "large";
  }>;
  usage?: {
    input_tokens: number;
    output_tokens: number;
  };
}

// ─── Analysis Provider Interface ───────────────────────────────────────────

export interface AnalysisProvider {
  name: string;
  analyze(context: AnalysisContext): Promise<ProviderAnalysisResult>;
}
