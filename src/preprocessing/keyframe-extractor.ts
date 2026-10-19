import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { logger } from "../utils/logger.js";
import { KeyframeExtractionError } from "../utils/errors.js";
const execFileAsync = promisify(execFile);
interface Keyframe {
  index: number;
  timestamp_ms: number;
  path: string;
  base64?: string;
  width: number;
  height: number;
  pixel_signature?: number[];
}
interface ExtractionOptions {
  intervalSeconds: number;
  maxFrames: number;
  outputDir: string;
  width?: number;
  startMs?: number;
  signal?: AbortSignal;
}
/** A lightweight, deterministic content signature; it needs no image decoder. */
export function signatureFromBytes(bytes: Uint8Array, buckets = 32): number[] {
  if (!bytes.length)
    return [];
  return Array.from({ length: buckets }, (_, bucket) => {
    const start = Math.floor((bucket * bytes.length) / buckets);
    const end = Math.max(start + 1, Math.floor(((bucket + 1) * bytes.length) / buckets));
    let total = 0;
    for (let index = start; index < end; index++)
      total += bytes[index];
    return total / (end - start);
  });
}
export function changeScoresFromSignatures(signatures: number[][]): number[] {
  return signatures.map((signature, index) => {
    if (!index || !signature.length || signature.length !== signatures[index - 1].length)
      return 0;
    const prior = signatures[index - 1];
    return Math.min(1, signature.reduce((sum, value, bucket) => sum + Math.abs(value - prior[bucket]), 0) / (signature.length * 255));
  });
}
export async function computeKeyframeChangeScores(keyframes: Keyframe[]): Promise<number[]> {
  if(keyframes.some(frame=>!frame.pixel_signature))throw new KeyframeExtractionError("Decoded pixel signatures are required; compressed JPEG bytes are not visual change evidence");
  const signatures = keyframes.map(frame=>frame.pixel_signature!);
  return changeScoresFromSignatures(signatures);
}
const DEFAULT_WIDTH = 800;
const FRAME_PATTERN = /^frame_(\d{4})\.jpg$/;
/**
 * Compute the effective sampling interval and frame count so candidates are
 * distributed uniformly across the ENTIRE video duration rather than only the
 * first `maxFrames` seconds.
 *
 * When the requested `intervalSeconds` would yield more frames than `maxFrames`,
 * the interval is widened so the cap still covers from the start to (near) the
 * end of the video. This guarantees a candidate close to the end before the
 * adaptive selection runs.
 *
 * @returns `effectiveInterval` (seconds) and `framesToExtract` (cap).
 */
export function computeFramePlan(durationSeconds: number, intervalSeconds: number, maxFrames: number): {
  effectiveInterval: number;
  framesToExtract: number;
} {
  const safeMaxFrames = Math.max(1, maxFrames);
  // Widened interval: cover the full duration with at most maxFrames candidates.
  // Use (maxFrames - 1) segments between samples so both endpoints are covered.
  const intervalFromBudget = durationSeconds / Math.max(1, safeMaxFrames - 1);
  const effectiveInterval = Math.max(intervalSeconds, intervalFromBudget);
  const estimatedFrames = Math.max(1, Math.floor(durationSeconds / effectiveInterval) + 1);
  const framesToExtract = Math.min(estimatedFrames, safeMaxFrames);
  return { effectiveInterval, framesToExtract };
}
/**
 * Extract keyframes from a video file using ffmpeg.
 *
 * Strategy:
 * 1. Compute a uniform sampling plan across the full duration (see
 *    {@link computeFramePlan}) so long videos are not only sampled at the start.
 * 2. Select source frames and split them into JPEG and grayscale outputs.
 * 3. Read actual showinfo PTS and decoded pixel signatures alongside frame files.
 *
 * @throws {KeyframeExtractionError} if ffmpeg is missing, the command fails,
 *   or no frames are produced.
 */
