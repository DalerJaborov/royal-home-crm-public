import type { ClientSort, ClientStatus } from "@royal-home/shared";

export { CLIENT_STATUS_LABELS, CLIENT_SOURCE_LABELS } from "@royal-home/shared";

/**
 * Порядок выдачи списка клиентов — одна корзина подписей на десктоп
 * (pages/Clients.tsx, шторка «Фильтры») и телефон
 * (pages/Clients.tsx, та же шторка в идиоме `.mh`):
 * жил только в Clients.tsx до 22.09.2026, телефон сортировку не предлагал
 * вовсе (баг класса «desktop и mobile ship together», CLAUDE.md).
 */
export const DEFAULT_CLIENT_SORT: ClientSort = "created_desc";

type ClientSortField = "name" | "status" | "score" | "budget" | "source" | "created" | "contact" | "agent" | "attention";

/** «created_desc» → ["created", "desc"]. Направление всегда последним куском,
 *  поэтому режем по последнему подчёркиванию, а не по первому. */
function parseClientSort(sort: ClientSort): [ClientSortField, "asc" | "desc"] {
  const cut = sort.lastIndexOf("_");
  return [sort.slice(0, cut) as ClientSortField, sort.slice(cut + 1) as "asc" | "desc"];
}

const CLIENT_SORT_COLUMN_LABELS: Record<ClientSortField, string> = {
  name: "Клиент / телефон",
  status: "Статус",
  score: "Скор",
  budget: "Бюджет",
  source: "Источник",
  created: "Первое обращение",
  contact: "Последний контакт",
  agent: "Агент",
  attention: "Кому нужен ответ",
};

export const CLIENT_SORT_OPTIONS: { value: ClientSort; label: string }[] = [
  { value: "created_desc", label: "Сначала новые" },
  { value: "attention_desc", label: "Сначала те, кому нужен ответ" },
  { value: "created_asc", label: "Сначала давние" },
  { value: "contact_desc", label: "Свежий контакт" },
  { value: "contact_asc", label: "Давно не общались" },
  { value: "budget_desc", label: "Бюджет: больше" },
  { value: "budget_asc", label: "Бюджет: меньше" },
  { value: "score_desc", label: "Скор: выше" },
  { value: "name_asc", label: "Имя: А-Я" },
];

/** Порядок, пришедший ссылкой (например, по агенту), в коротком списке
 *  отсутствует — без этой строки выбор показывал бы пустое значение и первое же
 *  его открытие молча сбрасывало бы сортировку. */
export function clientSortOptionsFor(current: ClientSort): { value: ClientSort; label: string }[] {
  if (CLIENT_SORT_OPTIONS.some((o) => o.value === current)) return CLIENT_SORT_OPTIONS;
  const [field, direction] = parseClientSort(current);
  return [
    { value: current, label: `${CLIENT_SORT_COLUMN_LABELS[field]} ${direction === "asc" ? "↑" : "↓"}` },
    ...CLIENT_SORT_OPTIONS,
  ];
}

export const CLIENT_STATUS_CLASSES: Record<ClientStatus, string> = {
  NEW: "text-blue bg-blue/10",
  CONTACTED: "text-violet bg-violet-bg",
  HOT: "text-red bg-red-bg",
  COLD: "text-gray-500 bg-line-soft",
  UNRESPONSIVE: "text-amber bg-amber-bg",
  /* Красно-серый: это не «горячий» и не «в работе» — карточка выпала из оборота. */
  LOST: "text-red bg-line-soft",
  DEAL_CLOSED: "text-green bg-green-bg",
  ARCHIVED: "text-gray-400 bg-line-soft",
};

/**
 * Человекочитаемый номер клиента/объекта — ТЗ «Путь покупателя», п. 2: «Каждому
 * клиенту CRM автоматически присваивает уникальный номер. Например: КЛ-000001».
 *
 * Сами функции переехали в @royal-home/shared (packages/shared/src/format.ts)
 * 30.08.2026 вместе с префиксом по типу клиента (ПК/ПР/ПО, покупатель — с
 * 31.08.2026, было КЛ): их читает и веб, и
 * тексты уведомлений API, а разбор номера в поиске (parseShortCode) лежал в общем
 * пакете и раньше — расходиться показу и поиску нельзя. Здесь остался реэкспорт,
 * чтобы не переписывать полтора десятка импортов по экранам.
 */
export {
  formatClientCode,
  formatPropertyCode,
  formatClientName,
  CLIENT_KIND_LABELS,
  clientKindLabel,
} from "@royal-home/shared";

/**
 * Полосы совпадения для 7-го лида (Путь покупателя, п.5.1) — дословные
 * формулировки владельца: 90-100% практически полное совпадение, 85-90%
 * основное совпадает с небольшим расхождением, 75-80% совпадает большая часть,
 * но есть заметное расхождение по одному из ключевых параметров. Ниже 75 сюда
 * не попадает вовсе — порог совпадения (с 10.09.2026 — 90) в Настройках отсекает раньше.
 */
