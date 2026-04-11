import { stat, access } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { extname } from "node:path";
import { VideoValidationError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";
import { downloadVideo } from "./downloader.js";

export interface ValidationResult {
  valid: boolean;
  filePath: string;
  sizeBytes: number;
}

const ALLOWED_EXTENSIONS = new Set([".mp4", ".webm", ".mov", ".avi", ".mkv"]);

/**
 * Validate that a video file exists and is within limits.
 * - Check file exists and is readable
 * - Check file size is within maxSizeMB
 * - Check file extension is a known video format (.mp4, .webm, .mov, .avi, .mkv)
 * - Return validation result
 */
export async function validateVideoFile(
  filePath: string,
  maxSizeMB: number,
): Promise<ValidationResult> {
  // Check file extension
  const ext = extname(filePath).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    throw new VideoValidationError("Unsupported video file extension", {
      filePath,
      extension: ext,
      allowedExtensions: Array.from(ALLOWED_EXTENSIONS),
    });
  }

  // Check file exists and is readable
  try {
    await access(filePath, constants.R_OK);
  } catch {
    throw new VideoValidationError("Video file does not exist or is not readable", {
      filePath,
    });
  }

  // Check file size
  const fileStat = await stat(filePath);

  if (!fileStat.isFile()) {
    throw new VideoValidationError("Path is not a regular file", { filePath });
  }

  const maxSizeBytes = maxSizeMB * 1024 * 1024;
  if (fileStat.size > maxSizeBytes) {
    throw new VideoValidationError(
      `Video file exceeds maximum size: ${(fileStat.size / 1024 / 1024).toFixed(1)}MB > ${maxSizeMB}MB`,
      { filePath, sizeBytes: fileStat.size, maxSizeBytes },
    );
  }

  if (fileStat.size === 0) {
    throw new VideoValidationError("Video file is empty", { filePath });
  }

  logger.debug("Video file validated", {
    filePath,
    sizeBytes: fileStat.size,
    extension: ext,
  });

  return {
    valid: true,
    filePath,
    sizeBytes: fileStat.size,
  };
}

/**
 * Resolve video source — either validate local file or download from URL.
 * Returns the local file path ready for processing.
 */
export async function resolveVideoSource(
  input: { video_url?: string; video_file_path?: string },
  tempDir: string,
  maxSizeMB: number,
): Promise<{ filePath: string; sizeBytes: number; wasDownloaded: boolean }> {
  const { video_url, video_file_path } = input;

  if (!video_url && !video_file_path) {
    throw new VideoValidationError("Either video_url or video_file_path must be provided", {
      input,
    });
  }

  // Prefer local file if both are provided
  if (video_file_path) {
    logger.info("Resolving video from local file", { filePath: video_file_path });

    const validation = await validateVideoFile(video_file_path, maxSizeMB);

    return {
      filePath: validation.filePath,
      sizeBytes: validation.sizeBytes,
      wasDownloaded: false,
    };
  }

  // Download from URL
  logger.info("Resolving video from URL", { url: video_url });

  const extension = extractExtensionFromUrl(video_url!) ?? ".mp4";
  const destFileName = `${randomUUID()}${extension}`;
  const destPath = join(tempDir, destFileName);

  const downloadResult = await downloadVideo(video_url!, destPath, maxSizeMB);

  // Validate the downloaded file
  await validateVideoFile(destPath, maxSizeMB);

  return {
    filePath: downloadResult.filePath,
    sizeBytes: downloadResult.sizeBytes,
    wasDownloaded: true,
  };
}

/**
 * Try to extract a video file extension from a URL.
 * Returns null if no recognizable extension is found.
 */
function extractExtensionFromUrl(url: string): string | null {
  try {
    const pathname = new URL(url).pathname;
    const ext = extname(pathname).toLowerCase();
    if (ALLOWED_EXTENSIONS.has(ext)) {
      return ext;
    }
  } catch {
    // Invalid URL — fall through
  }
  return null;
}