export async function extractKeyframes(videoPath: string, durationMs: number, options: ExtractionOptions): Promise<Keyframe[]> {
  const { intervalSeconds, maxFrames, outputDir, width = DEFAULT_WIDTH } = options;
  // Calculate how many frames we expect, distributing candidates uniformly
  // across the full duration so a long video is not only sampled at its start.
  const durationSeconds = durationMs / 1000;
  const { effectiveInterval, framesToExtract } = computeFramePlan(durationSeconds, intervalSeconds, maxFrames);
  logger.info("Starting keyframe extraction", {
    videoPath,
    durationMs,
    intervalSeconds,
    effectiveInterval,
    framesToExtract,
    outputDir,
  });
  // Build the ffmpeg video-filter string. Using the effective interval spreads
  // samples across the whole timeline; -frames:v is only a safety cap.
  const outputPattern = join(outputDir, "frame_%04d.jpg");
  let selectedTimes: number[] = [];
  try {
    const { stderr } = await execFileAsync("ffmpeg", [
      "-nostdin", "-hide_banner", "-y", "-ss", String((options.startMs ?? 0) / 1000),
      "-i", videoPath,
      "-filter_complex", `[0:v]select='isnan(prev_selected_t)+gte(t-prev_selected_t,${effectiveInterval})',showinfo,split=2[images][pixels];[images]scale=${width}:-1[jpegs];[pixels]scale=32:32,format=gray[gray]`,
      "-map", "[jpegs]", "-t", String(durationSeconds), "-fps_mode", "vfr", "-frames:v", String(framesToExtract), "-q:v", "2", outputPattern,
      "-map", "[gray]", "-t", String(durationSeconds), "-fps_mode", "vfr", "-frames:v", String(framesToExtract), "-f", "rawvideo", join(outputDir, "signatures.gray"),
    ], { signal: options.signal, timeout: 120000, maxBuffer: 8 * 1024 * 1024 });
    selectedTimes = [...stderr.matchAll(/\bpts_time:([0-9.e+-]+)/g)].map(match => Number(match[1]) * 1000);
    if (selectedTimes.some(t => !Number.isFinite(t)))
      throw new Error("Invalid frame PTS");
    logger.debug("ffmpeg stderr output", { stderr });
  }
  catch (err: unknown) {
    const execError = err as {
      code?: string;
      stderr?: string;
    };
    if (execError.code === "ENOENT") {
      throw new KeyframeExtractionError("ffmpeg is not installed or not found on PATH. Please install ffmpeg and try again.", { videoPath });
    }
    throw new KeyframeExtractionError(`ffmpeg keyframe extraction failed for: ${videoPath}`, {
      videoPath,
      stderr: execError.stderr ?? String(err),
    });
  }
  // Read the output directory and collect extracted frames.
  const files = await readdir(outputDir);
  const frameFiles = files
    .filter((f) => FRAME_PATTERN.test(f))
    .sort();
  if (frameFiles.length === 0) {
    throw new KeyframeExtractionError("No keyframes were extracted from the video", { videoPath, outputDir });
  }
  logger.info("Keyframes extracted", { count: frameFiles.length });
  // Use the selected source PTS; do not infer timestamps from frame numbering.
  const pixels = await readFile(join(outputDir, "signatures.gray"));
  if (selectedTimes.length < frameFiles.length || pixels.length < frameFiles.length * 1024)
    throw new KeyframeExtractionError("Frame timestamps/signatures incomplete");
  const keyframes: Keyframe[] = frameFiles.map((file, idx) => {
    const timestampMs = (options.startMs ?? 0) + selectedTimes[idx];
    return {
      index: idx,
      timestamp_ms: Math.round(timestampMs),
      path: join(outputDir, file),
      width,
      height: 0, // Actual height depends on source aspect ratio.
      pixel_signature: signatureFromBytes(pixels.subarray(idx * 1024, (idx + 1) * 1024), 1024),
    };
  });
  // Determine actual dimensions from the first extracted frame.
  try {
    const { stdout } = await execFileAsync("ffprobe", [
      "-v",
      "quiet",
      "-print_format",
      "json",
      "-show_streams",
      keyframes[0].path,
    ], { signal: options.signal, timeout: 10000 });
    const probe = JSON.parse(stdout) as {
      streams?: Array<{
        width?: number;
        height?: number;
      }>;
    };
    const imageStream = probe.streams?.[0];
    if (imageStream) {
      const actualWidth = imageStream.width ?? width;
      const actualHeight = imageStream.height ?? 0;
      for (const kf of keyframes) {
        kf.width = actualWidth;
        kf.height = actualHeight;
      }
    }
  }
  catch {
    // Non-fatal: we keep width from the option and height as 0.
    options.signal?.throwIfAborted();
    logger.warn("Could not determine actual keyframe dimensions via ffprobe");
  }
  return keyframes;
}
/**
 * Load keyframe images as base64-encoded JPEG strings.
 *
 * Reads each keyframe file from disk and populates the `base64` field so
 * frames can be sent directly to LLM vision providers.
 *
 * Returns a new array with base64 fields populated (does not mutate input).
 */
export async function loadKeyframesAsBase64(keyframes: Keyframe[]): Promise<Keyframe[]> {
  logger.info("Loading keyframes as base64", { count: keyframes.length });
  const results = await Promise.all(keyframes.map(async (kf) => {
    const buffer = await readFile(kf.path);
    return {
      ...kf,
      base64: buffer.toString("base64"),
    };
  }));
  logger.debug("Base64 loading complete", {
    count: results.length,
    totalSizeBytes: results.reduce((acc, kf) => acc + (kf.base64?.length ?? 0), 0),
  });
  return results;
}
