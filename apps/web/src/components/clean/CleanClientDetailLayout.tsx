import type { CSSProperties, ReactNode } from "react";
import { Clock3, Home, MessageCircle, Phone, UserRound, type LucideIcon } from "lucide-react";
import { CCard } from "./ui";

export type CleanClientTab = "short" | "chat" | "calls" | "props" | "hist";
const tabIcons = { short: UserRound, chat: MessageCircle, calls: Phone, props: Home, hist: Clock3 };

/** Clean phones use one active panel; only the historical phone view is a stack. */
export function cleanClientShowsPanel(clean: boolean, mobile: boolean, active: CleanClientTab, panel: CleanClientTab) {
  return (!clean && mobile) || active === panel;
}

const sections: { id: CleanClientTab; label: string }[] = [
  { id: "short", label: "Обзор" },
  { id: "props", label: "Объекты" },
  { id: "chat", label: "Переписка" },
  { id: "calls", label: "Звонки" },
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

/** Стрелки и Home/End по вкладкам карточки — общее правило для всех `.clean-record-tabs`. */
export function cleanRecordTabForKey<Id extends string>(ids: readonly Id[], current: Id, key: string): Id | undefined {
  const index = ids.indexOf(current);
  if (key === "Home") return ids[0];
  if (key === "End") return ids[ids.length - 1];
  if (key === "ArrowRight") return ids[(index + 1) % ids.length];
  if (key === "ArrowLeft") return ids[(index + ids.length - 1) % ids.length];
  return undefined;
}

export function cleanClientTabForKey(current: CleanClientTab, key: string): CleanClientTab | undefined {
  return cleanRecordTabForKey(sections.map((section) => section.id), current, key);
}

export function cleanClientPanelProps(tab: CleanClientTab) {
  return { role: "tabpanel", id: `clean-client-panel-${tab}`, "aria-labelledby": `clean-client-tab-${tab}`, tabIndex: 0 } as const;
}

export type CleanRecordTab<Id extends string> = { id: Id; label: string; short?: string; icon: LucideIcon };

/**
 * Вкладки карточки записи в оболочке Clean (`.clean-record-tabs`): клиент,
 * кандидат. Роли tablist/tab, roving tabindex, стрелки и Home/End; панели
 * связаны через `<idPrefix>-tab-<id>` / `<idPrefix>-panel-<id>`.
 */
export function CleanRecordTabs<Id extends string>({ tabs, value, onChange, ariaLabel, idPrefix }: { tabs: ReadonlyArray<CleanRecordTab<Id>>; value: Id; onChange: (value: Id) => void; ariaLabel: string; idPrefix: string }) {
  const ids = tabs.map((t) => t.id);
  return (
    <div role="tablist" aria-label={ariaLabel} className="clean-record-tabs">
      {tabs.map(({ id, label, short, icon: Icon }) => (
        <button key={id} type="button" role="tab" id={`${idPrefix}-tab-${id}`}
          aria-selected={id === value} aria-label={label} aria-controls={`${idPrefix}-panel-${id}`} tabIndex={id === value ? 0 : -1}
          className="rounded-full px-[18px] py-3 font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue"
          style={{ minHeight: 44, fontSize: 16, border: 0, background: id === value ? "var(--c-card)" : "transparent", color: id === value ? "rgb(var(--rgb-accent))" : "rgb(var(--rgb-ink))" }}
          onClick={(event) => { onChange(id); event.currentTarget.scrollIntoView({ block: "nearest", inline: "nearest" }); }}
          onKeyDown={(event) => {
            const next = cleanRecordTabForKey(ids, id, event.key);
            if (!next) return;
            event.preventDefault();
            onChange(next);
            event.currentTarget.parentElement?.querySelector<HTMLButtonElement>(`#${idPrefix}-tab-${next}`)?.focus();
          }}
        ><span aria-hidden="true"><Icon size={18} /></span><span className="client-tab-long">{label}</span><span aria-hidden="true" className="client-tab-short">{short ?? label}</span></button>
      ))}
    </div>
  );
}

export function CleanClientDetailTabs({ value, onChange, objectsLabel = "Объекты" }: { value: CleanClientTab; onChange: (value: CleanClientTab) => void; objectsLabel?: string }) {
  const tabs = sections.map(({ id, label }) => ({ id, icon: tabIcons[id], label: id === "props" ? objectsLabel : label, short: id === "chat" ? "Чаты" : id === "props" ? "По объектам" : label }));
  return <CleanRecordTabs tabs={tabs} value={value} onChange={onChange} ariaLabel="Разделы карточки клиента" idPrefix="clean-client" />;
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
