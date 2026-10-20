import { useEntityAuditLog } from "../hooks/useAuditLog";
import { useCan } from "../lib/permissions";
import { PROPERTY_STATUS_LABELS, relativeTime } from "../lib/format";
import { MIN_PROPERTY_PHOTOS, PROPERTY_STAGE_OWNER, type PropertyStatus } from "@royal-home/shared";
import { DismissibleHint } from "./ui/DismissibleHint";
import { AUDIT_ACTION_LABELS } from "../lib/audit";
import { canViewPropertyHistory } from "../lib/propertyHistoryVisible";

/**
 * История объекта — спецификация владельца: «руководитель обязан видеть,
 * кто и когда двигал объект». Раньше смена статуса/ответственного нигде не
 * логировалась — это построчный журнал по одной карточке, не общая лента
 * Архива (auditLogRouter уже умеет фильтровать по entityId — см. routes/auditLog.ts).
 *
 * Вид — вкладка «История» эталона (property-detail.html): строки `.list`/`.row`,
 * слева что произошло и кто, справа дата в `.meta`. Цветных иконок-кружков с
 * соединительной линией больше нет: §3 договора дизайна разрешает иконкам
 * только `--ink` и `--muted`, а различать события цветом на этом экране нечем
 * и незачем.
 *
 * ДОСТУП. Раньше карточка была видна только тем, у кого есть `auditLog.view`
 * (то же самое право, что открывает общий Архив) — рядовой агент не видел
 * историю даже СВОЕГО ЖЕ объекта. Теперь она открыта ещё и текущему
 * ответственному (риелтор/интейкер/создатель карточки — `isResponsible`
 * приходит от PropertyDetail, где уже посчитан ровно этот набор для canEdit).
 * Бэкенд (routes/auditLog.ts) разрешает тот же набор людей для entityType
 * Property — открывать карточку тут без права на сервере смысла не было бы,
 * запрос просто вернул бы 403.
 */

/**
 * Подписи, у которых на ЭТОЙ карточке формулировка своя — «Карточка заведена»
 * вместо общего «Создание». Всё остальное берётся из общего словаря журнала
 * (lib/audit.ts), а не дублируется здесь: свой список покрывал 12 действий из
 * 25 возможных у объекта, и остальные тринадцать — снятие поста, публикация в
 * TikTok и истории, возврат монтажёру, заявка на удаление — карточка истории
 * показывала служебным кодом. Полноту общего словаря сторожит
 * `npm run audit:audit-labels`.
 */
const ACTION_LABELS: Record<string, string> = {
  PROPERTY_CREATED: "Карточка заведена",
  PROPERTY_STATUS_CHANGED: "Статус изменён",
  PROPERTY_ASSIGNED_AGENT_CHANGED: "Ответственный агент изменён",
  PROPERTY_INTAKE_CHANGED: "Интейкер изменён",
  PROPERTY_EDITING_DONE: "Монтаж завершён, объект в продаже",
  TRASH: "Перемещён в корзину",
  RESTORE: "Восстановлен из корзины",
  PERMANENT_DELETE: "Удалён навсегда",
};

/** Строки «было → стало» из записи PROPERTY_FIELDS_CHANGED. Текст готовит сервер
 *  (lib/propertyChanges.ts), здесь только выводим — второго словаря полей нет. */
function fieldChanges(meta: unknown): { label: string; was: string; becomes: string }[] {
  const changes = (meta as { changes?: unknown } | null)?.changes;
  if (!Array.isArray(changes)) return [];
  return changes.filter(
    (c): c is { label: string; was: string; becomes: string } =>
      !!c && typeof c.label === "string" && typeof c.was === "string" && typeof c.becomes === "string"
  );
}

function statusLabel(v: unknown): string {
  if (typeof v !== "string") return "не указано";
  return PROPERTY_STATUS_LABELS[v as PropertyStatus] ?? v;
}

/** Чего объект ждёт сейчас и кто за это отвечает — строка-заголовок карточки.
 *  Роль (маркетинг/монтажёр) для этапов, где ответственный — не конкретный
 *  человек, а функция; для «ожидает фото/видео» ответственный — сам агент. */
const STAGE_WAITING_TEXT: Partial<Record<PropertyStatus, string>> = {
  PENDING_REVIEW: "проверка фото и видео",
  AWAITING_PHOTOS: `загрузка фото (минимум ${MIN_PROPERTY_PHOTOS})`,
  AWAITING_VIDEO: "видео объекта",
  EDITING: "монтаж и ссылка на видео-обзор",
};

