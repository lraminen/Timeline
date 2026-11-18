import { useId, useState } from 'react';
import { ArrowUpToLine, ImagePlus, Link as LinkIcon, Trash2, Upload } from 'lucide-react';
import { getOEmbedUrl } from '@chronicle/core';
import { isSafeMediaUrl, type TimelineMedia } from '@chronicle/schema';
import { guessMediaType } from '../../lib/import-csv.js';
import { Field } from '../ui.js';

/** Embedded uploads live inside the timeline file until server uploads exist (Phase 3). */
export const MAX_EMBED_BYTES = 2 * 1024 * 1024;

const TYPE_LABELS: Record<TimelineMedia['type'], string> = {
  image: 'Image',
  video: 'Video file',
  audio: 'Audio file',
  oembed: 'Embed (YouTube, Vimeo…)',
  map: 'Map (Google Maps embed)',
};

function dataKind(type: TimelineMedia['type']) {
  return type === 'image' || type === 'video' || type === 'audio' ? type : undefined;
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') resolve(reader.result);
      else reject(new Error('Could not read file'));
    };
    reader.onerror = () => {
      reject(reader.error ?? new Error('Could not read file'));
    };
    reader.readAsDataURL(file);
  });
}

function MediaItem({
  media,
  index,
  onChange,
  onRemove,
  onMakePrimary,
}: {
  media: TimelineMedia;
  index: number;
  onChange: (patch: Partial<TimelineMedia>) => void;
  onRemove: () => void;
  onMakePrimary?: () => void;
}) {
  const safe = isSafeMediaUrl(media.url, dataKind(media.type));
  const embed = media.type === 'oembed' || media.type === 'map' ? getOEmbedUrl(media.url) : null;
  const isDataUrl = media.url.startsWith('data:');

  return (
    <li className="space-y-2 rounded-md border border-slate-200 bg-white p-3">
      <div className="flex gap-3">
        <div className="flex h-16 w-24 shrink-0 items-center justify-center overflow-hidden rounded bg-slate-100 text-xs text-slate-600">
          {media.type === 'image' && safe ? (
            <img src={media.url} alt="" className="h-full w-full object-cover" />
          ) : (
            TYPE_LABELS[media.type].split(' ')[0]
          )}
        </div>
        <div className="min-w-0 flex-1 space-y-1">
          <p className="text-xs font-medium text-slate-700">
            {index === 0 ? 'Primary media (shown on the card)' : `Media ${String(index + 1)}`}
          </p>
          {!safe && <p className="text-xs text-red-700">This URL scheme is not allowed.</p>}
          {safe && (media.type === 'oembed' || media.type === 'map') && (
            <p className="text-xs text-slate-600">
              {embed
                ? 'Will be embedded in a sandboxed player.'
                : 'Not a supported embed provider — shown as a link.'}
            </p>
          )}
          {isDataUrl && (
            <p className="text-xs text-slate-600">Uploaded file (stored inside the timeline).</p>
          )}
          <div className="flex gap-1 pt-1">
            {onMakePrimary && (
              <button type="button" className="btn-ghost px-2 py-1 text-xs" onClick={onMakePrimary}>
                <ArrowUpToLine size={13} aria-hidden /> Make primary
              </button>
            )}
            <button
              type="button"
              className="btn-ghost px-2 py-1 text-xs text-red-700"
              onClick={onRemove}
            >
              <Trash2 size={13} aria-hidden /> Remove
            </button>
          </div>
        </div>
      </div>

      {!isDataUrl && (
        <Field label="URL" error={safe ? null : 'Use an http(s) or relative URL'}>
          {(p) => (
            <input
              {...p}
              className="input"
              value={media.url}
              onChange={(e) => {
                onChange({ url: e.target.value });
              }}
            />
          )}
        </Field>
      )}
      <Field label="Type">
        {(p) => (
          <select
            {...p}
            className="input"
            value={media.type}
            onChange={(e) => {
              onChange({ type: e.target.value as TimelineMedia['type'] });
            }}
          >
            {Object.entries(TYPE_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        )}
      </Field>
      {media.type === 'image' && (
        <Field
          label="Alt text"
          hint="Describe the image for people who can't see it."
          error={media.alt?.trim() ? null : 'Alt text is recommended for images'}
        >
          {(p) => (
            <input
              {...p}
              className="input"
              value={media.alt ?? ''}
              onChange={(e) => {
                onChange({ alt: e.target.value || undefined });
              }}
            />
          )}
        </Field>
      )}
      <div className="grid grid-cols-2 gap-2">
        <Field label="Caption">
          {(p) => (
            <input
              {...p}
              className="input"
              value={media.caption ?? ''}
              onChange={(e) => {
                onChange({ caption: e.target.value || undefined });
              }}
            />
          )}
        </Field>
        <Field label="Credit">
          {(p) => (
            <input
              {...p}
              className="input"
              value={media.credit ?? ''}
              onChange={(e) => {
                onChange({ credit: e.target.value || undefined });
              }}
            />
          )}
        </Field>
      </div>
    </li>
  );
}

export function MediaManager({
  media,
  onChange,
}: {
  media: TimelineMedia[];
  onChange: (media: TimelineMedia[]) => void;
}) {
  const id = useId();
  const [url, setUrl] = useState('');
  const [error, setError] = useState<string | null>(null);

  const addUrl = () => {
    const trimmed = url.trim();
    if (!trimmed) return;
    const type = guessMediaType(trimmed);
    if (!isSafeMediaUrl(trimmed, dataKind(type))) {
      setError('That URL scheme is not allowed. Use an http(s) link.');
      return;
    }
    onChange([...media, { type, url: trimmed }]);
    setUrl('');
    setError(null);
  };

  const addFile = async (file: File) => {
    const type = file.type.split('/')[0];
    if (type !== 'image' && type !== 'video' && type !== 'audio') {
      setError('Choose an image, video or audio file.');
      return;
    }
    if (file.size > MAX_EMBED_BYTES) {
      setError(
        `That file is ${(file.size / 1024 / 1024).toFixed(1)} MB. Files are stored inside the timeline for now, so the limit is 2 MB — link to a hosted copy instead.`,
      );
      return;
    }
    const dataUrl = await readAsDataUrl(file);
    onChange([...media, { type, url: dataUrl, alt: type === 'image' ? '' : undefined }]);
    setError(null);
  };

  return (
    <div className="space-y-3">
      {media.length > 0 && (
        <ul className="space-y-2">
          {media.map((m, i) => (
            <MediaItem
              // Media items have no ids. The key must not include editable fields
              // (e.g. the URL), or typing would remount the item and drop focus.
              key={i}
              media={m}
              index={i}
              onChange={(patch) => {
                onChange(media.map((item, j) => (j === i ? { ...item, ...patch } : item)));
              }}
              onRemove={() => {
                onChange(media.filter((_, j) => j !== i));
              }}
              onMakePrimary={
                i > 0
                  ? () => {
                      onChange([m, ...media.filter((_, j) => j !== i)]);
                    }
                  : undefined
              }
            />
          ))}
        </ul>
      )}

      <div className="space-y-2 rounded-md border border-dashed border-slate-300 p-3">
        <label htmlFor={`${id}-url`} className="label flex items-center gap-1">
          <LinkIcon size={13} aria-hidden /> Add from a link
        </label>
        <div className="flex gap-2">
          <input
            id={`${id}-url`}
            className="input"
            placeholder="https://…  (image, YouTube, Vimeo, Google Maps)"
            value={url}
            aria-describedby={error ? `${id}-error` : undefined}
            onChange={(e) => {
              setUrl(e.target.value);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                addUrl();
              }
            }}
          />
          <button
            type="button"
            className="btn-secondary shrink-0"
            onClick={addUrl}
            disabled={!url.trim()}
          >
            <ImagePlus size={15} aria-hidden /> Add
          </button>
        </div>
        {/* The (visually hidden) file input is the real, labelled control: one tab stop. */}
        <label className="btn-ghost cursor-pointer px-2 py-1 text-xs focus-within:ring-2 focus-within:ring-blue-600">
          <Upload size={13} aria-hidden /> Upload a file (max 2 MB)
          <input
            type="file"
            accept="image/*,video/*,audio/*"
            className="sr-only"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void addFile(file);
              e.target.value = '';
            }}
          />
        </label>
        {error && (
          <p id={`${id}-error`} className="text-xs text-red-700" role="alert">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
