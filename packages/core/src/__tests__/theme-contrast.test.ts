import { describe, it, expect } from 'vitest';
import { getAllThemes } from '../theme/index.js';
import type { ThemeTokens } from '../types.js';

/** WCAG 2.x relative luminance of a #rrggbb colour. */
function luminance(hex: string): number {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) throw new Error(`expected #rrggbb, got ${hex}`);
  const [r, g, b] = [m[1], m[2], m[3]].map((h) => {
    const c = parseInt(h, 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

type ColorKey = keyof ThemeTokens['colors'];

/**
 * Foreground/background token pairs that BASE_STYLES actually renders as
 * text. Keep in sync with renderer/styles.ts.
 */
const TEXT_PAIRS: [fg: ColorKey, bg: ColorKey, where: string][] = [
  ['text', 'surface', 'card titles'],
  ['text', 'surfaceAlt', 'search input text'],
  ['textSecondary', 'surface', 'card body, filter buttons'],
  ['textSecondary', 'surfaceAlt', 'tags, media captions'],
  ['textSecondary', 'background', 'empty state'],
  ['primary', 'surface', 'event dates'],
  ['textInverse', 'primary', 'active filter button, skip link'],
];

describe.each(getAllThemes().map((t) => [t.name, t] as const))('theme %s', (_name, theme) => {
  it.each(TEXT_PAIRS)('%s on %s (%s) meets WCAG AA 4.5:1', (fg, bg) => {
    const ratio = contrast(theme.colors[fg], theme.colors[bg]);
    expect(
      ratio,
      `${theme.colors[fg]} on ${theme.colors[bg]} = ${ratio.toFixed(2)}`,
    ).toBeGreaterThanOrEqual(4.5);
  });
});
