import { describe, expect, it } from "vitest";
import { selectFramesForAnalysis } from "../../src/orchestrator/pipeline.js";

const keyframes = Array.from({ length: 10 }, (_, index) => ({ index, timestamp_ms: index * 1_000, path: `/tmp/${index}.jpg`, width: 1, height: 1 }));

describe("adaptive pipeline frame preparation", () => {
  it("reduces candidates while retaining anchors and a representative event", () => {
    const result = selectFramesForAnalysis(keyframes, { maxFrames: 5, changeThreshold: 0.5, safetyIntervalMs: 3_000, minFrames: 2 }, [0, 0, 0, 0, 0.9, 0, 0, 0, 0, 0]);
    expect(result.selected.map((frame) => frame.index)).toContain(0);
    expect(result.selected.map((frame) => frame.index)).toContain(4);
    expect(result.selected.map((frame) => frame.index)).toContain(9);
    expect(result.selected.length).toBeLessThan(keyframes.length);
  });
});
