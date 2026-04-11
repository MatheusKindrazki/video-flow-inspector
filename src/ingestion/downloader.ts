import { createWriteStream } from "node:fs";
import { unlink } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { logger } from "../utils/logger.js";
import { VideoIngestionError } from "../utils/errors.js";

export interface DownloadResult {
  filePath: string;
  sizeBytes: number;
  contentType: string | null;
}

/**
 * Download video from URL to a local file path.
 * - Validates URL format
 * - Follows redirects (fetch does this by default)
 * - Enforces max size limit
 * - Streams to disk (don't buffer in memory)
 * - Returns download result with size and content type
 */
export async function downloadVideo(
  url: string,
  destPath: string,
  maxSizeMB: number,
): Promise<DownloadResult> {
  // Validate URL format
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    throw new VideoIngestionError("Invalid video URL", {
      url,
      reason: "URL parsing failed",
    });
  }

  if (!["http:", "https:"].includes(parsedUrl.protocol)) {
    throw new VideoIngestionError("Invalid URL protocol — only HTTP and HTTPS are supported", {
      url,
      protocol: parsedUrl.protocol,
    });
  }

  const maxSizeBytes = maxSizeMB * 1024 * 1024;

  logger.info("Starting video download", { url, destPath, maxSizeMB });

  let response: Response;
  try {
    response = await fetch(url);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new VideoIngestionError("Network error during video download", {
      url,
      reason: message,
    });
  }

  if (!response.ok) {
    throw new VideoIngestionError(`HTTP error ${response.status}: ${response.statusText}`, {
      url,
      status: response.status,
      statusText: response.statusText,
    });
  }

  if (!response.body) {
    throw new VideoIngestionError("Response body is empty", { url });
  }

  const contentType = response.headers.get("content-type");

  // Check Content-Length header if available (early rejection)
  const contentLength = response.headers.get("content-length");
  if (contentLength) {
    const declaredSize = parseInt(contentLength, 10);
    if (!Number.isNaN(declaredSize) && declaredSize > maxSizeBytes) {
      throw new VideoIngestionError(
        `Video exceeds maximum size: ${(declaredSize / 1024 / 1024).toFixed(1)}MB > ${maxSizeMB}MB`,
        { url, declaredSize, maxSizeBytes },
      );
    }
  }

  // Stream response body to disk while tracking size
  const writeStream = createWriteStream(destPath);
  let bytesWritten = 0;

  // Convert web ReadableStream to Node.js Readable
  const reader = response.body.getReader();
  const nodeStream = new Readable({
    async read() {
      try {
        const { done, value } = await reader.read();
        if (done) {
          this.push(null);
          return;
        }

        bytesWritten += value.byteLength;

        if (bytesWritten > maxSizeBytes) {
          // Cancel the reader and destroy this stream
          reader.cancel().catch(() => {});
          this.destroy(
            new VideoIngestionError(
              `Video exceeds maximum size during download: ${(bytesWritten / 1024 / 1024).toFixed(1)}MB > ${maxSizeMB}MB`,
              { url, bytesWritten, maxSizeBytes },
            ),
          );
          return;
        }

        this.push(value);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        this.destroy(
          new VideoIngestionError("Stream read error during download", {
            url,
            reason: message,
          }),
        );
      }
    },
  });

  try {
    await pipeline(nodeStream, writeStream);
  } catch (error: unknown) {
    // Clean up partial file on any error
    await cleanupPartialFile(destPath);

    if (error instanceof VideoIngestionError) {
      throw error;
    }

    const message = error instanceof Error ? error.message : String(error);
    throw new VideoIngestionError("Failed to write video to disk", {
      url,
      destPath,
      reason: message,
    });
  }

  logger.info("Video download complete", {
    url,
    destPath,
    sizeBytes: bytesWritten,
    contentType,
  });

  return {
    filePath: destPath,
    sizeBytes: bytesWritten,
    contentType,
  };
}

async function cleanupPartialFile(filePath: string): Promise<void> {
  try {
    await unlink(filePath);
    logger.debug("Cleaned up partial download file", { filePath });
  } catch {
    // File may not exist yet — ignore cleanup errors
  }
}
