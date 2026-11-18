import { z } from 'zod';

/**
 * Schema for geographic locations associated with timeline events.
 */
export const TimelineLocationSchema = z
  .object({
    lat: z.number().min(-90).max(90).describe('Latitude in decimal degrees (-90 to 90).'),
    lng: z.number().min(-180).max(180).describe('Longitude in decimal degrees (-180 to 180).'),
    label: z
      .string()
      .optional()
      .describe('Human-readable place name, e.g. "Rome, Italy" or "Great Wall of China".'),
    zoom: z
      .number()
      .min(1)
      .max(20)
      .optional()
      .describe('Map zoom level from 1 (world) to 20 (building).'),
  })
  .describe('A geographic location with optional label and zoom level.');

/** Inferred TypeScript type for a timeline location. */
export type TimelineLocation = z.infer<typeof TimelineLocationSchema>;
