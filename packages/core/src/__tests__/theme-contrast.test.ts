import { describe, it, expect } from 'vitest';
import { getAllThemes, applyThemeOverrides, lightTheme } from '../theme/index.js';
import { contrastRatio, TEXT_CONTRAST_PAIRS } from '../theme/contrast.js';

describe.each(getAllThemes().map((t) => [t.name, t] as const))('theme %s', (_name, theme) => {
  it.each(TEXT_CONTRAST_PAIRS)('%s on %s (%s) meets WCAG AA 4.5:1', (fg, bg) => {
    const ratio = contrastRatio(theme.colors[fg], theme.colors[bg]);
    expect(ratio, `${theme.colors[fg]} on ${theme.colors[bg]}`).not.toBeNull();
    expect(ratio ?? 0, `${theme.colors[fg]} on ${theme.colors[bg]}`).toBeGreaterThanOrEqual(4.5);
  });
});

describe('contrastRatio', () => {
  it('matches known WCAG values', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrastRatio('#ffffff', '#ffffff')).toBeCloseTo(1, 5);
    expect(contrastRatio('#777777', '#ffffff')).toBeCloseTo(4.48, 2);
  });

  it('returns null for non-hex input', () => {
    expect(contrastRatio('red', '#ffffff')).toBeNull();
  });
});

describe('applyThemeOverrides', () => {
  it('returns the base theme unchanged when there are no overrides', () => {
    expect(applyThemeOverrides(lightTheme, undefined)).toBe(lightTheme);
  });

  it('layers colour, font and radius overrides without mutating the base', () => {
    const t = applyThemeOverrides(lightTheme, {
      colors: { primary: '#7c3aed' },
      fontFamily: 'Georgia, serif',
      radius: 'none',
    });
    expect(t.colors.primary).toBe('#7c3aed');
    expect(t.colors.marker).toBe('#7c3aed');
    expect(t.colors.text).toBe(lightTheme.colors.text);
    expect(t.typography.fontFamily).toBe('Georgia, serif');
    expect(t.borderRadius.md).toBe('0px');
    expect(lightTheme.colors.primary).not.toBe('#7c3aed');
  });
});
