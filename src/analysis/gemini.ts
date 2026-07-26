import { GoogleGenerativeAI, type Part, type GenerateContentResult } from "@google/generative-ai";
import { type AnalysisProvider, type AnalysisContext, type ProviderAnalysisResult } from "./provider.js";
import { buildSystemPrompt, buildUserPrompt } from "./prompt-builder.js";
import { repairJson } from "./json-repair.js";
import { ProviderError, ProviderTimeoutError } from "../utils/errors.js";

type GeminiClient = { getGenerativeModel(options: Record<string, unknown>): { generateContent(request: unknown, options?: unknown): Promise<GenerateContentResult> } };
export interface GeminiProviderOptions {
  client?: GeminiClient;
  escalationModel?: string;
  escalationEnabled?: boolean;
  escalationConfidenceThreshold?: number;
  escalationOnCritical?: boolean;
  maxOutputTokens?: number;
  timeoutReduceFrames?: boolean;
  retryDelayMs?: number;
}

type Parsed = Pick<ProviderAnalysisResult, "summary" | "timeline" | "detected_issues" | "hypotheses" | "recommended_actions">;
type ModelAnalysis = { raw: string; parsed: Parsed; usage?: ProviderAnalysisResult["usage"]; attempts: number; repaired: boolean; reduced: boolean };

class GeminiParseFailureError extends ProviderError {
  constructor(readonly analysis: Omit<ModelAnalysis, "parsed">) {
    super("Failed to parse Gemini response as JSON", { provider: "gemini" });
  }
}

export class GeminiProvider implements AnalysisProvider {
  name = "gemini";
  private client: GeminiClient;
  private options: Required<Omit<GeminiProviderOptions, "client">>;

  constructor(private apiKey: string, private model = "gemini-2.5-flash-lite", private maxRetries = 3, private timeoutMs = 120000, options: GeminiProviderOptions = {}) {
    this.client = options.client ?? (new GoogleGenerativeAI(apiKey) as unknown as GeminiClient);
    this.options = {
      escalationModel: options.escalationModel ?? "gemini-2.5-flash",
      escalationEnabled: options.escalationEnabled ?? false,
      escalationConfidenceThreshold: options.escalationConfidenceThreshold ?? 0.5,
      escalationOnCritical: options.escalationOnCritical ?? true,
      maxOutputTokens: options.maxOutputTokens ?? 8192,
      timeoutReduceFrames: options.timeoutReduceFrames ?? true,
      retryDelayMs: options.retryDelayMs ?? 1000,
    };
  }

  async analyze(context: AnalysisContext): Promise<ProviderAnalysisResult> {
    let first: ModelAnalysis;
    try {
      first = await this.analyzeModel(context, this.model);
    } catch (error) {
      if (this.options.escalationEnabled && this.model !== this.options.escalationModel && error instanceof GeminiParseFailureError) {
        const escalated = await this.analyzeModel(context, this.options.escalationModel);
        return this.toResult(escalated, { triggered: true, from_model: this.model, to_model: this.options.escalationModel, reason: "ambiguous_response" }, error.analysis);
      }
      throw error;
    }
    const reason = this.escalationReason(first.parsed);
    if (this.options.escalationEnabled && reason && this.model !== this.options.escalationModel) {
      const escalated = await this.analyzeModel(context, this.options.escalationModel);
      return this.toResult(escalated, { triggered: true, from_model: this.model, to_model: this.options.escalationModel, reason }, first);
    }
    return this.toResult(first, { triggered: false });
  }

