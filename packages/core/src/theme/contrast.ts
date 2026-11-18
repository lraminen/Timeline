/** WCAG 2.x relative luminance of a `#rrggbb` colour; `null` if not parseable. */
export function relativeLuminance(hex: string): number | null {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim());
  if (!m) return null;
  const [r, g, b] = [m[1], m[2], m[3]].map((part) => {
    const c = parseInt(part, 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio (1–21) between two `#rrggbb` colours; `null` if either is invalid. */
export function contrastRatio(a: string, b: string): number | null {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  if (la === null || lb === null) return null;
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Foreground/background token pairs that the renderer draws as text, with
 * where they appear. Used by tests and by the editor's theme builder.
 */
export const TEXT_CONTRAST_PAIRS = [
  ['text', 'surface', 'Card titles'],
  ['text', 'surfaceAlt', 'Search input text'],
  ['textSecondary', 'surface', 'Card body, filter buttons'],
  ['textSecondary', 'surfaceAlt', 'Tags, media captions'],
  ['textSecondary', 'background', 'Empty state'],
  ['primary', 'surface', 'Event dates'],
  ['textInverse', 'primary', 'Active filter button, skip link'],
] as const;
