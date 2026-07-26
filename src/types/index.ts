// ─── Action & Status Enums ──────────────────────────────────────────────────

export type ActionType =
  | "click"
  | "type"
  | "navigate"
  | "scroll"
  | "wait"
  | "error"
  | "transition";

export type EventStatus = "normal" | "warning" | "error";

export type IssueSeverity = "critical" | "major" | "minor" | "info";

export type IssueType =
  | "crash"
  | "regression"
  | "ui_glitch"
  | "flow_deviation"
  | "performance"
  | "accessibility"
  | "data_error"
  | "unknown";

export type ActionCategory =
  | "investigate"
  | "fix"
  | "test"
  | "monitor"
  | "escalate";

export type EffortEstimate = "trivial" | "small" | "medium" | "large";

export type ProviderName = "gemini" | "openai" | "anthropic";

// ─── Analysis Input ─────────────────────────────────────────────────────────

export interface AnalyzeVideoFlowInput {
  video_url?: string;
  video_file_path?: string;
  goal: string;
  app_context?: string;
  expected_flow?: string[];
  environment?: string;
  instructions?: string;
}

// ─── Timeline Event ─────────────────────────────────────────────────────────

export interface TimelineEvent {
  timestamp_ms: number;
  frame_index: number;
  action: ActionType;
  element?: string;
  description: string;
  screenshot_index?: number;
  status: EventStatus;
}

// ─── Detected Issue ─────────────────────────────────────────────────────────

export interface DetectedIssue {
  id: string;
  severity: IssueSeverity;
  type: IssueType;
  title: string;
  description: string;
  timestamp_ms?: number;
  frame_index?: number;
  expected_behavior?: string;
  actual_behavior: string;
  evidence: string;
}

// ─── Hypothesis ─────────────────────────────────────────────────────────────

export interface Hypothesis {
  id: string;
  description: string;
  confidence: number;
  supporting_evidence: string[];
  suggested_investigation: string;
}

// ─── Recommended Action ─────────────────────────────────────────────────────

export interface RecommendedAction {
  id: string;
  priority: number;
  action: string;
  rationale: string;
  type: ActionCategory;
  estimated_effort?: EffortEstimate;
}

// ─── Analysis Metadata ──────────────────────────────────────────────────────

export interface AnalysisMetadata {
  provider: string;
  model: string;
  video_duration_ms: number;
  keyframes_analyzed: number;
  analysis_duration_ms: number;
  cost_estimate_usd?: number;
  frames?: { candidates: number; analyzed: number; discarded: number; selection_strategy: string };
  usage?: { input_tokens: number; output_tokens: number };
  cost?: { input_cost_usd: number; output_cost_usd: number; total_cost_usd: number; pricing_source: "confirmed" | "heuristic" };
  escalation?: { triggered: boolean; from_model?: string; to_model?: string; reason?: string; from_usage?: { input_tokens: number; output_tokens: number } };
  retries?: { attempts: number; json_repaired: boolean; frames_reduced: boolean };
}

// ─── Full Analysis Output ───────────────────────────────────────────────────

export interface AnalyzeVideoFlowOutput {
  summary: string;
  timeline: TimelineEvent[];
  detected_issues: DetectedIssue[];
  hypotheses: Hypothesis[];
  recommended_actions: RecommendedAction[];
  next_best_action: RecommendedAction;
  confidence: number;
  metadata: AnalysisMetadata;
  raw_provider_notes?: string;
}

// ─── Video Metadata ─────────────────────────────────────────────────────────

export interface VideoMetadata {
  duration_ms: number;
  width: number;
  height: number;
  fps: number;
  codec: string;
  size_bytes: number;
  format: string;
}

// ─── Keyframe ───────────────────────────────────────────────────────────────

export interface Keyframe {
  index: number;
  timestamp_ms: number;
  path: string;
  base64?: string;
  width: number;
  height: number;
}

// ─── Provider Configuration ─────────────────────────────────────────────────

export interface ProviderConfig {
  name: ProviderName;
  model: string;
  apiKey: string;
  maxRetries: number;
  timeoutMs: number;
}

// ─── Provider Response ──────────────────────────────────────────────────────

export interface ProviderResponse {
  raw: string;
  parsed: {
    summary: string;
    timeline: TimelineEvent[];
    detected_issues: DetectedIssue[];
    hypotheses: Hypothesis[];
    recommended_actions: RecommendedAction[];
  };
  usage?: {
    input_tokens: number;
    output_tokens: number;
  };
}

// ─── App Configuration ──────────────────────────────────────────────────────

export interface AppConfig {
  defaultProvider: ProviderName;
  fallbackProvider: ProviderName;
  maxKeyframes: number;
  keyframeIntervalSeconds: number;
  maxVideoSizeMB: number;
  maxVideoDurationSeconds: number;
  logLevel: string;
  gemini: {
    escalationModel: string;
    escalationEnabled: boolean;
    escalationConfidenceThreshold: number;
    escalationOnCritical: boolean;
    maxOutputTokens: number;
    timeoutReduceFrames: boolean;
  };
  frameSelection: { changeThreshold: number; safetyIntervalMs: number };
  providers: Record<ProviderName, ProviderConfig | undefined>;
}
