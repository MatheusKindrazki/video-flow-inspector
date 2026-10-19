export interface Segment {
  id: string;
  start_ms: number;
  end_ms: number;
}
export function planSegments(durationMs: number, segmentMs = 60000, overlapMs = 2000): Segment[] {
  if (!Number.isFinite(durationMs) || durationMs <= 0 || !Number.isFinite(segmentMs) || segmentMs <= 0 || overlapMs < 0 || overlapMs >= segmentMs)
    throw new Error('Invalid segment plan');
  const result: Segment[] = [];
  for (let start = 0; start < durationMs; start += segmentMs - overlapMs) {
    result.push({ id: `S${result.length + 1}`, start_ms: start, end_ms: Math.min(start + segmentMs, durationMs) });
    if (start + segmentMs >= durationMs)
      break;
  }
  return result;
}
/** Workers settle before rejection so media cannot be cleaned while a worker uses it. */
export async function mapConcurrent<I, O>(items: I[], concurrency: number, run: (item: I, index: number) => Promise<O>, signal?: AbortSignal): Promise<O[]> {
  if (!Number.isInteger(concurrency) || concurrency < 1)
    throw new Error('Invalid concurrency');
  const results: O[] = [];
  let next = 0;
  let failure: unknown;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length && failure === undefined) {
      try {
        signal?.throwIfAborted();
        const i = next++;
        results[i] = await run(items[i], i);
      }
      catch (e) {
        failure = e;
      }
    }
  }));
  if (failure !== undefined)
    throw failure;
  signal?.throwIfAborted();
  return results;
}
