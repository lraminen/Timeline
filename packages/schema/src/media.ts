import { z } from 'zod';

/**
 * Schema for media items attached to timeline events.
 */
export const TimelineMediaSchema = z
  .object({
    type: z.enum(['image', 'video', 'audio', 'oembed', 'map']).describe('The type of media asset.'),
    url: z
      .string()
      .min(1)
      .describe(
        'The URL or path of the media resource. Supports absolute URLs, relative paths, data URIs, and blob URLs.',
      ),
    alt: z.string().optional().describe('Alternative text for accessibility (images).'),
    caption: z.string().optional().describe('A short caption displayed beneath the media.'),
    credit: z.string().optional().describe('Attribution / credit line for the media.'),
    thumbnail: z
      .string()
      .optional()
      .describe('Optional thumbnail URL or path used for previews and lazy loading.'),
  })
  .describe('A media attachment (image, video, audio, embed, or map).');

/** Inferred TypeScript type for a timeline media item. */
export type TimelineMedia = z.infer<typeof TimelineMediaSchema>;
