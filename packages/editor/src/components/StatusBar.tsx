import * as Popover from '@radix-ui/react-popover';
import { CircleAlert, CircleCheck, CloudOff, HardDrive, TriangleAlert } from 'lucide-react';
import { useIssues, useOnline, type SaveStatus } from '../hooks.js';
import { useEditor } from '../store/editor-store.js';
import { CloudStatus } from './cloud/CloudStatus.js';

export function StatusBar({
  save,
  offlineReady,
  issuesOpen,
  onIssuesOpenChange,
}: {
  save: SaveStatus;
  offlineReady: boolean;
  issuesOpen: boolean;
  onIssuesOpenChange: (open: boolean) => void;
}) {
  const issues = useIssues();
  const online = useOnline();
  const errors = issues.filter((i) => i.severity === 'error');
  const warnings = issues.filter((i) => i.severity === 'warning');
  const time = (t: number) => new Intl.DateTimeFormat(undefined, { timeStyle: 'short' }).format(t);

  return (
    <footer className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-slate-200 bg-white px-3 py-1.5 text-xs text-slate-700">
      <Popover.Root open={issuesOpen} onOpenChange={onIssuesOpenChange}>
        <Popover.Trigger className="btn-ghost px-2 py-0.5 text-xs" disabled={issues.length === 0}>
          {errors.length > 0 ? (
            <CircleAlert size={14} className="text-red-700" aria-hidden />
          ) : warnings.length > 0 ? (
            <TriangleAlert size={14} className="text-amber-700" aria-hidden />
          ) : (
            <CircleCheck size={14} className="text-green-700" aria-hidden />
          )}
          {issues.length === 0
            ? 'No problems'
            : `${String(errors.length)} ${errors.length === 1 ? 'error' : 'errors'}, ${String(warnings.length)} ${warnings.length === 1 ? 'warning' : 'warnings'}`}
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content
            side="top"
            align="start"
            sideOffset={6}
            className="z-50 max-h-80 w-96 overflow-y-auto rounded-md border border-slate-200 bg-white p-2 shadow-lg"
          >
            <h2 className="px-2 pb-1 text-xs font-semibold uppercase tracking-wide text-slate-600">
              Problems
            </h2>
            <ul className="space-y-0.5">
              {issues.map((issue, i) => (
                <li key={i}>
                  <button
                    type="button"
                    className="flex w-full items-start gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-slate-100 disabled:cursor-default"
                    disabled={!issue.eventId}
                    onClick={() => {
                      if (issue.eventId) {
                        const s = useEditor.getState();
                        s.select(issue.eventId);
                        s.setSidebarTab('events');
                        onIssuesOpenChange(false);
                      }
                    }}
                  >
                    {issue.severity === 'error' ? (
                      <CircleAlert
                        size={14}
                        className="mt-0.5 shrink-0 text-red-700"
                        aria-label="Error"
                      />
                    ) : (
                      <TriangleAlert
                        size={14}
                        className="mt-0.5 shrink-0 text-amber-700"
                        aria-label="Warning"
                      />
                    )}
                    <span>{issue.message}</span>
                  </button>
                </li>
              ))}
            </ul>
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>

      <span className="flex items-center gap-1" role="status" aria-live="polite">
        <HardDrive size={13} aria-hidden />
        {save.state === 'saving' && 'Saving…'}
        {save.state === 'saved' && `Saved in this browser at ${time(save.at)}`}
        {save.state === 'error' && (
          <span className="text-red-700">Couldn’t save draft: {save.message}</span>
        )}
        {save.state === 'idle' && 'Drafts save automatically'}
      </span>

      <CloudStatus />

      <span className="ml-auto flex items-center gap-1">
        {!online && (
          <span className="flex items-center gap-1 font-medium text-amber-800">
            <CloudOff size={13} aria-hidden /> Offline — your work is still saved locally
          </span>
        )}
        {online && offlineReady && 'Ready to work offline'}
      </span>
    </footer>
  );
}
