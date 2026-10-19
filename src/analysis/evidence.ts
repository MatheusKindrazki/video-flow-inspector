import { z } from 'zod';
import type { Segment } from '../orchestrator/segments.js';
export const TranscriptSchema = z.object({ id: z.string().min(1).max(128), start_ms: z.number().int().nonnegative(), end_ms: z.number().int().nonnegative(), text: z.string().min(1).max(8000) });
const RefSchema = z.discriminatedUnion('kind', [z.object({ kind: z.literal('frame'), frame_index: z.number().int().nonnegative() }), z.object({ kind: z.literal('transcript'), transcript_id: z.string().min(1) })]);
export const FindingSchema = z.object({ id: z.string().min(1), category: z.enum(['bug', 'usability']), basis: z.enum(['observed', 'reported', 'hypothesis']), severity: z.enum(['critical', 'major', 'minor', 'info']), title: z.string().min(1).max(300), description: z.string().min(1).max(8000), timestamp_ms: z.number().int().nonnegative(), end_timestamp_ms: z.number().int().nonnegative().optional(), evidence_refs: z.array(RefSchema).min(1).max(32), recommendation: z.string().min(1).max(4000) });
export type Transcript = z.infer<typeof TranscriptSchema> & {
  source_segment: string;
  provenance: 'model_transcribed';
};
export type Finding = z.infer<typeof FindingSchema> & {
  source_segment: string;
  source_start_ms?: number;
  source_end_ms?: number;
  merged_sources?: string[];
};
interface EvidenceContext {
  segment: Segment;
  keyframes: Array<{
    index: number;
    timestamp_ms: number;
  }>;
  hasAudio: boolean;
}
export function validateSegmentEvidence(raw: {
  transcript?: unknown[];
  findings?: unknown[];
}, context: EvidenceContext): {
  transcript: Transcript[];
  findings: Finding[];
  warnings: string[];
} {
  const { segment, keyframes, hasAudio } = context;
  const warnings: string[] = [];
  const transcript: Transcript[] = [];
  const findings: Finding[] = [];
  const transcriptIds = new Set<string>();
  const findingIds = new Set<string>();
  const within = (n: number) => n >= segment.start_ms && n <= segment.end_ms;
  for (const item of (raw.transcript ?? []).slice(0, 200)) {
    const p = TranscriptSchema.safeParse(item);
    if (!hasAudio || !p.success || !within(p.data.start_ms) || !within(p.data.end_ms) || p.data.end_ms <= p.data.start_ms || transcriptIds.has(p.data.id)) {
      warnings.push(`${segment.id}: invalid or unavailable transcript evidence discarded`);
      continue;
    }
    transcriptIds.add(p.data.id);
    transcript.push({ ...p.data, id: `${segment.id}:${p.data.id}`, source_segment: segment.id, provenance: 'model_transcribed' });
  }
  for (const item of (raw.findings ?? []).slice(0, 100)) {
    const p = FindingSchema.safeParse(item);
    if (!p.success) {
      warnings.push(`${segment.id}: malformed finding discarded`);
      continue;
    }
    const f = p.data;
    if (findingIds.has(f.id)) {
      warnings.push(`${segment.id}: duplicate finding ID discarded`);
      continue;
    }
    findingIds.add(f.id);
    const refs = f.evidence_refs.map(r => r.kind === 'transcript' ? { ...r, transcript_id: `${segment.id}:${r.transcript_id}` } : r);
    const valid = within(f.timestamp_ms) && (f.end_timestamp_ms === undefined || (within(f.end_timestamp_ms) && f.end_timestamp_ms >= f.timestamp_ms)) && refs.every(r => r.kind === 'frame' ? keyframes.some(k => k.index === r.frame_index) : transcript.some(t => t.id === r.transcript_id));
    const temporallySupported = refs.some(r => r.kind === 'frame' ? keyframes.some(k => k.index === r.frame_index && Math.abs(k.timestamp_ms - f.timestamp_ms) <= 2000) : transcript.some(t => t.id === r.transcript_id && f.timestamp_ms >= t.start_ms && f.timestamp_ms <= t.end_ms));
    const frameSupports = refs.some(r => r.kind === 'frame' && keyframes.some(k => k.index === r.frame_index && Math.abs(k.timestamp_ms - f.timestamp_ms) <= 2000));
    const speechSupports = refs.some(r => r.kind === 'transcript' && transcript.some(t => t.id === r.transcript_id && f.timestamp_ms >= t.start_ms && f.timestamp_ms <= t.end_ms));
    const basisSupported = f.basis === 'observed' ? frameSupports : f.basis === 'reported' ? speechSupports : true;
    if (!valid || !temporallySupported || !basisSupported) {
      warnings.push(`${segment.id}: unsupported finding/reference discarded`);
      continue;
    }
    findings.push({ ...f, id: `${segment.id}:${f.id}`, evidence_refs: refs, source_segment: segment.id, source_start_ms: segment.start_ms, source_end_ms: segment.end_ms });
  }
  if ((raw.transcript?.length ?? 0) > 200 || (raw.findings?.length ?? 0) > 100)
    warnings.push(`${segment.id}: output item budget exceeded`);
  return { transcript, findings, warnings };
}
/** Conservative overlap deduplication: do not collapse a later recurrence. */
export function mergeFindings(items: Finding[]): Finding[] {
  const result: Finding[] = [];
  const order = { critical: 0, major: 1, minor: 2, info: 3 };
  for (const item of [...items].sort((a, b) => a.timestamp_ms - b.timestamp_ms)) {
    const previous = result.find(f => {
      const start = Math.max(f.source_start_ms ?? 0, item.source_start_ms ?? 0);
      const end = Math.min(f.source_end_ms ?? Infinity, item.source_end_ms ?? Infinity);
      return f.source_segment !== item.source_segment && !(f.merged_sources??[]).includes(item.source_segment) && f.category === item.category && f.basis === item.basis && f.title.trim().toLowerCase() === item.title.trim().toLowerCase() && Math.abs(f.timestamp_ms - item.timestamp_ms) <= 3000 && f.timestamp_ms >= start && item.timestamp_ms >= start && f.timestamp_ms <= end && item.timestamp_ms <= end;
    });
    if (!previous) {
      result.push({ ...item, evidence_refs: [...item.evidence_refs] });
      continue;
    }
    previous.merged_sources = [...new Set([...(previous.merged_sources ?? [previous.source_segment]), item.source_segment])];
    previous.evidence_refs = [...new Map([...previous.evidence_refs, ...item.evidence_refs].map(r => [JSON.stringify(r), r])).values()];
    if (order[item.severity] < order[previous.severity]) {
      previous.severity = item.severity;
      previous.description = item.description;
      previous.recommendation = item.recommendation;
    }
  }
  return result.sort((a, b) => order[a.severity] - order[b.severity] || a.timestamp_ms - b.timestamp_ms);
}