const OWNER_ROLE_LABELS: Record<"MARKETING" | "EDITOR" | "AGENT", string> = {
  MARKETING: "маркетинг",
  EDITOR: "монтажёр",
  AGENT: "агент",
};

function waitingLine(
  status: PropertyStatus,
  agentNames: { assigned?: string | null; intake?: string | null }
): string | null {
  const waiting = STAGE_WAITING_TEXT[status];
  if (!waiting) return null;
  const owner = PROPERTY_STAGE_OWNER[status];
  const who =
    owner === "AGENT"
      ? agentNames.assigned ?? agentNames.intake ?? "агент не назначен"
      : owner
        ? OWNER_ROLE_LABELS[owner]
        : "не указано";
  return `Ждём: ${waiting} · ответственный: ${who}`;
}

export function PropertyHistoryCard({
  propertyId,
  status,
  isResponsible,
  assignedAgentName,
  intakeAgentName,
  showEmpty = false,
}: {
  propertyId: string;
  status: PropertyStatus;
  /** Текущий пользователь ведёт этот объект (риелтор/интейкер/создатель) —
   *  та же тройка, что и canManageProperty на сервере. Открывает карточку
   *  даже без общего права `auditLog.view`. */
  isResponsible: boolean;
  assignedAgentName?: string | null;
  intakeAgentName?: string | null;
  /** Вкладка «История» на компьютере: там карточка — единственное содержимое, и
   *  без неё вкладка открывалась совсем пустой (разбор 24.09.2026, пункт F).
   *  В стопке секций (телефон, правка) пустую карточку по-прежнему не рисуем. */
  showEmpty?: boolean;
}) {
  const can = useCan();
  // Правило то же, что у сервера (routes/auditLog.ts) — см. lib/propertyHistoryVisible.ts.
  const allowed = canViewPropertyHistory(can, isResponsible);
  const { data } = useEntityAuditLog("Property", propertyId, allowed);
  if (!allowed || !data || data.items.length === 0) {
    if (!showEmpty) return null;
    return (
      <div className="card">
        <div className="sec-h stack">
          <h2>История объекта</h2>
        </div>
        <div className="empty">
          <p>
          {!allowed
            ? "Историю объекта видят руководитель и агент этого объекта."
            : !data
              ? "Загружаем историю…"
              : "Записей пока нет: здесь появятся смена статуса, цены и ответственного."}
          </p>
        </div>
      </div>
    );
  }

  const waiting = waitingLine(status, { assigned: assignedAgentName, intake: intakeAgentName });

  return (
    <div className="card">
      <div className="sec-h stack">
        <h2>История объекта</h2>
        {waiting && <span className="note">{waiting}</span>}
      </div>
      {waiting && (
        /* Объясняем СМЫСЛ строки выше только при первом заходе — «Ждём: … ·
           ответственный: …» само по себе не говорит новому человеку, что за
           этим стоит целый конвейер со сменой ответственных на каждом этапе. */
        <DismissibleHint id="property-history-waiting-explainer">
          Объект готовится к продаже по шагам (проверка → фото → видео → монтаж), и на
          каждой стадии за неё отвечает свой человек или роль. Строка выше показывает, на какой стадии объект
          сейчас и кто должен её закрыть. Просрочка на любой стадии считается по срокам из Настроек.
        </DismissibleHint>
      )}

      <div className="list">
        {data.items.map((e) => (
          <div className="row" key={e.id}>
            <div className="t">
              <b>
                {ACTION_LABELS[e.action] ?? AUDIT_ACTION_LABELS[e.action] ?? e.action}
                {e.action === "PROPERTY_STATUS_CHANGED" &&
                  `: ${statusLabel(e.meta?.was)} на ${statusLabel(e.meta?.becomes)}`}
                {(e.action === "PROPERTY_PHOTOS_ADDED" || e.action === "PROPERTY_VIDEOS_ADDED") &&
                  typeof e.meta?.count === "number" &&
                  `: ${String(e.meta?.count)} шт.`}
              </b>
              {e.action === "PROPERTY_FIELDS_CHANGED" &&
                fieldChanges(e.meta).map((c, i) => (
                  <span key={i}>
                    {c.label}: {c.was} → {c.becomes}
                  </span>
                ))}
              <span>{e.agentName}</span>
            </div>
            <span className="meta">{relativeTime(e.createdAt)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
