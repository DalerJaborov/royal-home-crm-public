import { formatClientCode, formatClientName, formatPropertyCode, normalizeInstagramUrl, parseShortCode } from "@royal-home/shared";
import type { AssistantCard, AssistantClientCard, AssistantPropertyCard } from "@royal-home/shared";
import { prisma } from "../db.js";
import { clientNamePhoneSafe, clientPhoneFor } from "../lib/clientPhone.js";
import type { AssistantActor } from "./assistant.js";
import { formatPrice } from "./seoGenerator.js";

/**
 * БЫСТРЫЙ ПУТЬ ПОМОЩНИКА БЕЗ МОДЕЛИ (полоса А, docs/design/internal-assistant-
 * architecture-2026-10-31.md, п. 1.4 и задача 1.5).
 *
 * Фраза, которая целиком состоит из номера карточки («ОБ-000088», «объект 88»,
 * «ПК-42»), телефона или ссылки на пост Instagram, не требует понимания языка:
 * ответ — одна выборка из базы. Ждать на неё три похода в Gemini незачем, да и
 * квоту на это тратить нечего. Любая фраза, которую не удалось разобрать
 * ОДНОЗНАЧНО, возвращает null — и дальше работает обычный путь через модель.
 *
 * ПРАВА — ТЕ ЖЕ, ЧТО У ИНСТРУМЕНТОВ ПОМОЩНИКА (assistant.ts, runTool), без новых
 * правил:
 *   · клиент: удалённый (Корзина) не отдаётся; агент без `clients.viewAll` видит
 *     только своих и только принятых заявок (`ownScope`, `clientUnavailable`);
 *   · телефон — по общему правилу CRM (`clientPhoneFor`, право clients.viewPhone,
 *     непринятая заявка номера не раскрывает), номер внутри имени маскируется;
 *   · поиск клиента ПО ТЕЛЕФОНУ — только тому, кому номер виден: иначе право
 *     обходится перебором («найди клиента с номером …57» = ответ да/нет на догадку);
 *   · объекты, как в search_properties, видны всем ролям; Корзина — нет.
 * Нет доступа или ничего не найдено — null (пусть отвечает обычный путь: он сам
 * честно скажет «не нашёл», не раскрывая, существует ли закрытая карточка).
 *
 * РЕГУЛЯРКИ БЕЗ `\b` И `\w`: в JS они молчат на кириллице (см. CLAUDE.md,
 * «Ловушки»), поэтому границы слов — пробелы и начало/конец строки.
 */

export interface AssistantFastPathResult {
  cards: AssistantCard[];
  /** Короткий текстовый ответ — попадает в историю диалога как реплика помощника. */
  reply: string;
  /** Имя «инструмента» для журнала обращений (AiAssistantAuditLog): быстрый путь читает те же данные, что и модель. */
  tool: string;
  /** Что открыли — id карточки, не телефон и не текст вопроса (журнал хранит факт обращения). */
  argsSummary: string;
}

/** Слова-«глаголы» перед номером: «покажи ОБ-88», «найди клиента ПК-5». */
const LEADING_FILLER = /^(?:(?:покажи|показать|найди|найти|открой|открыть|дай|дайте|что\s+за|кто\s+такой|кто\s+это|инфо(?:рмация)?\s+по|карточка|карточку|show|open|find)\s+)+/i;

const PROPERTY_WORDS = "(?:объект|обьект|ob)";
const PROPERTY_PREFIX = "(?:об|ob)";
const CLIENT_WORDS = "(?:клиент|покупатель|продавец)";
const CLIENT_PREFIX = "(?:пк|пр|по|кл|pk|pr|po|kl)";
const SEP = "[\\s.\\-–—]*";
const NUMBER = "[№#]?\\s*(\\d{1,9})";

const PROPERTY_CODE_RE = new RegExp(`^(?:${PROPERTY_WORDS}\\s*${SEP}|${PROPERTY_PREFIX}${SEP})${NUMBER}$`, "i");
const CLIENT_CODE_RE = new RegExp(`^(?:${CLIENT_WORDS}\\s*${SEP}|${CLIENT_PREFIX}${SEP})${NUMBER}$`, "i");

