import { z } from "zod";
import { safeFetch } from "../lib/safeFetch.js";

const SITE_ORIGIN = "https://royalhome.tj";
const CATALOG_TIMEOUT_MS = 2_500;
const CATALOG_MAX_BYTES = 512 * 1024;
const RESULT_LIMIT = 3;
const SHELL_STAGE = "Коробка, черновые не сделаны";
const UNFINISHED = new Set(["Без отделки", "Без ремонта"]);
const siteId = z.number().int().positive().max(2_147_483_647);
const publicCard = z.object({
  id: siteId,
  crmShortId: siteId.nullable(),
  published: z.literal(true),
  sold: z.literal(false),
  // Require the same anonymous projection as the existing single-listing reader.
  externalId: z.null(), mapAddress: z.null(), lat: z.null(), lng: z.null(),
  category: z.enum(["APARTMENT", "HOUSE", "COMMERCIAL", "LAND"]),
  location: z.string().trim().min(1).max(100).regex(/^[\p{L}\p{M}\p{N} .,()/‐-]+$/u),
  price: z.number().int().positive().safe(),
  rooms: z.number().int().nonnegative(),
  area: z.number().finite().nonnegative(),
  stage: z.string().nullable(),
  repair: z.string().nullable(),
}).transform(({ id, crmShortId, category, location, price, rooms, area, stage, repair }) => ({
  id, crmShortId, category, location, price, rooms, area, stage, repair,
}));
const catalogue = z.object({ result: z.object({ data: z.object({ json: z.array(z.unknown()).max(1000) }) }) });

export type AssistantPublicSiteListing = z.output<typeof publicCard>;

/** Read the live anonymous site catalogue. No actor, user text, headers or links may alter the request. */
export async function readAssistantPublicSiteCatalog(signal?: AbortSignal, read = safeFetch): Promise<readonly AssistantPublicSiteListing[] | null> {
  const timeout = AbortSignal.timeout(CATALOG_TIMEOUT_MS);
  const deadline = signal ? AbortSignal.any([signal, timeout]) : timeout;
  if (deadline.aborted) return null;
  const url = new URL("/api/trpc/listing.list", SITE_ORIGIN);
  url.searchParams.set("input", JSON.stringify({ json: { sold: false } }));
  const pending = (async () => {
    try {
      const response = await read(url.href, { credentials: "omit", maxRedirects: 0, maxBytes: CATALOG_MAX_BYTES,
        timeoutMs: CATALOG_TIMEOUT_MS, signal: deadline, headers: { Accept: "application/json" } });
      if (deadline.aborted || !response || response.status !== 200 || response.url !== url.href || response.truncated ||
          response.body.byteLength > CATALOG_MAX_BYTES || !/^application\/json(?:\s*;|$)/i.test(response.contentType)) return null;
      const parsed = catalogue.safeParse(JSON.parse(response.body.toString("utf8")));
      if (!parsed.success) return null;
      const entries = parsed.data.result.data.json;
      const rows = entries.flatMap((entry) => {
        const card = publicCard.safeParse(entry);
        return card.success ? [card.data] : [];
      });
      return entries.length && !rows.length ? null : rows;
    } catch (error) {
      if (!deadline.aborted) console.warn("[assistant] public site catalogue unavailable", error instanceof Error ? error.name : "Error");
      return null;
    }
  })();
  // DNS resolution inside safeFetch may outlast the socket timeout.
  let abandon!: () => void;
  const cancelled = new Promise<null>((resolve) => {
    abandon = () => resolve(null);
    deadline.addEventListener("abort", abandon, { once: true });
    if (deadline.aborted) abandon();
  });
  try {
    return await Promise.race([pending, cancelled]);
  } finally {
    deadline.removeEventListener("abort", abandon);
  }
}

export type PublicShellRequest = { type: "APARTMENT" | "HOUSE" | null };
type Language = "ru" | "tg";

