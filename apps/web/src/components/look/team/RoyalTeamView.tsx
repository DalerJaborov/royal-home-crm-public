import { useState, type ReactNode } from "react";
import { MoreHorizontal, SlidersHorizontal } from "lucide-react";
import type { TeamMember } from "../../../hooks/useTeam";
import type { HallOfFameTeammate } from "../../../pages/HallOfFame";
import { ROLE_LABELS } from "../../../lib/roles";
import { absenceLabel } from "../../../lib/absenceLabel";
import { formatMoney, pluralizeRu, relativeTime } from "../../../lib/format";
import { TeamTabs } from "../../SectionTabs";
import { Rh2Sheet } from "../../rh2/Rh2Sheet";
import { RhAvatar, RhBlockState, RhButton, RhGroup, RhRow, RhSection, RhTile } from "../ui";
import { RoyalIcon } from "../RoyalIcon";
import { RoyalSection } from "../clients/RoyalSection";
import type { RoyalIconName } from "../royalIconData";

/**
 * КОМАНДА В «НОВОМ ВИДЕ» (18.11.2026, макет `screenTeam`/`teamTable`).
 *
 * Только разметка. Данные, фильтры, права и окна (фильтры, отпуск, передача
 * дел, журнал баллов) приходят готовыми из pages/Team.tsx — те же запросы и те
 * же обработчики, что у прежнего вида. Строка сотрудника: одно главное действие
 * (открыть карточку), остальные три — под «⋯» в шторке.
 */
type Filter = "all" | "agents" | "managers" | "frozen";

export interface RoyalTeamProps {
  supervisor: boolean;
  fame: { data: { team: HallOfFameTeammate[] } | undefined; loading: boolean; error: boolean; retry: () => void };
  team: { data: TeamMember[] | undefined; loading: boolean; error: boolean; retry: () => void };
  visible: TeamMember[];
  counts: Record<Filter, number>;
  online: number;
  frozen: TeamMember[];
  load: { agents: number; total: number };
  filter: Filter;
  onFilter: (filter: Filter) => void;
  sheetFilters: number;
  onOpenFilters: () => void;
  showStages: boolean;
  onToggleStages: () => void;
  stagesNode: ReactNode;
  recognition: ReactNode;
  boards: ReactNode;
  rank: (id: string) => { score: number | null; place: number } | undefined;
  rankTotal: number;
  seesMoney: boolean;
  canManage: boolean;
  chips: (member: TeamMember) => ReactNode;
  onOpen: (id: string) => void;
  onFreeze: (member: TeamMember) => void;
  onHandover: (member: TeamMember) => void;
  onPoints: (member: TeamMember) => void;
  overlays: ReactNode;
}

const INTRO = "Показатели за текущий месяц. Их видит только руководство: агент видит свои цифры и своё место, чужие только по номинациям.";

function statusLine(m: TeamMember): string {
  return `${ROLE_LABELS[m.role]}${m.frozen ? `, ${absenceLabel(m)}` : !m.isActive ? ", деактивирован" : m.online ? ", в сети"
    : m.lastSeenAt ? `, был(а) ${relativeTime(m.lastSeenAt)}` : ""}`;
}

/** Заголовок экрана: сведения о том, кто видит показатели, — открытой строкой, не под «i». */
function Head({ actions }: { actions?: ReactNode }) {
  return (
    <header className="ry-page-head">
      <div className="ry-page-title"><h1 className="ry-title" data-dup>Команда</h1></div>
      {actions && <div className="ry-page-acts">{actions}</div>}
      <p className="ry-meta ry-page-intro">{INTRO}</p>
    </header>
  );
}

export function RoyalTeamView(p: RoyalTeamProps) {
  // Метка раздела: шторки и окна из этого экрана (фильтры, отпуск, передача дел) — тоже в разделе team.
  return <RoyalSection name="team"><RoyalTeamBody {...p} /></RoyalSection>;
}

