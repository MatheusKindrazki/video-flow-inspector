export interface FrameDescriptor {
  index: number;
  timestamp_ms: number;
  changeScore: number;
}
export interface FrameSelectionOptions {
  maxFrames: number;
  changeThreshold: number;
  safetyIntervalMs: number;
  minFrames: number;
}
export interface FrameSelectionResult {
  selected: FrameDescriptor[];
  discarded: FrameDescriptor[];
  strategy: string;
  stats: {
    candidates: number;
    selected_count: number;
    discarded_count: number;
    by_relevance: number;
    by_safety: number;
    by_anchor: number;
  };
}
/** Reserve temporal coverage before relevance can consume the entire budget. */
export function selectKeyframes(frames: FrameDescriptor[], options: FrameSelectionOptions): FrameSelectionResult {
  const unique = [...new Map(frames.map(f => [f.index, f])).values()].sort((a, b) => a.timestamp_ms - b.timestamp_ms);
  const cap = Math.max(1, Math.floor(options.maxFrames));
  const selected = new Map<number, 'anchor' | 'relevance' | 'safety'>();
  const add = (f: FrameDescriptor, reason: 'anchor' | 'relevance' | 'safety') => { if (!selected.has(f.index))
    selected.set(f.index, reason); };
  if (unique.length)
    add(unique[0], 'anchor');
  if (unique.length > 1 && cap > 1)
    add(unique.at(-1)!, 'anchor');
  const relevant = unique.filter(f => f.changeScore >= options.changeThreshold).sort((a, b) => b.changeScore - a.changeScore || a.timestamp_ms - b.timestamp_ms);
  for (const f of relevant)
    add(f, 'relevance');
  let last = unique[0]?.timestamp_ms ?? 0;
  for (const f of unique) {
    if (f.timestamp_ms - last >= options.safetyIntervalMs) {
      add(f, 'safety');
      last = f.timestamp_ms;
    }
    else if (selected.has(f.index))
      last = f.timestamp_ms;
  }
  const distance = (f: FrameDescriptor) => Math.min(...unique.filter(x => selected.has(x.index)).map(x => Math.abs(x.timestamp_ms - f.timestamp_ms)));
  while (selected.size < Math.min(options.minFrames, cap, unique.length)) {
    const f = unique.filter(x => !selected.has(x.index)).sort((a, b) => distance(b) - distance(a))[0];
    if (!f)
      break;
    add(f, 'safety');
  }
  while (selected.size > cap) {
    const active = unique.filter(f => selected.has(f.index));
    const duration = Math.max(1, unique.at(-1)!.timestamp_ms - unique[0].timestamp_ms);
    const removable = active.filter(f => f.index !== unique[0].index && (cap === 1 || f.index !== unique.at(-1)!.index));
    const penalty = (f: FrameDescriptor) => { const i = active.indexOf(f); const merged = (active[i + 1]?.timestamp_ms ?? f.timestamp_ms) - (active[i - 1]?.timestamp_ms ?? f.timestamp_ms); return merged / duration + (f.changeScore >= options.changeThreshold ? .01 * f.changeScore : 0); };
    removable.sort((a, b) => penalty(a) - penalty(b) || a.timestamp_ms - b.timestamp_ms);
    if (!removable.length)
      break;
    selected.delete(removable[0].index);
  }
  const chosen = unique.filter(f => selected.has(f.index));
  const seen = new Set<number>();
  const discarded = frames.filter(f => { const duplicate = seen.has(f.index); seen.add(f.index); return duplicate || !selected.has(f.index); });
  const reasons = [...selected.values()];
  return { selected: chosen, discarded, strategy: `balanced(cap=${cap},change>=${options.changeThreshold},safety=${options.safetyIntervalMs}ms)`, stats: { candidates: frames.length, selected_count: chosen.length, discarded_count: discarded.length, by_anchor: reasons.filter(x => x === 'anchor').length, by_relevance: reasons.filter(x => x === 'relevance').length, by_safety: reasons.filter(x => x === 'safety').length } };
}
