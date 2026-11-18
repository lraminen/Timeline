import { z } from 'zod';

/**
 * Schema for a named era / period that spans a date range on the timeline.
 */
export const TimelineEraSchema = z
  .object({
    id: z.string().describe('Unique identifier for the era.'),
    title: z.string().describe('Display title of the era.'),
    start: z.string().describe('Start date string of the era (same format as event dates).'),
    end: z.string().describe('End date string of the era (same format as event dates).'),
    color: z
      .string()
      .optional()
      .describe(
        'Optional CSS color used to style the era band, e.g. "#6366f1" or "rebeccapurple".',
      ),
  })
  .describe('A named era or period rendered as a coloured band behind the timeline.');

/** Inferred TypeScript type for a timeline era. */
export type TimelineEra = z.infer<typeof TimelineEraSchema>;
