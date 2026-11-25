import { lazy, Suspense, useEffect, useState } from 'react';
import * as Tooltip from '@radix-ui/react-tooltip';
import { useEditor } from './store/editor-store.js';
import { useAutosave, useShortcuts } from './hooks.js';
import { addNewEvent, exportDocument } from './actions.js';
import { createBlankTimeline, createSampleTimeline } from './lib/document.js';
import { latestDraft, loadDraft, requestPersistentStorage } from './lib/drafts.js';
import { newId } from './lib/ids.js';
import { MOD_KEY } from './lib/platform.js';
import { loadEditorConfig } from './lib/api.js';
import { initCloud, useCloud } from './cloud/cloud-store.js';
import { useCloudSync } from './cloud/use-cloud-sync.js';
import { AuthDialog } from './components/cloud/AuthDialog.js';
import {
  ConflictDialog,
  OpenProjectDialog,
  PublishDialog,
} from './components/cloud/CloudDialogs.js';
import { Toolbar } from './components/Toolbar.js';
import { Sidebar } from './components/sidebar/Sidebar.js';
import { Inspector } from './components/inspector/Inspector.js';
import { PreviewCanvas } from './components/PreviewCanvas.js';
import { StatusBar } from './components/StatusBar.js';
import { DraftsDialog } from './components/DraftsDialog.js';

const ConflictsDialog = lazy(() =>
  import('./components/ConflictsDialog.js').then((m) => ({ default: m.ConflictsDialog })),
);

// Loaded on first use: pulls in the CSV and JSON-position parsers.
const ImportDialog = lazy(() =>
  import('./components/import/ImportDialog.js').then((m) => ({ default: m.ImportDialog })),
);

