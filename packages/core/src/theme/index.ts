import type { ThemeOverrides } from '@chronicle/schema';
import type { ThemeTokens } from '../types.js';
import { themeToCSSProperties } from './tokens.js';
import { lightTheme } from './light.js';
import { darkTheme } from './dark.js';
import { minimalTheme } from './minimal.js';
import { editorialTheme } from './editorial.js';

const themes = new Map<string, ThemeTokens>();

// Register default themes
themes.set('light', lightTheme);
themes.set('dark', darkTheme);
themes.set('minimal', minimalTheme);
themes.set('editorial', editorialTheme);

/**
 * Retrieves a theme by name, defaulting to lightTheme if not found.
 */
export function getTheme(name: string): ThemeTokens {
  return themes.get(name.toLowerCase()) ?? lightTheme;
}

/**
 * Returns all currently registered themes.
 */
export function getAllThemes(): ThemeTokens[] {
  return Array.from(themes.values());
}

/**
 * Registers a new or custom theme.
 */
export function registerTheme(theme: ThemeTokens): void {
  themes.set(theme.name.toLowerCase(), theme);
}

/**
 * Applies a theme's CSS custom properties to an HTMLElement.
 */
export function applyTheme(element: HTMLElement, theme: ThemeTokens): void {
  const props = themeToCSSProperties(theme);
  for (const [key, val] of Object.entries(props)) {
    element.style.setProperty(key, val);
  }
}

/**
 * Clears all `--chronicle-*` custom properties from an element.
 */
export function removeTheme(element: HTMLElement): void {
  const inlineStyles = element.style;
  const toRemove: string[] = [];
  for (const prop of Array.from(inlineStyles)) {
    if (prop.startsWith('--chronicle-')) {
      toRemove.push(prop);
    }
  }
  for (const prop of toRemove) {
    element.style.removeProperty(prop);
  }
}

const RADIUS_PRESETS: Record<NonNullable<ThemeOverrides['radius']>, ThemeTokens['borderRadius']> = {
  none: { sm: '0px', md: '0px', lg: '0px', full: '9999px' },
  small: { sm: '2px', md: '4px', lg: '6px', full: '9999px' },
  medium: { sm: '4px', md: '8px', lg: '12px', full: '9999px' },
  large: { sm: '8px', md: '14px', lg: '20px', full: '9999px' },
};

/**
 * Returns `theme` with a timeline's `settings.themeOverrides` applied.
 * Overrides are schema-validated (`#rrggbb` colours, restricted font names),
 * and are applied as CSS custom property values, so they cannot inject CSS.
 */
export function applyThemeOverrides(theme: ThemeTokens, overrides?: ThemeOverrides): ThemeTokens {
  if (!overrides) return theme;
  const colors = { ...theme.colors };
  for (const [key, value] of Object.entries(overrides.colors ?? {})) {
    if (value) colors[key as keyof typeof colors] = value;
  }
  // Keep derived tokens visually consistent with their overridden sources.
  if (overrides.colors?.primary && !overrides.colors.marker) colors.marker = colors.primary;
  if (overrides.colors?.primary) colors.markerActive = colors.primary;

  return {
    ...theme,
    name: `${theme.name}+custom`,
    colors,
    typography: overrides.fontFamily
      ? { ...theme.typography, fontFamily: overrides.fontFamily }
      : theme.typography,
    borderRadius: overrides.radius ? RADIUS_PRESETS[overrides.radius] : theme.borderRadius,
  };
}

export { themeToCSSProperties, lightTheme, darkTheme, minimalTheme, editorialTheme };
