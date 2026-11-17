import { z } from "zod";
import { parseShortCode } from "@royal-home/shared";
import { loadAgentAccess } from "../auth/middleware.js";
import { actorFromAccess } from "../ai/assistant/actor.js";
import { runTool } from "../ai/assistant.js";
import { prisma } from "../db.js";
import { findAgentByTelegramChatId, findAgentByTelegramUserId } from "../lib/telegramAgentLink.js";
import { propertyPublicationQuestion } from "./assistantGroupParticipation.js";
import { sendStaffPropertyCard } from "./assistantStaffPropertyCard.js";

type Language = "ru" | "tg";
type Scope = { chatId: string; agentId: string; telegramUserId?: string; threadId?: number; replyTo?: number; group?: { registeredAt: Date; contextEnabledAt: Date; addressed: boolean } };
type Candidate = { id: string; status: string };
type Selection = { candidates: Candidate[]; filters?: Record<string, unknown> };
type Page = { filters: Record<string, unknown>; shown: Set<string>; messageId?: number; expiresAt: number };
const ttl = 15 * 60_000;
const pages = new Map<string, Page>();
const inFlight = new Set<string>();
const keyOf = ({ chatId, agentId, threadId, group }: Scope) =>
  JSON.stringify([chatId, agentId, threadId ?? null, group?.registeredAt.getTime() ?? null, group?.contextEnabledAt.getTime() ?? null]);

const candidate = z.object({ id: z.string().uuid(), status: z.string().min(1).max(32) });
const filters = z.object({
  query: z.string().max(300).optional(),
  districtName: z.string().max(160).optional(),
  type: z.enum(["APARTMENT", "HOUSE", "COMMERCIAL", "LAND"]).optional(),
  maxPrice: z.number().positive().optional(),
  currency: z.enum(["TJS", "USD"]).optional(),
  minRooms: z.number().positive().optional(),
  minAreaSqm: z.number().positive().optional(),
  maxAreaSqm: z.number().positive().optional(),
  stage: z.string().max(32).optional(),
  status: z.enum(["PENDING_REVIEW", "AWAITING_PHOTOS", "AWAITING_VIDEO", "EDITING", "AVAILABLE", "RESERVED", "SOLD", "WITHDRAWN"]).optional(),
  publishedOnSite: z.boolean().optional(),
  locationNames: z.array(z.string().max(120)).max(6).optional(),
  preferManyWindows: z.boolean().optional(),
  withVideo: z.boolean().optional(),
  semanticQuery: z.string().max(400).optional(),
});

function parseCandidates(rows: unknown): Candidate[] {
  if (!Array.isArray(rows)) return [];
  const found = new Map<string, Candidate>();
  for (const row of rows.slice(0, 8)) {
    const parsed = candidate.safeParse(row);
    if (parsed.success) found.set(parsed.data.id, parsed.data);
  }
  return [...found.values()];
}

/** No output ID or URL can come from the model's narrative. */
export function propertySelection(name: string, result: unknown, args?: Record<string, unknown>): Selection | null {
  const rows = name === "search_properties" ? result
    : name === "find_property" && result && typeof result === "object" && "items" in result ? result.items
      : null;
  const candidates = parseCandidates(rows);
  if (!candidates.length) return null;
  const exactQuery = typeof args?.query === "string" && parseShortCode(args.query) !== null;
  const parsed = name === "search_properties" && args && args.shortId === undefined && !exactQuery ? filters.safeParse(args) : null;
  return { candidates, ...(parsed?.success ? { filters: parsed.data } : {}) };
}

const PAGE_COUNTS: Record<string, number> = { "2": 2, два: 2, две: 2, ду: 2, "3": 3, три: 3, се: 3, "4": 4, четыре: 4, чор: 4 };
const countWords = Object.keys(PAGE_COUNTS).join("|");
const propertyWords = "вариант(?:а|ов)?|объект(?:а|ов)?|квартир(?:ы)?|дом(?:а|ов)?|хона(?:и дигар)?";
const moreRequest = new RegExp(
  `^(?:(?:а|покажи|пришли|дай)\\s+)?(?:ещ[её](?:\\s+(?:покажи|пришли))?|боз(?:\\s+нишон деҳ)?)(?:\\s+(${countWords}))?(?:[- ]то)?(?:\\s+(?:${propertyWords}))?[.!?]*$`, "iu",
);
const requestedCount = new RegExp(`(?:^|\\s)(${countWords})(?:[- ]то)?\\s+(?:${propertyWords})(?![\\p{L}\\p{N}-])`, "iu");

export function propertyPageRequest(text: string): number | null {
  const match = moreRequest.exec(text.trim());
  return match ? PAGE_COUNTS[match[1]?.toLowerCase() ?? ""] ?? 3 : null;
}

export function propertyPageSize(text: string): number {
  const match = requestedCount.exec(text);
  return PAGE_COUNTS[match?.[1]?.toLowerCase() ?? ""] ?? 3;
}

export function propertyWorkflowRequest(text: string): boolean {
  return propertyPublicationQuestion(text) || /монтаж|перемонтаж|где\s+(?:видео|ролик)|статус\s+(?:видео|ролика)|навор.{0,24}дар ку[ҷч]о|дар ку[ҷч]о.{0,24}навор/iu.test(text);
}

