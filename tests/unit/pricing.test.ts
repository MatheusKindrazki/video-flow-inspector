import { describe, expect, it } from "vitest";
import { calculateCost } from "../../src/analysis/pricing.js";

describe("calculateCost", () => {
  it("calculates confirmed Gemini Flash pricing from real usage", () => {
    expect(calculateCost("gemini-2.5-flash", { input_tokens: 1_000_000, output_tokens: 1_000_000 })).toMatchObject({
      input_cost_usd: 0.3,
      output_cost_usd: 2.5,
      total_cost_usd: 2.8,
      pricing_source: "confirmed",
    });
  });

  it("calculates confirmed Gemini Flash-Lite pricing from real usage", () => {
    expect(calculateCost("gemini-2.5-flash-lite", { input_tokens: 1_000_000, output_tokens: 1_000_000 })).toMatchObject({
      input_cost_usd: 0.1,
      output_cost_usd: 0.4,
      total_cost_usd: 0.5,
      pricing_source: "confirmed",
    });
  });

  it("uses a labelled heuristic when usage is unavailable", () => {
    const cost = calculateCost("gemini-2.5-flash-lite");
    expect(cost.pricing_source).toBe("heuristic");
    expect(cost.total_cost_usd).toBeGreaterThan(0);
  });

  it("uses a heuristic for an unknown model", () => {
    expect(calculateCost("future-model", { input_tokens: 100, output_tokens: 50 }).pricing_source).toBe("heuristic");
  });
});
