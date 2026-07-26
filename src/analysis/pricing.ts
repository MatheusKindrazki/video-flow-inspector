/**
 * Gemini token prices in USD per million tokens. Confirmed against Google's
 * published Gemini pricing on 2026-07-26. Unconfirmed entries intentionally
 * use the heuristic path until they are verified.
 */
const CONFIRMED_PRICING: Record<string, { inputPerMillion: number; outputPerMillion: number }> = {
  "gemini-2.5-flash": { inputPerMillion: 0.3, outputPerMillion: 2.5 },
  "gemini-2.5-flash-lite": { inputPerMillion: 0.1, outputPerMillion: 0.4 },
};

export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
}

export interface CostBreakdown extends TokenUsage {
  input_cost_usd: number;
  output_cost_usd: number;
  total_cost_usd: number;
  pricing_source: "confirmed" | "heuristic";
}

const round = (value: number): number => Math.round(value * 1_000_000_000) / 1_000_000_000;

export function calculateCost(model: string, usage?: TokenUsage): CostBreakdown {
  const tokenUsage = usage ?? { input_tokens: 4_000, output_tokens: 1_000 };
  const pricing = usage ? CONFIRMED_PRICING[model] : undefined;

  if (pricing) {
    const input = round((tokenUsage.input_tokens / 1_000_000) * pricing.inputPerMillion);
    const output = round((tokenUsage.output_tokens / 1_000_000) * pricing.outputPerMillion);
    return { ...tokenUsage, input_cost_usd: input, output_cost_usd: output, total_cost_usd: round(input + output), pricing_source: "confirmed" };
  }

  // Conservative, explicitly labelled fallback for unknown models or missing usage.
  const input = round((tokenUsage.input_tokens / 1_000_000) * 0.3);
  const output = round((tokenUsage.output_tokens / 1_000_000) * 2.5);
  return { ...tokenUsage, input_cost_usd: input, output_cost_usd: output, total_cost_usd: round(input + output), pricing_source: "heuristic" };
}
