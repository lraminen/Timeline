import { z } from "zod";
import { TimelineEventSchema } from "./event.js";
import { TimelineEraSchema } from "./era.js";

/**
 * Schema for global timeline display settings.
 */
export const TimelineSettingsSchema = z
  .object({
    layout: z
      .enum(["horizontal", "vertical", "card"])
      .default("vertical")
      .describe("Layout mode for the timeline renderer."),
    theme: z
      .string()
      .default("light")
      .describe('Visual theme name, e.g. "light", "dark", or a custom theme.'),
    locale: z
      .string()
      .default("en")
      .describe("BCP-47 locale tag used for date formatting."),
    startDate: z
      .string()
      .optional()
      .describe(
        "Initial date the viewport should centre on when the timeline loads."
      ),
    zoomLevel: z
      .number()
      .optional()
      .describe("Initial zoom level (interpretation depends on the renderer)."),
  })
  .describe("Display and rendering settings for a Chronicle timeline.");

/** Inferred TypeScript type for timeline settings. */
export type TimelineSettings = z.infer<typeof TimelineSettingsSchema>;

/**
 * Root schema for a complete Chronicle timeline document.
 */
export const TimelineSchema = z
  .object({
    id: z.string().describe("Unique identifier for the timeline."),
    title: z.string().describe("Display title of the timeline."),
    description: z
      .string()
      .optional()
      .describe("Optional longer description or subtitle."),
    events: z
      .array(TimelineEventSchema)
      .describe("Ordered list of events that make up the timeline."),
    eras: z
      .array(TimelineEraSchema)
      .default([])
      .describe("Named eras / periods rendered behind the events."),
    settings: TimelineSettingsSchema.default({})
      .describe("Display settings with sensible defaults."),
  })
  .describe("A complete Chronicle timeline document.");

/** Inferred TypeScript type for a full timeline. */
export type Timeline = z.infer<typeof TimelineSchema>;
