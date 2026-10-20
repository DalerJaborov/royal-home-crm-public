import type { CSSProperties, ReactNode } from "react";
import { Clock3, Home, MessageCircle, Phone, UserRound } from "lucide-react";
import { CCard } from "./ui";

export type CleanClientTab = "short" | "chat" | "calls" | "props" | "hist";
const tabIcons = { short: UserRound, chat: MessageCircle, calls: Phone, props: Home, hist: Clock3 };

/** Clean phones use one active panel; only the historical phone view is a stack. */
export function cleanClientShowsPanel(clean: boolean, mobile: boolean, active: CleanClientTab, panel: CleanClientTab) {
  return (!clean && mobile) || active === panel;
}

const sections: { id: CleanClientTab; label: string }[] = [
  { id: "short", label: "Обзор" },
  { id: "chat", label: "Переписка" },
  { id: "calls", label: "Звонки" },
  { id: "props", label: "Объекты" },
  { id: "hist", label: "История" },
];

/** Local type scale: inherited by this desktop card, never by mobile or dialogs. */
export const cleanClientDetailScale = {
  "--fs-base": "16px", "--fs-12": "14px", "--fs-13": "14px", "--fs-14": "16px", "--fs-15": "16px", "--fs-23": "26px",
  fontSize: 16, lineHeight: 1.55,
} as CSSProperties;

export function CleanClientDetailHeader({ enabled, children }: { enabled: boolean; children: ReactNode }) {
  if (!enabled) return <div className="card">{children}</div>;
  return <header className="card clean-client-header" style={{ border: 0, padding: 24 }}>{children}</header>;
}

export function cleanClientTabForKey(current: CleanClientTab, key: string): CleanClientTab | undefined {
  const index = sections.findIndex((section) => section.id === current);
  if (key === "Home") return sections[0].id;
  if (key === "End") return sections[sections.length - 1].id;
  if (key === "ArrowRight") return sections[(index + 1) % sections.length].id;
  if (key === "ArrowLeft") return sections[(index + sections.length - 1) % sections.length].id;
  return undefined;
}

export function cleanClientPanelProps(tab: CleanClientTab) {
  return { role: "tabpanel", id: `clean-client-panel-${tab}`, "aria-labelledby": `clean-client-tab-${tab}`, tabIndex: 0 } as const;
}

export function CleanClientDetailTabs({ value, onChange }: { value: CleanClientTab; onChange: (value: CleanClientTab) => void }) {
  return (
    <div role="tablist" aria-label="Разделы карточки клиента" className="clean-record-tabs">
      {sections.map(({ id, label }) => (
        <button key={id} type="button" role="tab" id={`clean-client-tab-${id}`}
          aria-selected={id === value} aria-controls={`clean-client-panel-${id}`} tabIndex={id === value ? 0 : -1}
          className="rounded-full px-[18px] py-3 font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue"
          style={{ minHeight: 44, fontSize: 16, border: 0, background: id === value ? "var(--c-card)" : "transparent", color: id === value ? "rgb(var(--rgb-accent))" : "rgb(var(--rgb-ink))" }}
          onClick={() => onChange(id)}
          onKeyDown={(event) => {
            const next = cleanClientTabForKey(id, event.key);
            if (!next) return;
            event.preventDefault();
            onChange(next);
            event.currentTarget.parentElement?.querySelector<HTMLButtonElement>(`#clean-client-tab-${next}`)?.focus();
          }}
        ><span aria-hidden="true">{(() => { const Icon = tabIcons[id]; return <Icon size={18} />; })()}</span>{label}</button>
      ))}
    </div>
  );
}

export function CleanClientDetailSkeleton() {
  return (
    <div className="mx-auto grid max-w-[1440px] gap-5 p-6" role="status" aria-label="Загружаем карточку клиента" aria-busy="true">
      <CCard className="border-0">
        <div className="flex items-center gap-4"><span className="size-16 shrink-0 rounded-2xl bg-row-alt" /><div className="grid flex-1 gap-3"><span className="h-7 w-2/3 rounded-lg bg-row-alt" /><span className="h-5 w-1/2 rounded-lg bg-row-alt" /></div></div>
        <div className="mt-5 h-11 w-40 rounded-full bg-row-alt" />
      </CCard>
      <CCard className="border-0"><div className="h-12 rounded-2xl bg-row-alt" /><div className="mt-6 grid gap-3">{[1, 2, 3].map((line) => <span key={line} className="h-5 rounded-lg bg-row-alt" style={{ width: `${100 - line * 12}%` }} />)}</div></CCard>
    </div>
  );
}
