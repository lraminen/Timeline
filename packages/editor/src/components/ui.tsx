import * as Tooltip from '@radix-ui/react-tooltip';
import { forwardRef, useId, type ButtonHTMLAttributes, type ReactNode } from 'react';

/**
 * Icon-only button. `label` is both the accessible name and the tooltip, so
 * the button is never unlabelled for screen readers.
 */
export const IconButton = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & {
    label: string;
    shortcut?: string;
    children: ReactNode;
  }
>(function IconButton({ label, shortcut, children, className, ...props }, ref) {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>
        <button
          ref={ref}
          type="button"
          aria-label={label}
          aria-keyshortcuts={shortcut}
          className={`icon-btn ${className ?? ''}`}
          {...props}
        >
          {children}
        </button>
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content
          side="bottom"
          sideOffset={6}
          className="z-50 rounded bg-slate-900 px-2 py-1 text-xs text-white shadow"
        >
          {label}
          {shortcut && <span className="ml-2 text-slate-300">{shortcut}</span>}
          <Tooltip.Arrow className="fill-slate-900" />
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
});

/** Labelled form field. Wires `id`, error and hint via render prop. */
export function Field({
  label,
  hint,
  error,
  children,
  className,
}: {
  label: string;
  hint?: string;
  error?: string | null;
  className?: string;
  children: (props: {
    id: string;
    'aria-invalid'?: boolean;
    'aria-describedby'?: string;
  }) => ReactNode;
}) {
  const id = useId();
  const describedBy = [error ? `${id}-error` : null, hint ? `${id}-hint` : null]
    .filter(Boolean)
    .join(' ');
  return (
    <div className={className}>
      <label htmlFor={id} className="label">
        {label}
      </label>
      {children({
        id,
        'aria-invalid': error ? true : undefined,
        'aria-describedby': describedBy || undefined,
      })}
      {hint && !error && (
        <p id={`${id}-hint`} className="mt-1 text-xs text-slate-600">
          {hint}
        </p>
      )}
      {error && (
        <p id={`${id}-error`} className="mt-1 text-xs text-red-700" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

export function Section({
  title,
  children,
  actions,
}: {
  title: string;
  children: ReactNode;
  actions?: ReactNode;
}) {
  const id = useId();
  return (
    <section
      aria-labelledby={id}
      className="space-y-3 border-b border-slate-200 px-4 py-4 last:border-b-0"
    >
      <div className="flex items-center justify-between">
        <h3 id={id} className="panel-heading">
          {title}
        </h3>
        {actions}
      </div>
      {children}
    </section>
  );
}
