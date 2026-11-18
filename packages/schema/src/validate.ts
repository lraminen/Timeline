import { ZodError } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { TimelineSchema, type Timeline } from "./timeline.js";
import { TimelineEventSchema, type TimelineEvent } from "./event.js";

// ---------------------------------------------------------------------------
// Validation result types
// ---------------------------------------------------------------------------

/** Successful validation result. */
export interface ValidationSuccess<T> {
  success: true;
  data: T;
}

/** Failed validation result. */
export interface ValidationFailure {
  success: false;
  errors: ZodError;
}

export type ValidationResult<T> = ValidationSuccess<T> | ValidationFailure;

// ---------------------------------------------------------------------------
// Validators
// ---------------------------------------------------------------------------

/**
 * Validates an unknown payload against the full {@link TimelineSchema}.
 *
 * @param data - The raw data to validate.
 * @returns A discriminated union: `{ success: true, data }` or `{ success: false, errors }`.
 */
export function validateTimeline(
  data: unknown
): ValidationResult<Timeline> {
  const result = TimelineSchema.safeParse(data);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return { success: false, errors: result.error };
}

/**
 * Validates an unknown payload against the {@link TimelineEventSchema}.
 *
 * @param data - The raw data to validate.
 * @returns A discriminated union: `{ success: true, data }` or `{ success: false, errors }`.
 */
export function validateEvent(
  data: unknown
): ValidationResult<TimelineEvent> {
  const result = TimelineEventSchema.safeParse(data);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return { success: false, errors: result.error };
}

// ---------------------------------------------------------------------------
// JSON Schema export
// ---------------------------------------------------------------------------

/**
 * Converts the Chronicle {@link TimelineSchema} to a standard JSON Schema
 * document, suitable for use in editors, documentation, or external validators.
 *
 * @returns A plain JSON Schema object.
 */
export function toJsonSchema(): Record<string, unknown> {
  return zodToJsonSchema(TimelineSchema, "Timeline") as Record<
    string,
    unknown
  >;
}
