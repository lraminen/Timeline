// @chronicle/schema — public API surface
// Re-export everything from each sub-module.

export {
  TimelineDateSchema,
  daysInMonth,
  isValidTimelineDateString,
  parseTimelineDate,
  compareDates,
  type TimelineDate,
} from './date.js';

export { TimelineMediaSchema, type TimelineMedia } from './media.js';

export { getUrlScheme, isSafeMediaUrl } from './url.js';

export { TimelineLocationSchema, type TimelineLocation } from './location.js';

export { TimelineEventSchema, type TimelineEvent } from './event.js';

export { TimelineEraSchema, type TimelineEra } from './era.js';

export {
  TimelineSettingsSchema,
  TimelineSchema,
  ThemeOverridesSchema,
  THEME_OVERRIDE_COLOR_KEYS,
  type ThemeOverrides,
  type ThemeOverrideColorKey,
  type TimelineSettings,
  type Timeline,
} from './timeline.js';

export {
  validateTimeline,
  validateEvent,
  toJsonSchema,
  type ValidationResult,
  type ValidationSuccess,
  type ValidationFailure,
} from './validate.js';

export {
  migrateFromTimelineJS,
  migrateFromTimelineJSWithReport,
  type MigrationReport,
  type MigrationWarning,
} from './migrate.js';

export {
  repairLegacyDateString,
  repairTimelineDates,
  type DateRepairReport,
  type RepairedDateString,
} from './repair.js';
