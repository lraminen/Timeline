import { useEffect, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { CircleAlert, Copy, ExternalLink, Globe, Lock, X } from 'lucide-react';
import type { ProjectSummary } from '../../lib/api.js';
import { useCloud } from '../../cloud/cloud-store.js';
import {
  openProject,
  publishCurrent,
  resolveConflict,
  type PublishResult,
} from '../../cloud/sync.js';
import { useEditor } from '../../store/editor-store.js';
import { Field } from '../ui.js';

function Shell({
  open,
  onOpenChange,
  title,
  description,
  children,
  width = '32rem',
  dismissable = true,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  title: string;
  description: string;
  children: React.ReactNode;
  width?: string;
  dismissable?: boolean;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-slate-900/40" />
        <Dialog.Content
          className="fixed left-1/2 top-1/2 z-50 max-h-[90vh] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-lg bg-white p-5 shadow-xl"
          style={{ width: `min(${width}, calc(100vw - 2rem))` }}
          onInteractOutside={(e) => {
            if (!dismissable) e.preventDefault();
          }}
          onEscapeKeyDown={(e) => {
            if (!dismissable) e.preventDefault();
          }}
        >
          <div className="mb-2 flex items-center justify-between">
            <Dialog.Title className="text-base font-semibold">{title}</Dialog.Title>
            {dismissable && (
              <Dialog.Close className="icon-btn" aria-label="Close">
                <X size={18} aria-hidden />
              </Dialog.Close>
            )}
          </div>
          <Dialog.Description className="mb-4 text-sm text-slate-600">
            {description}
          </Dialog.Description>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

// ---------------------------------------------------------------------------

export function OpenProjectDialog({
  open,
  onOpenChange,
  beforeOpen,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  beforeOpen: () => Promise<void>;
}) {
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setProjects(null);
    setError(null);
    const api = useCloud.getState().api;
    api?.listProjects().then(setProjects, (err: unknown) => {
      setError(err instanceof Error ? err.message : String(err));
    });
  }, [open]);

  const fmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

  return (
    <Shell
      open={open}
      onOpenChange={onOpenChange}
      title="Open from Chronicle"
      description="Timelines you own or collaborate on."
    >
      {error && (
        <p role="alert" className="text-sm text-red-800">
          {error}
        </p>
      )}
      {!projects && !error && <p className="text-sm text-slate-600">Loading…</p>}
      {projects?.length === 0 && (
        <p className="text-sm text-slate-600">No timelines on the server yet.</p>
      )}
      <ul className="max-h-[55vh] space-y-1 overflow-y-auto">
        {projects?.map((p) => (
          <li key={p.id}>
            <button
              type="button"
              className="w-full rounded-md px-3 py-2 text-left hover:bg-slate-50"
              onClick={() =>
                void beforeOpen()
                  .then(() => openProject(p.id))
                  .then(() => {
                    onOpenChange(false);
                  })
                  .catch((err: unknown) => {
                    setError(err instanceof Error ? err.message : String(err));
                  })
              }
            >
              <span className="flex items-center gap-2 text-sm font-medium text-slate-900">
                {p.isPublic ? (
                  <Globe size={13} aria-label="Public" />
                ) : (
                  <Lock size={13} aria-label="Private" />
                )}
                {p.title}
              </span>
              <span className="text-xs text-slate-600">
                {p.role} · {p.eventCount} events ·{' '}
                {p.publishedVersion ? `published v${String(p.publishedVersion)}` : 'not published'}{' '}
                · edited {fmt.format(new Date(p.updatedAt))}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </Shell>
  );
}

// ---------------------------------------------------------------------------

export function ConflictDialog() {
  const conflict = useCloud((s) => s.conflict);
  const [busy, setBusy] = useState(false);
  const choose = (choice: Parameters<typeof resolveConflict>[0]) => {
    setBusy(true);
    void resolveConflict(choice).finally(() => {
      setBusy(false);
    });
  };
  const when = conflict?.serverUpdatedAt
    ? new Intl.DateTimeFormat(undefined, { timeStyle: 'short', dateStyle: 'medium' }).format(
        new Date(conflict.serverUpdatedAt),
      )
    : null;

  return (
    <Shell
      open={conflict !== null}
      onOpenChange={() => undefined}
      dismissable={false}
      title="This timeline changed somewhere else"
      description={`Someone saved a different version${when ? ` at ${when}` : ''} while you were editing. Choose which version to keep.`}
    >
      <div className="space-y-2">
        <button
          type="button"
          className="btn-secondary w-full justify-start text-left"
          disabled={busy}
          onClick={() => {
            choose('keep-mine');
          }}
        >
          <span>
            <span className="block font-medium">Keep my version</span>
            <span className="block text-xs font-normal text-slate-600">
              Replace the server copy with what you see now.
            </span>
          </span>
        </button>
        <button
          type="button"
          className="btn-secondary w-full justify-start text-left"
          disabled={busy}
          onClick={() => {
            choose('use-theirs');
          }}
        >
          <span>
            <span className="block font-medium">Use the server version</span>
            <span className="block text-xs font-normal text-slate-600">
              Load “{conflict?.serverDraft.title}”. You can undo this to get your version back.
            </span>
          </span>
        </button>
        <button
          type="button"
          className="btn-secondary w-full justify-start text-left"
          disabled={busy}
          onClick={() => {
            choose('save-copy');
          }}
        >
          <span>
            <span className="block font-medium">Save mine as a copy</span>
            <span className="block text-xs font-normal text-slate-600">
              Keep both: your version becomes a new timeline.
            </span>
          </span>
        </button>
      </div>
    </Shell>
  );
}

// ---------------------------------------------------------------------------

function CopyField({
  label,
  value,
  multiline = false,
}: {
  label: string;
  value: string;
  multiline?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <Field label={label}>
      {(p) => (
        <div className="flex gap-2">
          {multiline ? (
            <textarea {...p} readOnly rows={3} className="input font-mono text-xs" value={value} />
          ) : (
            <input {...p} readOnly className="input font-mono text-xs" value={value} />
          )}
          <button
            type="button"
            className="btn-secondary shrink-0"
            onClick={() =>
              void navigator.clipboard.writeText(value).then(() => {
                setCopied(true);
                setTimeout(() => {
                  setCopied(false);
                }, 1500);
              })
            }
          >
            <Copy size={14} aria-hidden /> {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
      )}
    </Field>
  );
}

export function PublishDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const remote = useEditor((s) => s.remote);
  const isOwner = !remote || remote.role === 'owner';
  const [isPublic, setIsPublic] = useState(true);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<PublishResult | null>(null);
  const [shareUrl, setShareUrl] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setResult(null);
      setError(null);
      setShareUrl(null);
      setMessage('');
    }
  }, [open]);

  const publish = async () => {
    setBusy(true);
    setError(null);
    try {
      setResult(await publishCurrent({ isPublic, message: message.trim() || undefined }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const createShareLink = async () => {
    const { api } = useCloud.getState();
    const projectId = useEditor.getState().remote?.projectId;
    if (!api || !projectId) return;
    try {
      setShareUrl((await api.createShareLink(projectId)).pageUrl);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <Shell
      open={open}
      onOpenChange={onOpenChange}
      title={result ? `Published version ${String(result.version)}` : 'Publish timeline'}
      description={
        result
          ? result.isPublic
            ? 'Your timeline is live. Share the page or embed it anywhere.'
            : 'Published privately. Only people with a share link can see it.'
          : 'Publishing saves a permanent version readers can see. Your draft stays editable.'
      }
    >
      {!result ? (
        <div className="space-y-4">
          {isOwner ? (
            <label className="flex items-start gap-2 text-sm text-slate-800">
              <input
                type="checkbox"
                className="mt-0.5 h-4 w-4"
                checked={isPublic}
                onChange={(e) => {
                  setIsPublic(e.target.checked);
                }}
              />
              <span>
                Public
                <span className="block text-xs text-slate-600">
                  Anyone with the link can view it, and search engines may index it. Untick to share
                  privately with expiring links.
                </span>
              </span>
            </label>
          ) : (
            <p className="text-sm text-slate-600">Visibility is set by the timeline’s owner.</p>
          )}
          <Field label="What changed? (optional)">
            {(p) => (
              <input
                {...p}
                className="input"
                maxLength={500}
                value={message}
                onChange={(e) => {
                  setMessage(e.target.value);
                }}
              />
            )}
          </Field>
          {error && (
            <p role="alert" className="flex items-start gap-1.5 text-sm text-red-800">
              <CircleAlert size={15} className="mt-0.5 shrink-0" aria-hidden /> {error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Dialog.Close className="btn-ghost">Cancel</Dialog.Close>
            <button
              type="button"
              className="btn-primary"
              disabled={busy}
              onClick={() => void publish()}
            >
              {busy ? 'Publishing…' : 'Publish'}
            </button>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          {result.isPublic ? (
            <>
              <a
                href={result.pageUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-sm font-medium text-blue-700 underline"
              >
                Open the published page <ExternalLink size={13} aria-hidden />
                <span className="sr-only">(opens in a new tab)</span>
              </a>
              <CopyField label="Page link" value={result.pageUrl} />
              <CopyField
                label="Embed code"
                multiline
                value={`<script src="${result.scriptUrl}" defer></script>\n<chronicle-timeline src="${result.embedUrl}"></chronicle-timeline>`}
              />
            </>
          ) : shareUrl ? (
            <CopyField label="Private share link (valid for 7 days)" value={shareUrl} />
          ) : (
            <button type="button" className="btn-secondary" onClick={() => void createShareLink()}>
              Create a private share link
            </button>
          )}
          {error && (
            <p role="alert" className="text-sm text-red-800">
              {error}
            </p>
          )}
          <div className="flex justify-end">
            <Dialog.Close className="btn-primary">Done</Dialog.Close>
          </div>
        </div>
      )}
    </Shell>
  );
}
