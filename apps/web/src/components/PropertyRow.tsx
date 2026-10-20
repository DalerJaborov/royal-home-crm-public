import type { ReactNode } from "react";
import { CleanPropertyItem } from "./clean/CleanPropertyItem";
import { Link } from "react-router-dom";
import { formatMoney, formatPricePerSqm, STAGE_OWNER_LABELS } from "../lib/format";
import { formatPropertyCode } from "../lib/clientFormat";
import { initials, statusChipClass, statusChipLabel } from "../lib/theme2026";
import { avatarTone } from "../lib/avatarTone";
import { dushanbeTime } from "../lib/date";
import { PropertyStats } from "./PropertyStats";
import { PropertyHealthDot } from "./PropertyHealthDot";
import { propertyFloorsLabel, type PropertyHealthBrief } from "@royal-home/shared";

/** «, 5 из 9 этаж» у квартиры, «, 2 этажа» у дома, ничего у участка. */
function rowFloors(p: { type: string; floor?: number | null; totalFloors?: number | null }): string {
  const f = propertyFloorsLabel(p);
  if (!f) return "";
  return f.label === "Этаж" ? `, ${f.value} этаж` : `, ${f.value}`;
}
import type { Property } from "../types";

/**
 * ЧИПЫ СОСТОЯНИЯ МОНТАЖА (25.09.2026, задание D, владелец: «в списке объектов
 * сразу видеть, в каком состоянии») — из `Property.videoHandoffBrief`
 * (lib/propertyListItem.ts, без N+1 на список). Один объект может дать до
 * двух чипов сразу («У монтажёра 5 ч» + «Дошло 12/15», если доставка ещё не
 * закончилась) — тот же приём, что у остальных чипов строки, просто массив.
 */
function videoHandoffBriefChips(p: Property): { text: string; tone: "warn" | "mute" | "crit" | "ok" }[] {
  const brief = p.videoHandoffBrief;
  if (!brief || brief.state === "none") return [];
  switch (brief.state) {
    case "held":
      return [{ text: "Отложен", tone: "mute" }];
    case "queued":
      return [{ text: brief.position != null ? `В очереди ${brief.position}-й` : "В очереди", tone: "mute" }];
    case "editing": {
      const chips: { text: string; tone: "warn" | "mute" | "crit" | "ok" }[] = [
        { text: brief.hours != null ? `У монтажёра ${brief.hours} ч` : "У монтажёра", tone: "warn" },
      ];
      if (brief.deliveredOf) {
        const [delivered, total] = brief.deliveredOf;
        if (delivered < total) chips.push({ text: `Дошло ${delivered}/${total}`, tone: "crit" });
      }
      return chips;
    }
    case "received":
      return [{ text: "Ролик получен", tone: "ok" }];
    case "clip_review":
      return [{ text: "Ролик на проверке", tone: "warn" }];
    case "scheduled":
      return [{ text: brief.publishAt ? `Выйдет ${dushanbeTime(brief.publishAt)}` : "Ролик получен", tone: "ok" }];
    default:
      return [];
  }
}

/**
 * Строка каталога в облике эталона темы «Royal Home 2026».
 *
 * Разметка взята из docs/pult/theme-2026/screens/properties.html один в один:
 * `.prow.row` → `.pick` → `.ph` (с числом фотографий в `.n`) → `.t` (название
 * ссылкой `.lk` + строка адреса) → `.pr` → `.chip` → `.who` → `.act`. Своих
 * классов нет; узкая ширина обслуживается правилами `@media (max-width:820px)`
 * самого эталона (`.prow` переносит строки и раскладывает цену/чип/агента).
 *
 * Данные, права и поведение не тронуты: те же поля объекта, та же галочка выбора,
 * тот же переход на карточку.
 */

