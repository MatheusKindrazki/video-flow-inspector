import { describe, expect, it } from "vitest";
import { GeminiProvider } from "../../src/analysis/gemini.js";

const valid = (hypotheses: unknown[] = []) => JSON.stringify({ summary: "ok", timeline: [], detected_issues: [], hypotheses, recommended_actions: [] });
const context = { goal: "check flow", keyframes: [], video_duration_ms: 1_000 };

function clientWith(responses: Array<string | Error>) {
  const models: string[] = [];
  return {
    models,
    getGenerativeModel: ({ model }: { model: string }) => ({
      generateContent: async () => {
        models.push(model);
        const response = responses.shift();
        if (response instanceof Error) throw response;
        return { response: { text: () => response, usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } } };
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

  it("escalates when the Lite response remains ambiguous after repair", async () => {
    const client = clientWith(["not JSON", valid()]);
    const result = await new GeminiProvider("unused", "gemini-2.5-flash-lite", 1, 100, { client, escalationEnabled: true, retryDelayMs: 0 }).analyze(context);
    expect(client.models).toEqual(["gemini-2.5-flash-lite", "gemini-2.5-flash"]);
    expect(result.meta?.escalation.reason).toBe("ambiguous_response");
  });

  it("does not escalate when disabled", async () => {
    const client = clientWith([valid([{ confidence: 0.2 }])]);
    await new GeminiProvider("unused", "gemini-2.5-flash-lite", 1, 100, { client, escalationEnabled: false, retryDelayMs: 0 }).analyze(context);
    expect(client.models).toEqual(["gemini-2.5-flash-lite"]);
  });
});
