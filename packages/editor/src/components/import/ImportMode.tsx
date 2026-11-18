export type Mode = 'replace' | 'append';

export function ImportMode({ mode, onChange }: { mode: Mode; onChange: (m: Mode) => void }) {
  return (
    <fieldset className="space-y-1">
      <legend className="label">How should these events be added?</legend>
      {(
        [
          ['replace', 'Replace the current timeline', 'You can undo this.'],
          ['append', 'Add to the current timeline', 'Keeps your existing events.'],
        ] as const
      ).map(([value, label, hint]) => (
        <label key={value} className="flex items-start gap-2 text-sm text-slate-800">
          <input
            type="radio"
            name="import-mode"
            className="mt-0.5"
            checked={mode === value}
            onChange={() => {
              onChange(value);
            }}
          />
          <span>
            {label} <span className="text-xs text-slate-600">— {hint}</span>
          </span>
        </label>
      ))}
    </fieldset>
  );
}
