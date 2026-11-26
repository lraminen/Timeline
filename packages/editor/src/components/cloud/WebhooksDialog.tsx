import { useEffect, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Copy, RefreshCw, Send, Trash2, Webhook as WebhookIcon, X } from 'lucide-react';
import type { Webhook, WebhookDelivery, WebhookEventType } from '../../lib/api.js';
import { useCloud } from '../../cloud/cloud-store.js';
import { useEditor } from '../../store/editor-store.js';
import { Field } from '../ui.js';

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const EVENTS: { id: WebhookEventType; label: string }[] = [
  { id: 'timeline.published', label: 'A version is published' },
  { id: 'draft.updated', label: 'The draft changes (at most once a minute)' },
  { id: 'comment.created', label: 'A comment is added' },
  { id: 'comment.updated', label: 'A comment is edited or resolved' },
  { id: 'comment.deleted', label: 'A comment is deleted' },
];

function SecretNotice({ secret, title }: { secret: string; title: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="mb-4 rounded-md border border-amber-300 bg-amber-50 p-3">
      <Field
        label={title}
        hint="Copy it now: it will not be shown again. Use it to check the webhook-signature header."
      >
        {(p) => (
          <div className="flex gap-2">
            <input {...p} readOnly className="input font-mono text-xs" value={secret} />
            <button
              type="button"
              className="btn-secondary shrink-0"
              onClick={() =>
                void navigator.clipboard.writeText(secret).then(() => {
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
    </div>
  );
}

function Deliveries({ projectId, hook }: { projectId: string; hook: Webhook }) {
  const api = useCloud((s) => s.api);
  const [items, setItems] = useState<WebhookDelivery[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () => {
    if (!api?.listWebhookDeliveries) return;
    setError(null);
    api.listWebhookDeliveries(projectId, hook.id).then(setItems, (err: unknown) => {
      setError(message(err));
    });
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(load, [projectId, hook.id]);
  const fmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'short', timeStyle: 'medium' });
  return (
    <div className="mt-2 rounded border border-slate-200 bg-slate-50 p-2 text-xs">
      <div className="mb-1 flex items-center justify-between">
        <span className="font-medium text-slate-800">Recent deliveries</span>
        <button type="button" className="btn-ghost px-1.5 py-0.5 text-xs" onClick={load}>
          <RefreshCw size={12} aria-hidden /> Refresh
        </button>
      </div>
      {error && <p role="alert">{error}</p>}
      {items?.length === 0 && <p className="text-slate-600">Nothing sent yet.</p>}
      {items && items.length > 0 && (
        <ul className="space-y-0.5">
          {items.map((d) => (
            <li key={d.id} className="flex flex-wrap gap-x-2">
              <span
                className={
                  d.status === 'succeeded'
                    ? 'text-emerald-800'
                    : d.status === 'failed'
                      ? 'text-red-800'
                      : 'text-amber-800'
                }
              >
                {d.status}
              </span>
              <code>{d.eventType}</code>
              <span className="text-slate-600">{fmt.format(new Date(d.createdAt))}</span>
              {d.lastStatusCode !== null && <span>HTTP {d.lastStatusCode}</span>}
              {d.lastError && d.status !== 'succeeded' && (
                <span className="text-slate-700">— {d.lastError}</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Webhooks for the linked timeline (owners only): Chronicle POSTs a signed
 * JSON message to each URL when something happens, e.g. to rebuild a site
 * when a new version is published.
 */
export function WebhooksDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const api = useCloud((s) => s.api);
  const projectId = useEditor((s) => s.remote?.projectId);
  const [hooks, setHooks] = useState<Webhook[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [url, setUrl] = useState('');
  const [events, setEvents] = useState<WebhookEventType[]>(['timeline.published']);
  const [secret, setSecret] = useState<{ title: string; value: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !api?.listWebhooks || !projectId) return;
    setHooks(null);
    setError(null);
    setSecret(null);
    setNotice(null);
    api.listWebhooks(projectId).then(setHooks, (err: unknown) => {
      setError(message(err));
    });
  }, [open, api, projectId]);

  if (!api || !projectId) return null;

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await work();
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  };
  const refresh = async () => {
    if (api.listWebhooks) setHooks(await api.listWebhooks(projectId));
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-slate-900/40" />
        <Dialog.Content
          className="fixed left-1/2 top-1/2 z-50 max-h-[90vh] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-lg bg-white p-5 shadow-xl"
          style={{ width: 'min(38rem, calc(100vw - 2rem))' }}
        >
          <div className="mb-2 flex items-center justify-between">
            <Dialog.Title className="text-base font-semibold">Webhooks</Dialog.Title>
            <Dialog.Close className="icon-btn" aria-label="Close">
              <X size={18} aria-hidden />
            </Dialog.Close>
          </div>
          <Dialog.Description className="mb-4 text-sm text-slate-600">
            Chronicle sends a signed POST request to your URL when something happens in this
            timeline — for example, to rebuild a website when a new version is published. Failed
            deliveries are retried for about a day.
          </Dialog.Description>

          {error && (
            <p role="alert" className="mb-3 text-sm text-red-800">
              {error}
            </p>
          )}
          {notice && (
            <p role="status" className="mb-3 text-sm text-emerald-800">
              {notice}
            </p>
          )}
          {secret && <SecretNotice title={secret.title} secret={secret.value} />}

          <form
            className="mb-4 space-y-2 rounded-md border border-slate-200 p-3"
            onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                if (!api.createWebhook) return;
                const created = await api.createWebhook(projectId, { url: url.trim(), events });
                setSecret({ title: `Signing secret for ${created.url}`, value: created.secret });
                setUrl('');
                await refresh();
              });
            }}
          >
            <Field label="Payload URL">
              {(p) => (
                <input
                  {...p}
                  type="url"
                  className="input"
                  placeholder="https://example.com/hooks/chronicle"
                  value={url}
                  onChange={(e) => {
                    setUrl(e.target.value);
                  }}
                />
              )}
            </Field>
            <fieldset>
              <legend className="label">Send when</legend>
              <div className="grid gap-1 sm:grid-cols-2">
                {EVENTS.map((ev) => (
                  <label key={ev.id} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={events.includes(ev.id)}
                      onChange={(e) => {
                        setEvents((list) =>
                          e.target.checked ? [...list, ev.id] : list.filter((x) => x !== ev.id),
                        );
                      }}
                    />
                    {ev.label}
                  </label>
                ))}
              </div>
            </fieldset>
            <div className="flex justify-end">
              <button
                type="submit"
                className="btn-primary"
                disabled={busy || !url.trim() || events.length === 0}
              >
                <WebhookIcon size={14} aria-hidden /> Add webhook
              </button>
            </div>
          </form>

          {!hooks && !error && <p className="text-sm text-slate-600">Loading…</p>}
          {hooks?.length === 0 && <p className="text-sm text-slate-600">No webhooks yet.</p>}
          {hooks && hooks.length > 0 && (
            <ul className="divide-y divide-slate-200 rounded-md border border-slate-200">
              {hooks.map((h) => (
                <li key={h.id} className="px-3 py-2">
                  <div className="flex items-start justify-between gap-3">
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium text-slate-900">
                        {h.url}
                      </span>
                      <span className="block text-xs text-slate-600">
                        {h.events.join(', ')}
                        {h.active ? '' : ' · off'}
                      </span>
                      {h.disabledReason && (
                        <span className="block text-xs text-red-800">{h.disabledReason}</span>
                      )}
                    </span>
                    <span className="flex shrink-0 gap-0.5">
                      <button
                        type="button"
                        className="btn-ghost px-1.5 py-0.5 text-xs"
                        disabled={busy}
                        onClick={() =>
                          void run(async () => {
                            await api.updateWebhook?.(projectId, h.id, { active: !h.active });
                            await refresh();
                          })
                        }
                      >
                        {h.active ? 'Turn off' : 'Turn on'}
                      </button>
                      <button
                        type="button"
                        className="btn-ghost px-1.5 py-0.5 text-xs"
                        disabled={busy}
                        onClick={() =>
                          void run(async () => {
                            await api.testWebhook?.(projectId, h.id);
                            setNotice('Test ping queued. Check the recent deliveries.');
                            setExpanded(h.id);
                          })
                        }
                      >
                        <Send size={12} aria-hidden /> Test
                      </button>
                      <button
                        type="button"
                        className="btn-ghost px-1.5 py-0.5 text-xs"
                        aria-expanded={expanded === h.id}
                        onClick={() => {
                          setExpanded((id) => (id === h.id ? null : h.id));
                        }}
                      >
                        Deliveries
                      </button>
                      <button
                        type="button"
                        className="btn-ghost px-1.5 py-0.5 text-xs"
                        disabled={busy}
                        onClick={() => {
                          if (!window.confirm('Issue a new secret? The old one stops working.'))
                            return;
                          void run(async () => {
                            const value = await api.rotateWebhookSecret?.(projectId, h.id);
                            if (value) setSecret({ title: `New secret for ${h.url}`, value });
                          });
                        }}
                      >
                        New secret
                      </button>
                      <button
                        type="button"
                        className="icon-btn"
                        aria-label={`Delete webhook ${h.url}`}
                        disabled={busy}
                        onClick={() => {
                          if (!window.confirm(`Delete the webhook for ${h.url}?`)) return;
                          void run(async () => {
                            await api.deleteWebhook?.(projectId, h.id);
                            await refresh();
                          });
                        }}
                      >
                        <Trash2 size={15} aria-hidden />
                      </button>
                    </span>
                  </div>
                  {expanded === h.id && <Deliveries projectId={projectId} hook={h} />}
                </li>
              ))}
            </ul>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
