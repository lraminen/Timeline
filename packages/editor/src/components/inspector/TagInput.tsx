import { useId, useState } from 'react';
import { X } from 'lucide-react';

/**
 * Tag editor with autocomplete from tags already used in the timeline
 * (native datalist: keyboard- and screen-reader-friendly).
 */
export function TagInput({
  tags,
  suggestions,
  onChange,
}: {
  tags: string[];
  suggestions: string[];
  onChange: (tags: string[]) => void;
}) {
  const id = useId();
  const [text, setText] = useState('');

  const add = (raw: string) => {
    const incoming = raw
      .split(/[,;]/)
      .map((t) => t.trim())
      .filter(Boolean);
    const lower = new Set(tags.map((t) => t.toLowerCase()));
    const fresh = incoming.filter((t) => !lower.has(t.toLowerCase()));
    if (fresh.length) onChange([...tags, ...new Set(fresh)]);
    setText('');
  };

  return (
    <div>
      <label htmlFor={id} className="label">
        Tags
      </label>
      <div className="flex flex-wrap items-center gap-1.5 rounded-md border border-slate-300 bg-white p-1.5 focus-within:border-blue-600 focus-within:ring-2 focus-within:ring-blue-600/30">
        <ul className="contents" aria-label="Current tags">
          {tags.map((tag) => (
            <li
              key={tag}
              className="inline-flex items-center gap-1 rounded-full bg-slate-100 py-0.5 pl-2 pr-1 text-xs text-slate-800"
            >
              #{tag}
              <button
                type="button"
                className="rounded-full p-0.5 hover:bg-slate-200"
                aria-label={`Remove tag ${tag}`}
                onClick={() => {
                  onChange(tags.filter((t) => t !== tag));
                }}
              >
                <X size={12} aria-hidden />
              </button>
            </li>
          ))}
        </ul>
        <input
          id={id}
          list={`${id}-list`}
          className="min-w-[6rem] flex-1 border-0 bg-transparent px-1 py-0.5 text-sm outline-none focus-visible:ring-0"
          placeholder={tags.length ? 'Add tag' : 'Add tags (Enter or comma)'}
          aria-describedby={`${id}-hint`}
          value={text}
          onChange={(e) => {
            const v = e.target.value;
            if (/[,;]$/.test(v)) add(v);
            else setText(v);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              add(text);
            } else if (e.key === 'Backspace' && !text && tags.length) {
              onChange(tags.slice(0, -1));
            }
          }}
          onBlur={() => {
            if (text.trim()) add(text);
          }}
        />
        <datalist id={`${id}-list`}>
          {suggestions
            .filter((s) => !tags.includes(s))
            .map((s) => (
              <option key={s} value={s} />
            ))}
        </datalist>
      </div>
      <p id={`${id}-hint`} className="mt-1 text-xs text-slate-600">
        Press Enter or type a comma to add. Readers can filter the timeline by tag.
      </p>
    </div>
  );
}