const WORD = "(?<!\\p{L})";
const END = "(?!\\p{L})";
const propertyWord = (pattern: string) => new RegExp(WORD + "(?:" + pattern + ")" + END, "iu");
const APARTMENT = propertyWord("квартир(?:аи|[аыуе])|манзил(?:и|ҳо)?|хона(?:и)? истиқоматӣ");
const HOUSE = propertyWord("дом(?:а|у|ов|ик)?|ҳавл[иӣ](?:ҳо|и)?|хавл[ий]|коттедж");
const HOUSING = propertyWord("хона(?:и|ҳо)?|жиль[ёея]");
const SHELL = propertyWord("[кқ][оа]робк(?:аи|[аиуые])|қутти[иӣ]");
const NO_FINISH = propertyWord("без (?:ремонта|отделки)|бе ?таъмир|бе ?ремонт|бетаъмир");
const OTHER_CONDITION = propertyWord(
  "продаю|продаём|мефурӯшам|фурӯхтан|сдаю|сдать|аренда|иҷора|котлован|таҳкурсӣ|с ремонтом|бо таъмир|" +
  "не (?:ищу|надо|нуж[нe]а|хочу)|намехоҳам|бюджет|арзон|нарх|район|ноҳия|назди|сино|ш[ооҳ]ҳ?мансур|фирдавс[иӣ]|сомон[иӣ]",
);

/** Handles the specific shell/no-finish request, not a generic or negated property discussion. */
export function matchPublicShellRequest(text: string): PublicShellRequest | null {
  const value = text.normalize("NFKC").trim().toLowerCase().replace(/\s+/gu, " ");
  if (!value || value.length > 180 || /[\p{N}@#]/u.test(value) || /https?:\/\//u.test(value) ||
      OTHER_CONDITION.test(value) || !SHELL.test(value) || !NO_FINISH.test(value)) return null;
  const apartment = APARTMENT.test(value), house = HOUSE.test(value);
  if (!apartment && !house && !HOUSING.test(value)) return null;
  return { type: apartment === house ? null : apartment ? "APARTMENT" : "HOUSE" };
}

const copy = {
  ru: {
    clarify: "Вы ищете квартиру или отдельный дом?",
    unavailable: "Сайт сейчас не отвечает. Попробуйте спросить чуть позже.",
    empty: { APARTMENT: "На сайте сейчас нет квартир в коробке без отделки.", HOUSE: "На сайте сейчас нет отдельных домов в коробке без отделки. Квартира подойдёт?" },
    intro: { APARTMENT: "Вот квартиры в коробке без отделки с нашего сайта.", HOUSE: "Вот отдельные дома в коробке без отделки с нашего сайта." },
    rooms: "комн.", currency: "сомони",
  },
  tg: {
    clarify: "Квартира меҷӯед ё ҳавлӣ?",
    unavailable: "Ҳозир сайт ҷавоб намедиҳад. Каме баъд боз пурсед.",
    empty: { APARTMENT: "Ҳозир дар сайт квартираи коробка, бе таъмир нест.", HOUSE: "Ҳозир дар сайт ҳавлии коробка, бе таъмир нест. Квартира ҳам мешавад?" },
    intro: { APARTMENT: "Ин квартираҳо дар сайти мо ҳастанд. Коробка, бе таъмир.", HOUSE: "Ин ҳавлиҳо дар сайти мо ҳастанд. Коробка, бе таъмир." },
    rooms: "ҳуҷра", currency: "сомонӣ",
  },
} as const;

const amount = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 2 });

export async function replyPublicShellRequest(request: PublicShellRequest, language: Language, signal?: AbortSignal,
  read = readAssistantPublicSiteCatalog): Promise<string> {
  const t = copy[language];
  if (!request.type) return t.clarify;
  const rows = await read(signal);
  if (!rows || signal?.aborted) return t.unavailable;
  const exact = rows.filter(row => row.category === request.type && row.stage === SHELL_STAGE && row.repair && UNFINISHED.has(row.repair));
  const distinct = [...new Map(exact.map(row => [row.id, row])).values()];
  const results = distinct.sort((a, b) => a.price - b.price || a.id - b.id).slice(0, RESULT_LIMIT);
  if (!results.length) return t.empty[request.type];
  return [t.intro[request.type], ...results.map(row => [
    row.location, row.rooms ? `${row.rooms} ${t.rooms}` : null, row.area ? `${amount.format(row.area)} м²` : null,
    `${amount.format(row.price)} ${t.currency}`,
  ].filter(Boolean).join(" · ") + `\n${SITE_ORIGIN}${language === "tg" ? "/tg/khona" : "/listing"}/${row.id}`)].join("\n\n");
}