export function clearStaffPropertyPage(scope: Scope) {
  pages.delete(keyOf(scope));
}

async function staffAccess(scope: Scope) {
  if (scope.group) {
    if (!scope.telegramUserId) return null;
    const [linked, settings, group] = await Promise.all([
      findAgentByTelegramUserId(scope.telegramUserId),
      prisma.settings.findUnique({ where: { id: "singleton" }, select: { telegramDiscussionGroupId: true } }),
      prisma.assistantTelegramGroup.findUnique({
        where: { chatId: scope.chatId },
        select: { createdAt: true, contextEnabledAt: true, proactiveMutedUntil: true },
      }),
    ]);
    if (linked?.id !== scope.agentId || settings?.telegramDiscussionGroupId === scope.chatId
      || !group || group.createdAt.getTime() !== scope.group.registeredAt.getTime()
      || group.contextEnabledAt?.getTime() !== scope.group.contextEnabledAt.getTime()
      || (!scope.group.addressed && group.proactiveMutedUntil && group.proactiveMutedUntil > new Date())) return null;
  } else if ((await findAgentByTelegramChatId(scope.chatId))?.id !== scope.agentId) return null;
  const access = await loadAgentAccess(scope.agentId);
  if (!access?.isActive) return null;
  return actorFromAccess(scope.agentId, access, scope.group ? "telegram-group" : "telegram-private");
}

async function deliver(scope: Scope, candidates: Candidate[], count: number, lang: Language) {
  const consumed: string[] = [];
  let uncertain = false;
  let changed = false;
  let hadEligible = false;
  for (const { id, status } of candidates) {
    // Each album can take seconds to deliver. Its authorization cannot be reused for the next one.
    const actor = await staffAccess(scope);
    if (!actor) return { consumed, uncertain, changed, hadEligible, denied: true };
    const canDelete = actor.permissions?.has("properties.delete") ?? false;
    const current = await prisma.property.findUnique({
      where: {
        id, deletedAt: null,
        ...(!canDelete ? { deleteRequests: { none: { status: "PENDING", requestedById: scope.agentId } } } : {}),
      },
      select: { status: true },
    });
    if (current?.status !== status) {
      changed = true;
      continue;
    }
    hadEligible = true;
    const outcome = await sendStaffPropertyCard(scope.chatId, id, lang, scope.replyTo, scope.threadId);
    if (outcome !== "unavailable") consumed.push(id);
    if (outcome === "uncertain") {
      uncertain = true;
      break;
    }
    if (consumed.length >= count) break;
  }
  return { consumed, uncertain, changed, hadEligible, denied: false };
}

export type FirstPropertyDelivery = "handled" | "fallback" | "changed" | "denied";
export async function sendStaffPropertySelection(scope: Scope, selection: Selection, count: number, lang: Language): Promise<FirstPropertyDelivery> {
  const key = keyOf(scope);
  if (inFlight.has(key)) return "handled";
  const previous = pages.get(key);
  if (scope.replyTo !== undefined && previous?.messageId !== undefined && scope.replyTo <= previous.messageId) return "handled";
  inFlight.add(key);
  try {
    const result = await deliver(scope, selection.candidates, count, lang);
    if (result.denied && !result.consumed.length) return "denied";
    pages.delete(key);
    if (selection.filters && result.consumed.length) {
      pages.set(key, { filters: selection.filters, shown: new Set(result.consumed), messageId: scope.replyTo, expiresAt: Date.now() + ttl });
      if (pages.size > 512) pages.delete(pages.keys().next().value!);
    }
    if (result.consumed.length || result.uncertain) return "handled";
    return result.changed ? "changed" : "fallback";
  } finally {
    inFlight.delete(key);
  }
}

export type MorePropertyDelivery = "handled" | "empty" | "missing" | "denied" | "unavailable";
export async function sendMoreStaffProperties(scope: Scope, count: number, lang: Language): Promise<MorePropertyDelivery> {
  const key = keyOf(scope);
  if (inFlight.has(key)) return "handled";
  const page = pages.get(key);
  if (!page || page.expiresAt <= Date.now()) {
    pages.delete(key);
    return "missing";
  }
  if (scope.replyTo !== undefined && page.messageId !== undefined && scope.replyTo <= page.messageId) return "handled";
  inFlight.add(key);
  try {
    const actor = await staffAccess(scope);
    if (!actor) return "denied";
    page.messageId = scope.replyTo ?? page.messageId;
    if (page.shown.size >= 100) return "empty";
    const result = await runTool("search_properties", page.filters, actor, undefined, { excludeIds: [...page.shown] });
    const current = await staffAccess(scope);
    if (!current) return "denied";
    const candidates = parseCandidates(result).filter(item => !page.shown.has(item.id));
    if (!candidates.length) return "empty";
    const delivery = await deliver(scope, candidates, count, lang);
    for (const id of delivery.consumed) page.shown.add(id);
    page.expiresAt = Date.now() + ttl;
    if (delivery.consumed.length || delivery.uncertain) return "handled";
    if (delivery.denied) return "denied";
    return delivery.hadEligible ? "unavailable" : "empty";
  } finally {
    inFlight.delete(key);
  }
}
