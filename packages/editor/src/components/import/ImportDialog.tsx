import * as Dialog from '@radix-ui/react-dialog';
import * as Tabs from '@radix-ui/react-tabs';
import { X } from 'lucide-react';
import { JsonImport } from './JsonImport.js';
import { CsvImport } from './CsvImport.js';

export function ImportDialog({
  open,
  onOpenChange,
  onImported,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onImported: (message: string) => void;
}) {
  const done = (message: string) => {
    onOpenChange(false);
    onImported(message);
  };
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-slate-900/40" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 flex max-h-[90vh] w-[min(44rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col rounded-lg bg-white shadow-xl">
          <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3">
            <Dialog.Title className="text-base font-semibold text-slate-900">
              Import events
            </Dialog.Title>
            <Dialog.Close className="icon-btn" aria-label="Close">
              <X size={18} aria-hidden />
            </Dialog.Close>
          </div>
          <Dialog.Description className="sr-only">
            Import a timeline from JSON, TimelineJS or a CSV spreadsheet.
          </Dialog.Description>
          <Tabs.Root defaultValue="csv" className="flex min-h-0 flex-1 flex-col">
            <Tabs.List aria-label="Import format" className="flex border-b border-slate-200 px-4">
              {[
                ['csv', 'Spreadsheet (CSV)'],
                ['json', 'JSON / TimelineJS'],
              ].map(([value, label]) => (
                <Tabs.Trigger
                  key={value}
                  value={value}
                  className="-mb-px border-b-2 border-transparent px-3 py-2 text-sm font-medium text-slate-600 hover:text-slate-900 data-[state=active]:border-blue-600 data-[state=active]:text-blue-700"
                >
                  {label}
                </Tabs.Trigger>
              ))}
            </Tabs.List>
            <div className="min-h-0 flex-1 overflow-y-auto p-5">
              <Tabs.Content value="csv">
                <CsvImport onDone={done} />
              </Tabs.Content>
              <Tabs.Content value="json">
                <JsonImport onDone={done} />
              </Tabs.Content>
            </div>
          </Tabs.Root>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
