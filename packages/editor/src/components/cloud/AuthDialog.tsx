import { useState, type FormEvent } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { ApiRequestError } from '../../lib/api.js';
import { useCloud } from '../../cloud/cloud-store.js';
import { Field } from '../ui.js';

export function AuthDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const [mode, setMode] = useState<'signin' | 'signup'>('signin');
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const { api, setUser } = useCloud.getState();
    if (!api) return;
    setBusy(true);
    setError(null);
    try {
      const user =
        mode === 'signin'
          ? await api.login(email, password)
          : await api.register(email, name, password);
      setUser(user);
      setPassword('');
      onOpenChange(false);
    } catch (err) {
      if (err instanceof ApiRequestError && Array.isArray(err.details)) {
        setError((err.details as { message: string }[]).map((d) => d.message).join('. '));
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-slate-900/40" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[min(26rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-lg bg-white p-5 shadow-xl">
          <div className="mb-4 flex items-center justify-between">
            <Dialog.Title className="text-base font-semibold">
              {mode === 'signin' ? 'Sign in to Chronicle' : 'Create a Chronicle account'}
            </Dialog.Title>
            <Dialog.Close className="icon-btn" aria-label="Close">
              <X size={18} aria-hidden />
            </Dialog.Close>
          </div>
          <Dialog.Description className="mb-4 text-sm text-slate-600">
            Save timelines to the server, publish them, and edit them on any device.
          </Dialog.Description>
          <form onSubmit={(e) => void submit(e)} className="space-y-3">
            {mode === 'signup' && (
              <Field label="Name">
                {(p) => (
                  <input
                    {...p}
                    className="input"
                    autoComplete="name"
                    required
                    value={name}
                    onChange={(e) => {
                      setName(e.target.value);
                    }}
                  />
                )}
              </Field>
            )}
            <Field label="Email">
              {(p) => (
                <input
                  {...p}
                  className="input"
                  type="email"
                  autoComplete="email"
                  required
                  value={email}
                  onChange={(e) => {
                    setEmail(e.target.value);
                  }}
                />
              )}
            </Field>
            <Field
              label="Password"
              hint={mode === 'signup' ? 'At least 10 characters.' : undefined}
            >
              {(p) => (
                <input
                  {...p}
                  className="input"
                  type="password"
                  autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
                  minLength={mode === 'signup' ? 10 : undefined}
                  required
                  value={password}
                  onChange={(e) => {
                    setPassword(e.target.value);
                  }}
                />
              )}
            </Field>
            {error && (
              <p role="alert" className="text-sm text-red-800">
                {error}
              </p>
            )}
            <button type="submit" className="btn-primary w-full" disabled={busy}>
              {busy ? 'Please wait…' : mode === 'signin' ? 'Sign in' : 'Create account'}
            </button>
          </form>
          <p className="mt-4 text-center text-sm text-slate-600">
            {mode === 'signin' ? 'New to Chronicle? ' : 'Already have an account? '}
            <button
              type="button"
              className="font-medium text-blue-700 underline"
              onClick={() => {
                setMode(mode === 'signin' ? 'signup' : 'signin');
                setError(null);
              }}
            >
              {mode === 'signin' ? 'Create an account' : 'Sign in'}
            </button>
          </p>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
