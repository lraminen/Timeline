import { useMemo } from 'react';
import { Users } from 'lucide-react';
import { useCloud, type Peer } from '../../cloud/cloud-store.js';

const FIELD_NAMES: Record<string, string> = {
  title: 'the title',
  body: 'the description',
  'date.start': 'the date',
  'date.end': 'the end date',
  media: 'the media',
  tags: 'the tags',
};

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w.charAt(0).toUpperCase())
    .join('') || '?';

/** One entry per person (a person may have several tabs open). */
function usePeople(): Peer[] {
  const peers = useCloud((s) => s.peers);
  return useMemo(() => {
    const seen = new Map<string, Peer>();
    for (const p of peers) if (!seen.has(p.user.id)) seen.set(p.user.id, p);
    return [...seen.values()];
  }, [peers]);
}

function Avatar({ peer, size = 'md' }: { peer: Peer; size?: 'sm' | 'md' }) {
  return (
    <span
      className={`inline-flex items-center justify-center rounded-full font-semibold text-white ring-2 ring-white ${size === 'sm' ? 'h-4 w-4 text-[8px]' : 'h-6 w-6 text-[10px]'}`}
      style={{ backgroundColor: peer.user.color }}
      aria-hidden
    >
      {initials(peer.user.name)}
    </span>
  );
}

/** Who else is in this timeline right now (toolbar). */
export function PresenceAvatars() {
  const people = usePeople();
  const connection = useCloud((s) => s.connection);
  if (connection === 'off') return null;
  const names = people.map((p) => p.user.name).join(', ');
  return (
    <div
      className="flex items-center gap-1.5"
      role="status"
      aria-live="polite"
      data-connection={connection}
      aria-label={
        people.length
          ? `Also here: ${names}`
          : connection === 'live'
            ? 'Live — nobody else is here'
            : 'Not connected for live editing'
      }
      title={people.length ? `Also here: ${names}` : undefined}
    >
      {people.length > 0 ? (
        <span className="flex -space-x-1.5">
          {people.slice(0, 5).map((p) => (
            <Avatar key={p.user.id} peer={p} />
          ))}
          {people.length > 5 && (
            <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-slate-600 text-[10px] font-semibold text-white ring-2 ring-white">
              +{people.length - 5}
            </span>
          )}
        </span>
      ) : (
        <Users size={15} className="text-slate-500" aria-hidden />
      )}
      <span
        className={`h-2 w-2 rounded-full ${connection === 'live' ? 'bg-emerald-600' : connection === 'http' ? 'bg-amber-500' : 'bg-slate-400'}`}
        aria-hidden
      />
    </div>
  );
}

/** Small avatars of people who have an event selected (event list rows). */
export function EventPeers({ eventId }: { eventId: string }) {
  const people = usePeople().filter((p) => p.eventId === eventId);
  if (people.length === 0) return null;
  return (
    <span
      className="flex shrink-0 -space-x-1"
      title={people.map((p) => p.user.name).join(', ')}
      aria-label={`Selected by ${people.map((p) => p.user.name).join(', ')}`}
      role="img"
    >
      {people.slice(0, 3).map((p) => (
        <Avatar key={p.user.id} peer={p} size="sm" />
      ))}
    </span>
  );
}

/** "Grace is also editing the title" above the event form. */
export function EventPresenceNotice({ eventId }: { eventId: string }) {
  const people = usePeople().filter((p) => p.eventId === eventId);
  if (people.length === 0) return null;
  const text = people
    .map((p) => {
      const field = p.field ? (FIELD_NAMES[p.field] ?? null) : null;
      return field ? `${p.user.name} is editing ${field}` : `${p.user.name} is viewing this event`;
    })
    .join(' · ');
  return (
    <p
      className="flex items-center gap-1.5 rounded bg-sky-50 px-2 py-1 text-xs text-sky-900"
      role="status"
    >
      <span className="flex -space-x-1">
        {people.slice(0, 3).map((p) => (
          <Avatar key={p.user.id} peer={p} size="sm" />
        ))}
      </span>
      {text}. Changes merge automatically.
    </p>
  );
}
