import { z } from 'zod';
import { TimelineDateSchema } from './date.js';
import { TimelineMediaSchema } from './media.js';
import { TimelineLocationSchema } from './location.js';

/**
 * Schema for a single timeline event — the fundamental unit of a Chronicle timeline.
 */
export const TimelineEventSchema = z
  .object({
    id: z.string().describe('Unique identifier for the event.'),
    date: TimelineDateSchema.describe('The date or date range of this event.'),
    title: z
      .string()
      .min(1)
      .describe('Short title / headline for the event (required, non-empty).'),
    body: z.string().optional().describe('Longer description of the event. Supports Markdown.'),
    media: z.array(TimelineMediaSchema).default([]).describe('Media items attached to this event.'),
    location: TimelineLocationSchema.optional().describe(
      'Optional geographic location associated with this event.',
    ),
    tags: z
      .array(z.string())
      .default([])
      .describe('Freeform tags for filtering and grouping events.'),
    era: z.string().optional().describe('ID of the era this event belongs to.'),
    group: z.string().optional().describe('Grouping key used to cluster events in the UI.'),
  })
  .describe('A single event on a Chronicle timeline.');

/** Inferred TypeScript type for a timeline event. */
export type TimelineEvent = z.infer<typeof TimelineEventSchema>;