export function App({ offlineReady = false }: { offlineReady?: boolean }) {
  const [ready, setReady] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [draftsOpen, setDraftsOpen] = useState(false);
  const [authOpen, setAuthOpen] = useState(false);
  const [publishOpen, setPublishOpen] = useState(false);
  const [openServerOpen, setOpenServerOpen] = useState(false);
  const [issuesOpen, setIssuesOpen] = useState(false);
  const [conflictsOpen, setConflictsOpen] = useState(false);
  const [conflictsMounted, setConflictsMounted] = useState(false);
  const [notice, setNotice] = useState<{ text: string; tone: 'info' | 'error' } | null>(null);
  const { status, saveNow } = useAutosave(ready);

  // Connect to the Chronicle server (if configured) without delaying the editor.
  useEffect(() => {
    void loadEditorConfig().then((config) => initCloud(config.apiUrl));
  }, []);
  useCloudSync();

  // Restore the most recent draft, or start with a sample on first visit.
  useEffect(() => {
    const abort = new AbortController();
    void (async () => {
      try {
        const draft = await latestDraft();
        if (abort.signal.aborted) return;
        if (draft) useEditor.getState().load(draft.doc, draft.id, draft.remote ?? null);
        else useEditor.getState().load(createSampleTimeline(), newId());
      } catch {
        // IndexedDB unavailable (e.g. private mode): edit in memory.
        if (abort.signal.aborted) return;
        useEditor.getState().load(createSampleTimeline(), newId());
        setNotice({
          text: 'Local storage is unavailable, so drafts won’t be saved. Export to keep your work.',
          tone: 'error',
        });
      }
      setReady(true);
      void requestPersistentStorage();
    })();
    return () => {
      abort.abort();
    };
  }, []);

  useEffect(() => {
    if (!notice || notice.tone === 'error') return;
    const t = setTimeout(() => {
      setNotice(null);
    }, 5000);
    return () => {
      clearTimeout(t);
    };
  }, [notice]);

  useShortcuts({ onSave: () => void saveNow(), onNewEvent: addNewEvent });

  const onExport = (format: 'json' | 'csv') => {
    const errors = exportDocument(format);
    if (errors.length) {
      setNotice({
        text: `Fix ${String(errors.length)} problem${errors.length > 1 ? 's' : ''} before exporting: ${errors[0]}`,
        tone: 'error',
      });
      setIssuesOpen(true);
    } else {
      setNotice({ text: `Exported ${format.toUpperCase()}.`, tone: 'info' });
    }
  };

  const switchTo = async (load: () => Promise<void> | void) => {
    await saveNow();
    useCloud.getState().setConflict(null);
    await load();
  };

  if (!ready) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-slate-600" role="status">
        Loading your timeline…
      </div>
    );
  }

  return (
    <Tooltip.Provider delayDuration={400}>
      <div className="flex h-full flex-col">
        <a
          href="#inspector"
          className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded focus:bg-white focus:px-3 focus:py-2 focus:shadow"
        >
          Skip to event editor
        </a>
        <Toolbar
          onImport={() => {
            setImportOpen(true);
          }}
          onExport={onExport}
          onNewTimeline={() =>
            void switchTo(() => {
              useEditor.getState().load(createBlankTimeline(), newId());
              setNotice({
                text: 'Started a new timeline. Your previous one is in File → Open draft.',
                tone: 'info',
              });
            })
          }
          onOpenDrafts={() => {
            setDraftsOpen(true);
          }}
          onPublish={() => {
            setPublishOpen(true);
          }}
          onSignIn={() => {
            setAuthOpen(true);
          }}
          onOpenFromServer={() => {
            setOpenServerOpen(true);
          }}
        />

        {notice && (
          <div
            role={notice.tone === 'error' ? 'alert' : 'status'}
            className={`flex items-center gap-3 px-4 py-2 text-sm ${notice.tone === 'error' ? 'bg-red-50 text-red-900' : 'bg-blue-50 text-blue-900'}`}
          >
            <span className="flex-1">{notice.text}</span>
            <button
              type="button"
              className="text-xs underline"
              onClick={() => {
                setNotice(null);
              }}
            >
              Dismiss
            </button>
          </div>
        )}

        <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
          <aside
            aria-label="Timeline contents"
            className="flex max-h-[40vh] min-h-0 flex-col border-b border-slate-200 bg-white lg:max-h-none lg:w-72 lg:border-b-0 lg:border-r xl:w-80"
          >
            <Sidebar />
          </aside>
          <main className="flex min-h-[50vh] min-w-0 flex-1 flex-col lg:min-h-0">
            <PreviewCanvas
              onShowIssues={() => {
                setIssuesOpen(true);
              }}
            />
          </main>
          <aside
            id="inspector"
            tabIndex={-1}
            aria-label="Event editor"
            className="flex min-h-0 flex-col border-t border-slate-200 bg-white lg:w-96 lg:border-l lg:border-t-0"
          >
            <Inspector />
          </aside>
        </div>

        <StatusBar
          save={status}
          offlineReady={offlineReady}
          issuesOpen={issuesOpen}
          onIssuesOpenChange={setIssuesOpen}
          onOpenConflicts={() => {
            setConflictsMounted(true);
            setConflictsOpen(true);
          }}
        />
      </div>

      {(conflictsOpen || conflictsMounted) && (
        <Suspense fallback={null}>
          <ConflictsDialog open={conflictsOpen} onOpenChange={setConflictsOpen} />
        </Suspense>
      )}

      {importOpen && (
        <Suspense fallback={null}>
          <ImportDialog
            open={importOpen}
            onOpenChange={setImportOpen}
            onImported={(text) => {
              setNotice({ text: `${text} Press ${MOD_KEY}Z to undo.`, tone: 'info' });
            }}
          />
        </Suspense>
      )}
      <AuthDialog open={authOpen} onOpenChange={setAuthOpen} />
      <PublishDialog open={publishOpen} onOpenChange={setPublishOpen} />
      <OpenProjectDialog
        open={openServerOpen}
        onOpenChange={setOpenServerOpen}
        beforeOpen={async () => {
          await saveNow();
          useCloud.getState().setConflict(null);
        }}
      />
      <ConflictDialog />
      <DraftsDialog
        open={draftsOpen}
        onOpenChange={setDraftsOpen}
        onOpen={(id) =>
          void switchTo(async () => {
            const draft = await loadDraft(id);
            if (draft) useEditor.getState().load(draft.doc, draft.id, draft.remote ?? null);
            setDraftsOpen(false);
          })
        }
      />
    </Tooltip.Provider>
  );
}
