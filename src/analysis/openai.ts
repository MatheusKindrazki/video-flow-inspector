import OpenAI from "openai";
import {
  AnalysisProvider,
  AnalysisContext,
  ProviderAnalysisResult,
} from "./provider.js";
import {
  buildSystemPrompt,
  buildUserPrompt,
  buildOutputSchemaPrompt,
} from "./prompt-builder.js";
import { ProviderError, ProviderTimeoutError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";

export class OpenAIProvider implements AnalysisProvider {
  name = "openai";
  private client: OpenAI;
  private model: string;
  private maxRetries: number;
  private timeoutMs: number;

  constructor(
    apiKey: string,
    model: string = "gpt-4o",
    maxRetries = 3,
    timeoutMs = 120000
  ) {
    this.client = new OpenAI({ apiKey });
    this.model = model;
    this.maxRetries = maxRetries;
    this.timeoutMs = timeoutMs;
  }

  async analyze(context: AnalysisContext): Promise<ProviderAnalysisResult> {
    const systemPrompt = buildSystemPrompt();
    const userPrompt = buildUserPrompt(context);

    const contentParts: OpenAI.ChatCompletionContentPart[] = [
      { type: "text", text: userPrompt },
    ];

    for (const keyframe of context.keyframes) {
      if (!keyframe.base64) {
        logger.warn("Keyframe missing base64 data, skipping", {
          frame_index: keyframe.index,
          timestamp_ms: keyframe.timestamp_ms,
        });
        continue;
      }

      contentParts.push({
        type: "image_url",
        image_url: {
          url: `data:image/jpeg;base64,${keyframe.base64}`,
          detail: "low",
        },
      });
    }

    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        logger.info("OpenAI API call starting", {
          attempt,
          model: this.model,
          keyframe_count: context.keyframes.length,
        });

        const completion = await this.callWithTimeout(
          systemPrompt,
          contentParts,
          attempt
        );

        const rawText = completion.choices[0]?.message?.content ?? "";

        if (!rawText || rawText.trim().length === 0) {
          throw new ProviderError("OpenAI returned empty response", {
            attempt,
            model: this.model,
            finish_reason: completion.choices[0]?.finish_reason,
          });
        }

        logger.debug("OpenAI raw response received", {
          attempt,
          response_length: rawText.length,
          finish_reason: completion.choices[0]?.finish_reason,
        });

        const parsed = this.parseResponse(rawText);

        const usageStats = completion.usage
          ? {
              input_tokens: completion.usage.prompt_tokens,
              output_tokens: completion.usage.completion_tokens,
            }
          : undefined;

        logger.info("OpenAI analysis completed successfully", {
          attempt,
          model: this.model,
          timeline_events: parsed.timeline.length,
          issues_found: parsed.detected_issues.length,
          input_tokens: usageStats?.input_tokens,
          output_tokens: usageStats?.output_tokens,
        });

        return {
          raw: rawText,
          summary: parsed.summary,
          timeline: parsed.timeline,
          detected_issues: parsed.detected_issues,
          hypotheses: parsed.hypotheses,
          recommended_actions: parsed.recommended_actions,
          usage: usageStats,
        };
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        if (error instanceof ProviderTimeoutError) {
          logger.error("OpenAI API call timed out", {
            attempt,
            timeout_ms: this.timeoutMs,
          });
          if (attempt === this.maxRetries) {
            throw error;
          }
        } else {
          logger.error("OpenAI API call failed", {
            attempt,
            error: lastError.message,
          });
        }

        if (attempt < this.maxRetries) {
          const backoffMs = Math.min(1000 * Math.pow(2, attempt - 1), 16000);
          logger.info("Retrying OpenAI API call", {
            attempt: attempt + 1,
            backoff_ms: backoffMs,
          });
          await this.sleep(backoffMs);
        }
      }
    }

    throw new ProviderError(
      `OpenAI analysis failed after ${this.maxRetries} attempts: ${lastError?.message ?? "unknown error"}`,
      {
        provider: this.name,
        model: this.model,
        attempts: this.maxRetries,
      }
    );
  }

  private async callWithTimeout(
    systemPrompt: string,
    contentParts: OpenAI.ChatCompletionContentPart[],
    attempt: number
  ): Promise<OpenAI.ChatCompletion> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const completion = await this.client.chat.completions.create(
        {
          model: this.model,
          response_format: { type: "json_object" },
          temperature: 0.1,
          messages: [
            {
              role: "system",
              content: systemPrompt,
            },
            {
              role: "user",
              content: contentParts,
            },
          ],
        },
        { signal: controller.signal }
      );

      return completion;
    } catch (error) {
      if (
        error instanceof Error &&
        (error.name === "AbortError" || error.message.includes("abort"))
      ) {
        throw new ProviderTimeoutError(
          `OpenAI API call timed out after ${this.timeoutMs}ms`,
          {
            provider: this.name,
            model: this.model,
            timeout_ms: this.timeoutMs,
            attempt,
          }
        );
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private parseResponse(rawText: string): {
    summary: string;
    timeline: ProviderAnalysisResult["timeline"];
    detected_issues: ProviderAnalysisResult["detected_issues"];
    hypotheses: ProviderAnalysisResult["hypotheses"];
    recommended_actions: ProviderAnalysisResult["recommended_actions"];
  } {
    let text = rawText.trim();

    // Strip markdown code fences if present
    if (text.startsWith("```")) {
      const firstNewline = text.indexOf("\n");
      text = text.slice(firstNewline + 1);
      if (text.endsWith("```")) {
        text = text.slice(0, -3).trim();
      }
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(text);
    } catch {
      logger.error("Failed to parse OpenAI response as JSON", {
        response_preview: text.slice(0, 500),
      });
      throw new ProviderError("Failed to parse OpenAI response as JSON", {
        provider: this.name,
        response_preview: text.slice(0, 500),
      });
    }

    const summary =
      typeof parsed.summary === "string" && parsed.summary.length > 0
        ? parsed.summary
        : "Analysis completed but no summary was provided.";

    const timeline = Array.isArray(parsed.timeline)
      ? (parsed.timeline as ProviderAnalysisResult["timeline"])
      : [];

    const detected_issues = Array.isArray(parsed.detected_issues)
      ? (parsed.detected_issues as ProviderAnalysisResult["detected_issues"])
      : [];

    const hypotheses = Array.isArray(parsed.hypotheses)
      ? (parsed.hypotheses as ProviderAnalysisResult["hypotheses"])
      : [];

    const recommended_actions = Array.isArray(parsed.recommended_actions)
      ? (parsed.recommended_actions as ProviderAnalysisResult["recommended_actions"])
      : [];

    return {
      summary,
      timeline,
      detected_issues,
      hypotheses,
      recommended_actions,
    };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