/** Телефон целиком: цифры, плюс, пробелы, скобки, дефисы; допускается слово «телефон/номер» впереди. */
const PHONE_ONLY_RE = /^(?:(?:телефон|тел|номер|phone)[\s.:]*)?(\+?[\d\s()\-]{7,22})$/i;
const INSTAGRAM_POST_RE = /instagram\.com\/(?:reel|reels|p|tv)\/([A-Za-z0-9_-]+)/i;
/** Сколько лишних символов вокруг ссылки допустимо: «вот ссылка …» — ещё не вопрос, требующий модели. */
const INSTAGRAM_EXTRA_TEXT_LIMIT = 40;
const MAX_CARDS = 5;

function clean(text: string): string {
  return text
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[?!.…]+$/u, "")
    .replace(LEADING_FILLER, "")
    .trim();
}

/** «+992 90 123-45-67», «0901234567», «901234567» → «+992901234567»; иначе null. */
export function toCrmPhone(raw: string): string | null {
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 12 && digits.startsWith("992")) return `+${digits}`;
  if (digits.length === 10 && digits.startsWith("0")) return `+992${digits.slice(1)}`;
  if (digits.length === 9) return `+992${digits}`;
  return null;
}

type Intent =
  | { kind: "property-code"; shortId: number }
  | { kind: "client-code"; shortId: number }
  | { kind: "instagram"; code: string }
  | { kind: "phone"; phone: string };

/** Разбор фразы в намерение. Экспортирован ради unit-тестов без базы. */
export function parseFastPathIntent(text: string): Intent | null {
  const raw = text.trim();
  if (!raw || raw.length > 300) return null;

  const instagram = INSTAGRAM_POST_RE.exec(raw);
  if (instagram) {
    const canonical = normalizeInstagramUrl(raw);
    if (!canonical) return null;
    const urlLength = /\S*instagram\.com\/\S*/i.exec(raw)?.[0].length ?? 0;
    if (raw.length - urlLength > INSTAGRAM_EXTRA_TEXT_LIMIT) return null;
    return { kind: "instagram", code: instagram[1] };
  }

  const phrase = clean(raw);
  const property = PROPERTY_CODE_RE.exec(phrase);
  if (property) {
    const shortId = parseShortCode(property[1]);
    return shortId === null ? null : { kind: "property-code", shortId };
  }
  const client = CLIENT_CODE_RE.exec(phrase);
  if (client) {
    const shortId = parseShortCode(client[1]);
    return shortId === null ? null : { kind: "client-code", shortId };
  }
  const phone = PHONE_ONLY_RE.exec(phrase);
  if (phone) {
    const normalized = toCrmPhone(phone[1]);
    return normalized ? { kind: "phone", phone: normalized } : null;
  }
  return null;
}

const propertyInclude = {
  district: { select: { name: true } },
  assignedAgent: { select: { fullName: true } },
} as const;

function propertyCard(p: {
  id: string;
  shortId: number;
  title: string;
  price: unknown;
  currency: string;
  status: string;
  rooms: number | null;
  areaSqm: unknown;
  district: { name: string } | null;
  assignedAgent: { fullName: string } | null;
}): AssistantPropertyCard {
  return {
    kind: "property",
    id: p.id,
    code: formatPropertyCode(p.shortId),
    title: p.title,
    price: Number(p.price),
    currency: p.currency === "USD" ? "USD" : "TJS",
    status: p.status,
    district: p.district?.name ?? null,
    rooms: p.rooms,
    areaSqm: Number(p.areaSqm),
    agent: p.assignedAgent?.fullName ?? null,
    href: `/properties/${p.id}`,
  };
}

