import { z } from 'zod';
import { isSafeMediaUrl } from './url.js';

const MEDIA_TYPES = ['image', 'video', 'audio', 'oembed', 'map'] as const;

/** `data:` URLs are only accepted for media whose MIME family matches. */
function dataKindFor(type: (typeof MEDIA_TYPES)[number]): 'image' | 'video' | 'audio' | undefined {
  return type === 'image' || type === 'video' || type === 'audio' ? type : undefined;
}

/**
 * Schema for media items attached to timeline events.
 */
export const TimelineMediaSchema = z
  .object({
    type: z.enum(MEDIA_TYPES).describe('The type of media asset.'),
    url: z
      .string()
      .min(1)
      .describe(
        'The URL or path of the media resource. Supports http(s) URLs, relative paths, blob URLs, and data URIs matching the media type (e.g. data:image/… for images). Other schemes such as javascript: are rejected.',
      ),
    alt: z.string().optional().describe('Alternative text for accessibility (images).'),
    caption: z.string().optional().describe('A short caption displayed beneath the media.'),
    credit: z.string().optional().describe('Attribution / credit line for the media.'),
    thumbnail: z
      .string()
      .optional()
      .describe('Optional thumbnail image URL or path used for previews and lazy loading.'),
  })
  .superRefine((media, ctx) => {
    if (!isSafeMediaUrl(media.url, dataKindFor(media.type))) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['url'],
        message: 'Unsupported or unsafe URL scheme',
      });
    }
    if (media.thumbnail !== undefined && !isSafeMediaUrl(media.thumbnail, 'image')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['thumbnail'],
        message: 'Unsupported or unsafe URL scheme',
      });
    }
  })
  .describe('A media attachment (image, video, audio, embed, or map).');

/** Inferred TypeScript type for a timeline media item. */
export type TimelineMedia = z.infer<typeof TimelineMediaSchema>;
