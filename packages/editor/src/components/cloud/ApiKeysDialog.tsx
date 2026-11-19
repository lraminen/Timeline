import { useEffect, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Copy, KeyRound, Trash2, X } from 'lucide-react';
import type { ApiKey } from '../../lib/api.js';
import { useCloud } from '../../cloud/cloud-store.js';
import { Field } from '../ui.js';

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Create, list and revoke API keys, used to connect integrations such as
 * the WordPress plugin. A new key's secret is shown once and never again.
 */
export function ApiKeysDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [keys, setKeys] = useState<ApiKey[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [label, setLabel] = useState('');
  const [created, setCreated] = useState<{ label: string; key: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  const api = useCloud((s) => s.api);

  useEffect(() => {
    if (!open || !api) return;
    setKeys(null);
    setError(null);
    setCreated(null);
    api.listApiKeys().then(setKeys, (err: unknown) => {
      setError(message(err));
    });
  }, [open, api]);

  const create = async () => {
    if (!api || !label.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const key = await api.createApiKey(label.trim());
      setCreated({ label: key.label, key: key.key });
      setLabel('');
      setKeys(await api.listApiKeys());
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (key: ApiKey) => {
    if (!api) return;
    if (!window.confirm(`Revoke “${key.label}”? Anything using it stops working.`)) return;
    setError(null);
    try {
      await api.revokeApiKey(key.id);
      setKeys((current) => current?.filter((k) => k.id !== key.id) ?? null);
    } catch (err) {
      setError(message(err));
    }
  };

  const fmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-slate-900/40" />
        <Dialog.Content
          className="fixed left-1/2 top-1/2 z-50 max-h-[90vh] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-lg bg-white p-5 shadow-xl"
          style={{ width: 'min(34rem, calc(100vw - 2rem))' }}
        >
          <div className="mb-2 flex items-center justify-between">
            <Dialog.Title className="text-base font-semibold">API keys</Dialog.Title>
            <Dialog.Close className="icon-btn" aria-label="Close">
              <X size={18} aria-hidden />
            </Dialog.Close>
          </div>
          <Dialog.Description className="mb-4 text-sm text-slate-600">
            Keys let other tools, such as the WordPress plugin, use your account. A key can do
            anything you can, except manage keys.
          </Dialog.Description>

          {error && (
            <p role="alert" className="mb-3 text-sm text-red-800">
              {error}
            </p>
          )}

          {created && (
            <div className="mb-4 rounded-md border border-amber-300 bg-amber-50 p-3">
              <Field
                label={`New key “${created.label}”`}
                hint="Copy it now: it will not be shown again."
              >
                {(p) => (
                  <div className="flex gap-2">
                    <input
                      {...p}
                      readOnly
                      className="input font-mono text-xs"
                      value={created.key}
                    />
                    <button
                      type="button"
                      className="btn-secondary shrink-0"
                      onClick={() =>
                        void navigator.clipboard.writeText(created.key).then(() => {
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
          )}

          <form
            className="mb-4 flex items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void create();
            }}
          >
            <Field label="New key name" className="flex-1">
              {(p) => (
                <input
                  {...p}
                  className="input"
                  value={label}
                  maxLength={100}
                  placeholder="e.g. Our WordPress site"
                  onChange={(e) => {
                    setLabel(e.target.value);
                  }}
                />
              )}
            </Field>
            <button type="submit" className="btn-primary" disabled={busy || !label.trim()}>
              <KeyRound size={14} aria-hidden /> Create key
            </button>
          </form>

          {!keys && !error && <p className="text-sm text-slate-600">Loading…</p>}
          {keys?.length === 0 && <p className="text-sm text-slate-600">No keys yet.</p>}
          {keys && keys.length > 0 && (
            <ul className="divide-y divide-slate-200 rounded-md border border-slate-200">
              {keys.map((k) => (
                <li key={k.id} className="flex items-center justify-between gap-3 px-3 py-2">
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium text-slate-900">
                      {k.label}
                    </span>
                    <span className="block text-xs text-slate-600">
                      <code>chr_{k.prefix}_…</code> · created {fmt.format(new Date(k.createdAt))}
                      {' · '}
                      {k.lastUsedAt
                        ? `last used ${fmt.format(new Date(k.lastUsedAt))}`
                        : 'never used'}
                    </span>
                  </span>
                  <button
                    type="button"
                    className="icon-btn"
                    aria-label={`Revoke ${k.label}`}
                    onClick={() => void revoke(k)}
                  >
                    <Trash2 size={15} aria-hidden />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
