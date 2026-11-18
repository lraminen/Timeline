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

export { themeToCSSProperties, lightTheme, darkTheme, minimalTheme, editorialTheme };
