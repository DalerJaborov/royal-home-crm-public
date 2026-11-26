import type { ContactFacts } from "@royal-home/shared";

/**
 * ИМЯ БЕЗЫМЯННОГО ЧАТА ПО ИНТЕРЕСУ (владелец 26.11.2026): у многих переписок нет имени («Без имени»), но бот уже
 * знает, что человеку нужно. Список называет такой чат по этому: «Ищет 2к · Шохмансур», «Продаёт 3к · Сино»,
 * а бюджет («до 650 тыс.») идёт отдельной подписью и кружком «2к» вместо буквы.
 *
 * Берётся только то, что уже собрано: `leadDraft` диалога, а если там пусто — факты досье собеседника
 * (ContactProfile.facts). Второго механизма имён нет: настоящее имя (карточка клиента, имя из профиля канала)
 * всегда главнее, а это запасное название показывается, только когда имени нет вовсе.
 */
export interface ChatInterest {
  /** «Ищет 2к · Шохмансур» — подставляется вместо «Без имени». */
  title: string;
  /** «до 650 тыс.» — отдельной подписью; null, если бюджета нет. */
  budget: string | null;
  /** «2к» или «Уч.» — для кружка вместо буквы; null, если нечего сказать коротко. */
  badge: string | null;
  /** Кто пишет: покупает, продаёт и т. д. — для значка в кружке. */
  kind: "buy" | "rent" | "sell" | "job" | null;
}

interface DraftLike {
  intent?: unknown;
  budgetMin?: unknown;
  budgetMax?: unknown;
  districtName?: unknown;
  type?: unknown;
  rooms?: unknown;
}

const ROLE: Record<NonNullable<ChatInterest["kind"]>, string> = {
  buy: "Ищет",
  rent: "Ищет аренду",
  sell: "Продаёт",
  job: "Ищет работу",
};
const CATEGORY_KIND: Record<string, ChatInterest["kind"]> = { BUYER: "buy", SELLER: "sell", JOB: "job" };

function num(value: unknown): number | null {
  const n = typeof value === "string" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 40) : null;
}

/** Факт досье по ключу: `facts.buyer.rooms.v`. Продавец хранит район и комнаты в своём разделе. */
function fact(facts: ContactFacts | null | undefined, key: string): unknown {
  return facts?.buyer?.[key]?.v ?? facts?.seller?.[key]?.v;
}

function money(max: number | null, min: number | null): string | null {
  const fmt = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)} тыс.` : String(Math.round(n)));
  if (max) return `до ${fmt(max)}`;
  if (min) return `от ${fmt(min)}`;
  return null;
}

export function buildChatInterest(input: {
  draft?: DraftLike | null;
  category?: string | null;
  facts?: ContactFacts | null;
}): ChatInterest | null {
  const draft = input.draft && typeof input.draft === "object" ? input.draft : null;
  const rooms = num(draft?.rooms) ?? num(fact(input.facts, "rooms"));
  const district = text(draft?.districtName) ?? text(fact(input.facts, "districtName") ?? fact(input.facts, "district"));
  const type = (text(draft?.type) ?? text(fact(input.facts, "type")) ?? "").toLowerCase();
  const max = num(draft?.budgetMax) ?? num(fact(input.facts, "budgetMax"));
  const min = num(draft?.budgetMin) ?? num(fact(input.facts, "budgetMin"));

  const intent = typeof draft?.intent === "string" ? draft.intent : null;
  const kind: ChatInterest["kind"] =
    intent === "buy" || intent === "rent" || intent === "sell" || intent === "job"
      ? intent
      : CATEGORY_KIND[input.category ?? ""] ?? null;

  const land = /участ|земл|замин/.test(type);
  const house = !land && /(^|\s)дом|ҳавлӣ|хавли|house/.test(type);
  const object = land ? "участок" : house ? "дом" : rooms ? `${Math.round(rooms)}к` : null;
  const parts = [object, district].filter((p): p is string => !!p);
  const badge = land ? "Уч." : rooms ? `${Math.round(rooms)}к` : null;

  if (parts.length === 0) {
    // Про сам объект ничего нет — называем по роли, если она ясна. Иначе имени по интересу нет вовсе.
    if (kind === "buy") return { title: "Покупатель", budget: money(max, min), badge, kind };
    if (kind === "sell") return { title: "Продавец", budget: money(max, min), badge, kind };
    if (kind === "job") return { title: "Ищет работу", budget: null, badge: null, kind };
    return null;
  }
  const raw = `${kind ? `${ROLE[kind]} ` : ""}${parts.join(" · ")}`;
  const title = raw.charAt(0).toUpperCase() + raw.slice(1);
  return { title, budget: kind === "job" ? null : money(max, min), badge, kind };
}