export function matchScoreBand(score: number): string {
  if (score >= 90) return "практически полное совпадение";
  if (score >= 85) return "совпадение по основным параметрам";
  if (score >= 75) return "совпадение по большинству параметров";
  return "частичное совпадение";
}

export const INTERACTION_TYPE_LABELS: Record<string, string> = {
  CALL: "Звонок",
  MESSAGE: "Сообщение",
  MEETING: "Встреча",
  SHOWING: "Показ",
  STATUS_CHANGE: "Смена статуса",
  SYSTEM: "Система",
};

/**
 * Кто действовал (П-10, 17.09.2026, docs/audit/lead-ownership-17-09.md §2) —
 * без AGENT: у него имя видно напрямую (interaction.agent.fullName), а не
 * этим лейблом. `actorKind` появился только у новых/перекрашенных бэкофиллом
 * записей — у старых, не тронутых бэкофиллом, поле уже стоит AGENT по
 * умолчанию (см. миграцию 2026091722xxxx_interaction_actor_kind), так что
 * `actorLabel` ниже безопасен и на них.
 */
export const INTERACTION_ACTOR_KIND_LABELS: Record<string, string> = {
  SYSTEM: "Система",
  AI: "ИИ CRM",
  BOT: "Бот",
  CLIENT: "Клиент",
};

/**
 * Подпись автора для заголовка строки хронологии, БЕЗ раскрытия записи
 * (владелец: «каждый раз приходится раскрывать», см. InteractionTimeline.tsx).
 * AGENT — null: для него имя и так печатается заголовком/полем «Кто» ниже,
 * вторая подпись была бы дублем. Для остальных — «Система»/«ИИ CRM»/«Бот»/
 * «Клиент», и мелкая «для <субъекта>» у SYSTEM/AI, когда известно, чья это
 * задача (subjectAgent).
 */
export function actorLabel(i: { actorKind?: string | null; subjectAgent?: { fullName: string } | null }): string | null {
  const kind = i.actorKind ?? "AGENT";
  if (kind === "AGENT") return null;
  const label = INTERACTION_ACTOR_KIND_LABELS[kind];
  if (!label) return null;
  const forWhom = (kind === "SYSTEM" || kind === "AI") && i.subjectAgent?.fullName ? ` · для ${i.subjectAgent.fullName}` : "";
  return `${label}${forWhom}`;
}

/**
 * Текст системного события БЕЗ служебного кода в начале.
 *
 * Сервер намеренно пишет в `notes` префикс `[<источник>]` — `[lifecycle.assign]`,
 * `[reassignment.wave]`, `[manual.*]` и так далее (см. `lib/changeClientAgent.ts`
 * и `lib/clientLifecycle.ts`): по нему ищут бэкофиллы и разборы, убирать его из
 * базы нельзя. Но владельцу 21.09.2026 эти коды доехали прямо на экран карточки
 * клиента — «[lifecycle.assign] Нурмухаммад вручную назначил(а) …», — и читаются
 * как поломка. Прячем их ТОЛЬКО при показе: в базе всё остаётся как было.
 *
 * Квадратные скобки внутри самого текста не трогаем — срезается лишь код в самом
 * начале строки и только если он похож на технический (латиница, точки, дефисы,
 * подчёркивания), чтобы человеческое «[важно] …» осталось на месте.
 */
const TECHNICAL_SOURCE_PREFIX = /^\[[a-z0-9][a-z0-9._-]*\]\s*/i;

export function humanNote(notes: string | null | undefined): string {
  if (!notes) return "";
  return notes.replace(TECHNICAL_SOURCE_PREFIX, "");
}

// Подписи исходов живут в общем пакете: их читают и форма, и хронология, и сервер
// (в тексте уведомлений), расходиться им нельзя.
export { INTERACTION_OUTCOME_LABELS } from "@royal-home/shared";

/**
 * Состояние подтверждения показа для плашки — одинаковое в календаре и в
 * хронологии карточки клиента, поэтому живёт здесь, а не в двух компонентах.
 *
 * Четвёртого состояния нет намеренно: пока клиенту не написали, показывать
 * нечего, а «не подтвердил» — это НЕ отказ, а всего лишь «ждём ответа». Отменять
 * показ по тишине нельзя: половина людей не отвечает и приходит.
 */
export function showingConfirmationBadge(interaction: {
  type: string;
  taskCancelledAt?: string | null;
  /** Обязателен: по паре «задачи нет + есть отказ» показ отличается от живого. */
  nextAction: string | null;
  confirmAskedAt?: string | null;
  confirmedAt?: string | null;
  declinedAt?: string | null;
}): { label: string; className: string } | null {
  if (interaction.type !== "SHOWING") return null;
  if (interaction.taskCancelledAt) return { label: "Отменено", className: "text-muted bg-gray-100" };
  // Отменённый показ — снятая задача вместе с отказом (см. apps/api/src/lib/tasks.ts,
  // COUNTED_SHOWING_WHERE). В хронологии он обязан отличаться от живого: иначе
  // отменённая встреча выглядит назначенной, и агент едет.
  if (interaction.declinedAt && !interaction.nextAction) return { label: "Отменён", className: "text-red bg-red-bg" };
  if (!interaction.confirmAskedAt) return null;
  if (interaction.declinedAt) return { label: "Не сможет прийти", className: "text-red bg-red-bg" };
  if (interaction.confirmedAt) return { label: "Подтвердил", className: "text-green bg-green-bg" };
  return { label: "Ждём подтверждения", className: "text-amber bg-amber-bg" };
}

