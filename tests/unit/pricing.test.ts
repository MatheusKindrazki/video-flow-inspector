import { describe, expect, it } from "vitest";
import { calculateCost } from "../../src/analysis/pricing.js";

describe("calculateCost", () => {
  it("calculates confirmed Gemini Flash pricing from real usage", () => {
    expect(calculateCost("gemini-3.5-flash", { input_tokens: 1_000_000, output_tokens: 1_000_000 })).toMatchObject({
      input_cost_usd: 1.5,
      output_cost_usd: 9,
      total_cost_usd: 10.5,
      pricing_source: "confirmed",
    });
  });

  it("calculates confirmed Gemini Flash-Lite pricing from real usage", () => {
    expect(calculateCost("gemini-3.1-flash-lite", { input_tokens: 1_000_000, output_tokens: 1_000_000 })).toMatchObject({
      input_cost_usd: 0.25,
      output_cost_usd: 1.5,
      total_cost_usd: 1.75,
      pricing_source: "confirmed",
    });
  });

  it("uses a labelled heuristic when usage is unavailable", () => {
    const cost = calculateCost("gemini-3.1-flash-lite");
    expect(cost.pricing_source).toBe("heuristic");
    expect(cost.total_cost_usd).toBeGreaterThan(0);
  });

  it("uses a heuristic for an unknown model", () => {
    expect(calculateCost("future-model", { input_tokens: 100, output_tokens: 50 }).pricing_source).toBe("heuristic");
  });
});
