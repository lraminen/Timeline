import { useMemo, useState } from 'react';
import { Copy, MousePointerClick, Sparkles, Trash2 } from 'lucide-react';
import type { TimelineEvent } from '@chronicle/schema';
import { useCloud } from '../../cloud/cloud-store.js';
import { useEditor, selectSelectedEvent } from '../../store/editor-store.js';
import { patchObject, updateEvent } from '../../store/commands.js';
import { addNewEvent, deleteSelected, duplicateSelected } from '../../actions.js';
import { allTags } from '../../lib/document.js';
import { useIssues } from '../../hooks.js';
import { Field, Section } from '../ui.js';
import { DateField } from './DateField.js';
import { RichTextEditor } from './RichTextEditor.js';
import { MediaManager } from './MediaManager.js';
import { TagInput } from './TagInput.js';
import { LocationFields } from './LocationFields.js';

export function Inspector() {
  const event = useEditor(selectSelectedEvent);

  if (!event) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center text-sm text-slate-600">
        <MousePointerClick size={28} className="text-slate-400" aria-hidden />
        <p>Select an event in the list or the preview to edit it.</p>
        <button type="button" className="btn-secondary" onClick={addNewEvent}>
          Add an event
        </button>
      </div>
    );
  }
  // Remount per event so local field state (e.g. half-typed years) never leaks between events.
  return <EventForm key={event.id} event={event} />;
}