/**
 * Кого показать в колонке «Агент» — хозяина объекта по правилу сервера
 * (`propertyOwnerAgentId`: принял → ведёт сделку → завёл; решение владельца
 * 24.09.2026 «хозяин объекта — тот, кто его принял у собственника»). До
 * 28.09.2026 строка подписывалась наоборот, `assignedAgent ?? intakeAgent`: у
 * объекта, который приняла Ноза, а сделку вёл другой, в списке стояло чужое
 * имя, а в «Мои объекты» он у Нозы был — владелец читал это как «объекты не
 * показывает». Одно правило на список, фильтр, карту и профиль.
 */
function ownerAgent(p: Property) {
  return p.intakeAgent ?? p.assignedAgent ?? null;
}

function ownerAgentTitle(p: Property) {
  if (p.intakeAgent) {
    return p.assignedAgent && p.assignedAgent.id !== p.intakeAgent.id
      ? `Принял объект: ${p.intakeAgent.fullName} · сделку ведёт ${p.assignedAgent.fullName}`
      : `Принял объект: ${p.intakeAgent.fullName}`;
  }
  if (p.assignedAgent) return `Ведёт сделку: ${p.assignedAgent.fullName}`;
  return "Ответственного агента нет, легаси-объект без интейкера";
}

export function PropertyRow({
  property: p,
  myId,
  selected,
  onToggleSelect,
  onTogglePublish,
  health,
  subline,
  band,
  hideHandoffBrief,
  clean = false,
  cleanVariant = "row",
}: {
  property: Property;
  /** Текущий сотрудник — чтобы показать чип «Передан вам», когда объект передан
   *  именно ему и ещё не принят (см. PropertyOwnerCard.tsx на карточке объекта). */
  myId?: string;
  /** Светофор объекта (GET /properties/health) — точка перед названием. */
  health?: PropertyHealthBrief;
  selected?: boolean;
  onToggleSelect?: (id: string) => void;
  /** Публикация из строки — кнопка «Снять с сайта»/«На сайт» в `.act`, как решение
   *  одной кнопкой (эталон: решения без модалок). */
  onTogglePublish?: (id: string, action: "publish" | "unpublish") => void;
  /** Строка экрана-хозяина ВНУТРИ карточки, под адресом (конвейер: «На
   *  монтаже · 3 дня»). Список объектов её не передаёт. */
  subline?: ReactNode;
  /** Экран подготовки объектов рисует свою полосу очереди под строкой — чип
   *  состояния монтажа из списка там дублировал бы её. */
  hideHandoffBrief?: boolean;
  /** Полоса экрана-хозяина на всю ширину карточки, вторым рядом под основной
   *  строкой (конвейер: чипы и кнопки очереди монтажа). В `.act` не кладётся:
   *  там она сжимала название и адрес в столбик. Лежит выше растянутой ссылки —
   *  клик по кнопкам не открывает карточку. */
  band?: ReactNode;
  clean?: boolean;
  cleanVariant?: "row" | "card";
}) {
  const agent = ownerAgent(p);
  const stage = p.pipeline;
  if (clean) {
    return <CleanPropertyItem property={p} health={health} variant={cleanVariant} selected={selected} onToggleSelect={onToggleSelect} onTogglePublish={onTogglePublish} agentName={agent?.fullName} agentTitle={ownerAgentTitle(p)} floors={rowFloors(p)} awaitingAcceptance={!!p.handoverPendingSince && !!myId && p.intakeAgent?.id === myId} handoff={hideHandoffBrief ? [] : videoHandoffBriefChips(p)} subline={subline} band={band} />;
  }
  return (
    <>
    <div
      data-property-row=""
      data-list-row
      className="prow row wrapt relative"
      style={band ? { flexWrap: "wrap" } : undefined}
    >
            {onToggleSelect && (
        <input
          className="pick relative z-10"
          type="checkbox"
          checked={!!selected}
          onChange={() => onToggleSelect(p.id)}
          aria-label={`Выбрать объект: ${p.title}`}
        />
      )}
      {/* `.ph` эталона: знак места с иконкой дома, поверх — число фотографий.
          Есть снимок — он и стоит в рамке (эталон допускает `.ph img`). */}
      <span className="ph">
        {p.photos[0] ? (
          <img src={p.photos[0].thumbUrl} alt="" />
        ) : (
          <svg className="i" viewBox="0 0 24 24">
            <path d="M3 11 12 3l9 8v10H3z" />
            <path d="M9 21v-6h6v6" />
          </svg>
        )}
        {p.photos.length > 0 && <i className="n">{p.photos.length}</i>}
      </span>
      <div className="t">
        <b>
          <PropertyHealthDot health={health} />
          <Link className="lk" to={`/properties/${p.shortId}`}>
            {formatPropertyCode(p.shortId)} · {p.title}
          </Link>
        </b>
        <span>
          {p.district?.name ?? "Район не указан"}, {p.address}. {p.areaSqm} м²
          {rowFloors(p)}
        </span>
        {/* Три цифры плитками (Livento-кейс, бриф цветного слоя): только поля,
            которые реально приходят в ответе списка — см. PropertyStats.tsx. */}
        <PropertyStats property={p} />
        {subline}
      </div>
      <span className="pr">
        {formatMoney(p.price, p.currency)}
        <small>{formatPricePerSqm(p.price, p.areaSqm, p.currency)}</small>
      </span>
      <span className={statusChipClass(p.status, p.pipeline)}>{statusChipLabel(p.status, p.pipeline)}</span>
      {p.publishedOnSite && <span className="chip ok">На сайте</span>}
      {!!p.handoverPendingSince && !!myId && p.intakeAgent?.id === myId && (
        <span className="chip warn">Передан вам · примите</span>
      )}
      {!hideHandoffBrief && videoHandoffBriefChips(p).map((c) => (
        <span key={c.text} className={`chip ${c.tone}`}>
          {c.text}
        </span>
      ))}
      <span className="who" title={ownerAgentTitle(p)}>
        {agent ? (
          <>
            <span className="av" style={avatarTone(agent.fullName)}>{initials(agent.fullName)}</span>
            <span className="lk mut">{agent.fullName.split(" ")[0]}</span>
          </>
        ) : (
          <span className="chip mute">Без агента</span>
        )}
      </span>
      <div className="act relative z-10">
        {onTogglePublish && (
          <button
            className="pill ghost sm"
            type="button"
            onClick={() => onTogglePublish(p.id, p.publishedOnSite ? "unpublish" : "publish")}
          >
            {p.publishedOnSite ? "Снять с сайта" : "Опубликовать"}
          </button>
        )}
        <Link className="pill ghost sm" to={`/properties/${p.shortId}`}>
          Открыть
        </Link>
      </div>
      {/* Растянутая ссылка — как было до переноса на тему 2026 (e8859f31 её потерял):
          объект открывается нажатием в ЛЮБОЕ место строки, а не только по названию;
          ctrl-клик — новая вкладка, адрес копируется, клавиатура доходит. Лежит НИЖЕ
          чекбокса и кнопок `.act` — у них `relative z-10`. Найдено e2e smoke
          «карточка объекта открывается из списка» 10.09.2026. */}
      {band && (
        // order 8 — после `.act` (order 7) и на телефонной раскладке `.prow`.
        <div
          className="relative z-10"
          style={{ flex: "0 0 100%", order: 8, minWidth: 0, display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6 }}
        >
          {band}
        </div>
      )}
      <Link
        to={`/properties/${p.shortId}`}
        aria-label={`Открыть объект: ${p.title}`}
        className="absolute inset-0 z-0 rounded-lg focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-blue"
      />
    </div>
    {/* Просрочка этапа — тихая строка ПОД строкой объекта, ровно как в эталоне
        (properties.html, объект №118): `.quiet.crit` соседом `.prow`, не внутри. */}
    {stage?.overdue && (
      <div className="quiet crit" style={{ paddingLeft: 8 }}>
        <span className="dot crit" />
        <span className="txt">
          {STAGE_OWNER_LABELS[stage.owner ?? ""] ?? stage.owner ?? "Этап"} задерживает объект:{" "}
          {stage.daysInStage} дн. при сроке {stage.limitDays ?? "не задан"}.
        </span>
      </div>
    )}
    </>
  );
}
