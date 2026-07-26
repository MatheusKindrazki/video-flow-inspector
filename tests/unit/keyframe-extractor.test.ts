import { describe, expect, it } from "vitest";
import { computeFramePlan } from "../../src/preprocessing/keyframe-extractor.js";

describe("computeFramePlan", () => {
  it("keeps the requested interval when it already fits the budget", () => {
    // 20s video, 2s interval → 11 frames, well within maxFrames 40.
    const plan = computeFramePlan(20, 2, 40);
    expect(plan.effectiveInterval).toBe(2);
    expect(plan.framesToExtract).toBe(11);
  });

  it("widens the interval so candidates cover the full duration of a long video", () => {
    // 300s video, requested 1s interval → would be 301 frames, capped at 40.
    // The interval must widen so the 40 candidates span the whole timeline,
    // guaranteeing a sample near the end (not only the first 40s).
    const plan = computeFramePlan(300, 1, 40);
    // 300 / (40 - 1) ≈ 7.69s between samples → ~40 frames spanning 0..300s.
    expect(plan.framesToExtract).toBeLessThanOrEqual(40);
    const lastCandidateMs = plan.effectiveInterval * (plan.framesToExtract - 1) * 1000;
    // The last candidate must be within one interval of the end (near the end).
    expect(lastCandidateMs).toBeGreaterThanOrEqual(290_000);
  });

  it("never exceeds maxFrames", () => {
    expect(computeFramePlan(1000, 0.5, 20).framesToExtract).toBeLessThanOrEqual(20);
    expect(computeFramePlan(1000, 0.5, 1).framesToExtract).toBe(1);
  });
});
