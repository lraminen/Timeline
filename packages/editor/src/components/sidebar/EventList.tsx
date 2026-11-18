import { useMemo, useState } from 'react';
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
  type Announcements,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { ArrowDownWideNarrow, GripVertical, Search, AlertCircle } from 'lucide-react';
import type { TimelineEvent } from '@chronicle/schema';
import { formatDate, searchEvents } from '@chronicle/core';
import { useEditor } from '../../store/editor-store.js';
import { moveEvent, sortEventsByDate } from '../../store/commands.js';
import { addNewEvent, deleteSelected } from '../../actions.js';
import { useIssues } from '../../hooks.js';
import { dateProblem } from '../../lib/dates.js';

function displayDate(evt: TimelineEvent, locale: string): string {
  if (evt.date.displayOverride) return evt.date.displayOverride;
  if (dateProblem(evt.date.start)) return evt.date.start || 'No date';
  return formatDate(evt.date.start, locale, {
    approximate: evt.date.approximate,
    uncertain: evt.date.uncertain,
  });
}

function Row({
  event,
  selected,
  draggable,
  hasError,
  eraColor,
  locale,
}: {
  event: TimelineEvent;
  selected: boolean;
  draggable: boolean;
  hasError: boolean;
  eraColor?: string;
  locale: string;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: event.id,
    disabled: !draggable,
  });
  const select = useEditor((s) => s.select);

  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`group flex items-stretch rounded-md ${isDragging ? 'z-10 shadow-lg' : ''} ${
        selected ? 'bg-blue-50 ring-1 ring-blue-300' : 'hover:bg-slate-100'
      }`}
    >
      {draggable && (
        <button
          type="button"
          className="flex w-6 shrink-0 cursor-grab items-center justify-center rounded-l-md text-slate-500 hover:text-slate-800 active:cursor-grabbing"
          aria-label={`Reorder ${event.title || 'untitled event'}`}
          {...attributes}
          {...listeners}
        >
          <GripVertical size={14} aria-hidden />
        </button>
      )}
      <button
        type="button"
        aria-current={selected ? 'true' : undefined}
        onClick={() => {
          select(event.id);
        }}
        onKeyDown={(e) => {
          if ((e.key === 'Delete' || e.key === 'Backspace') && selected) {
            e.preventDefault();
            deleteSelected();
          }
        }}
        className={`min-w-0 flex-1 rounded-r-md py-1.5 pr-2 text-left ${draggable ? '' : 'pl-2'}`}
      >
        <span className="flex items-center gap-1.5 text-xs text-slate-600">
          {eraColor && (
            <span
              className="h-2 w-2 shrink-0 rounded-full"
              style={{ backgroundColor: eraColor }}
              aria-hidden
            />
          )}
          {displayDate(event, locale)}
          {hasError && (
            <>
              <AlertCircle size={12} className="text-red-600" aria-hidden />
              <span className="sr-only">(has errors)</span>
            </>
          )}
        </span>
        <span className="block truncate text-sm font-medium text-slate-900">
          {event.title || <em className="font-normal text-slate-600">Untitled</em>}
        </span>
      </button>
    </li>
  );
}

export function EventList() {
  const events = useEditor((s) => s.doc.events);
  const eras = useEditor((s) => s.doc.eras);
  const locale = useEditor((s) => s.doc.settings.locale);
  const selectedId = useEditor((s) => s.selectedId);
  const execute = useEditor((s) => s.execute);
  const issues = useIssues();
  const [query, setQuery] = useState('');

  const filtered = useMemo(() => searchEvents(events, query), [events, query]);
  const eventsWithErrors = useMemo(
    () => new Set(issues.filter((i) => i.severity === 'error' && i.eventId).map((i) => i.eventId)),
    [issues],
  );
  const eraColors = useMemo(() => new Map(eras.map((e) => [e.id, e.color ?? '#94a3b8'])), [eras]);
  const titleOf = (id: string | number) => events.find((e) => e.id === id)?.title ?? 'event';
  const positionOf = (id: string | number) => events.findIndex((e) => e.id === id) + 1;

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const announcements: Announcements = {
    onDragStart: ({ active }) =>
      `Picked up ${titleOf(active.id)}. Use arrow keys to move, Space to drop, Escape to cancel.`,
    onDragOver: ({ active, over }) =>
      over
        ? `${titleOf(active.id)} is now at position ${String(positionOf(over.id))} of ${String(events.length)}.`
        : undefined,
    onDragEnd: ({ active, over }) =>
      over
        ? `Dropped ${titleOf(active.id)} at position ${String(positionOf(over.id))}.`
        : `Dropped ${titleOf(active.id)}.`,
    onDragCancel: ({ active }) => `Cancelled moving ${titleOf(active.id)}.`,
  };

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    const from = events.findIndex((e) => e.id === active.id);
    const to = events.findIndex((e) => e.id === over.id);
    if (from !== -1 && to !== -1) execute(moveEvent(from, to));
  };

  // Reordering a filtered subset would be ambiguous, so drag is disabled while searching.
  const draggable = !query.trim();

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="space-y-2 border-b border-slate-200 p-3">
        <div className="relative">
          <Search
            size={14}
            className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500"
            aria-hidden
          />
          <input
            type="search"
            className="input pl-8"
            placeholder="Search events"
            aria-label="Search events"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
            }}
          />
        </div>
        <div className="flex items-center justify-between">
          <p className="text-xs text-slate-600" aria-live="polite">
            {query
              ? `${String(filtered.length)} of ${String(events.length)} events`
              : `${String(events.length)} events`}
          </p>
          <button
            type="button"
            className="btn-ghost px-2 py-1 text-xs"
            onClick={() => {
              execute(sortEventsByDate(useEditor.getState().doc));
            }}
            disabled={events.length < 2}
          >
            <ArrowDownWideNarrow size={14} aria-hidden /> Sort by date
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {events.length === 0 ? (
          <div className="p-4 text-center text-sm text-slate-600">
            <p>No events yet.</p>
            <button type="button" className="btn-primary mt-3" onClick={addNewEvent}>
              Add your first event
            </button>
          </div>
        ) : (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={onDragEnd}
            accessibility={{ announcements }}
          >
            <SortableContext
              items={filtered.map((e) => e.id)}
              strategy={verticalListSortingStrategy}
            >
              <ul aria-label="Events" className="space-y-0.5">
                {filtered.map((evt) => (
                  <Row
                    key={evt.id}
                    event={evt}
                    selected={evt.id === selectedId}
                    draggable={draggable}
                    hasError={eventsWithErrors.has(evt.id)}
                    eraColor={evt.era ? eraColors.get(evt.era) : undefined}
                    locale={locale}
                  />
                ))}
              </ul>
            </SortableContext>
          </DndContext>
        )}
      </div>
      <p className="border-t border-slate-200 px-3 py-2 text-[11px] leading-snug text-slate-600">
        Timelines always display chronologically. List order decides which comes first when events
        share a date.
      </p>
    </div>
  );
}
