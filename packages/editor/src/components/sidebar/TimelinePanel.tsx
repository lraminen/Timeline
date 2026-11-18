import { Plus, Trash2 } from 'lucide-react';
import { useEditor } from '../../store/editor-store.js';
import {
  addEra,
  deleteEra,
  updateEra,
  updateSettings,
  updateTimeline,
} from '../../store/commands.js';
import { newId } from '../../lib/ids.js';
import { dateProblem } from '../../lib/dates.js';
import { Field, Section } from '../ui.js';
import { DateField } from '../inspector/DateField.js';

const LOCALES = [
  { value: 'en', label: 'English' },
  { value: 'es', label: 'Español' },
  { value: 'ar', label: 'العربية (right-to-left)' },
];

const ERA_COLORS = ['#dbeafe', '#dcfce7', '#fef3c7', '#fce7f3', '#ede9fe', '#e0f2fe'];

export function TimelinePanel() {
  const doc = useEditor((s) => s.doc);
  const execute = useEditor((s) => s.execute);
  const current = () => useEditor.getState().doc;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <Section title="Details">
        <Field label="Title" error={doc.title.trim() ? null : 'Give your timeline a title'}>
          {(p) => (
            <input
              {...p}
              className="input"
              value={doc.title}
              onChange={(e) => {
                execute(updateTimeline(current(), { title: e.target.value }));
              }}
            />
          )}
        </Field>
        <Field label="Description" hint="Shown to screen readers and in exports.">
          {(p) => (
            <textarea
              {...p}
              rows={3}
              className="input"
              value={doc.description ?? ''}
              onChange={(e) => {
                execute(updateTimeline(current(), { description: e.target.value || undefined }));
              }}
            />
          )}
        </Field>
        <Field label="Language" hint="Controls date formatting and text direction.">
          {(p) => (
            <select
              {...p}
              className="input"
              value={doc.settings.locale}
              onChange={(e) => {
                execute(updateSettings(current(), { locale: e.target.value }));
              }}
            >
              {LOCALES.map((l) => (
                <option key={l.value} value={l.value}>
                  {l.label}
                </option>
              ))}
              {!LOCALES.some((l) => l.value === doc.settings.locale) && (
                <option value={doc.settings.locale}>{doc.settings.locale}</option>
              )}
            </select>
          )}
        </Field>
      </Section>

      <Section
        title="Eras"
        actions={
          <button
            type="button"
            className="btn-ghost px-2 py-1 text-xs"
            onClick={() => {
              const d = current();
              const first = d.events[0]?.date.start ?? '2000';
              execute(
                addEra({
                  id: newId(),
                  title: `Era ${String(d.eras.length + 1)}`,
                  start: first,
                  end: d.events.at(-1)?.date.start ?? first,
                  color: ERA_COLORS[d.eras.length % ERA_COLORS.length],
                }),
              );
            }}
          >
            <Plus size={14} aria-hidden /> Add era
          </button>
        }
      >
        {doc.eras.length === 0 && (
          <p className="text-sm text-slate-600">
            Eras are named periods shown as bands behind your events (in the horizontal layout).
          </p>
        )}
        <ul className="space-y-3">
          {doc.eras.map((era) => (
            <li key={era.id} className="space-y-2 rounded-md border border-slate-200 bg-white p-3">
              <div className="flex items-end gap-2">
                <Field label="Name" className="flex-1">
                  {(p) => (
                    <input
                      {...p}
                      className="input"
                      value={era.title}
                      onChange={(e) => {
                        execute(updateEra(current(), era.id, { title: e.target.value }));
                      }}
                    />
                  )}
                </Field>
                <Field label="Colour">
                  {(p) => (
                    <input
                      {...p}
                      type="color"
                      className="h-[34px] w-11 cursor-pointer rounded-md border border-slate-300 bg-white p-0.5"
                      value={/^#[0-9a-f]{6}$/i.test(era.color ?? '') ? era.color : '#dbeafe'}
                      onChange={(e) => {
                        execute(updateEra(current(), era.id, { color: e.target.value }));
                      }}
                    />
                  )}
                </Field>
                <button
                  type="button"
                  className="icon-btn"
                  aria-label={`Delete era ${era.title}`}
                  onClick={() => {
                    execute(deleteEra(current(), era.id));
                  }}
                >
                  <Trash2 size={16} aria-hidden />
                </button>
              </div>
              <DateField
                legend="Starts"
                value={era.start}
                locale={doc.settings.locale}
                error={dateProblem(era.start)}
                onChange={(start) => {
                  execute(updateEra(current(), era.id, { start }));
                }}
              />
              <DateField
                legend="Ends"
                value={era.end}
                locale={doc.settings.locale}
                error={dateProblem(era.end)}
                onChange={(end) => {
                  execute(updateEra(current(), era.id, { end }));
                }}
              />
            </li>
          ))}
        </ul>
      </Section>
    </div>
  );
}
