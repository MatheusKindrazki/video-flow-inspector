import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/utils/config.js";

const original = { ...process.env };
beforeEach(() => { delete process.env.GEMINI_MODEL; });
afterEach(() => { process.env = { ...original }; });

describe("loadConfig adaptive pipeline settings", () => {
  it("parses Gemini escalation, output, timeout, and frame selection options", () => {
    process.env.GEMINI_API_KEY = "test";
    process.env.GEMINI_ESCALATION_ENABLED = "true";
    process.env.GEMINI_ESCALATION_MODEL = "gemini-2.5-flash";
    process.env.GEMINI_ESCALATION_CONFIDENCE_THRESHOLD = "0.7";
    process.env.GEMINI_ESCALATION_ON_CRITICAL = "false";
    process.env.MAX_OUTPUT_TOKENS = "4096";
    process.env.GEMINI_TIMEOUT_REDUCE_FRAMES = "false";
    process.env.FRAME_CHANGE_THRESHOLD = "0.25";
    process.env.FRAME_SAFETY_INTERVAL_MS = "2500";
    const config = loadConfig();
    expect(config.providers.gemini?.model).toBe("gemini-2.5-flash-lite");
    expect(config.gemini).toMatchObject({ escalationEnabled: true, escalationModel: "gemini-2.5-flash", escalationConfidenceThreshold: 0.7, escalationOnCritical: false, maxOutputTokens: 4096, timeoutReduceFrames: false });
    expect(config.frameSelection).toEqual({ changeThreshold: 0.25, safetyIntervalMs: 2500 });
  });
});
