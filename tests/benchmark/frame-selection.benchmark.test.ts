import { describe, expect, it } from "vitest";
import { selectKeyframes } from "../../src/preprocessing/frame-selector.js";

describe("frame selection benchmark", () => {
  it("reduces synthetic candidates while covering events", () => {
    const events = [12_000, 45_000, 78_000];
    const frames = Array.from({ length: 91 }, (_, index) => ({ index, timestamp_ms: index * 1_000, changeScore: events.includes(index * 1_000) ? 0.9 : 0.01 }));
    const result = selectKeyframes(frames, { maxFrames: 24, changeThreshold: 0.5, safetyIntervalMs: 5_000, minFrames: 2 });
    const covered = events.filter((event) => result.selected.some((frame) => Math.abs(frame.timestamp_ms - event) <= 5_000));
    const reduction = 1 - result.selected.length / frames.length;
    console.info(`frame-selection benchmark: candidates=${frames.length} selected=${result.selected.length} reduction=${(reduction * 100).toFixed(1)}% events=${covered.length}/${events.length}`);
    expect(result.selected.length).toBeLessThanOrEqual(frames.length * 0.4);
    expect(covered).toHaveLength(events.length);
    expect(result.selected[0].index).toBe(0);
    expect(result.selected.at(-1)?.index).toBe(90);
  });
});
