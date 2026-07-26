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
  stats: { candidates: number; selected_count: number; discarded_count: number; by_relevance: number; by_safety: number; by_anchor: number };
}

type Reason = "anchor" | "relevance" | "safety";

export function selectKeyframes(frames: FrameDescriptor[], options: FrameSelectionOptions): FrameSelectionResult {
  const unique = frames.filter((frame, position) => frames.findIndex((candidate) => candidate.index === frame.index) === position)
    .sort((a, b) => a.index - b.index);
  const selected = new Map<number, Reason>();
  const add = (frame: FrameDescriptor, reason: Reason): void => { if (!selected.has(frame.index)) selected.set(frame.index, reason); };
  if (unique.length) add(unique[0], "anchor");
  if (unique.length > 1) add(unique.at(-1)!, "anchor");

  for (const frame of unique) if (frame.changeScore >= options.changeThreshold) add(frame, "relevance");

  let lastSelectedTimestamp = unique[0]?.timestamp_ms;
  for (const frame of unique) {
    if (frame.index === unique[0]?.index) continue;
    if (lastSelectedTimestamp !== undefined && frame.timestamp_ms - lastSelectedTimestamp > options.safetyIntervalMs) {
      add(frame, "safety");
      lastSelectedTimestamp = frame.timestamp_ms;
    } else if (selected.has(frame.index)) {
      lastSelectedTimestamp = frame.timestamp_ms;
    }
  }

  const targetMin = Math.min(options.minFrames, options.maxFrames);
  while (selected.size < targetMin) {
    const available = unique.filter((frame) => !selected.has(frame.index));
    if (!available.length) break;
    const rank = Math.floor((available.length - 1) / 2);
    add(available[rank], "safety");
  }

  const anchors = new Set([unique[0]?.index, unique.at(-1)?.index]);
  while (selected.size > options.maxFrames) {
    const removable = unique.filter((frame) => selected.has(frame.index) && !anchors.has(frame.index))
      .sort((a, b) => a.changeScore - b.changeScore || b.index - a.index);
    if (!removable.length) break;
    selected.delete(removable[0].index);
  }

  const selectedFrames = unique.filter((frame) => selected.has(frame.index));
  const selectedIndexes = new Set(selectedFrames.map((frame) => frame.index));
  const discarded = frames.filter((frame, position) => !selectedIndexes.has(frame.index) || frames.findIndex((candidate) => candidate.index === frame.index) !== position)
    .sort((a, b) => a.index - b.index);
  const reasons = [...selected.values()];
  return {
    selected: selectedFrames,
    discarded,
    strategy: `adaptive(cap=${options.maxFrames},change>=${options.changeThreshold},safety=${options.safetyIntervalMs}ms)`,
    stats: {
      candidates: frames.length,
      selected_count: selectedFrames.length,
      discarded_count: discarded.length,
      by_relevance: reasons.filter((reason) => reason === "relevance").length,
      by_safety: reasons.filter((reason) => reason === "safety").length,
      by_anchor: reasons.filter((reason) => reason === "anchor").length,
    },
  };
}
