import { useState } from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import {
  ArrowDownToLine,
  ChevronDown,
  Copy,
  FilePlus2,
  FolderOpen,
  Plus,
  Redo2,
  Trash2,
  Undo2,
  Upload,
  Rows3,
  GalleryHorizontal,
  LayoutList,
  Cloud,
  LogIn,
  LogOut,
  KeyRound,
} from 'lucide-react';
import { getAllThemes } from '@chronicle/core';
import type { TimelineSettings } from '@chronicle/schema';
import { useEditor, selectRedoLabel, selectUndoLabel } from '../store/editor-store.js';
import { updateSettings } from '../store/commands.js';
import { addNewEvent, deleteSelected, duplicateSelected } from '../actions.js';
import { IconButton } from './ui.js';
import { useCloud } from '../cloud/cloud-store.js';
import { ApiKeysDialog } from './cloud/ApiKeysDialog.js';
import { isApplePlatform, MOD_KEY } from '../lib/platform.js';

const isMac = isApplePlatform();
const MOD = MOD_KEY;

const LAYOUTS: { value: TimelineSettings['layout']; label: string; Icon: typeof Rows3 }[] = [
  { value: 'vertical', label: 'Vertical', Icon: Rows3 },
  { value: 'horizontal', label: 'Horizontal', Icon: GalleryHorizontal },
  { value: 'card', label: 'Story cards', Icon: LayoutList },
];

const menuItem =
  'flex cursor-default select-none items-center gap-2 rounded px-2 py-1.5 text-sm text-slate-800 outline-none data-[highlighted]:bg-blue-50 data-[highlighted]:text-blue-800';

function PublishButton({ onPublish, onSignIn }: { onPublish: () => void; onSignIn: () => void }) {
  const api = useCloud((s) => s.api);
  const user = useCloud((s) => s.user);
  const role = useEditor((s) => s.remote?.role);
  if (!api) {
    return (
      <span title="Publishing needs a Chronicle server. Use Export to save a file instead.">
        <button type="button" className="btn-primary" disabled aria-describedby="publish-note">
          Publish
        </button>
        <span id="publish-note" className="sr-only">
          Publishing needs a Chronicle server; use Export.
        </span>
      </span>
    );
  }
  if (!user) {
    return (
      <button type="button" className="btn-primary" onClick={onSignIn}>
        Publish
      </button>
    );
  }
  return (
    <button
      type="button"
      className="btn-primary"
      disabled={role === 'viewer'}
      title={role === 'viewer' ? 'You have view-only access' : undefined}
      onClick={onPublish}
    >
      Publish
    </button>
  );
}

function AccountMenu({
  onSignIn,
  onOpenFromServer,
}: {
  onSignIn: () => void;
  onOpenFromServer: () => void;
}) {
  const api = useCloud((s) => s.api);
  const user = useCloud((s) => s.user);
  const checking = useCloud((s) => s.checking);
  const [keysOpen, setKeysOpen] = useState(false);
  if (!api) return null;
  if (checking) return <span className="px-2 text-xs text-slate-600">Connecting…</span>;
  if (!user) {
    return (
      <button type="button" className="btn-ghost" onClick={onSignIn}>
        <LogIn size={15} aria-hidden /> Sign in
      </button>
    );
  }
  return (
    <>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger className="btn-ghost" aria-label={`Account: ${user.name}`}>
          <span
            className="flex h-6 w-6 items-center justify-center rounded-full bg-blue-600 text-xs font-semibold text-white"
            aria-hidden
          >
            {user.name.slice(0, 1).toUpperCase()}
          </span>
          <ChevronDown size={14} aria-hidden />
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            align="end"
            sideOffset={4}
            className="z-40 min-w-56 rounded-md border border-slate-200 bg-white p-1 shadow-lg"
          >
            <DropdownMenu.Label className="px-2 py-1.5 text-xs text-slate-600">
              Signed in as <span className="font-medium text-slate-900">{user.email}</span>
            </DropdownMenu.Label>
            <DropdownMenu.Item className={menuItem} onSelect={onOpenFromServer}>
              <Cloud size={15} aria-hidden /> Open from Chronicle…
            </DropdownMenu.Item>
            <DropdownMenu.Item
              className={menuItem}
              onSelect={() => {
                setKeysOpen(true);
              }}
            >
              <KeyRound size={15} aria-hidden /> API keys…
            </DropdownMenu.Item>
            <DropdownMenu.Separator className="my-1 h-px bg-slate-200" />
            <DropdownMenu.Item
              className={menuItem}
              onSelect={() => {
                const { api: client, setUser } = useCloud.getState();
                void client?.logout().then(() => {
                  setUser(null);
                });
              }}
            >
              <LogOut size={15} aria-hidden /> Sign out
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
      <ApiKeysDialog open={keysOpen} onOpenChange={setKeysOpen} />
    </>
  );
}

