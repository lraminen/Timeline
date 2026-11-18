// @chronicle/schema — public API surface
// Re-export everything from each sub-module.

export {
  TimelineDateSchema,
  parseTimelineDate,
  compareDates,
  type TimelineDate,
} from "./date.js";

export { TimelineMediaSchema, type TimelineMedia } from "./media.js";

export {
  TimelineLocationSchema,
  type TimelineLocation,
} from "./location.js";

export { TimelineEventSchema, type TimelineEvent } from "./event.js";

export { TimelineEraSchema, type TimelineEra } from "./era.js";

export {
  TimelineSettingsSchema,
  TimelineSchema,
  type TimelineSettings,
  type Timeline,
} from "./timeline.js";

export {
  validateTimeline,
  validateEvent,
  toJsonSchema,
  type ValidationResult,
  type ValidationSuccess,
  type ValidationFailure,
} from "./validate.js";

export { migrateFromTimelineJS } from "./migrate.js";
