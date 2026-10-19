import { getConfig } from '../utils/config.js';
import { logger } from '../utils/logger.js';
import { ProviderError } from '../utils/errors.js';
import { GeminiProvider } from './gemini.js';
import { OpenAIProvider } from './openai.js';
import type { AnalysisProvider, AnalysisContext } from './provider.js';
import type { AppConfig, ProviderName } from '../types/index.js';
import { calculateCost, type CostBreakdown, type TokenUsage } from './pricing.js';
function createProvider(name: ProviderName, config: AppConfig): AnalysisProvider | null {
  const providerConfig = config.providers[name];
  if (!providerConfig || !providerConfig.apiKey) {
    logger.debug(`Provider "${name}" has no API key configured, skipping`, {
      provider: name,
    });
    return null;
  }
  switch (name) {
    case "gemini":
      return new GeminiProvider(providerConfig.apiKey, providerConfig.model, providerConfig.maxRetries, providerConfig.timeoutMs, {
        escalationModel: config.gemini.escalationModel,
        escalationEnabled: config.gemini.escalationEnabled,
        escalationConfidenceThreshold: config.gemini.escalationConfidenceThreshold,
        escalationOnCritical: config.gemini.escalationOnCritical,
        maxOutputTokens: config.gemini.maxOutputTokens,
        timeoutReduceFrames: config.gemini.timeoutReduceFrames,
      });
    case "openai":
      return new OpenAIProvider(providerConfig.apiKey, providerConfig.model, providerConfig.maxRetries, providerConfig.timeoutMs);
    case "anthropic":
      // Anthropic provider not yet implemented
      logger.warn("Anthropic provider is not yet implemented", {
        provider: name,
      });
      return null;
    default:
      logger.warn(`Unknown provider: "${name}"`, { provider: name });
      return null;
  }
}
export interface ProviderRunResult {
  providerName: string;
  model: string;
  result: {
    raw: string;
    output_warnings?: string[];
    findings?: unknown[];
    transcript?: unknown[];
    summary: string;
    timeline: unknown[];
    detected_issues: unknown[];
    hypotheses: unknown[];
    recommended_actions: unknown[];
    usage?: {
      input_tokens: number;
      output_tokens: number;
    };
    meta?: {
      retries: {
        attempts: number;
        json_repaired: boolean;
        frames_reduced: boolean;
      };
      escalation: {
        triggered: boolean;
        from_model?: string;
        to_model?: string;
        reason?: string;
        from_usage?: TokenUsage;
      };
    };
  };
}
export function calculateResultCost(model: string, result: Pick<ProviderRunResult["result"], "usage" | "meta">): {
  cost: CostBreakdown;
  usage?: TokenUsage;
} {
  const escalated = result.meta?.escalation;
  const currentCost = calculateCost(model, result.usage);
  if (!escalated?.triggered || !escalated.from_model || !escalated.from_usage)
    return { cost: currentCost, usage: result.usage };
  const firstCost = calculateCost(escalated.from_model, escalated.from_usage);
  const round = (value: number) => Math.round(value * 1000000000) / 1000000000;
  return {
    // Aggregate initial + final token usage so it stays coherent with the
    // combined cost. Only return summed usage when the final (escalation) usage
    // is actually present; otherwise omit usage rather than inventing tokens.
    usage: result.usage ? {
      input_tokens: escalated.from_usage.input_tokens + result.usage.input_tokens,
      output_tokens: escalated.from_usage.output_tokens + result.usage.output_tokens,
    } : undefined,
    cost: {
      input_tokens: firstCost.input_tokens + currentCost.input_tokens,
      output_tokens: firstCost.output_tokens + currentCost.output_tokens,
      input_cost_usd: round(firstCost.input_cost_usd + currentCost.input_cost_usd),
      output_cost_usd: round(firstCost.output_cost_usd + currentCost.output_cost_usd),
      total_cost_usd: round(firstCost.total_cost_usd + currentCost.total_cost_usd),
      pricing_source: firstCost.pricing_source === "confirmed" && currentCost.pricing_source === "confirmed" ? "confirmed" : "heuristic",
    },
  };
}
/**
 * Run analysis with primary provider, falling back to the fallback provider
 * if the primary fails.
 */
export async function runAnalysisWithFallback(context: AnalysisContext, config: AppConfig): Promise<ProviderRunResult> {
  // Try primary provider
  context.signal?.throwIfAborted();
  const primaryProvider = context.audio && config.defaultProvider !== "gemini" ? null : createProvider(config.defaultProvider, config);
  const primaryConfig = config.providers[config.defaultProvider];
  if (primaryProvider && primaryConfig) {
    try {
      logger.info("Running analysis with primary provider", {
        provider: config.defaultProvider,
        model: primaryConfig.model,
      });
      const result = await primaryProvider.analyze(context);
      return {
        providerName: config.defaultProvider,
        model: result.meta?.escalation.to_model ?? primaryConfig.model,
        result,
      };
    }
    catch (error) {
      context.signal?.throwIfAborted();
      if (error instanceof Error && error.message === "PROVIDER_CALL_BUDGET_EXCEEDED")
        throw error;
      const message = error instanceof Error ? error.message : String(error);
      logger.warn("Primary provider failed, attempting fallback", {
        primary_provider: config.defaultProvider,
        fallback_provider: config.fallbackProvider,
        error: "provider_request_failed",
      });
    }
  }
  else {
    logger.warn("Primary provider not available, attempting fallback", {
      primary_provider: config.defaultProvider,
      fallback_provider: config.fallbackProvider,
    });
  }
  // Try fallback provider (only if different from primary)
  if (config.fallbackProvider !== config.defaultProvider && (!context.audio || config.fallbackProvider === "gemini")) {
    const fallbackProvider = createProvider(config.fallbackProvider, config);
    const fallbackConfig = config.providers[config.fallbackProvider];
    if (fallbackProvider && fallbackConfig) {
      try {
        logger.info("Running analysis with fallback provider", {
          provider: config.fallbackProvider,
          model: fallbackConfig.model,
        });
        const result = await fallbackProvider.analyze(context);
        return {
          providerName: config.fallbackProvider,
          model: result.meta?.escalation.to_model ?? fallbackConfig.model,
          result,
        };
      }
      catch (error) {
        context.signal?.throwIfAborted();
        if (error instanceof Error && error.message === "PROVIDER_CALL_BUDGET_EXCEEDED")
          throw error;
        const message = error instanceof Error ? error.message : String(error);
        logger.error("Fallback provider also failed", {
          fallback_provider: config.fallbackProvider,
          error: "provider_request_failed",
        });
        throw new ProviderError(`Both primary (${config.defaultProvider}) and fallback (${config.fallbackProvider}) providers failed. Last request failed.`, {
          primary_provider: config.defaultProvider,
          fallback_provider: config.fallbackProvider,
        });
      }
    }
  }
  // No providers available at all
  throw new ProviderError("No analysis provider available. Ensure at least one provider API key is configured.", {
    default_provider: config.defaultProvider,
    fallback_provider: config.fallbackProvider,
    configured_providers: Object.entries(config.providers)
      .filter(([, cfg]) => cfg !== undefined)
      .map(([name]) => name),
  });
}