function clientCard(
  c: {
    id: string;
    shortId: number;
    kind: "BUYER" | "SELLER" | "OTHER";
    fullName: string;
    dualIntent: boolean;
    phone: string;
    status: string;
    acceptedAt: Date | null;
    lastContactAt: Date | null;
    assignedAgent: { fullName: string } | null;
  },
  actor: AssistantActor
): AssistantClientCard {
  return {
    kind: "client",
    id: c.id,
    code: formatClientCode(c.shortId, c.kind),
    name: clientNamePhoneSafe(formatClientName(c), actor.canViewPhone),
    // Тот же запрет, что в search_clients: непринятая заявка номера не раскрывает даже тому, у кого есть право.
    phone: clientPhoneFor(c.phone, actor.canViewPhone && c.acceptedAt !== null),
    status: c.status,
    agent: c.assignedAgent?.fullName ?? null,
    lastContactAt: c.lastContactAt ? c.lastContactAt.toISOString() : null,
    href: `/clients/${c.id}`,
  };
}

/** Условие видимости клиента — зеркало ownScope/clientUnavailable из runTool (assistant.ts). */
function visibleClientWhere(actor: AssistantActor) {
  const ownScope = actor.canViewAllClients ? undefined : actor.id;
  return {
    deletedAt: null,
    // Агент не видит ЧУЖИХ и ещё НЕ ПРИНЯТЫХ заявок (REST отдаёт ему 404 / скрывает до принятия).
    ...(ownScope ? { assignedAgentId: ownScope, acceptedAt: { not: null } } : {}),
  };
}

const clientInclude = { assignedAgent: { select: { fullName: true } } } as const;

async function findByIntent(intent: Intent, actor: AssistantActor): Promise<AssistantCard[]> {
  switch (intent.kind) {
    case "property-code": {
      const p = await prisma.property.findFirst({
        where: { shortId: intent.shortId, deletedAt: null },
        include: propertyInclude,
      });
      return p ? [propertyCard(p)] : [];
    }
    case "instagram": {
      const rows = await prisma.property.findMany({
        where: { deletedAt: null, instagramUrl: { contains: `/${intent.code}` } },
        include: propertyInclude,
        orderBy: { createdAt: "desc" },
        take: MAX_CARDS * 4,
      });
      // `contains` ловит и более длинные коды с тем же началом (/ABC и /ABCD) — оставляем точное совпадение.
      const exact = rows.filter((row) => INSTAGRAM_POST_RE.exec(row.instagramUrl ?? "")?.[1] === intent.code);
      return exact.slice(0, MAX_CARDS).map(propertyCard);
    }
    case "client-code": {
      const c = await prisma.client.findFirst({
        where: { shortId: intent.shortId, ...visibleClientWhere(actor) },
        include: clientInclude,
      });
      return c ? [clientCard(c, actor)] : [];
    }
    case "phone": {
      // Поиск по номеру — только тому, кому номер виден (см. шапку файла).
      if (!actor.canViewPhone) return [];
      const c = await prisma.client.findFirst({
        where: { phone: intent.phone, ...visibleClientWhere(actor) },
        include: clientInclude,
      });
      return c ? [clientCard(c, actor)] : [];
    }
  }
}

function replyFor(cards: AssistantCard[]): string {
  return cards
    .map((card) => {
      if (card.kind === "property") {
        return `Нашёл объект [${card.code} · ${card.title}](${card.href}): ${formatPrice(card.price, card.currency)}.`;
      }
      return `Нашёл клиента [${card.name}](${card.href}) (${card.code}).`;
    })
    .join("\n");
}

/**
 * Пробует ответить без модели. null — «это не моё»: фраза не разобрана
 * однозначно, ничего не найдено или у вызвавшего нет доступа; тогда работает
 * обычный путь через Gemini. Бросает только ошибки базы — вызывающий обязан
 * поймать и тоже уйти на обычный путь.
 */
export async function tryAssistantFastPath(text: string, actor: AssistantActor): Promise<AssistantFastPathResult | null> {
  const intent = parseFastPathIntent(text);
  if (!intent) return null;
  const cards = await findByIntent(intent, actor);
  if (cards.length === 0) return null;
  const first = cards[0];
  return {
    cards,
    reply: replyFor(cards),
    tool: `fast_path.${intent.kind}`,
    argsSummary: JSON.stringify(first.kind === "client" ? { clientId: first.id } : { propertyId: first.id }),
  };
}