function RoyalTeamBody(p: RoyalTeamProps) {
  const [actionsFor, setActionsFor] = useState<TeamMember | null>(null);

  if (!p.supervisor) {
    const fame = p.fame.data;
    return (
      <div className="rh2 screens ry-teamp" data-ry-section="team">
        <div className="scr">
          <Head />
          <div className="ry-subtabs"><TeamTabs /></div>
          {p.boards}
          <RhSection title="Вся команда">
            <p className="ry-meta">Ваши коллеги. Показатели каждого видит только руководство.</p>
            {p.fame.loading ? <RhBlockState kind="loading" /> : p.fame.error ? <RhBlockState kind="error" onRetry={p.fame.retry} />
              : !fame?.team.length ? <div className="ry-state">В команде пока никого нет</div> : (
                <RhGroup label="Коллеги">
                  {fame.team.map((m) => (
                    <RhRow key={m.id} lead={<Person name={m.fullName} src={m.avatarUrl} online={m.online} />}
                      title={m.fullName} sub={m.online ? "в сети" : "не в сети"} subTone={m.online ? "ok" : undefined} />
                  ))}
                </RhGroup>
              )}
          </RhSection>
        </div>
      </div>
    );
  }

  const list = p.team.data ?? [];
  return (
    <div className="rh2 screens ry-teamp" data-ry-section="team">
      <div className="scr">
        <Head actions={<>
          <RhButton variant="gray" onClick={p.onOpenFilters}>
            <SlidersHorizontal size={20} strokeWidth={2} aria-hidden="true" />Фильтры{p.sheetFilters > 0 ? ` ${p.sheetFilters}` : ""}
          </RhButton>
          <RhButton variant={p.showStages ? "dark" : "gray"} aria-pressed={p.showStages} onClick={p.onToggleStages}>Показы и сделки</RhButton>
        </>} />
        <div className="ry-subtabs"><TeamTabs /></div>

        {list.length > 0 && (
          <div className="ry-team-tiles">
            <RhTile variant="brand" icon="users-round" label="В команде" value={p.counts.all} />
            <RhTile variant="ink" icon="zap" label="В сети" value={p.online} />
            <RhTile variant="plain" icon="inbox" label={p.load.agents === 0 ? "Раздавать некому" : `В работе у ${p.load.agents} ${pluralizeRu(p.load.agents, ["агента", "агентов", "агентов"])}`}
              value={p.load.agents === 0 ? 0 : p.load.total} />
          </div>
        )}

        {p.canManage && p.frozen.length > 0 && (
          <RhSection title="Решить сейчас">
            <RhGroup>
              {p.frozen.map((m) => (
                <div className="ry-row" key={m.id}>
                  <Person name={m.fullName} src={m.avatarUrl} online={false} />
                  <span className="ry-row-text">
                    <button type="button" className="ry-row-title ry-linklike" onClick={() => p.onOpen(m.id)}>{m.fullName}</button>
                    <span className="ry-row-sub ry-wrap" data-tone="warn">
                      {absenceLabel(m)}{m.frozenAt ? `, с ${relativeTime(m.frozenAt)}` : ""}.{m.frozenReason ? ` Причина: ${m.frozenReason}.` : ""} Новые лиды ему не приходят.
                    </span>
                  </span>
                  <span className="ry-row-right"><RhButton variant="primary" onClick={() => p.onFreeze(m)}>Вернуть в строй</RhButton></span>
                </div>
              ))}
            </RhGroup>
          </RhSection>
        )}

        {p.recognition}

        <RhSection title="Вся команда">
          <p className="ry-meta">{p.counts.all} {pluralizeRu(p.counts.all, ["человек", "человека", "человек"])}, {p.online} в сети</p>
          <div className="ry-chips" role="tablist" aria-label="Кого показывать">
            {([["all", "Все"], ["agents", "Агенты"], ["managers", "Менеджеры"], ["frozen", "Заморожены"]] as const).map(([key, label]) => (
              <button key={key} type="button" role="tab" aria-selected={p.filter === key} className="ry-pill" onClick={() => p.onFilter(key)}>
                {label}<b className="ry-num">{p.counts[key]}</b>
              </button>
            ))}
          </div>
          {p.showStages && p.stagesNode}
          {/* Что такое «Баллы» и «Место» — одной строкой рядом с таблицей, а не сноской под ней (главные руководителей, 20.11.2026). */}
          {list.length > 0 && <p className="ry-meta">Баллы — оценка работы агента в рейтинге: растут за дела вовремя, сделки и показы, падают за пропуски. Место — среди агентов по баллам.</p>}
          {p.team.loading ? <RhBlockState kind="loading" /> : p.team.error ? <RhBlockState kind="error" onRetry={p.team.retry} />
            : list.length === 0 ? <div className="ry-state">В команде пока никого нет</div> : (
              <div className="ry-group ry-members" role="list" aria-label="Сотрудники">
                <div className="ry-mhead" aria-hidden="true">
                  <span>Сотрудник</span><span>В работе</span><span>Лиды</span><span>Показы</span><span>Сделки</span>
                  {p.seesMoney && <span>Комиссия</span>}<span>Баллы</span><span>Место</span><span />
                </div>
                {p.visible.map((m) => {
                  const rank = p.rank(m.id);
                  return (
                    <div className="ry-mrow" role="listitem" key={m.id} data-money={p.seesMoney || undefined}>
                      <button type="button" className="ry-mrow-main" onClick={() => p.onOpen(m.id)} aria-label={`Открыть карточку: ${m.fullName}`}>
                        <Person name={m.fullName} src={m.avatarUrl} online={m.online} />
                        <span className="ry-mrow-text">
                          <span className="ry-row-title">{m.fullName}</span>
                          <span className="ry-row-sub" data-tone={m.frozen ? "warn" : undefined}>{statusLine(m)}</span>
                          {p.chips(m)}
                        </span>
                        <span className="ry-mrow-stats">
                        <Stat label="В работе" value={m.role === "AGENT" ? m.activeLoad : "нет"} />
                        <Stat label="Лиды" value={m.month.leads} />
                        <Stat label="Показы" value={m.month.showings} />
                        <Stat label="Сделки" value={m.month.dealsCompleted} />
                        {p.seesMoney && <Stat label="Комиссия" value={formatMoney(m.month.commission ?? 0, "TJS")} wide />}
                        <Stat label="Баллы" value={rank?.score ?? "нет"} />
                        <Stat label="Место" value={rank ? `${rank.place} из ${p.rankTotal}` : "нет"} />
                        </span>
                      </button>
                      <button type="button" className="ry-more-btn" aria-label={`Действия: ${m.fullName}`} onClick={() => setActionsFor(m)}>
                        <MoreHorizontal size={22} strokeWidth={2} aria-hidden="true" />
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          {list.length > 0 && <p className="ry-meta">Показаны {p.visible.length} из {p.counts.all}.</p>}
        </RhSection>
      </div>

      {actionsFor && (
        <Rh2Sheet title={actionsFor.fullName} onClose={() => setActionsFor(null)} ariaLabel={`Действия: ${actionsFor.fullName}`}>
          <RhGroup>
            <RhRow onClick={() => { const m = actionsFor; setActionsFor(null); p.onOpen(m.id); }} title="Открыть карточку"
              lead={<span className="ry-circle" data-tone="a0" aria-hidden="true"><Glyph name="users-round" /></span>} />
            {p.canManage && <>
              <RhRow onClick={() => { const m = actionsFor; setActionsFor(null); p.onFreeze(m); }} title={actionsFor.frozen ? "Вернуть в строй" : "Отпуск / больничный"}
                lead={<span className="ry-circle" data-tone="a5" aria-hidden="true"><Glyph name="clock" /></span>} />
              <RhRow onClick={() => { const m = actionsFor; setActionsFor(null); p.onHandover(m); }} title="Передать дела"
                lead={<span className="ry-circle" data-tone="a4" aria-hidden="true"><Glyph name="handshake" /></span>} />
            </>}
            <RhRow onClick={() => { const m = actionsFor; setActionsFor(null); p.onPoints(m); }}
              title={`${actionsFor.points} бонусных ${pluralizeRu(actionsFor.points, ["балл", "балла", "баллов"])} (архив)`}
              lead={<span className="ry-circle" data-tone="a2" aria-hidden="true"><Glyph name="archive" /></span>} />
          </RhGroup>
        </Rh2Sheet>
      )}
      {p.overlays}
    </div>
  );
}

function Stat({ label, value, wide }: { label: string; value: ReactNode; wide?: boolean }) {
  return <span className="ry-stat" data-wide={wide || undefined}><b className="ry-num">{value}</b><small>{label}</small></span>;
}

function Person({ name, src, online }: { name: string; src?: string | null; online: boolean }) {
  return (
    <span className="ry-person">
      <RhAvatar name={name} src={src} />
      <span className="ry-pres" data-on={online} aria-hidden="true" />
    </span>
  );
}

function Glyph({ name }: { name: RoyalIconName }) { return <RoyalIcon name={name} />; }
