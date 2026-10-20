import type { PropertyType } from "./enums.js";
import { PROPERTY_TYPE_LABELS } from "./labels.js";

/**
 * Заполнение карточки клиента со слов самого клиента (пакет владельца 31.07, п. 5):
 * «ИИ заполняет карточку сам, агент подтверждает шагами».
 *
 * Здесь — общий словарь мастера: готовые варианты ответов и формат, в котором
 * тип объекта, срочность и пожелания хранятся ВНУТРИ requirementsNotes.
 *
 * Почему в заметках, а не отдельными колонками: в модели Client колонок под тип
 * недвижимости и срочность нет, а миграция ради двух полей тянет за собой подбор,
 * фильтры и импорт. Формат строки стабилен и разбирается обратно
 * (parseRequirementsNotes), поэтому мастер, открытый второй раз, показывает ровно
 * то, что агент подтвердил в первый, — и превратить это в настоящие колонки позже
 * можно без потери данных.
 */

/** Срочность запроса: насколько быстро клиенту нужен результат. */
export const CLIENT_URGENCIES = ["ASAP", "MONTH", "QUARTER", "LOOKING"] as const;
export type ClientUrgency = (typeof CLIENT_URGENCIES)[number];

export const CLIENT_URGENCY_LABELS: Record<ClientUrgency, string> = {
  ASAP: "Срочно, на этой неделе",
  MONTH: "В течение месяца",
  QUARTER: "1-3 месяца",
  LOOKING: "Присматривается, без срока",
};

/** Готовые пожелания одним нажатием — вместо того, чтобы агент печатал их руками.
 *  Формулировки взяты из живой лексики душанбинских сделок (см. промт бота). */
export const CARD_NOTE_TAGS = [
  "Только с ремонтом",
  "Без ремонта (каробка) подойдёт",
  "Только новостройка",
  "Советский дом подойдёт",
  "Первый этаж не предлагать",
  "Последний этаж не предлагать",
  "Оплата наличными",
  "Нужна рассрочка",
  "Есть обмен (алиш)",
  "Торг обязателен",
] as const;
export type CardNoteTag = (typeof CARD_NOTE_TAGS)[number];

export interface BudgetPreset {
  label: string;
  min?: number;
  max?: number;
}

/** Ступени бюджета в сомони — под реальный рынок Душанбе. Агент выбирает вилку
 *  нажатием; точные цифры нужны редко и правятся вручную в форме «Изменить». */
export const BUDGET_PRESETS_TJS: BudgetPreset[] = [
  { label: "до 300 тыс.", max: 300_000 },
  { label: "300-500 тыс.", min: 300_000, max: 500_000 },
  { label: "500-800 тыс.", min: 500_000, max: 800_000 },
  { label: "800 тыс. - 1,2 млн", min: 800_000, max: 1_200_000 },
  { label: "1,2-2 млн", min: 1_200_000, max: 2_000_000 },
  { label: "больше 2 млн", min: 2_000_000 },
];

/** Те же ступени для клиентов, чей бюджет ведётся в долларах (Client.currency=USD). */
export const BUDGET_PRESETS_USD: BudgetPreset[] = [
  { label: "до $25 тыс.", max: 25_000 },
  { label: "$25-45 тыс.", min: 25_000, max: 45_000 },
  { label: "$45-70 тыс.", min: 45_000, max: 70_000 },
  { label: "$70-110 тыс.", min: 70_000, max: 110_000 },
  { label: "$110-180 тыс.", min: 110_000, max: 180_000 },
  { label: "больше $180 тыс.", min: 180_000 },
];

export const ROOMS_PRESETS = [1, 2, 3, 4, 5] as const;

/** Метки строк внутри requirementsNotes. Менять их нельзя, не написав миграцию
 *  текста: по ним мастер разбирает уже сохранённые карточки обратно в поля. */
const TYPE_PREFIX = "Тип: ";
const URGENCY_PREFIX = "Срочность: ";
const TAGS_PREFIX = "Пожелания: ";

export interface RequirementsParts {
  type?: PropertyType | null;
  urgency?: ClientUrgency | null;
  tags?: readonly string[];
  /** Свободный текст агента — всё, что не разложилось по вариантам. */
  text?: string | null;
}

