import { useState } from 'react';
import { Cloud, CloudAlert, CloudOff, CloudUpload, RefreshCw } from 'lucide-react';
import { useCloud } from '../../cloud/cloud-store.js';
import { linkCurrentDraft, pushDraft } from '../../cloud/sync.js';
import { useEditor } from '../../store/editor-store.js';

/** Sync status for drafts linked to a Chronicle server (hidden in local-only mode). */
export function CloudStatus() {
  const api = useCloud((s) => s.api);
  const user = useCloud((s) => s.user);
  const sync = useCloud((s) => s.sync);
  const linked = useEditor((s) => s.remote !== null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!api) return null;

  if (!linked) {
    if (!user) return null;
    return (
      <span className="flex items-center gap-1.5">
        <button
          type="button"
          className="btn-ghost px-2 py-0.5 text-xs"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            setError(null);
            linkCurrentDraft()
              .catch((err: unknown) => {
                setError(err instanceof Error ? err.message : String(err));
              })
              .finally(() => {
                setBusy(false);
              });
          }}
        >
          <CloudUpload size={14} aria-hidden /> {busy ? 'Saving…' : 'Save to Chronicle'}
        </button>
        {error && (
          <span role="alert" className="text-red-700">
            {error}
          </span>
        )}
      </span>
    );
  }

  const time = (t: number) => new Intl.DateTimeFormat(undefined, { timeStyle: 'short' }).format(t);
  const view = (() => {
    switch (sync.kind) {
      case 'synced':
        return {
          icon: <Cloud size={13} aria-hidden />,
          text: `Saved to Chronicle at ${time(sync.at)}`,
          tone: '',
        };
      case 'syncing':
        return {
          icon: (
            <RefreshCw size={13} className="animate-spin motion-reduce:animate-none" aria-hidden />
          ),
          text: 'Saving to Chronicle…',
          tone: '',
        };
      case 'pending':
        return {
          icon: <Cloud size={13} aria-hidden />,
          text: 'Changes will sync shortly',
          tone: '',
        };
      case 'offline':
        return {
          icon: <CloudOff size={13} aria-hidden />,
          text: 'Offline — changes will sync when you reconnect',
          tone: 'text-amber-800',
        };
      case 'conflict':
        return {
          icon: <CloudAlert size={13} aria-hidden />,
          text: 'Save conflict — choose a version',
          tone: 'text-amber-800',
        };
      case 'blocked':
        return {
          icon: <CloudAlert size={13} aria-hidden />,
          text: sync.reason,
          tone: 'text-amber-800',
        };
      case 'error':
        return {
          icon: <CloudAlert size={13} aria-hidden />,
          text: `Sync failed: ${sync.message}`,
          tone: 'text-red-700',
        };
      case 'local':
        return { icon: <Cloud size={13} aria-hidden />, text: 'Linked to Chronicle', tone: '' };
    }
  })();

  return (
    <span
      className={`flex items-center gap-1 ${view.tone}`}
      role="status"
      aria-live="polite"
      data-sync={sync.kind}
    >
      {view.icon}
      {view.text}
      {sync.kind === 'error' && (
        <button type="button" className="ml-1 underline" onClick={() => void pushDraft()}>
          Retry
        </button>
      )}
    </span>
  );
}