/**
 * Плашка статуса в теме «Royal Home 2026»: модификатор прототипного `.chip`
 * (docs/pult/theme-2026/screens/_components.css). Второй словарь подписей не
 * заводим, подписи те же CLIENT_STATUS_LABELS, здесь только вид.
 *
 * Красный `chip crit` в прототипе закреплён за «надо сделать», а не за
 * состоянием клиента (договор §3), поэтому «Горячий» рисуется обычной плашкой с
 * золотой точкой, ровно как в screens/clients.html.
 */
export const CLIENT_STATUS_CHIP: Record<ClientStatus, string> = {
  NEW: "",
  CONTACTED: "",
  HOT: "",
  COLD: "mute",
  UNRESPONSIVE: "warn",
  LOST: "mute",
  DEAL_CLOSED: "ok",
  ARCHIVED: "mute",
};

/** Точка внутри плашки: ключ есть, значит точка рисуется; значение, её модификатор. */
export const CLIENT_STATUS_CHIP_DOT: Partial<Record<ClientStatus, string>> = {
  HOT: "gold",
  LOST: "",
  ARCHIVED: "",
};

/**
 * ОТОБРАЖАЕМОЕ ИМЯ КЛИЕНТА — ВТОРОЙ РУБЕЖ (17.09.2026, жалоба «Позвонить: @•••••»
 * на Главной агента, блок «Между встречами»).
 *
 * КОРЕНЬ ЧИНИТСЯ НА СЕРВЕРЕ (routes/clients/shared.ts::presentClient): у карточек,
 * заведённых до 17.08.2026 без имени, `fullName` иногда и есть сам ник соцсети
 * («@nozil760»), а маскировка номеров в имени (та же функция закрывает
 * «Входящий +992…») по пути стирает такой ник целиком в «@•••••» — «замаскировано»
 * технически верно, но агенту это уже ни о чём не говорит. Сервер теперь подставляет
 * каноническую подпись («Покупатель ПК-000058») вместо этого.
 *
 * ЭТОТ ХЕЛПЕР — НЕ ЗАМЕНА, А СЕТКА ПОД НИМ: используется там, где имя клиента
 * читается из общего кэша списка клиентов (useClients — Главная агента, оба
 * экрана) и не проходит через отдельный ответ карточки. Если сервер всё же
 * прислал голую маску (старый закэшированный ответ, будущая копия того же бага в
 * другом маршруте) — нейтральная подпись вместо мусора, а не молчаливый показ
 * «@•••••» человеку.
 */
export function clientDisplayName(fullName: string | null | undefined): string {
  const name = (fullName ?? "").trim();
  if (!name) return "Клиент";
  // Голая маска ника: «@•••••», «@••», даже «@» без единого читаемого символа.
  if (/^@[•\s]*$/u.test(name)) return "Клиент";
  return name;
}

/**
 * Показ ещё действует: не проведён и не отменён. Отмена показа снимает задачу
 * (nextAction = null) и ставит declinedAt, а ДАТУ оставляет (apps/api/src/lib/
 * showingBooking.ts, applyCancellation), так что по одной дате его не отличить
 * от живого (LOCAL-ONLY-WEB02). Тот же признак отмены, что в showingConfirmationBadge.
 */
export function isLiveShowing(i: {
  type: string;
  taskCancelledAt?: string | null;
  nextAction: string | null;
  declinedAt?: string | null;
  completedAt?: string | null;
}): boolean {
  if (i.type !== "SHOWING" || i.completedAt || i.taskCancelledAt) return false;
  return !(i.declinedAt && !i.nextAction);
}

/** Будущие действующие показы клиента: объект → время. Для кнопки «Назначить показ» в подборе. */
export function bookedShowingsByProperty(
  interactions: ReadonlyArray<{
    type: string;
    taskCancelledAt?: string | null;
    propertyId?: string | null;
    nextAction: string | null;
    nextActionDate: string | null;
    declinedAt?: string | null;
    completedAt?: string | null;
  }>,
  now: number = Date.now()
): Map<string, string> {
  const booked = new Map<string, string>();
  for (const i of interactions) {
    if (!isLiveShowing(i) || !i.propertyId || !i.nextActionDate) continue;
    if (new Date(i.nextActionDate).getTime() <= now) continue;
    booked.set(i.propertyId, i.nextActionDate);
  }
  return booked;
}
