import { useId, useState } from 'react';
import { ArrowUpToLine, ImagePlus, Link as LinkIcon, Sparkles, Trash2, Upload } from 'lucide-react';
import { getOEmbedUrl } from '@chronicle/core';
import { isSafeMediaUrl, type TimelineMedia } from '@chronicle/schema';
import { guessMediaType } from '../../lib/import-csv.js';
import { Field } from '../ui.js';
import { useCloud } from '../../cloud/cloud-store.js';
import { useEditor } from '../../store/editor-store.js';

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
  eventTitle,
  onChange,
  onRemove,
  onMakePrimary,
}: {
  media: TimelineMedia;
  index: number;
  eventTitle?: string;
  onChange: (patch: Partial<TimelineMedia>) => void;
  onRemove: () => void;
  onMakePrimary?: () => void;
}) {
  const safe = isSafeMediaUrl(media.url, dataKind(media.type));
  const embed = media.type === 'oembed' || media.type === 'map' ? getOEmbedUrl(media.url) : null;
  const isDataUrl = media.url.startsWith('data:');
  const api = useCloud((s) => s.api);
  const user = useCloud((s) => s.user);
  const projectId = useEditor((s) => s.remote?.projectId);
  const [altBusy, setAltBusy] = useState(false);
  const [altSuggestion, setAltSuggestion] = useState<{ altText: string; confidence: number } | null>(
    null,
  );
  const [altError, setAltError] = useState<string | null>(null);

  const suggestAlt = async () => {
    if (!api?.aiAltText || !user) return;
    setAltBusy(true);
    setAltError(null);
    try {
      const res = await api.aiAltText({
        ...(isDataUrl ? { imageDataUrl: media.url } : { imageUrl: media.url }),
        eventTitle,
        caption: media.caption,
        projectId,
      });
      setAltSuggestion({ altText: res.altText, confidence: res.confidence });
    } catch (err) {
      setAltError(err instanceof Error ? err.message : String(err));
    } finally {
      setAltBusy(false);
    }
  };

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
        <div className="space-y-1.5">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-medium text-slate-700">Alt text</span>
            {api?.aiAltText && user && safe && (
              <button
                type="button"
                className="btn-ghost px-1.5 py-0.5 text-[11px]"
                disabled={altBusy}
                onClick={() => void suggestAlt()}
              >
                <Sparkles size={11} aria-hidden />
                {altBusy ? 'Generating…' : 'Suggest alt text'}
              </button>
            )}
          </div>
          <Field
            label="Alt text"
            className="[&>label]:sr-only"
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
          {altError && (
            <p className="text-xs text-red-700" role="alert">
              {altError}
            </p>
          )}
          {altSuggestion && (
            <div className="space-y-1.5 rounded border border-purple-200 bg-purple-50/70 p-2 text-xs">
              <div className="flex items-center justify-between">
                <span className="inline-flex items-center gap-1 font-medium text-purple-900">
                  <Sparkles size={11} aria-hidden /> AI alt-text suggestion (
                  {String(Math.round(altSuggestion.confidence * 100))}%)
                </span>
              </div>
              <p className="text-slate-800">{altSuggestion.altText}</p>
              <div className="flex justify-end gap-1.5">
                <button
                  type="button"
                  className="btn-ghost px-2 py-0.5 text-xs"
                  onClick={() => {
                    setAltSuggestion(null);
                  }}
                >
                  Dismiss
                </button>
                <button
                  type="button"
                  className="btn-primary px-2 py-0.5 text-xs"
                  onClick={() => {
                    onChange({ alt: altSuggestion.altText });
                    setAltSuggestion(null);
                  }}
                >
                  Apply
                </button>
              </div>
            </div>
          )}
        </div>
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
  eventTitle,
  onChange,
}: {
  media: TimelineMedia[];
  eventTitle?: string;
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

  const api = useCloud((s) => s.api);
  const user = useCloud((s) => s.user);
  const remote = useEditor((s) => s.remote);
  /** Linked + signed in: upload to the server's media pipeline instead of embedding. */
  const serverUpload =
    api && user && remote && remote.role !== 'viewer' ? { api, projectId: remote.projectId } : null;
  const [uploading, setUploading] = useState(false);

  const addFile = async (file: File) => {
    const type = file.type.split('/')[0];
    if (type !== 'image' && type !== 'video' && type !== 'audio') {
      setError('Choose an image, video or audio file.');
      return;
    }
    if (serverUpload) {
      setUploading(true);
      setError(null);
      try {
        const uploaded = await serverUpload.api.uploadMedia(serverUpload.projectId, file);
        onChange([
          ...media,
          {
            type: uploaded.kind,
            url: uploaded.url,
            alt: uploaded.kind === 'image' ? '' : undefined,
          },
        ]);
      } catch (err) {
        setError(`Upload failed: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        setUploading(false);
      }
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
              eventTitle={eventTitle}
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
          <Upload size={13} aria-hidden />{' '}
          {uploading
            ? 'Uploading…'
            : serverUpload
              ? 'Upload a file (optimised and stored on Chronicle)'
              : 'Upload a file (max 2 MB, stored in the timeline)'}
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
