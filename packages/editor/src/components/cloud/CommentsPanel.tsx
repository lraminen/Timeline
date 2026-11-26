import { useId, useMemo, useState } from 'react';
import { Check, MessageSquare, Pencil, RotateCcw, Trash2 } from 'lucide-react';
import type { CommentDto } from '@chronicle/collab';
import { useCloud } from '../../cloud/cloud-store.js';
import { applyComment } from '../../cloud/session-registry.js';
import { useEditor } from '../../store/editor-store.js';

interface Thread {
  root: CommentDto;
  replies: CommentDto[];
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const when = (iso: string) =>
  new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(iso),
  );

function Composer({
  label,
  placeholder,
  submitLabel,
  initial = '',
  onSubmit,
  onCancel,
}: {
  label: string;
  placeholder: string;
  submitLabel: string;
  initial?: string;
  onSubmit: (body: string) => Promise<void>;
  onCancel?: () => void;
}) {
  const id = useId();
  const [body, setBody] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = () => {
    if (!body.trim() || busy) return;
    setBusy(true);
    setError(null);
    onSubmit(body.trim())
      .then(() => {
        setBody('');
      })
      .catch((err: unknown) => {
        setError(describe(err));
      })
      .finally(() => {
        setBusy(false);
      });
  };
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="sr-only">
        {label}
      </label>
      <textarea
        id={id}
        className="input min-h-[3.5rem] text-sm"
        placeholder={placeholder}
        value={body}
        maxLength={5000}
        onChange={(e) => {
          setBody(e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            submit();
          }
        }}
      />
      {error && (
        <p role="alert" className="text-xs text-red-700">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-1.5">
        {onCancel && (
          <button type="button" className="btn-ghost px-2 py-1 text-xs" onClick={onCancel}>
            Cancel
          </button>
        )}
        <button
          type="button"
          className="btn-primary px-2 py-1 text-xs"
          disabled={!body.trim() || busy}
          onClick={submit}
        >
          {busy ? 'Sending…' : submitLabel}
        </button>
      </div>
    </div>
  );
}

function CommentItem({
  comment,
  isRoot,
  canResolve,
}: {
  comment: CommentDto;
  isRoot: boolean;
  canResolve: boolean;
}) {
  const api = useCloud((s) => s.api);
  const user = useCloud((s) => s.user);
  const remote = useEditor((s) => s.remote);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!api || !remote) return null;
  const mine = comment.author?.id === user?.id;
  const canDelete = mine || remote.role === 'owner';

  const act = (work: () => Promise<void>) => {
    setError(null);
    work().catch((err: unknown) => {
      setError(describe(err));
    });
  };
  const update = (input: { body?: string; resolved?: boolean }) =>
    api.updateComment
      ? api.updateComment(remote.projectId, comment.id, input).then((c) => {
          applyComment('updated', c);
        })
      : Promise.resolve();

  return (
    <div className={isRoot ? '' : 'ml-4 border-l border-slate-200 pl-2'}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-xs font-medium text-slate-900">
          {comment.author?.name ?? 'Deleted user'}
        </span>
        <span className="text-[11px] text-slate-600">
          {when(comment.createdAt)}
          {comment.editedAt ? ' · edited' : ''}
        </span>
      </div>
      {editing ? (
        <Composer
          label="Edit comment"
          placeholder=""
          submitLabel="Save"
          initial={comment.body}
          onCancel={() => {
            setEditing(false);
          }}
          onSubmit={async (body) => {
            await update({ body });
            setEditing(false);
          }}
        />
      ) : (
        <p className="whitespace-pre-wrap break-words text-sm text-slate-800">{comment.body}</p>
      )}
      {error && (
        <p role="alert" className="text-xs text-red-700">
          {error}
        </p>
      )}
      {!editing && (
        <div className="mt-0.5 flex gap-1">
          {isRoot && canResolve && (
            <button
              type="button"
              className="btn-ghost px-1.5 py-0.5 text-[11px]"
              onClick={() => {
                act(() => update({ resolved: !comment.resolvedAt }));
              }}
            >
              {comment.resolvedAt ? (
                <>
                  <RotateCcw size={12} aria-hidden /> Reopen
                </>
              ) : (
                <>
                  <Check size={12} aria-hidden /> Resolve
                </>
              )}
            </button>
          )}
          {mine && (
            <button
              type="button"
              className="btn-ghost px-1.5 py-0.5 text-[11px]"
              onClick={() => {
                setEditing(true);
              }}
            >
              <Pencil size={12} aria-hidden /> Edit
            </button>
          )}
          {canDelete && (
            <button
              type="button"
              className="btn-ghost px-1.5 py-0.5 text-[11px]"
              aria-label={isRoot ? 'Delete thread' : 'Delete reply'}
              onClick={() => {
                if (isRoot && !window.confirm('Delete this thread and its replies?')) return;
                act(async () => {
                  await api.deleteComment?.(remote.projectId, comment.id);
                  applyComment('deleted', comment);
                });
              }}
            >
              <Trash2 size={12} aria-hidden /> Delete
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function ThreadView({ thread, canResolve }: { thread: Thread; canResolve: boolean }) {
  const api = useCloud((s) => s.api);
  const remote = useEditor((s) => s.remote);
  const [replying, setReplying] = useState(false);
  const resolved = thread.root.resolvedAt !== null;
  return (
    <li
      className={`space-y-2 rounded-md border p-2 ${resolved ? 'border-slate-200 bg-slate-50' : 'border-amber-200 bg-amber-50/40'}`}
    >
      {resolved && (
        <p className="text-[11px] text-slate-600">
          Resolved by {thread.root.resolvedBy?.name ?? 'someone'}
        </p>
      )}
      <CommentItem comment={thread.root} isRoot canResolve={canResolve} />
      {thread.replies.map((r) => (
        <CommentItem key={r.id} comment={r} isRoot={false} canResolve={false} />
      ))}
      {replying ? (
        <Composer
          label="Reply"
          placeholder="Reply…"
          submitLabel="Reply"
          onCancel={() => {
            setReplying(false);
          }}
          onSubmit={async (body) => {
            if (!api?.createComment || !remote) return;
            applyComment(
              'created',
              await api.createComment(remote.projectId, { parentId: thread.root.id, body }),
            );
            setReplying(false);
          }}
        />
      ) : (
        <button
          type="button"
          className="btn-ghost px-1.5 py-0.5 text-[11px]"
          onClick={() => {
            setReplying(true);
          }}
        >
          Reply
        </button>
      )}
    </li>
  );
}

/** Threaded comments on one event (shown when the draft is linked to a server). */
export function CommentsPanel({ eventId }: { eventId: string }) {
  const api = useCloud((s) => s.api);
  const user = useCloud((s) => s.user);
  const comments = useCloud((s) => s.comments);
  const remote = useEditor((s) => s.remote);
  const [showResolved, setShowResolved] = useState(false);

  const threads = useMemo(() => {
    const list = (comments ?? []).filter((c) => c.eventId === eventId);
    return list
      .filter((c) => !c.parentId)
      .map((root) => ({ root, replies: list.filter((c) => c.parentId === root.id) }));
  }, [comments, eventId]);

  if (!api?.createComment || !remote || !user) return null;
  if (comments === null) {
    return <p className="text-xs text-slate-600">Comments load when you’re connected.</p>;
  }
  const open = threads.filter((t) => !t.root.resolvedAt);
  const resolved = threads.filter((t) => t.root.resolvedAt);

  return (
    <div className="space-y-2">
      {open.length === 0 && resolved.length === 0 && (
        <p className="flex items-center gap-1.5 text-xs text-slate-600">
          <MessageSquare size={13} aria-hidden /> No comments yet.
        </p>
      )}
      {open.length > 0 && (
        <ul className="space-y-2" aria-label="Open comment threads">
          {open.map((t) => (
            <ThreadView
              key={t.root.id}
              thread={t}
              canResolve={remote.role !== 'viewer' || t.root.author?.id === user.id}
            />
          ))}
        </ul>
      )}
      {resolved.length > 0 && (
        <div>
          <button
            type="button"
            className="btn-ghost px-1.5 py-0.5 text-xs"
            aria-expanded={showResolved}
            onClick={() => {
              setShowResolved((v) => !v);
            }}
          >
            {showResolved ? 'Hide' : 'Show'} {resolved.length} resolved
          </button>
          {showResolved && (
            <ul className="mt-2 space-y-2" aria-label="Resolved comment threads">
              {resolved.map((t) => (
                <ThreadView
                  key={t.root.id}
                  thread={t}
                  canResolve={remote.role !== 'viewer' || t.root.author?.id === user.id}
                />
              ))}
            </ul>
          )}
        </div>
      )}
      <Composer
        label="New comment on this event"
        placeholder="Add a comment…"
        submitLabel="Comment"
        onSubmit={async (body) => {
          const created = await api.createComment?.(remote.projectId, { eventId, body });
          if (created) applyComment('created', created);
        }}
      />
    </div>
  );
}
