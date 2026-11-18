import { useMemo } from 'react';
import { Check, RotateCcw, TriangleAlert } from 'lucide-react';
import {
  TEXT_CONTRAST_PAIRS,
  applyThemeOverrides,
  contrastRatio,
  getAllThemes,
  getTheme,
} from '@chronicle/core';
import {
  THEME_OVERRIDE_COLOR_KEYS,
  type ThemeOverrideColorKey,
  type ThemeOverrides,
} from '@chronicle/schema';
import { useEditor } from '../../store/editor-store.js';
import { updateSettings } from '../../store/commands.js';
import { Field, Section } from '../ui.js';

const COLOR_LABELS: Record<ThemeOverrideColorKey, string> = {
  primary: 'Accent (dates, buttons)',
  background: 'Page background',
  surface: 'Card background',
  surfaceAlt: 'Subtle background',
  text: 'Text',
  textSecondary: 'Secondary text',
  textInverse: 'Text on accent',
  border: 'Borders',
  axisLine: 'Axis line',
  marker: 'Event markers',
};

const FONTS = [
  { label: 'Theme default', value: '' },
  { label: 'System sans-serif', value: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif' },
  { label: 'Serif', value: 'Georgia, "Times New Roman", serif' },
  { label: 'Humanist', value: '"Gill Sans", "Trebuchet MS", Calibri, sans-serif' },
  { label: 'Monospace', value: 'ui-monospace, Menlo, Consolas, monospace' },
];

const RADII: { value: NonNullable<ThemeOverrides['radius']> | ''; label: string }[] = [
  { value: '', label: 'Theme default' },
  { value: 'none', label: 'Square' },
  { value: 'small', label: 'Small' },
  { value: 'medium', label: 'Medium' },
  { value: 'large', label: 'Large' },
];

const HEX = /^#[0-9a-f]{6}$/i;

/** Drops empty sub-objects so the stored document stays minimal. */
function compact(o: ThemeOverrides): ThemeOverrides | undefined {
  const colors = Object.fromEntries(Object.entries(o.colors ?? {}).filter(([, v]) => v));
  const next: ThemeOverrides = {
    ...(Object.keys(colors).length ? { colors } : {}),
    ...(o.fontFamily ? { fontFamily: o.fontFamily } : {}),
    ...(o.radius ? { radius: o.radius } : {}),
  };
  return Object.keys(next).length ? next : undefined;
}

export function ThemePanel() {
  const settings = useEditor((s) => s.doc.settings);
  const execute = useEditor((s) => s.execute);
  const overrides = settings.themeOverrides ?? {};
  const resolved = useMemo(
    () => applyThemeOverrides(getTheme(settings.theme), settings.themeOverrides),
    [settings.theme, settings.themeOverrides],
  );

  const setOverrides = (next: ThemeOverrides) => {
    execute(updateSettings(useEditor.getState().doc, { themeOverrides: compact(next) }));
  };
  const setColor = (key: ThemeOverrideColorKey, value: string | undefined) => {
    setOverrides({ ...overrides, colors: { ...overrides.colors, [key]: value } });
  };

  const checks = TEXT_CONTRAST_PAIRS.map(([fg, bg, where]) => ({
    where,
    fg,
    bg,
    ratio: contrastRatio(resolved.colors[fg], resolved.colors[bg]) ?? 0,
  }));
  const failing = checks.filter((c) => c.ratio < 4.5);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <Section
        title="Base theme"
        actions={
          settings.themeOverrides && (
            <button
              type="button"
              className="btn-ghost px-2 py-1 text-xs"
              onClick={() => {
                setOverrides({});
              }}
            >
              <RotateCcw size={13} aria-hidden /> Reset customisations
            </button>
          )
        }
      >
        <Field label="Start from">
          {(p) => (
            <select
              {...p}
              className="input"
              value={settings.theme}
              onChange={(e) => {
                execute(updateSettings(useEditor.getState().doc, { theme: e.target.value }));
              }}
            >
              {getAllThemes().map((t) => (
                <option key={t.name} value={t.name}>
                  {t.name[0].toUpperCase() + t.name.slice(1)}
                </option>
              ))}
            </select>
          )}
        </Field>
      </Section>

      <Section title="Colours">
        <ul className="space-y-2">
          {THEME_OVERRIDE_COLOR_KEYS.map((key) => {
            const custom = overrides.colors?.[key];
            const value = resolved.colors[key];
            return (
              <li key={key} className="flex items-center gap-2">
                <input
                  type="color"
                  aria-label={`${COLOR_LABELS[key]} colour`}
                  className="h-8 w-9 shrink-0 cursor-pointer rounded border border-slate-300 bg-white p-0.5"
                  value={HEX.test(value) ? value : '#000000'}
                  onChange={(e) => {
                    setColor(key, e.target.value);
                  }}
                />
                <span className="min-w-0 flex-1 text-sm text-slate-800">
                  {COLOR_LABELS[key]}
                  {custom && <span className="ml-1 text-xs text-blue-700">(custom)</span>}
                </span>
                <code className="text-xs text-slate-600">{value}</code>
                {custom && (
                  <button
                    type="button"
                    className="icon-btn h-7 w-7"
                    aria-label={`Reset ${COLOR_LABELS[key]}`}
                    onClick={() => {
                      setColor(key, undefined);
                    }}
                  >
                    <RotateCcw size={13} aria-hidden />
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      </Section>

      <Section title="Typography & shape">
        <Field label="Font">
          {(p) => (
            <select
              {...p}
              className="input"
              value={overrides.fontFamily ?? ''}
              onChange={(e) => {
                setOverrides({ ...overrides, fontFamily: e.target.value || undefined });
              }}
            >
              {FONTS.map((f) => (
                <option key={f.label} value={f.value}>
                  {f.label}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label="Corners">
          {(p) => (
            <select
              {...p}
              className="input"
              value={overrides.radius ?? ''}
              onChange={(e) => {
                setOverrides({
                  ...overrides,
                  radius: (e.target.value || undefined) as ThemeOverrides['radius'],
                });
              }}
            >
              {RADII.map((r) => (
                <option key={r.label} value={r.value}>
                  {r.label}
                </option>
              ))}
            </select>
          )}
        </Field>
      </Section>

      <Section title="Accessibility check">
        <p
          className={`text-sm ${failing.length ? 'text-amber-800' : 'text-green-800'}`}
          role="status"
        >
          {failing.length
            ? `${String(failing.length)} colour pair${failing.length > 1 ? 's' : ''} below WCAG AA (4.5:1).`
            : 'All text colours meet WCAG AA contrast (4.5:1).'}
        </p>
        <ul className="space-y-1">
          {checks.map((c) => (
            <li key={`${c.fg}-${c.bg}`} className="flex items-center gap-2 text-xs">
              {c.ratio >= 4.5 ? (
                <Check size={14} className="shrink-0 text-green-700" aria-label="Passes" />
              ) : (
                <TriangleAlert size={14} className="shrink-0 text-amber-700" aria-label="Fails" />
              )}
              <span
                className="inline-flex h-5 w-8 shrink-0 items-center justify-center rounded border border-slate-200 text-[10px] font-semibold"
                style={{ color: resolved.colors[c.fg], backgroundColor: resolved.colors[c.bg] }}
                aria-hidden
              >
                Aa
              </span>
              <span className="flex-1 text-slate-700">{c.where}</span>
              <span className={c.ratio >= 4.5 ? 'text-slate-600' : 'font-semibold text-amber-800'}>
                {c.ratio.toFixed(1)}:1
              </span>
            </li>
          ))}
        </ul>
      </Section>
    </div>
  );
}
