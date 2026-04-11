import { AnalysisContext } from "./provider.js";

/**
 * Build the system prompt for video flow analysis.
 * This is provider-agnostic — returns the text prompt.
 */
export function buildSystemPrompt(): string {
  return `You are a senior QA engineer and UI debugging specialist with deep expertise in front-end applications, mobile apps, and user experience.

Your task is to analyze a sequence of keyframe screenshots extracted from a video recording of a user interacting with an application. These keyframes represent the visual state of the UI at specific timestamps during the flow.

Your analysis should:

1. **Understand the user intent**: Based on the provided goal and the sequence of screenshots, determine what the user was trying to accomplish.

2. **Reconstruct the timeline**: For each keyframe, identify what action the user took or what happened in the UI (click, type, navigate, scroll, wait, error, transition).

3. **Detect issues**: Look for any problems, errors, or unexpected behavior, including:
   - Crashes or error screens
   - UI glitches (misaligned elements, broken layouts, overlapping text)
   - Flow deviations from the expected behavior
   - Performance issues (loading spinners persisting too long, blank screens)
   - Accessibility problems (tiny text, poor contrast, missing labels)
   - Data errors (wrong data displayed, empty states that shouldn't be empty)

4. **Form hypotheses**: Based on the evidence, propose possible root causes for any detected issues.

5. **Recommend actions**: Suggest concrete next steps for investigation, fixes, or tests.

CRITICAL RULES:
- Respond ONLY with valid JSON matching the exact schema specified.
- Do NOT include any text outside the JSON object.
- Do NOT wrap the JSON in markdown code fences.
- Every field must conform to the specified types and constraints.
- If no issues are found, return empty arrays for detected_issues and hypotheses, but still provide a timeline and summary.
- Confidence values must be between 0 and 1.
- Priority values must be positive integers (1 = highest priority).
- Use only the allowed enum values for status, severity, type, and action fields.`;
}

/**
 * Build the user prompt with context about the specific analysis.
 */
export function buildUserPrompt(context: AnalysisContext): string {
  const sections: string[] = [];

  sections.push(`## Analysis Goal\n${context.goal}`);

  if (context.app_context) {
    sections.push(`## Application Context\n${context.app_context}`);
  }

  if (context.expected_flow && context.expected_flow.length > 0) {
    const steps = context.expected_flow
      .map((step, i) => `${i + 1}. ${step}`)
      .join("\n");
    sections.push(`## Expected Flow\nThe expected sequence of steps is:\n${steps}`);
  }

  if (context.environment) {
    sections.push(`## Environment\n${context.environment}`);
  }

  if (context.instructions) {
    sections.push(`## Additional Instructions\n${context.instructions}`);
  }

  const durationSeconds = (context.video_duration_ms / 1000).toFixed(1);
  sections.push(
    `## Video Information\n- Total duration: ${durationSeconds}s (${context.video_duration_ms}ms)\n- Number of keyframes: ${context.keyframes.length}`
  );

  const frameDescriptions = context.keyframes
    .map(
      (kf) =>
        `- Frame ${kf.index}: timestamp=${kf.timestamp_ms}ms (${(kf.timestamp_ms / 1000).toFixed(1)}s), resolution=${kf.width}x${kf.height}`
    )
    .join("\n");

  sections.push(
    `## Keyframe Mapping\nEach image below corresponds to a keyframe extracted from the video at the specified timestamp. Analyze them in order to reconstruct the user's flow.\n${frameDescriptions}`
  );

  sections.push(
    `## Instructions\nAnalyze the ${context.keyframes.length} keyframe images provided below. Reconstruct the user's flow, identify any issues, and produce your analysis in the exact JSON format specified.\n\n${buildOutputSchemaPrompt()}`
  );

  return sections.join("\n\n");
}

/**
 * Build the JSON schema description that tells the LLM what format to respond in.
 * This goes into the prompt to enforce structured output.
 */
export function buildOutputSchemaPrompt(): string {
  return `## Required Output Format

Respond with a single JSON object matching this exact structure:

{
  "summary": "string — A concise 2-4 sentence summary of what happened in the video flow and any key findings.",

  "timeline": [
    {
      "timestamp_ms": 0,
      "frame_index": 0,
      "action": "click | type | navigate | scroll | wait | error | transition",
      "element": "string (optional) — The UI element involved, e.g. 'Login button', 'Email input'",
      "description": "string — What happened at this point in the flow",
      "screenshot_index": 0,
      "status": "normal | warning | error"
    }
  ],

  "detected_issues": [
    {
      "id": "string — Unique identifier, e.g. 'ISSUE-001'",
      "severity": "critical | major | minor | info",
      "type": "crash | regression | ui_glitch | flow_deviation | performance | accessibility | data_error | unknown",
      "title": "string — Short title for the issue",
      "description": "string — Detailed description of the issue",
      "timestamp_ms": 0,
      "frame_index": 0,
      "expected_behavior": "string (optional) — What should have happened",
      "actual_behavior": "string — What actually happened",
      "evidence": "string — Visual evidence from the keyframes supporting this issue"
    }
  ],

  "hypotheses": [
    {
      "id": "string — Unique identifier, e.g. 'HYP-001'",
      "description": "string — Description of the hypothesis",
      "confidence": 0.0,
      "supporting_evidence": ["string — Evidence supporting this hypothesis"],
      "suggested_investigation": "string — How to verify or disprove this hypothesis"
    }
  ],

  "recommended_actions": [
    {
      "id": "string — Unique identifier, e.g. 'ACTION-001'",
      "priority": 1,
      "action": "string — What to do",
      "rationale": "string — Why this action is recommended",
      "type": "investigate | fix | test | monitor | escalate",
      "estimated_effort": "trivial | small | medium | large (optional)"
    }
  ]
}

IMPORTANT:
- The "action" field in timeline entries must be one of: click, type, navigate, scroll, wait, error, transition
- The "status" field must be one of: normal, warning, error
- The "severity" field must be one of: critical, major, minor, info
- The "type" field in detected_issues must be one of: crash, regression, ui_glitch, flow_deviation, performance, accessibility, data_error, unknown
- The "type" field in recommended_actions must be one of: investigate, fix, test, monitor, escalate
- The "confidence" field must be a number between 0 and 1
- The "priority" field must be a positive integer (1 = highest)
- All arrays can be empty if no items apply, but "timeline" and "recommended_actions" should always have at least one entry
- Do NOT include any text outside the JSON object`;
}