export function Toolbar({
  onImport,
  onExport,
  onNewTimeline,
  onOpenDrafts,
  onPublish,
  onSignIn,
  onOpenFromServer,
}: {
  onImport: () => void;
  onExport: (format: 'json' | 'csv') => void;
  onNewTimeline: () => void;
  onOpenDrafts: () => void;
  onPublish: () => void;
  onSignIn: () => void;
  onOpenFromServer: () => void;
}) {
  const undoLabel = useEditor(selectUndoLabel);
  const redoLabel = useEditor(selectRedoLabel);
  const hasSelection = useEditor((s) => s.selectedId !== null);
  const settings = useEditor((s) => s.doc.settings);
  const title = useEditor((s) => s.doc.title);
  const { undo, redo, execute } = useEditor.getState();

  const setSetting = (patch: Partial<TimelineSettings>) => {
    execute(updateSettings(useEditor.getState().doc, patch));
  };

  return (
    <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-slate-200 bg-white px-3 py-2">
      <div className="flex min-w-0 items-center gap-2 pr-2">
        <img src="/favicon.svg" alt="" className="h-6 w-6" />
        <h1 className="truncate text-sm font-semibold text-slate-900" title={title}>
          <span className="sr-only">Chronicle editor: </span>
          {title || 'Untitled timeline'}
        </h1>
      </div>

      <div role="toolbar" aria-label="Edit" className="flex items-center gap-0.5">
        <IconButton
          label={undoLabel ? `Undo: ${undoLabel}` : 'Undo'}
          shortcut={`${MOD}Z`}
          disabled={!undoLabel}
          onClick={undo}
        >
          <Undo2 size={18} aria-hidden />
        </IconButton>
        <IconButton
          label={redoLabel ? `Redo: ${redoLabel}` : 'Redo'}
          shortcut={isMac ? '⌘⇧Z' : 'Ctrl+Y'}
          disabled={!redoLabel}
          onClick={redo}
        >
          <Redo2 size={18} aria-hidden />
        </IconButton>
        <span className="mx-1 h-5 w-px bg-slate-200" aria-hidden />
        <IconButton label="Add event" shortcut={`${MOD}Shift+E`} onClick={addNewEvent}>
          <Plus size={18} aria-hidden />
        </IconButton>
        <IconButton label="Duplicate event" disabled={!hasSelection} onClick={duplicateSelected}>
          <Copy size={17} aria-hidden />
        </IconButton>
        <IconButton label="Delete event" disabled={!hasSelection} onClick={deleteSelected}>
          <Trash2 size={17} aria-hidden />
        </IconButton>
      </div>

      <fieldset className="flex items-center rounded-md border border-slate-300 p-0.5">
        <legend className="sr-only">Layout</legend>
        {LAYOUTS.map(({ value, label, Icon }) => (
          <label
            key={value}
            title={label}
            className="relative flex h-7 cursor-pointer items-center gap-1 rounded px-2 text-xs font-medium text-slate-700 has-[:checked]:bg-blue-600 has-[:checked]:text-white has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-blue-600"
          >
            <input
              type="radio"
              name="layout"
              value={value}
              checked={settings.layout === value}
              onChange={() => {
                setSetting({ layout: value });
              }}
              className="sr-only"
            />
            <Icon size={15} aria-hidden />
            <span className="hidden xl:inline">{label}</span>
            <span className="sr-only xl:hidden">{label}</span>
          </label>
        ))}
      </fieldset>

      <label className="flex items-center gap-1.5 text-xs font-medium text-slate-700">
        Theme
        <select
          className="input w-auto py-1"
          value={settings.theme}
          onChange={(e) => {
            setSetting({ theme: e.target.value });
          }}
        >
          {getAllThemes().map((t) => (
            <option key={t.name} value={t.name}>
              {t.name[0].toUpperCase() + t.name.slice(1)}
            </option>
          ))}
        </select>
      </label>

      <div className="ml-auto flex items-center gap-1.5">
        <DropdownMenu.Root>
          <DropdownMenu.Trigger className="btn-ghost">
            <FolderOpen size={16} aria-hidden />
            File
            <ChevronDown size={14} aria-hidden />
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content
              align="end"
              sideOffset={4}
              className="z-40 min-w-48 rounded-md border border-slate-200 bg-white p-1 shadow-lg"
            >
              <DropdownMenu.Item className={menuItem} onSelect={onNewTimeline}>
                <FilePlus2 size={15} aria-hidden /> New timeline
              </DropdownMenu.Item>
              <DropdownMenu.Item className={menuItem} onSelect={onOpenDrafts}>
                <FolderOpen size={15} aria-hidden /> Open draft…
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>

        <button type="button" className="btn-secondary" onClick={onImport}>
          <Upload size={15} aria-hidden /> Import
        </button>

        <DropdownMenu.Root>
          <DropdownMenu.Trigger className="btn-secondary">
            <ArrowDownToLine size={15} aria-hidden /> Export
            <ChevronDown size={14} aria-hidden />
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content
              align="end"
              sideOffset={4}
              className="z-40 min-w-56 rounded-md border border-slate-200 bg-white p-1 shadow-lg"
            >
              <DropdownMenu.Item
                className={menuItem}
                onSelect={() => {
                  onExport('json');
                }}
              >
                JSON (full timeline)
              </DropdownMenu.Item>
              <DropdownMenu.Item
                className={menuItem}
                onSelect={() => {
                  onExport('csv');
                }}
              >
                CSV (events, for spreadsheets)
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>

        <PublishButton onPublish={onPublish} onSignIn={onSignIn} />
        <AccountMenu onSignIn={onSignIn} onOpenFromServer={onOpenFromServer} />
      </div>
    </header>
  );
}
