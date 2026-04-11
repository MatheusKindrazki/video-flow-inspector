import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { stat } from "node:fs/promises";
import { KeyframeExtractionError } from "../utils/errors.js";

const execFileAsync = promisify(execFile);

interface VideoMetadata {
  duration_ms: number;
  width: number;
  height: number;
  fps: number;
  codec: string;
  size_bytes: number;
  format: string;
}

/**
 * Check whether ffmpeg and ffprobe are available on the system PATH.
 * Returns true only if both binaries can be executed.
 */
export async function checkFfmpegAvailable(): Promise<boolean> {
  try {
    await Promise.all([
      execFileAsync("ffprobe", ["-version"]),
      execFileAsync("ffmpeg", ["-version"]),
    ]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Extract metadata from a video file using ffprobe.
 *
 * Runs:
 *   ffprobe -v quiet -print_format json -show_format -show_streams <filePath>
 *
 * Parses the JSON output to populate a VideoMetadata object with duration,
 * dimensions, fps, codec, file size, and container format.
 *
 * @throws {KeyframeExtractionError} if ffprobe is not installed, the file
 *   cannot be read, or the output cannot be parsed.
 */
export async function extractVideoMetadata(
  filePath: string,
): Promise<VideoMetadata> {
  // Verify the file exists and get its size on disk.
  let fileSizeBytes: number;
  try {
    const fileStat = await stat(filePath);
    fileSizeBytes = fileStat.size;
  } catch (err) {
    throw new KeyframeExtractionError(
      `Cannot access video file: ${filePath}`,
      { filePath, cause: String(err) },
    );
  }

  // Run ffprobe.
  let stdout: string;
  try {
    const result = await execFileAsync("ffprobe", [
      "-v",
      "quiet",
      "-print_format",
      "json",
      "-show_format",
      "-show_streams",
      filePath,
    ]);
    stdout = result.stdout;
  } catch (err: unknown) {
    const execError = err as { code?: string; stderr?: string };

    if (execError.code === "ENOENT") {
      throw new KeyframeExtractionError(
        "ffprobe is not installed or not found on PATH. Please install ffmpeg (which includes ffprobe) and try again.",
        { filePath },
      );
    }

    throw new KeyframeExtractionError(
      `ffprobe failed for file: ${filePath}`,
      {
        filePath,
        stderr: execError.stderr ?? String(err),
      },
    );
  }

  // Parse the JSON output.
  let probeData: {
    streams?: Array<Record<string, unknown>>;
    format?: Record<string, unknown>;
  };

  try {
    probeData = JSON.parse(stdout);
  } catch {
    throw new KeyframeExtractionError(
      "Failed to parse ffprobe JSON output",
      { filePath, rawOutput: stdout },
    );
  }

  // Find the first video stream.
  const videoStream = probeData.streams?.find(
    (s) => s.codec_type === "video",
  );

  if (!videoStream) {
    throw new KeyframeExtractionError(
      "No video stream found in file",
      { filePath },
    );
  }

  // Extract duration. Prefer format-level duration, fall back to stream.
  const rawDuration =
    probeData.format?.duration ?? videoStream.duration;
  const durationSeconds = parseFloat(String(rawDuration ?? "0"));
  const durationMs = Math.round(durationSeconds * 1000);

  // Extract dimensions.
  const width = Number(videoStream.width ?? 0);
  const height = Number(videoStream.height ?? 0);

  // Extract FPS from avg_frame_rate or r_frame_rate (format: "num/den").
  const fps = parseFps(
    String(videoStream.avg_frame_rate ?? videoStream.r_frame_rate ?? "0/1"),
  );

  // Extract codec name.
  const codec = String(videoStream.codec_name ?? "unknown");

  // Extract container format.
  const format = String(
    probeData.format?.format_name ?? "unknown",
  );

  // Prefer format-level size if available, fall back to fs stat.
  const sizeBytes = probeData.format?.size
    ? Number(probeData.format.size)
    : fileSizeBytes;

  return {
    duration_ms: durationMs,
    width,
    height,
    fps,
    codec,
    size_bytes: sizeBytes,
    format,
  };
}

/**
 * Parse an ffprobe frame-rate string like "30000/1001" or "30/1" into a
 * floating-point number. Returns 0 if the string cannot be parsed.
 */
function parseFps(fpsString: string): number {
  const parts = fpsString.split("/");
  if (parts.length === 2) {
    const numerator = parseFloat(parts[0]);
    const denominator = parseFloat(parts[1]);
    if (denominator !== 0 && !Number.isNaN(numerator) && !Number.isNaN(denominator)) {
      return Math.round((numerator / denominator) * 100) / 100;
    }
  }

  const direct = parseFloat(fpsString);
  return Number.isNaN(direct) ? 0 : direct;
}
