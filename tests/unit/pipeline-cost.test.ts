import { describe, expect, it } from "vitest";
import { calculateResultCost } from "../../src/orchestrator/pipeline.js";

describe("calculateResultCost", () => {
  it("charges each model's observed usage when analysis escalates", () => {
    const result = calculateResultCost("gemini-2.5-flash", {
      usage: { input_tokens: 200, output_tokens: 30 },
      meta: { escalation: { triggered: true, from_model: "gemini-2.5-flash-lite", to_model: "gemini-2.5-flash", from_usage: { input_tokens: 100, output_tokens: 20 } } },
    });
    expect(result.cost).toMatchObject({
      input_cost_usd: 0.00007,
      output_cost_usd: 0.000083,
      total_cost_usd: 0.000153,
      pricing_source: "confirmed",
    });
  });

  it("does not expose heuristic token defaults as observed usage", () => {
    const result = calculateResultCost("gemini-2.5-flash-lite", {});
    expect(result.usage).toBeUndefined();
    expect(result.cost).toMatchObject({ input_tokens: 4_000, output_tokens: 1_000, pricing_source: "heuristic" });
  });

  it("aggregates initial and final token usage when escalation succeeds", () => {
    // Cost already combines both models; usage must too, so reported tokens stay
    // coherent with the combined cost rather than only reflecting the final call.
    const result = calculateResultCost("gemini-2.5-flash", {
      usage: { input_tokens: 200, output_tokens: 30 },
      meta: { escalation: { triggered: true, from_model: "gemini-2.5-flash-lite", to_model: "gemini-2.5-flash", from_usage: { input_tokens: 100, output_tokens: 20 } } },
    });
    expect(result.usage).toEqual({ input_tokens: 300, output_tokens: 50 });
  });

  it("omits usage when the escalation final usage is absent", () => {
    // If the final usage is missing, do not invent tokens — cost still sums but
    // usage is undefined rather than exposing heuristic counts as observed.
    const result = calculateResultCost("gemini-2.5-flash", {
      meta: { escalation: { triggered: true, from_model: "gemini-2.5-flash-lite", to_model: "gemini-2.5-flash", from_usage: { input_tokens: 100, output_tokens: 20 } } },
    });
    expect(result.usage).toBeUndefined();
    expect(result.cost).toBeDefined();
  });
});