/** Собирает поля мастера в одну строку requirementsNotes. Пусто на входе — null на
 *  выходе: пустая строка в базе означала бы «заметки есть», и карточка считалась бы
 *  заполненной (см. isClientCardFilled). */
export function composeRequirementsNotes(parts: RequirementsParts): string | null {
  const tags = (parts.tags ?? []).map((t) => t.trim()).filter(Boolean);
  const text = (parts.text ?? "").trim();
  // Срочность БОЛЬШЕ НЕ ПИШЕТСЯ (решение владельца 01.08.2026: «срочность не нужна»).
  // Разбор её по-прежнему понимает — в уже заведённых карточках строка «Срочность: …»
  // есть, и если перестать её узнавать, она превратится в кусок свободного текста и
  // полезет агенту в глаза при каждой правке.
  const lines = [
    parts.type ? `${TYPE_PREFIX}${PROPERTY_TYPE_LABELS[parts.type]}` : null,
    tags.length > 0 ? `${TAGS_PREFIX}${tags.join(", ")}` : null,
    text || null,
  ].filter(Boolean) as string[];
  return lines.length > 0 ? lines.join("\n") : null;
}

const TYPE_BY_LABEL = new Map<string, PropertyType>(
  (Object.keys(PROPERTY_TYPE_LABELS) as PropertyType[]).map((t) => [PROPERTY_TYPE_LABELS[t].toLowerCase(), t])
);
const URGENCY_BY_LABEL = new Map<string, ClientUrgency>(
  CLIENT_URGENCIES.map((u) => [CLIENT_URGENCY_LABELS[u].toLowerCase(), u])
);

/**
 * Разбирает requirementsNotes обратно в поля мастера. Всё, что не опознано, остаётся
 * свободным текстом — заметки, написанные руками до появления мастера (и просто
 * произвольные), не должны потеряться при повторном сохранении.
 */
export function parseRequirementsNotes(notes: string | null | undefined): Required<RequirementsParts> {
  const result = { type: null as PropertyType | null, urgency: null as ClientUrgency | null, tags: [] as string[], text: "" };
  if (!notes) return { ...result, text: null };

  const rest: string[] = [];
  for (const line of notes.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith(TYPE_PREFIX)) {
      const found = TYPE_BY_LABEL.get(trimmed.slice(TYPE_PREFIX.length).trim().toLowerCase());
      if (found) {
        result.type = found;
        continue;
      }
    }
    if (trimmed.startsWith(URGENCY_PREFIX)) {
      const found = URGENCY_BY_LABEL.get(trimmed.slice(URGENCY_PREFIX.length).trim().toLowerCase());
      if (found) {
        result.urgency = found;
        continue;
      }
    }
    if (trimmed.startsWith(TAGS_PREFIX)) {
      const parsed = trimmed
        .slice(TAGS_PREFIX.length)
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
      // Строка «Пожелания:» без единого варианта — не метка, а обычный текст.
      if (parsed.length > 0) {
        result.tags = parsed;
        continue;
      }
    }
    rest.push(line);
  }

  const text = rest.join("\n").trim();
  return { ...result, text: text || null };
}

/**
 * Предложение по заполнению карточки, которое сервер отдаёт мастеру.
 * Значения — то, что клиент сказал САМ (черновик бота + разбор переписки ИИ);
 * ничего не сохраняется, пока агент не подтвердит шаги.
 */
export interface CardFillSuggestion {
  /** draft — хватило черновика бота; chat — часть полей достал ИИ из переписки;
   *  call — в разборе участвовали расшифровки телефонных разговоров (07.08.2026);
   *  none — говорить не о чем, мастер работает как обычный опросник.
   *
   *  Источник показывается агенту: «услышано в разговоре» и «прочитано в переписке» —
   *  разной надёжности сведения, и проверять их человек будет по-разному. */
  source: "draft" | "chat" | "call" | "none";
  budgetMin: number | null;
  budgetMax: number | null;
  districtId: string | null;
  districtName: string | null;
  rooms: number | null;
  type: PropertyType | null;
  urgency: ClientUrgency | null;
  notes: string | null;
  tags: string[];
  /** Короткие цитаты клиента, на которых держится предложение — агент проверяет глазами. */
  evidence: string[];
  /** ИИ не ответил (нет ключа, таймаут): предложение построено только по черновику бота. */
  aiUnavailable: boolean;
}
