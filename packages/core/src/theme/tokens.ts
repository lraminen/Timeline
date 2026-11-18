import type { ThemeTokens } from '../types.js';

/**
 * Converts a ThemeTokens configuration into a flat record of CSS custom properties.
 */
export function themeToCSSProperties(theme: ThemeTokens): Record<string, string> {
  const vars: Record<string, string> = {};

  // Colors
  vars['--chronicle-color-primary'] = theme.colors.primary;
  vars['--chronicle-color-primary-light'] = theme.colors.primaryLight;
  vars['--chronicle-color-secondary'] = theme.colors.secondary;
  vars['--chronicle-color-background'] = theme.colors.background;
  vars['--chronicle-color-surface'] = theme.colors.surface;
  vars['--chronicle-color-surface-alt'] = theme.colors.surfaceAlt;
  vars['--chronicle-color-text'] = theme.colors.text;
  vars['--chronicle-color-text-secondary'] = theme.colors.textSecondary;
  vars['--chronicle-color-text-inverse'] = theme.colors.textInverse;
  vars['--chronicle-color-border'] = theme.colors.border;
  vars['--chronicle-color-accent'] = theme.colors.accent;
  vars['--chronicle-color-error'] = theme.colors.error;
  vars['--chronicle-color-axis-line'] = theme.colors.axisLine;
  vars['--chronicle-color-marker'] = theme.colors.marker;
  vars['--chronicle-color-marker-active'] = theme.colors.markerActive;
  vars['--chronicle-color-era-background'] = theme.colors.eraBackground;

  // Typography
  vars['--chronicle-font-family'] = theme.typography.fontFamily;
  vars['--chronicle-font-family-mono'] = theme.typography.fontFamilyMono;
  vars['--chronicle-font-size-base'] = theme.typography.fontSizeBase;
  vars['--chronicle-font-size-sm'] = theme.typography.fontSizeSm;
  vars['--chronicle-font-size-lg'] = theme.typography.fontSizeLg;
  vars['--chronicle-font-size-xl'] = theme.typography.fontSizeXl;
  vars['--chronicle-font-size-title'] = theme.typography.fontSizeTitle;
  vars['--chronicle-line-height'] = theme.typography.lineHeight;
  vars['--chronicle-font-weight-normal'] = theme.typography.fontWeightNormal;
  vars['--chronicle-font-weight-medium'] = theme.typography.fontWeightMedium;
  vars['--chronicle-font-weight-bold'] = theme.typography.fontWeightBold;

  // Spacing
  vars['--chronicle-spacing-xs'] = theme.spacing.xs;
  vars['--chronicle-spacing-sm'] = theme.spacing.sm;
  vars['--chronicle-spacing-md'] = theme.spacing.md;
  vars['--chronicle-spacing-lg'] = theme.spacing.lg;
  vars['--chronicle-spacing-xl'] = theme.spacing.xl;
  vars['--chronicle-spacing-xxl'] = theme.spacing.xxl;

  // Border Radius
  vars['--chronicle-radius-sm'] = theme.borderRadius.sm;
  vars['--chronicle-radius-md'] = theme.borderRadius.md;
  vars['--chronicle-radius-lg'] = theme.borderRadius.lg;
  vars['--chronicle-radius-full'] = theme.borderRadius.full;

  // Shadows
  vars['--chronicle-shadow-sm'] = theme.shadows.sm;
  vars['--chronicle-shadow-md'] = theme.shadows.md;
  vars['--chronicle-shadow-lg'] = theme.shadows.lg;

  // Transitions
  vars['--chronicle-transition-fast'] = theme.transitions.fast;
  vars['--chronicle-transition-normal'] = theme.transitions.normal;
  vars['--chronicle-transition-slow'] = theme.transitions.slow;

  // Media
  vars['--chronicle-media-max-height'] = theme.media.maxMediaHeight;
  vars['--chronicle-thumbnail-size'] = theme.media.thumbnailSize;

  return vars;
}
