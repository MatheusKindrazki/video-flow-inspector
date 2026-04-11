export class VideoFlowError extends Error {
  public readonly code: string;
  public readonly details?: Record<string, unknown>;

  constructor(message: string, code: string, details?: Record<string, unknown>) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.details = details;
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      details: this.details,
    };
  }
}

export class VideoIngestionError extends VideoFlowError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, "INGESTION_ERROR", details);
  }
}

export class VideoValidationError extends VideoFlowError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, "VALIDATION_ERROR", details);
  }
}

export class KeyframeExtractionError extends VideoFlowError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, "KEYFRAME_ERROR", details);
  }
}

export class ProviderError extends VideoFlowError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, "PROVIDER_ERROR", details);
  }
}

export class ProviderTimeoutError extends ProviderError {
  constructor(message: string, details?: Record<string, unknown>) {
    // Call VideoFlowError constructor directly to set the correct code
    super(message, details);
    // Override code via Object.defineProperty since it's readonly
    Object.defineProperty(this, "code", { value: "PROVIDER_TIMEOUT" });
  }
}

export class NormalizationError extends VideoFlowError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, "NORMALIZATION_ERROR", details);
  }
}

export class ConfigError extends VideoFlowError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, "CONFIG_ERROR", details);
  }
}
