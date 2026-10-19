import type { AppConfig, ProviderConfig, ProviderName } from "../types/index.js";
import { ConfigError } from "./errors.js";
const DEFAULT_MODELS: Record<ProviderName, string> = {
  gemini: "gemini-3.1-flash-lite",
  openai: "gpt-4o",
  anthropic: "claude-sonnet-4-6-20250514",
};
const ENV_KEY_MAP: Record<ProviderName, string> = {
  gemini: "GEMINI_API_KEY",
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
};
const ENV_MODEL_MAP: Record<ProviderName, string> = {
  gemini: "GEMINI_MODEL",
  openai: "OPENAI_MODEL",
  anthropic: "ANTHROPIC_MODEL",
};
function buildProviderConfig(name: ProviderName): ProviderConfig | undefined {
  const apiKey = name === "gemini" && process.env.GEMINI_BACKEND === "vertex" ? process.env.VERTEX_API_KEY || "" : process.env[ENV_KEY_MAP[name]] || "";
  if (!apiKey) {
    return undefined;
  }
  return {
    name,
    model: process.env[ENV_MODEL_MAP[name]] || DEFAULT_MODELS[name],
    apiKey,
    maxRetries: boundedEnv(`${name.toUpperCase()}_MAX_RETRIES`,3,1,5),
    timeoutMs: boundedEnv(`${name.toUpperCase()}_TIMEOUT_MS`,120000,100,300000),
  };
}
function isValidProvider(value: string): value is ProviderName {
  return ["gemini", "openai", "anthropic"].includes(value);
}
function booleanEnv(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined)
    return defaultValue;
  return value.toLowerCase() === "true";
}
function boundedEnv(name: string, fallback: number, min: number, max: number): number { const value = Number(process.env[name] ?? fallback); if (!Number.isFinite(value) || value < min || value > max || !Number.isInteger(value))
  throw new ConfigError(`Invalid ${name}: expected an integer from ${min} to ${max}`); return value; }
export function loadConfig(): AppConfig {
  const backend=process.env.GEMINI_BACKEND??"gemini";
  if(backend!=="gemini"&&backend!=="vertex")throw new ConfigError("GEMINI_BACKEND must be gemini or vertex");
  const defaultProvider = process.env.DEFAULT_PROVIDER || "gemini";
  const fallbackProvider = process.env.FALLBACK_PROVIDER || "openai";
  if (!isValidProvider(defaultProvider)) {
    throw new ConfigError(`Invalid DEFAULT_PROVIDER: "${defaultProvider}". Must be one of: gemini, openai, anthropic`, {
      provided: defaultProvider,
    });
  }
  if (!isValidProvider(fallbackProvider)) {
    throw new ConfigError(`Invalid FALLBACK_PROVIDER: "${fallbackProvider}". Must be one of: gemini, openai, anthropic`, {
      provided: fallbackProvider,
    });
  }
  const providers: Record<ProviderName, ProviderConfig | undefined> = {
    gemini: buildProviderConfig("gemini"),
    openai: buildProviderConfig("openai"),
    anthropic: buildProviderConfig("anthropic"),
  };
  const hasAtLeastOneKey = Object.values(providers).some((p) => p !== undefined);
  if (!hasAtLeastOneKey) {
    throw new ConfigError("No provider API key configured. Set GEMINI_API_KEY, or GEMINI_BACKEND=vertex with VERTEX_API_KEY, or OPENAI_API_KEY");
  }
  return {
    defaultProvider,
    fallbackProvider,
    maxKeyframes: boundedEnv("MAX_KEYFRAMES", 20, 4, 80),
    keyframeIntervalSeconds: boundedEnv("KEYFRAME_INTERVAL_SECONDS",2,1,10),
    maxVideoSizeMB: boundedEnv("MAX_VIDEO_SIZE_MB", 150, 1, 1024),
    maxVideoDurationSeconds: boundedEnv("MAX_VIDEO_DURATION_SECONDS", 600, 1, 600),
    logLevel: process.env.LOG_LEVEL || "info",
    gemini: {
      backend,
      escalationModel: process.env.GEMINI_ESCALATION_MODEL || "gemini-3.5-flash",
      escalationEnabled: booleanEnv(process.env.GEMINI_ESCALATION_ENABLED, false),
      escalationConfidenceThreshold: parseFloat(process.env.GEMINI_ESCALATION_CONFIDENCE_THRESHOLD || "0.5"),
      escalationOnCritical: booleanEnv(process.env.GEMINI_ESCALATION_ON_CRITICAL, true),
      maxOutputTokens: boundedEnv("MAX_OUTPUT_TOKENS",8192,256,32768),
      timeoutReduceFrames: booleanEnv(process.env.GEMINI_TIMEOUT_REDUCE_FRAMES, true),
    },
    frameSelection: {
      changeThreshold: parseFloat(process.env.FRAME_CHANGE_THRESHOLD || "0.15"),
      safetyIntervalMs: boundedEnv("FRAME_SAFETY_INTERVAL_MS",3000,100,60000),
    },
    session: { segmentSeconds: boundedEnv("SEGMENT_SECONDS", 60, 10, 120), overlapSeconds: boundedEnv("SEGMENT_OVERLAP_SECONDS", 2, 0, 5), concurrency: boundedEnv("SEGMENT_CONCURRENCY", 2, 1, 4), maxRefinements: boundedEnv("MAX_REFINEMENTS", 2, 0, 4), maxProviderCalls: boundedEnv("MAX_PROVIDER_CALLS", 32, 1, 100), deadlineMs: boundedEnv("ANALYSIS_DEADLINE_MS", 900000, 1000, 1800000) },
    providers,
  };
}
let cachedConfig: AppConfig | null = null;
export function getConfig(): AppConfig {
  if (!cachedConfig) {
    cachedConfig = loadConfig();
  }
  return cachedConfig;
}
