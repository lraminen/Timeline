import { z } from 'zod';
import { TimelineEventSchema } from './event.js';
import { TimelineEraSchema } from './era.js';

/**
 * Schema for global timeline display settings.
 */
/** `#rrggbb` only: unambiguous, and safe to place in a CSS custom property. */
const HexColor = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, 'Expected a colour in #rrggbb form')
  .describe('A colour in #rrggbb form.');

/** Theme colour tokens that may be customised per timeline. */
export const THEME_OVERRIDE_COLOR_KEYS = [
  'primary',
  'background',
  'surface',
  'surfaceAlt',
  'text',
  'textSecondary',
  'textInverse',
  'border',
  'axisLine',
  'marker',
] as const;

export type ThemeOverrideColorKey = (typeof THEME_OVERRIDE_COLOR_KEYS)[number];

export const ThemeOverridesSchema = z
  .object({
    colors: z
      .object(
        Object.fromEntries(
          THEME_OVERRIDE_COLOR_KEYS.map((k) => [k, HexColor.optional()]),
        ) as Record<ThemeOverrideColorKey, z.ZodOptional<typeof HexColor>>,
      )
      .strict()
      .optional()
      .describe('Colour token overrides.'),
    fontFamily: z
      .string()
      .max(200)
      .regex(/^[\w\s,'"-]+$/, 'Font family may only contain names, quotes, commas and hyphens')
      .optional()
      .describe('CSS font-family list, e.g. "Georgia, serif".'),
    radius: z
      .enum(['none', 'small', 'medium', 'large'])
      .optional()
      .describe('Corner rounding preset.'),
  })
  .strict()
  .describe('Per-timeline customisation of the base theme.');

export type ThemeOverrides = z.infer<typeof ThemeOverridesSchema>;

export const TimelineSettingsSchema = z
  .object({
    layout: z
      .enum(['horizontal', 'vertical', 'card'])
      .default('vertical')
      .describe('Layout mode for the timeline renderer.'),
    theme: z
      .string()
      .default('light')
      .describe('Visual theme name, e.g. "light", "dark", or a custom theme.'),
    locale: z.string().default('en').describe('BCP-47 locale tag used for date formatting.'),
    startDate: z
      .string()
      .optional()
      .describe('Initial date the viewport should centre on when the timeline loads.'),
    zoomLevel: z
      .number()
      .optional()
      .describe('Initial zoom level (interpretation depends on the renderer).'),
    themeOverrides: ThemeOverridesSchema.optional().describe(
      'Customisations layered on top of the named theme, so custom themes travel with the document.',
    ),
  })
  .describe('Display and rendering settings for a Chronicle timeline.');

/** Inferred TypeScript type for timeline settings. */
export type TimelineSettings = z.infer<typeof TimelineSettingsSchema>;

/**
 * Root schema for a complete Chronicle timeline document.
 */
export const TimelineSchema = z
  .object({
    schemaVersion: z
      .literal('1.0.0')
      .default('1.0.0')
      .describe(
        'Schema version for forward-compatible migration. Must be "1.0.0" for this version.',
      ),
    id: z.string().describe('Unique identifier for the timeline.'),
    title: z.string().describe('Display title of the timeline.'),
    description: z.string().optional().describe('Optional longer description or subtitle.'),
    events: z
      .array(TimelineEventSchema)
      .describe('Ordered list of events that make up the timeline.'),
    eras: z
      .array(TimelineEraSchema)
      .default([])
      .describe('Named eras / periods rendered behind the events.'),
    settings: TimelineSettingsSchema.default({}).describe(
      'Display settings with sensible defaults.',
    ),
  })
  .describe('A complete Chronicle timeline document.');

/** Inferred TypeScript type for a full timeline. */
export type Timeline = z.infer<typeof TimelineSchema>;