function EventForm({ event }: { event: TimelineEvent }) {
  const execute = useEditor((s) => s.execute);
  const doc = useEditor((s) => s.doc);
  const projectId = useEditor((s) => s.remote?.projectId);
  const setSidebarTab = useEditor((s) => s.setSidebarTab);
  const api = useCloud((s) => s.api);
  const user = useCloud((s) => s.user);
  const issues = useIssues();
  const tagSuggestions = useMemo(() => allTags(doc), [doc]);

  const [summaryBusy, setSummaryBusy] = useState(false);
  const [summarySuggestion, setSummarySuggestion] = useState<string | null>(null);
  const [summaryError, setSummaryError] = useState<string | null>(null);

  const fieldError = (field: string) =>
    issues
      .find((i) => i.eventId === event.id && i.field === field && i.severity === 'error')
      ?.message.replace(/^.*?— /, '') ?? null;

  const update = (patch: Partial<TimelineEvent>) => {
    execute(updateEvent(useEditor.getState().doc, event.id, patch));
  };
  /** `undefined` clears an optional date field (e.g. unticking “Approximate”). */
  const updateDate = (patch: Partial<TimelineEvent['date']>) => {
    update({ date: patchObject(event.date, patch) });
  };

  const locale = doc.settings.locale;

  return (
    <form
      aria-label={`Edit event: ${event.title || 'untitled'}`}
      className="min-h-0 flex-1 overflow-y-auto"
      onSubmit={(e) => {
        e.preventDefault();
      }}
    >
      <Section
        title="Event"
        actions={
          <div className="flex gap-0.5">
            <button
              type="button"
              className="icon-btn h-7 w-7"
              aria-label="Duplicate event"
              onClick={duplicateSelected}
            >
              <Copy size={15} aria-hidden />
            </button>
            <button
              type="button"
              className="icon-btn h-7 w-7"
              aria-label="Delete event"
              onClick={deleteSelected}
            >
              <Trash2 size={15} aria-hidden />
            </button>
          </div>
        }
      >
        <Field label="Title" error={event.title.trim() ? null : 'Title is required'}>
          {(p) => (
            <input
              {...p}
              className="input"
              value={event.title}
              onChange={(e) => {
                update({ title: e.target.value });
              }}
            />
          )}
        </Field>

        <DateField
          legend="Date"
          value={event.date.start}
          locale={locale}
          error={fieldError('date.start')}
          onChange={(start) => {
            updateDate({ start });
          }}
          onApplyNormalized={(normalized) => {
            update({ date: normalized });
          }}
        />

        {event.date.end === undefined ? (
          <button
            type="button"
            className="btn-ghost px-2 py-1 text-xs"
            onClick={() => {
              updateDate({ end: event.date.start });
            }}
          >
            + Add an end date (date range)
          </button>
        ) : (
          <div className="space-y-1">
            <DateField
              legend="End date"
              value={event.date.end}
              locale={locale}
              error={fieldError('date.end')}
              onChange={(end) => {
                updateDate({ end });
              }}
            />
            <button
              type="button"
              className="btn-ghost px-2 py-1 text-xs"
              onClick={() => {
                updateDate({ end: undefined });
              }}
            >
              Remove end date
            </button>
          </div>
        )}

        <fieldset className="flex flex-wrap gap-x-4 gap-y-1">
          <legend className="sr-only">Date certainty</legend>
          <label className="flex items-center gap-1.5 text-sm text-slate-800">
            <input
              type="checkbox"
              className="h-4 w-4 rounded border-slate-400"
              checked={event.date.approximate ?? false}
              onChange={(e) => {
                updateDate({ approximate: e.target.checked || undefined });
              }}
            />
            Approximate (~)
          </label>
          <label className="flex items-center gap-1.5 text-sm text-slate-800">
            <input
              type="checkbox"
              className="h-4 w-4 rounded border-slate-400"
              checked={event.date.uncertain ?? false}
              onChange={(e) => {
                updateDate({ uncertain: e.target.checked || undefined });
              }}
            />
            Uncertain (?)
          </label>
        </fieldset>

        <Field
          label="Date label (optional)"
          hint="Shown instead of the date, e.g. “Spring 1940” or “The Renaissance”."
        >
          {(p) => (
            <input
              {...p}
              className="input"
              value={event.date.displayOverride ?? ''}
              onChange={(e) => {
                updateDate({ displayOverride: e.target.value || undefined });
              }}
            />
          )}
        </Field>
      </Section>

      <Section
        title="Description"
        actions={
          api?.aiSummarize && user && event.body?.trim() ? (
            <button
              type="button"
              className="btn-ghost px-2 py-1 text-xs"
              disabled={summaryBusy}
              onClick={() => {
                if (!api.aiSummarize || !event.body?.trim()) return;
                setSummaryBusy(true);
                setSummaryError(null);
                void api
                  .aiSummarize({
                    eventId: event.id,
                    projectId,
                    title: event.title || 'Untitled event',
                    body: event.body,
                  })
                  .then((res) => {
                    setSummarySuggestion(res.summary);
                  })
                  .catch((err: unknown) => {
                    setSummaryError(err instanceof Error ? err.message : String(err));
                  })
                  .finally(() => {
                    setSummaryBusy(false);
                  });
              }}
            >
              <Sparkles size={13} aria-hidden />
              {summaryBusy ? 'Summarizing…' : 'Suggest summary'}
            </button>
          ) : undefined
        }
      >
        <RichTextEditor
          label="Event description"
          value={event.body ?? ''}
          onChange={(body) => {
            update({ body: body.trim() ? body : undefined });
          }}
        />
        {summaryError && (
          <p className="text-xs text-red-700" role="alert">
            {summaryError}
          </p>
        )}
        {summarySuggestion && (
          <div className="space-y-2 rounded-md border border-purple-200 bg-purple-50/70 p-2.5 text-xs">
            <div className="flex items-center justify-between">
              <span className="inline-flex items-center gap-1 font-medium text-purple-900">
                <Sparkles size={12} aria-hidden /> AI summary suggestion — review before applying
              </span>
            </div>
            <p className="text-slate-800">{summarySuggestion}</p>
            <div className="flex flex-wrap justify-end gap-1.5">
              <button
                type="button"
                className="btn-ghost px-2 py-1 text-xs"
                onClick={() => {
                  setSummarySuggestion(null);
                }}
              >
                Dismiss
              </button>
              <button
                type="button"
                className="btn-secondary px-2 py-1 text-xs"
                onClick={() => {
                  update({
                    body: event.body ? `${summarySuggestion}\n\n${event.body}` : summarySuggestion,
                  });
                  setSummarySuggestion(null);
                }}
              >
                Prepend
              </button>
              <button
                type="button"
                className="btn-primary px-2 py-1 text-xs"
                onClick={() => {
                  update({ body: summarySuggestion });
                  setSummarySuggestion(null);
                }}
              >
                Replace body
              </button>
            </div>
          </div>
        )}
      </Section>

      <Section title="Media">
        <MediaManager
          media={event.media}
          eventTitle={event.title}
          onChange={(media) => {
            update({ media });
          }}
        />
      </Section>

      <Section title="Organise">
        <TagInput
          tags={event.tags}
          suggestions={tagSuggestions}
          onChange={(tags) => {
            update({ tags });
          }}
        />
        <Field label="Era" hint={doc.eras.length ? undefined : 'No eras yet.'}>
          {(p) => (
            <div className="flex gap-2">
              <select
                {...p}
                className="input"
                value={event.era ?? ''}
                onChange={(e) => {
                  update({ era: e.target.value || undefined });
                }}
              >
                <option value="">None</option>
                {doc.eras.map((era) => (
                  <option key={era.id} value={era.id}>
                    {era.title}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="btn-ghost shrink-0 px-2 text-xs"
                onClick={() => {
                  setSidebarTab('timeline');
                }}
              >
                Manage eras
              </button>
            </div>
          )}
        </Field>
      </Section>

      <Section title="Location">
        <LocationFields
          location={event.location}
          onChange={(location) => {
            update({ location });
          }}
        />
      </Section>
    </form>
  );
}
