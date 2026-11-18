import { useEffect, useRef, useState } from 'react';
// Importing the package also registers <chronicle-timeline>.
import { ChronicleTimeline } from '@chronicle/web-component';
import type { Timeline } from '@chronicle/schema';
import { CircleAlert } from 'lucide-react';
import { useEditor } from '../store/editor-store.js';
import { updateEvent } from '../store/commands.js';
import { hasErrors } from '../lib/validation.js';
import { useIssues } from '../hooks.js';

const PREVIEW_DEBOUNCE_MS = 120;

interface InlineEdit {
  eventId: string;
  value: string;
  rect: { top: number; left: number; width: number; height: number };
}

/**
 * Live preview using the real <chronicle-timeline> element, so what authors
 * see is exactly what readers get. Only valid documents are rendered; while
 * there are errors the last valid version stays on screen.
 */
export function PreviewCanvas({ onShowIssues }: { onShowIssues: () => void }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const timelineRef = useRef<ChronicleTimeline | null>(null);
  const fromPreview = useRef(false);
  const doc = useEditor((s) => s.doc);
  const selectedId = useEditor((s) => s.selectedId);
  const issues = useIssues();
  const invalid = hasErrors(issues);
  const [shown, setShown] = useState<Timeline | null>(null);
  const [inline, setInline] = useState<InlineEdit | null>(null);

  // Create the element once.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const el = document.createElement('chronicle-timeline');
    if (!(el instanceof ChronicleTimeline))
      throw new Error('<chronicle-timeline> is not registered');
    el.style.height = '100%';
    el.setAttribute('aria-label', 'Timeline preview');
    host.appendChild(el);
    timelineRef.current = el;

    const onSelect = (e: Event) => {
      const id = (e as CustomEvent<{ eventId: string }>).detail.eventId;
      fromPreview.current = true;
      useEditor.getState().select(id);
    };
    const onDblClick = (e: MouseEvent) => {
      const path = e.composedPath();
      const titleEl = path.find(
        (n): n is HTMLElement =>
          n instanceof HTMLElement && n.classList.contains('chronicle-event__title'),
      );
      const card = path.find(
        (n): n is HTMLElement => n instanceof HTMLElement && n.dataset.eventId !== undefined,
      );
      const eventId = card?.dataset.eventId;
      if (!titleEl || !eventId) return;
      const outer = host.getBoundingClientRect();
      const r = titleEl.getBoundingClientRect();
      const current = useEditor.getState().doc.events.find((x) => x.id === eventId);
      setInline({
        eventId,
        value: current?.title ?? '',
        rect: {
          top: r.top - outer.top,
          left: r.left - outer.left,
          width: Math.max(r.width, 160),
          height: r.height,
        },
      });
    };
    el.addEventListener('chronicle:event-select', onSelect);
    el.addEventListener('dblclick', onDblClick);
    return () => {
      el.removeEventListener('chronicle:event-select', onSelect);
      el.removeEventListener('dblclick', onDblClick);
      el.remove();
      timelineRef.current = null;
    };
  }, []);

  // Push valid documents to the preview (debounced).
  useEffect(() => {
    if (invalid) return;
    const timer = setTimeout(() => {
      setShown(doc);
      const el = timelineRef.current;
      if (el) {
        el.data = doc;
        const id = useEditor.getState().selectedId;
        if (id) el.highlightEvent(id);
      }
    }, PREVIEW_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [doc, invalid]);

  // Mirror selection into the preview (scrolling only when it came from elsewhere).
  useEffect(() => {
    const el = timelineRef.current;
    if (!el) return;
    el.highlightEvent(selectedId, { scroll: !fromPreview.current });
    fromPreview.current = false;
  }, [selectedId]);

  const commitInline = () => {
    if (!inline) return;
    const title = inline.value.trim();
    const current = useEditor.getState().doc;
    const existing = current.events.find((e) => e.id === inline.eventId);
    if (title && existing && existing.title !== title) {
      useEditor.getState().execute(updateEvent(current, inline.eventId, { title }));
    }
    setInline(null);
  };

  const errorCount = issues.filter((i) => i.severity === 'error').length;
  const stale = invalid && shown !== null;

  return (
    <section aria-label="Preview" className="relative flex min-h-0 flex-1 flex-col">
      {invalid && (
        <div
          role="status"
          className="flex items-center gap-2 border-b border-amber-200 bg-amber-50 px-3 py-1.5 text-xs text-amber-900"
        >
          <CircleAlert size={14} aria-hidden />
          {stale
            ? 'Preview paused — showing the last valid version.'
            : 'Nothing to preview yet.'}{' '}
          {errorCount} {errorCount === 1 ? 'problem needs' : 'problems need'} fixing.
          <button type="button" className="ml-auto font-medium underline" onClick={onShowIssues}>
            Show problems
          </button>
        </div>
      )}
      {!invalid && doc.events.length > 0 && (
        <p className="border-b border-slate-200 bg-white px-3 py-1 text-[11px] text-slate-600">
          Live preview · click an event to edit it · double-click a title to rename it
        </p>
      )}
      {/* Host and inline editor share one positioning context. */}
      <div className="relative min-h-0 flex-1">
        <div ref={hostRef} className="absolute inset-0 bg-slate-100" />
        {inline && (
          <input
            aria-label="Event title"
            className="input absolute z-10 shadow-lg"
            style={{
              top: inline.rect.top - 4,
              left: inline.rect.left - 4,
              width: inline.rect.width + 8,
            }}
            value={inline.value}
            autoFocus
            onChange={(e) => {
              setInline({ ...inline, value: e.target.value });
            }}
            onBlur={commitInline}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitInline();
              if (e.key === 'Escape') setInline(null);
            }}
          />
        )}
      </div>
    </section>
  );
}
