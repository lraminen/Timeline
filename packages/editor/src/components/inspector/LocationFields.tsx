import { useEffect, useState } from 'react';
import { ExternalLink, MapPin, Trash2 } from 'lucide-react';
import type { TimelineLocation } from '@chronicle/schema';
import { Field } from '../ui.js';

/** Numeric input that tolerates in-progress text like "-" or "41." */
function NumberField({
  label,
  value,
  min,
  max,
  onCommit,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onCommit: (n: number) => void;
}) {
  const [text, setText] = useState(String(value));
  useEffect(() => {
    setText((t) => (Number(t) === value ? t : String(value)));
  }, [value]);
  const n = Number(text);
  const error =
    text.trim() === '' || !Number.isFinite(n)
      ? 'Enter a number'
      : n < min || n > max
        ? `Between ${String(min)} and ${String(max)}`
        : null;

  return (
    <Field label={label} error={error}>
      {(p) => (
        <input
          {...p}
          className="input"
          inputMode="decimal"
          value={text}
          onChange={(e) => {
            const next = e.target.value;
            setText(next);
            const parsed = Number(next);
            if (next.trim() !== '' && Number.isFinite(parsed) && parsed >= min && parsed <= max)
              onCommit(parsed);
          }}
        />
      )}
    </Field>
  );
}

/**
 * Latitude/longitude entry. (Picking on a map arrives with the map renderer;
 * an OpenStreetMap link lets authors check the point meanwhile.)
 */
export function LocationFields({
  location,
  onChange,
}: {
  location: TimelineLocation | undefined;
  onChange: (location: TimelineLocation | undefined) => void;
}) {
  if (!location) {
    return (
      <button
        type="button"
        className="btn-secondary"
        onClick={() => {
          onChange({ lat: 0, lng: 0 });
        }}
      >
        <MapPin size={15} aria-hidden /> Add a location
      </button>
    );
  }

  const zoom = location.zoom ?? 10;
  const osm = `https://www.openstreetmap.org/?mlat=${String(location.lat)}&mlon=${String(location.lng)}#map=${String(zoom)}/${String(location.lat)}/${String(location.lng)}`;

  return (
    <div className="space-y-2">
      <Field label="Place name">
        {(p) => (
          <input
            {...p}
            className="input"
            placeholder="e.g. Rome, Italy"
            value={location.label ?? ''}
            onChange={(e) => {
              onChange({ ...location, label: e.target.value || undefined });
            }}
          />
        )}
      </Field>
      <div className="grid grid-cols-2 gap-2">
        <NumberField
          label="Latitude"
          value={location.lat}
          min={-90}
          max={90}
          onCommit={(lat) => {
            onChange({ ...location, lat });
          }}
        />
        <NumberField
          label="Longitude"
          value={location.lng}
          min={-180}
          max={180}
          onCommit={(lng) => {
            onChange({ ...location, lng });
          }}
        />
      </div>
      <div className="flex items-center justify-between">
        <a
          href={osm}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-xs text-blue-700 underline"
        >
          Check on OpenStreetMap <ExternalLink size={12} aria-hidden />
          <span className="sr-only">(opens in a new tab)</span>
        </a>
        <button
          type="button"
          className="btn-ghost px-2 py-1 text-xs text-red-700"
          onClick={() => {
            onChange(undefined);
          }}
        >
          <Trash2 size={13} aria-hidden /> Remove location
        </button>
      </div>
    </div>
  );
}
