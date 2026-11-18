import * as Tabs from '@radix-ui/react-tabs';
import { useEditor, type SidebarTab } from '../../store/editor-store.js';
import { EventList } from './EventList.js';
import { TimelinePanel } from './TimelinePanel.js';
import { ThemePanel } from './ThemePanel.js';

const TABS: { value: SidebarTab; label: string }[] = [
  { value: 'events', label: 'Events' },
  { value: 'timeline', label: 'Timeline' },
  { value: 'theme', label: 'Theme' },
];

export function Sidebar() {
  const tab = useEditor((s) => s.sidebarTab);
  const setTab = useEditor((s) => s.setSidebarTab);

  return (
    <Tabs.Root
      value={tab}
      onValueChange={(v) => {
        setTab(v as SidebarTab);
      }}
      className="flex min-h-0 flex-1 flex-col"
    >
      <Tabs.List aria-label="Sidebar" className="flex shrink-0 border-b border-slate-200 px-2">
        {TABS.map((t) => (
          <Tabs.Trigger
            key={t.value}
            value={t.value}
            className="-mb-px border-b-2 border-transparent px-3 py-2 text-sm font-medium text-slate-600 hover:text-slate-900 data-[state=active]:border-blue-600 data-[state=active]:text-blue-700"
          >
            {t.label}
          </Tabs.Trigger>
        ))}
      </Tabs.List>
      <Tabs.Content
        value="events"
        className="flex min-h-0 flex-1 flex-col data-[state=inactive]:hidden"
      >
        <EventList />
      </Tabs.Content>
      <Tabs.Content
        value="timeline"
        className="flex min-h-0 flex-1 flex-col data-[state=inactive]:hidden"
      >
        <TimelinePanel />
      </Tabs.Content>
      <Tabs.Content
        value="theme"
        className="flex min-h-0 flex-1 flex-col data-[state=inactive]:hidden"
      >
        <ThemePanel />
      </Tabs.Content>
    </Tabs.Root>
  );
}