  private async analyzeModel(context: AnalysisContext, model: string): Promise<ModelAnalysis> {
    const systemPrompt = buildSystemPrompt();
    let frames = context.keyframes;
    let repaired = false;
    let reduced = false;
    let lastError: Error | undefined;
    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      const parts: Part[] = [{ text: buildUserPrompt({ ...context, keyframes: frames }) }];
      for (const frame of frames) if (frame.base64) parts.push({ inlineData: { mimeType: "image/jpeg", data: frame.base64 } });
      try {
        const result = await this.callWithTimeout(model, systemPrompt, parts, attempt);
        const raw = result.response.text();
        const usageMetadata = result.response.usageMetadata;
        const usage = usageMetadata ? { input_tokens: usageMetadata.promptTokenCount ?? 0, output_tokens: usageMetadata.candidatesTokenCount ?? 0 } : undefined;
        let parsedResult: { parsed: Parsed; repaired: boolean };
        try {
          parsedResult = this.parseResponse(raw);
        } catch (error) {
          if (error instanceof ProviderError && error.message === "Failed to parse Gemini response as JSON") {
            throw new GeminiParseFailureError({ raw, usage, attempts: attempt, repaired, reduced });
          }
          throw error;
        }
        repaired ||= parsedResult.repaired;
        return { raw, parsed: parsedResult.parsed, usage, attempts: attempt, repaired, reduced };
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        const parseFailure = lastError instanceof ProviderError && lastError.message === "Failed to parse Gemini response as JSON";
        if (!(this.isTransient(lastError) || parseFailure) || attempt === this.maxRetries) throw lastError;
        if (lastError instanceof ProviderTimeoutError && this.options.timeoutReduceFrames && frames.length > 2) {
          frames = frames.filter((_, index) => index === 0 || index === frames.length - 1 || index % 2 === 0);
          reduced = true;
        }
        if (this.options.retryDelayMs) await new Promise((resolve) => setTimeout(resolve, Math.min(this.options.retryDelayMs * 2 ** (attempt - 1), 16000)));
      }
    }
    throw lastError ?? new ProviderError("Gemini analysis failed");
  }

  private async callWithTimeout(model: string, systemPrompt: string, parts: Part[], attempt: number): Promise<GenerateContentResult> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.client.getGenerativeModel({ model, systemInstruction: systemPrompt, generationConfig: { responseMimeType: "application/json", temperature: 0.1, maxOutputTokens: this.options.maxOutputTokens } }).generateContent({ contents: [{ role: "user", parts }] }, { signal: controller.signal });
    } catch (error) {
      if (error instanceof Error && (error.name === "AbortError" || error.message.toLowerCase().includes("abort"))) throw new ProviderTimeoutError(`Gemini API call timed out after ${this.timeoutMs}ms`, { provider: this.name, model, attempt });
      throw error;
    } finally { clearTimeout(timeoutId); }
  }

  private parseResponse(raw: string): { parsed: Parsed; repaired: boolean } {
    let parsed: Record<string, unknown> | null;
    let repaired = false;
    try { parsed = JSON.parse(raw) as Record<string, unknown>; } catch { parsed = repairJson(raw); repaired = true; }
    if (!parsed) throw new ProviderError("Failed to parse Gemini response as JSON", { provider: this.name });
    return { repaired, parsed: {
      summary: typeof parsed.summary === "string" && parsed.summary ? parsed.summary : "Analysis completed but no summary was provided.",
      timeline: Array.isArray(parsed.timeline) ? parsed.timeline as ProviderAnalysisResult["timeline"] : [],
      detected_issues: Array.isArray(parsed.detected_issues) ? parsed.detected_issues as ProviderAnalysisResult["detected_issues"] : [],
      hypotheses: Array.isArray(parsed.hypotheses) ? parsed.hypotheses as ProviderAnalysisResult["hypotheses"] : [],
      recommended_actions: Array.isArray(parsed.recommended_actions) ? parsed.recommended_actions as ProviderAnalysisResult["recommended_actions"] : [],
    } };
  }

  private escalationReason(parsed: Parsed): string | undefined {
    if (this.options.escalationOnCritical && parsed.detected_issues.some((issue) => issue.severity === "critical" || issue.severity === "major")) return "critical_or_major_issue";
    const confidences = parsed.hypotheses.map((hypothesis) => hypothesis.confidence).filter((value) => Number.isFinite(value));
    if (confidences.length && Math.max(...confidences) < this.options.escalationConfidenceThreshold) return "low_confidence";
    return undefined;
  }

  private isTransient(error: Error): boolean {
    if (error instanceof ProviderTimeoutError) return true;
    const status = (error as Error & { status?: number; statusCode?: number }).status ?? (error as Error & { statusCode?: number }).statusCode;
    if (typeof status === "number") return status === 429 || status >= 500;
    return /network|fetch|socket|econn|rate.?limit|timeout/i.test(error.message);
  }

  private toResult(result: ModelAnalysis, escalation: { triggered: boolean; from_model?: string; to_model?: string; reason?: string }, first?: Omit<ModelAnalysis, "parsed"> | ModelAnalysis): ProviderAnalysisResult {
    const retries = first ? {
      attempts: first.attempts + result.attempts,
      json_repaired: first.repaired || result.repaired,
      frames_reduced: first.reduced || result.reduced,
    } : { attempts: result.attempts, json_repaired: result.repaired, frames_reduced: result.reduced };
    return { raw: result.raw, ...result.parsed, usage: result.usage, meta: { retries, escalation: first ? { ...escalation, from_usage: first.usage } : escalation } };
  }
}
