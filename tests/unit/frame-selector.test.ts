import { describe, expect, it } from "vitest";
import { selectKeyframes, type FrameDescriptor } from "../../src/preprocessing/frame-selector.js";

const frames = (scores: number[], step = 1_000): FrameDescriptor[] => scores.map((changeScore, index) => ({ index, timestamp_ms: index * step, changeScore }));
const options = { maxFrames: 10, changeThreshold: 0.5, safetyIntervalMs: 3_000, minFrames: 2 };

describe("selectKeyframes", () => {
  it("preserves first and last anchors", () => {
    const result = selectKeyframes(frames([0, 0, 0, 0]), options);
    expect(result.selected.map((frame) => frame.index)).toEqual([0, 3]);
  });

  it("selects relevant frames at the threshold", () => {
    expect(selectKeyframes(frames([0, 0.5, 0.49, 0]), options).selected.map((frame) => frame.index)).toContain(1);
  });

  it("adds safety samples across long gaps", () => {
    const result = selectKeyframes(frames([0, 0, 0, 0, 0, 0, 0, 0, 0, 0], 1_000), options);
    expect(result.selected.map((frame) => frame.index)).toEqual([0, 4, 8, 9]);
  });

  it("respects the cap without dropping anchors", () => {
    const result = selectKeyframes(frames([0, 0.9, 0.6, 0.8, 0]), { ...options, maxFrames: 3 });
    expect(result.selected.map((frame) => frame.index)).toEqual([0, 1, 4]);
  });

  it("deduplicates descriptors with duplicate indexes", () => {
    const result = selectKeyframes([{ index: 0, timestamp_ms: 0, changeScore: 0 }, { index: 1, timestamp_ms: 1_000, changeScore: 0.9 }, { index: 1, timestamp_ms: 1_100, changeScore: 0.9 }, { index: 2, timestamp_ms: 2_000, changeScore: 0 }], options);
    expect(result.selected.map((frame) => frame.index)).toEqual([0, 1, 2]);
  });

  it("keeps internally consistent selection statistics", () => {
    const result = selectKeyframes(frames([0, 0.9, 0, 0, 0]), options);
    expect(result.stats.candidates).toBe(result.stats.selected_count + result.stats.discarded_count);
    expect(result.stats.by_relevance + result.stats.by_safety + result.stats.by_anchor).toBe(result.stats.selected_count);
  });

  it("handles empty and single-frame input", () => {
    expect(selectKeyframes([], options).selected).toEqual([]);
    expect(selectKeyframes(frames([0]), options).selected.map((frame) => frame.index)).toEqual([0]);
  });

  it("samples all-identical frames and tops up to minFrames", () => {
    const result = selectKeyframes(frames([0, 0, 0, 0, 0], 100), { ...options, safetyIntervalMs: 10_000, minFrames: 4 });
    expect(result.selected).toHaveLength(4);
  });
});
