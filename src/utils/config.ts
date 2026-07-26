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
  const apiKey = process.env[ENV_KEY_MAP[name]] || "";
  if (!apiKey) {
    return undefined;
  }
  return {
    name,
    model: process.env[ENV_MODEL_MAP[name]] || DEFAULT_MODELS[name],
    apiKey,
    maxRetries: parseInt(process.env[`${name.toUpperCase()}_MAX_RETRIES`] || "3", 10),
    timeoutMs: parseInt(process.env[`${name.toUpperCase()}_TIMEOUT_MS`] || "120000", 10),
  };
}

function isValidProvider(value: string): value is ProviderName {
  return ["gemini", "openai", "anthropic"].includes(value);
}

function booleanEnv(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined) return defaultValue;
  return value.toLowerCase() === "true";
}

export function loadConfig(): AppConfig {
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
    throw new ConfigError(
      "No provider API key configured. Set at least one of: GEMINI_API_KEY, OPENAI_API_KEY, ANTHROPIC_API_KEY",
    );
  }

  return {
    defaultProvider,
    fallbackProvider,
    maxKeyframes: parseInt(process.env.MAX_KEYFRAMES || "20", 10),
    keyframeIntervalSeconds: parseInt(process.env.KEYFRAME_INTERVAL_SECONDS || "2", 10),
    maxVideoSizeMB: parseInt(process.env.MAX_VIDEO_SIZE_MB || "150", 10),
    maxVideoDurationSeconds: parseInt(process.env.MAX_VIDEO_DURATION_SECONDS || "300", 10),
    logLevel: process.env.LOG_LEVEL || "info",
    gemini: {
      escalationModel: process.env.GEMINI_ESCALATION_MODEL || "gemini-3.5-flash",
      escalationEnabled: booleanEnv(process.env.GEMINI_ESCALATION_ENABLED, false),
      escalationConfidenceThreshold: parseFloat(process.env.GEMINI_ESCALATION_CONFIDENCE_THRESHOLD || "0.5"),
      escalationOnCritical: booleanEnv(process.env.GEMINI_ESCALATION_ON_CRITICAL, true),
      maxOutputTokens: parseInt(process.env.MAX_OUTPUT_TOKENS || "8192", 10),
      timeoutReduceFrames: booleanEnv(process.env.GEMINI_TIMEOUT_REDUCE_FRAMES, true),
    },
    frameSelection: {
      changeThreshold: parseFloat(process.env.FRAME_CHANGE_THRESHOLD || "0.15"),
      safetyIntervalMs: parseInt(process.env.FRAME_SAFETY_INTERVAL_MS || "3000", 10),
    },
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
