import { describe, expect, it } from "vitest";
import { GeminiProvider } from "../../src/analysis/gemini.js";

const valid = (hypotheses: unknown[] = []) => JSON.stringify({ summary: "ok", timeline: [], detected_issues: [], hypotheses, recommended_actions: [] });
const context = { goal: "check flow", keyframes: [], video_duration_ms: 1_000 };

function clientWith(responses: Array<string | Error | { raw: string; input: number; output: number }>) {
  const models: string[] = [];
  return {
    models,
    getGenerativeModel: ({ model }: { model: string }) => ({
      generateContent: async () => {
        models.push(model);
        const response = responses.shift();
        if (response instanceof Error) throw response;
        const content = typeof response === "string" ? { raw: response, input: 10, output: 5 } : response;
        return { response: { text: () => content.raw, usageMetadata: { promptTokenCount: content.input, candidatesTokenCount: content.output } } };
      },
    }),
  };
}

describe("GeminiProvider", () => {
  it("does not retry permanent 4xx failures", async () => {
    const error = Object.assign(new Error("bad request"), { status: 400 });
    const client = clientWith([error]);
    const provider = new GeminiProvider("unused", "gemini-2.5-flash-lite", 3, 100, { client, retryDelayMs: 0 });
    await expect(provider.analyze(context)).rejects.toThrow("bad request");
    expect(client.models).toHaveLength(1);
  });

  it("retries transient 5xx failures", async () => {
    const error = Object.assign(new Error("server error"), { status: 503 });
    const client = clientWith([error, valid()]);
    const result = await new GeminiProvider("unused", "gemini-2.5-flash-lite", 2, 100, { client, retryDelayMs: 0 }).analyze(context);
    expect(client.models).toHaveLength(2);
    expect(result.meta?.retries.attempts).toBe(2);
  });

  it("uses repair before attempting another request", async () => {
    const client = clientWith(['```json\n{"summary":"ok",}\n```']);
    const result = await new GeminiProvider("unused", "gemini-2.5-flash-lite", 2, 100, { client, retryDelayMs: 0 }).analyze(context);
    expect(client.models).toHaveLength(1);
    expect(result.meta?.retries.json_repaired).toBe(true);
  });

  it("does not mark valid pretty-printed JSON as repaired", async () => {
    const client = clientWith(['{\n  "summary": "ok",\n  "timeline": [],\n  "detected_issues": [],\n  "hypotheses": [],\n  "recommended_actions": []\n}']);
    const result = await new GeminiProvider("unused", "gemini-2.5-flash-lite", 1, 100, { client, retryDelayMs: 0 }).analyze(context);
    expect(result.meta?.retries.json_repaired).toBe(false);
  });

  it("retries once when JSON cannot be repaired", async () => {
    const client = clientWith(["not JSON", valid()]);
    const result = await new GeminiProvider("unused", "gemini-2.5-flash-lite", 2, 100, { client, retryDelayMs: 0 }).analyze(context);
    expect(client.models).toHaveLength(2);
    expect(result.meta?.retries.attempts).toBe(2);
  });

  it("escalates once on low confidence when enabled", async () => {
    const client = clientWith([valid([{ confidence: 0.2 }]), valid([{ confidence: 0.9 }])]);
    const result = await new GeminiProvider("unused", "gemini-2.5-flash-lite", 1, 100, { client, escalationEnabled: true, escalationConfidenceThreshold: 0.5, retryDelayMs: 0 }).analyze(context);
    expect(client.models).toEqual(["gemini-2.5-flash-lite", "gemini-2.5-flash"]);
    expect(result.meta?.escalation.triggered).toBe(true);
  });

  it("preserves first-model usage and combines retry stats when escalating", async () => {
    const transient = Object.assign(new Error("server error"), { status: 503 });
    const client = clientWith([transient, { raw: valid([{ confidence: 0.2 }]), input: 100, output: 20 }, { raw: valid([{ confidence: 0.9 }]), input: 200, output: 30 }]);
    const result = await new GeminiProvider("unused", "gemini-2.5-flash-lite", 2, 100, { client, escalationEnabled: true, escalationConfidenceThreshold: 0.5, retryDelayMs: 0 }).analyze(context);
    expect(result.usage).toEqual({ input_tokens: 200, output_tokens: 30 });
    expect(result.meta?.escalation.from_usage).toEqual({ input_tokens: 100, output_tokens: 20 });
    expect(result.meta?.retries).toEqual({ attempts: 3, json_repaired: false, frames_reduced: false });
  });

  it("escalates when the Lite response remains ambiguous after repair", async () => {
    const client = clientWith(["not JSON", valid()]);
    const result = await new GeminiProvider("unused", "gemini-2.5-flash-lite", 1, 100, { client, escalationEnabled: true, retryDelayMs: 0 }).analyze(context);
    expect(client.models).toEqual(["gemini-2.5-flash-lite", "gemini-2.5-flash"]);
    expect(result.meta?.escalation.reason).toBe("ambiguous_response");
    expect(result.meta?.escalation.from_usage).toEqual({ input_tokens: 10, output_tokens: 5 });
    expect(result.meta?.retries.attempts).toBe(2);
  });

  it("does not escalate when disabled", async () => {
    const client = clientWith([valid([{ confidence: 0.2 }])]);
    await new GeminiProvider("unused", "gemini-2.5-flash-lite", 1, 100, { client, escalationEnabled: false, retryDelayMs: 0 }).analyze(context);
    expect(client.models).toEqual(["gemini-2.5-flash-lite"]);
  });

  it("falls back to the primary result when the escalation call fails", async () => {
    // Primary succeeds but triggers escalation (low confidence); the escalation
    // model then fails. The valid primary result must be returned rather than
    // throwing, with honest metadata that escalation was attempted and failed.
    const escalationError = Object.assign(new Error("server error"), { status: 503 });
    const client = clientWith([valid([{ confidence: 0.2 }]), escalationError]);
    const result = await new GeminiProvider("unused", "gemini-2.5-flash-lite", 1, 100, { client, escalationEnabled: true, escalationConfidenceThreshold: 0.5, retryDelayMs: 0 }).analyze(context);
    expect(client.models).toEqual(["gemini-2.5-flash-lite", "gemini-2.5-flash"]);
    expect(result.meta?.escalation.triggered).toBe(false);
    expect(result.meta?.escalation.reason).toBe("escalation_failed:low_confidence");
    // Primary usage is preserved on the returned result.
    expect(result.usage).toEqual({ input_tokens: 10, output_tokens: 5 });
  });
});
