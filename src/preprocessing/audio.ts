import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import type { Segment } from '../orchestrator/segments.js';
const exec = promisify(execFile);
export interface AudioSegment {
  mimeType: 'audio/mpeg';
  base64: string;
  start_ms: number;
  end_ms: number;
}
/** No extraction is attempted for sources without an audio stream. */
export async function extractAudioSegment(video: string, segment: Segment, destination: string, signal?: AbortSignal): Promise<AudioSegment> {
  signal?.throwIfAborted();
  await exec('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-ss', String(segment.start_ms / 1000), '-i', video, '-t', String((segment.end_ms - segment.start_ms) / 1000), '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'libmp3lame', '-b:a', '48k', destination], { signal, timeout: 60000, maxBuffer: 1024 * 1024 });
  const bytes = await readFile(destination);
  if (!bytes.length || bytes.length > 4 * 1024 * 1024)
    throw new Error('Audio segment is empty or exceeds budget');
  return { mimeType: 'audio/mpeg', base64: bytes.toString('base64'), start_ms: segment.start_ms, end_ms: segment.end_ms };
}
