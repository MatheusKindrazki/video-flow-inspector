import { mkdir } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { createTempDir } from '../utils/temp-files.js';
import { getConfig } from '../utils/config.js';
import { resolveVideoSource } from '../ingestion/validator.js';
import { extractVideoMetadata, checkFfmpegAvailable } from '../preprocessing/metadata.js';
import { extractKeyframes, computeKeyframeChangeScores, loadKeyframesAsBase64 } from '../preprocessing/keyframe-extractor.js';
import { extractAudioSegment } from '../preprocessing/audio.js';
import { selectKeyframes, type FrameSelectionOptions } from '../preprocessing/frame-selector.js';
import { runAnalysisWithFallback, calculateResultCost, type ProviderRunResult } from '../analysis/router.js';
import { normalizeProviderOutput } from '../normalizer/semantic.js';
import { generateRecommendation } from '../recommender/actions.js';
import { validateSegmentEvidence, mergeFindings, type Finding, type Transcript } from '../analysis/evidence.js';
import { planSegments, mapConcurrent, type Segment } from './segments.js';
import type { AnalyzeVideoFlowInput } from '../schemas/input.js';
import type { AnalysisContext, Keyframe } from '../analysis/provider.js';
import type { AppConfig } from '../types/index.js';
import { VideoFlowError } from '../utils/errors.js';
export { calculateResultCost };
export function selectFramesForAnalysis(keyframes: Keyframe[], options: FrameSelectionOptions, changeScores: number[]) { return selectKeyframes(keyframes.map((k, i) => ({ index: k.index, timestamp_ms: k.timestamp_ms, changeScore: changeScores[i] ?? 0 })), options); }
export interface AnalysisRunOptions {
  signal?: AbortSignal;
  onProgress?: (progress: Record<string, unknown>) => void;
}
/** Injectable I/O seams allow deterministic orchestration tests without paid calls. */
export interface PipelineDependencies {
  config: () => AppConfig;
  checkMedia: typeof checkFfmpegAvailable;
  source: typeof resolveVideoSource;
  metadata: typeof extractVideoMetadata;
  frames: typeof extractKeyframes;
  audio: typeof extractAudioSegment;
  analyze: (context: AnalysisContext, config: AppConfig) => Promise<ProviderRunResult>;
}
const defaults: PipelineDependencies = { config: getConfig, checkMedia: checkFfmpegAvailable, source: resolveVideoSource, metadata: extractVideoMetadata, frames: extractKeyframes, audio: extractAudioSegment, analyze: runAnalysisWithFallback };
interface SegmentResult {
  segment: Segment;
  status: 'completed' | 'failed';
  audio_status: 'analyzed' | 'absent' | 'ignored' | 'failed';
  frames: Keyframe[];
  candidates: number;
  findings: Finding[];
  transcript: Transcript[];
  warnings: string[];
  normalized?: ReturnType<typeof normalizeProviderOutput>;
  provider?: ProviderRunResult;
  duration_ms: number;
}
export async function analyzeVideoFlow(input: Partial<AnalyzeVideoFlowInput> & {
  goal: string;
}, options: AnalysisRunOptions = {}, dependencies: Partial<PipelineDependencies> = {}) {
  const d = { ...defaults, ...dependencies };
  const config = d.config();
  const started = Date.now();
  const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(config.session.deadlineMs)]) : AbortSignal.timeout(config.session.deadlineMs);
  signal.throwIfAborted();
  if (!await d.checkMedia(signal))
    throw new VideoFlowError('Install ffmpeg and ffprobe before analyzing media', 'FFMPEG_NOT_FOUND');
  const temporary = await createTempDir('video-flow-');
  let calls = 0;
  let completed = 0;
  const progress = (phase: string, extra: Record<string, unknown> = {}) => { options.onProgress?.({ phase, elapsed_ms: Date.now() - started, provider_calls: calls, ...extra }); };
  try {
    progress('ingestion');
    const source = await d.source(input, temporary.path, config.maxVideoSizeMB, signal);
    const metadata = await d.metadata(source.filePath, signal);
    if (!Number.isFinite(metadata.duration_ms) || metadata.duration_ms <= 0 || metadata.duration_ms > config.maxVideoDurationSeconds * 1000)
      throw new VideoFlowError('Video duration must be positive and within the configured limit (at most 600 seconds)', 'VIDEO_TOO_LONG');
    const audioMode = input.audio_mode ?? 'auto';
    const useAudio = metadata.has_audio && audioMode !== 'ignore';
    if (audioMode === 'required' && !metadata.has_audio)
      throw new VideoFlowError('This recording has no audio stream', 'AUDIO_REQUIRED');
    if (useAudio && !(['gemini'] as const).some(name => config.providers[name] && (config.defaultProvider === name || config.fallbackProvider === name)))
      throw new VideoFlowError('Audio analysis requires Gemini as configured primary or fallback. Set audio_mode=ignore only if you explicitly want visual-only analysis', 'AUDIO_PROVIDER_UNAVAILABLE');
    const hash = createHash('sha256');
    for await (const bytes of createReadStream(source.filePath)) {
      signal.throwIfAborted();
      hash.update(bytes);
    }
    const sourceHash = hash.digest('hex');
    const segments = planSegments(metadata.duration_ms, config.session.segmentSeconds * 1000, config.session.overlapSeconds * 1000);
    progress('analysis', { segments_total: segments.length, segments_completed: 0 });
    const reserveCall = () => { signal.throwIfAborted(); if (calls >= config.session.maxProviderCalls)
      throw new Error('PROVIDER_CALL_BUDGET_EXCEEDED'); calls++; };
    const runSegment = async (segment: Segment, refinement = false): Promise<SegmentResult> => {
      const begin = Date.now();
      const folder = temporary.filePath(segment.id);
      await mkdir(folder, { recursive: true });
      const base: SegmentResult = { segment, status: 'failed', audio_status: useAudio ? 'failed' : metadata.has_audio ? 'ignored' : 'absent', frames: [], candidates: 0, findings: [], transcript: [], warnings: [], duration_ms: 0 };
      try {
        signal.throwIfAborted();
        const parts = await Promise.allSettled([
          d.frames(source.filePath, segment.end_ms - segment.start_ms, { intervalSeconds: refinement ? .15 : Math.max(.25,config.keyframeIntervalSeconds/4), maxFrames: config.maxKeyframes * 8, outputDir: folder, startMs: segment.start_ms, width: Math.min(metadata.width, refinement ? 1600 : 800), signal }),
          useAudio ? d.audio(source.filePath, segment, `${folder}/audio.mp3`, signal) : Promise.resolve(undefined),
        ]);
        signal.throwIfAborted();
        if (parts[0].status === 'rejected')
          throw new Error('FRAME_EXTRACTION_FAILED');
        const candidates = parts[0].value;
        const scores = await computeKeyframeChangeScores(candidates);
        const selection = selectFramesForAnalysis(candidates, { maxFrames: config.maxKeyframes, changeThreshold: config.frameSelection.changeThreshold, safetyIntervalMs: refinement ? 200 : config.frameSelection.safetyIntervalMs, minFrames: Math.min(4, config.maxKeyframes) }, scores);
        const chosen = new Set(selection.selected.map(f => f.index));
        // Each segment has a stable disjoint frame-index range, including refinement segments.
        const segmentNumber = Number(segment.id.slice(1)) + (refinement ? 1000 : 0);
        const frames = await loadKeyframesAsBase64(candidates.filter(f => chosen.has(f.index)).map(f => ({ ...f, index: segmentNumber * 10000 + f.index })));
        base.frames = frames;
        base.candidates = candidates.length;
        let audio = parts[1].status === 'fulfilled' ? parts[1].value : undefined;
        if (parts[1].status === 'rejected') {
          if (audioMode === 'required')
            throw new Error('AUDIO_EXTRACTION_FAILED');
          base.warnings.push(`${segment.id}: audio extraction failed; segment analyzed visually only`);
        }
        base.audio_status = audio ? 'analyzed' : base.audio_status;
        const context: AnalysisContext = { ...input, analysis_mode: input.analysis_mode ?? 'combined', keyframes: frames, video_duration_ms: metadata.duration_ms, segment, audio, signal, reserveCall };
        const provider = await d.analyze(context, config);
        base.provider = provider;
        const evidence = validateSegmentEvidence(provider.result, { segment, keyframes: frames, hasAudio: !!audio });
        base.findings = evidence.findings.filter(f => (input.analysis_mode ?? 'combined') === 'combined' || f.category === input.analysis_mode);
        base.transcript = evidence.transcript;
        base.warnings.push(...evidence.warnings, ...(provider.result.output_warnings ?? []).map(w => `${segment.id}: ${w}`));
        if (provider.result.detected_issues.length && !base.findings.length)
          base.warnings.push(`${segment.id}: legacy issues could not be promoted to evidence-validated findings`);
        if (audio && !evidence.transcript.length)
          base.warnings.push(`${segment.id}: no intelligible speech returned; speech recognition completeness is unverified`);
        if (!provider.result.findings)
          base.warnings.push(`${segment.id}: provider omitted structured findings; legacy issues are not evidence-verified findings`);
        const normalized = normalizeProviderOutput(provider.result);
        const originalTimeline = normalized.timeline.length;
        normalized.timeline = normalized.timeline.filter(event => Number.isInteger(event.frame_index) && frames.some(f => f.index === event.frame_index && Math.abs(f.timestamp_ms - event.timestamp_ms) <= 2000));
        if (normalized.timeline.length !== originalTimeline)
          base.warnings.push(`${segment.id}: unsupported timeline references discarded`);
        const dropped = (provider.result.timeline.length + provider.result.detected_issues.length + provider.result.hypotheses.length + provider.result.recommended_actions.length) - (normalized.timeline.length + normalized.detected_issues.length + normalized.hypotheses.length + normalized.recommended_actions.length);
        if (dropped > 0)
          base.warnings.push(`${segment.id}: ${dropped} provider entries failed normalization or evidence checks`);
        base.normalized = normalized;
        base.status = 'completed';
      }
      catch (error) {
        signal.throwIfAborted();
        if (error instanceof Error && error.message === "PROVIDER_CALL_BUDGET_EXCEEDED")
          base.warnings.push(`${segment.id}: provider call budget exhausted`);
        base.warnings.push(`${segment.id}: segment failed; no conclusion is available for this interval`);
      }
      base.duration_ms = Date.now() - begin;
      completed++;
      progress(refinement ? 'refinement' : 'analysis', { segments_total: segments.length, segments_completed: Math.min(completed, segments.length), last_segment: segment.id, last_segment_status: base.status, partial_findings: base.findings.length });
      return base;
    };
    const results = await mapConcurrent(segments, config.session.concurrency, segment => runSegment(segment), signal);
    if (results.every(r => r.status === 'failed'))
      throw new VideoFlowError('All segments failed. Check media extraction, provider model access, and audio capability', 'ANALYSIS_FAILED');
    const initialFindings = mergeFindings(results.flatMap(r => r.findings));
    const refineTargets = initialFindings.filter(f => f.basis === 'hypothesis' || f.severity === 'critical' || f.severity === 'major').filter((f, i, a) => a.findIndex(x => Math.abs(x.timestamp_ms - f.timestamp_ms) < 5000) === i).slice(0, config.session.maxRefinements);
    const refinements = refineTargets.map((f, i) => ({ id: `R${i + 1}`, start_ms: Math.max(0, f.timestamp_ms - 2500), end_ms: Math.min(metadata.duration_ms, f.timestamp_ms + 2500) }));
    if (calls < config.session.maxProviderCalls)
      results.push(...await mapConcurrent(refinements, config.session.concurrency, s => runSegment(s, true), signal));
    const findings = mergeFindings(results.flatMap(r => r.findings));
    const warnings = [...new Set(results.flatMap(r => r.warnings))];
    const timeline = results.flatMap(r => r.normalized?.timeline ?? []).sort((a, b) => a.timestamp_ms - b.timestamp_ms).filter((e, i, a) => !a.slice(0, i).some(p => p.action === e.action && p.description === e.description && Math.abs(p.timestamp_ms - e.timestamp_ms) < 2000));
    const issues = findings.filter(f => f.category === 'bug' && f.basis !== 'hypothesis').map(f => ({ id: f.id, severity: f.severity, type: 'unknown' as const, title: f.title, description: f.description, timestamp_ms: f.timestamp_ms, frame_index: f.evidence_refs.find(r => r.kind === 'frame')?.frame_index, actual_behavior: f.description, evidence: JSON.stringify(f.evidence_refs) }));
    const hypotheses = findings.filter(f => f.basis === 'hypothesis').map(f => ({ id: f.id, description: f.description, confidence: 0, supporting_evidence: f.evidence_refs.map(r => JSON.stringify(r)), suggested_investigation: f.recommendation, status: 'unverified' as const, confidence_status: 'not_calibrated' as const }));
    const actions = findings.map((f, i) => ({ id: `ACTION-${i + 1}`, priority: i + 1, action: f.recommendation, rationale: `${f.title}. Evidence: ${JSON.stringify(f.evidence_refs)}`, type: 'investigate' as const, finding_id: f.id }));
    const summary = `${results.filter(r => r.status === 'completed' && r.segment.id.startsWith('S')).length}/${segments.length} recording segments analyzed. ${findings.length} evidence-linked findings (${findings.filter(f => f.category === 'bug').length} bug, ${findings.filter(f => f.category === 'usability').length} usability). ${findings.slice(0, 3).map(f => f.title).join('; ')}${warnings.length ? ' Analysis limitations are listed in quality.warnings.' : ''}`;
    const legacy = generateRecommendation({ summary, timeline, detected_issues: issues, hypotheses, recommended_actions: actions });
    if (!actions.length)
      actions.push({ ...legacy.next_best_action, type: 'investigate', finding_id: '' });
    const costs = results.filter(r => r.provider).map(r => ({ segment_id: r.segment.id, provider: r.provider!.providerName, model: r.provider!.model, ...calculateResultCost(r.provider!.model, r.provider!.result), retries: r.provider!.result.meta?.retries, escalation: r.provider!.result.meta?.escalation }));
    const totalCost = costs.reduce((n, c) => n + c.cost.total_cost_usd, 0);
    const allFrames = results.flatMap(r => r.frames.map(f => ({ index: f.index, timestamp_ms: f.timestamp_ms, segment_id: r.segment.id, width: f.width, height: f.height })));
    const sortedTimes = [...new Set(results.filter(r => r.segment.id.startsWith('S')).flatMap(r => r.frames.map(f => f.timestamp_ms)))].sort((a, b) => a - b);
    const gaps = [sortedTimes[0] ?? metadata.duration_ms, ...sortedTimes.slice(1).map((t, i) => t - sortedTimes[i]), metadata.duration_ms - (sortedTimes.at(-1) ?? 0)];
    progress('completed', { segments_total: segments.length, segments_completed: results.filter(r => r.segment.id.startsWith('S') && r.status === 'completed').length, findings: findings.length });
    return { summary, timeline, detected_issues: issues, hypotheses, recommended_actions: actions, next_best_action: actions[0], confidence: legacy.confidence,
      findings, transcript: results.flatMap(r => r.transcript).sort((a, b) => a.start_ms - b.start_ms),
      segment_summaries: results.map(r => ({ segment: r.segment, status: r.status, audio_status: r.audio_status, summary: r.normalized?.summary ?? null })),
      evidence_catalog: { source_sha256: sourceHash, frames: allFrames },
      quality: { complete: results.every(r => r.status === 'completed') && !results.some(r => r.audio_status === 'failed') && warnings.length === 0, warnings, confidence_status: 'not_calibrated', limitations: ['Screen states are sampled, not continuous click/DOM/backend telemetry.', 'Transcript is model-generated, not human-verified.', 'No findings does not establish absence of problems.', 'Legacy numeric confidence and hypothesis confidence are not calibrated probabilities.', 'Global task completion and root causes require independent verification.'] },
      metadata: { provider: [...new Set(costs.map(c => c.provider))].join(','), model: [...new Set(costs.map(c => c.model))].join(','), video_duration_ms: metadata.duration_ms, keyframes_analyzed: allFrames.length, analysis_duration_ms: Date.now() - started, cost_estimate_usd: totalCost,
        frames: { candidates: results.reduce((n, r) => n + r.candidates, 0), analyzed: allFrames.length, discarded: results.reduce((n, r) => n + r.candidates - r.frames.length, 0), selection_strategy: 'balanced-segmented-pixel-difference', max_sample_gap_ms: Math.max(...gaps) },
        usage: costs.every(c => c.usage) ? { input_tokens: costs.reduce((n, c) => n + c.usage!.input_tokens, 0), output_tokens: costs.reduce((n, c) => n + c.usage!.output_tokens, 0) } : undefined,
        cost: { total_cost_usd: totalCost, pricing_source: useAudio ? 'heuristic' : costs.every(c => c.cost.pricing_source === 'confirmed') ? 'confirmed' : 'heuristic', scope: 'successful provider results only; failed attempts may incur additional cost; configured rates are not live-verified' },
        segments: segments.length, refinements: results.filter(r => r.segment.id.startsWith('R')).length, provider_calls: calls, max_provider_calls: config.session.maxProviderCalls, provider_runs: costs, audio: { source_has_audio: metadata.has_audio, mode: audioMode, analyzed_segments: results.filter(r => r.audio_status === 'analyzed').length }, gemini_backend:config.gemini.backend, confidence_method: 'legacy_uncalibrated_heuristic_not_probability' },
    };
  }
  catch (error) {
    if (signal.aborted)
      throw new VideoFlowError(options.signal?.aborted ? 'Analysis cancelled' : 'Analysis deadline exceeded', options.signal?.aborted ? 'ANALYSIS_CANCELLED' : 'ANALYSIS_TIMEOUT');
    if (error instanceof VideoFlowError)
      throw error;
    throw new VideoFlowError('Analysis failed; check source access, ffmpeg and provider configuration', 'PIPELINE_ERROR');
  }
  finally {
    await temporary.cleanup();
  }
}
export type PipelineOutput = Awaited<ReturnType<typeof analyzeVideoFlow>>;
