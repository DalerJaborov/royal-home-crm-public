/**
 * «КОМУ ПОДХОДИТ ОБЪЕКТ» В TELEGRAM И «ПРЕДЛОЖИТЬ КОЛЛЕГЕ» (решение владельца
 * 10.11.2026). Сразу после создания объекта мастер присылает одно сообщение:
 * свои клиенты полностью, клиенты коллег — без имени и телефона, с кнопкой
 * «Предложить». Процент совпадения НЕ показываем (владелец: это не качество
 * совпадения) — только причины подбора как есть.
 *
 * Кто что видит — lib/propertyMatchingClients.ts, запись предложения —
 * lib/propertyClientOffers.ts. Здесь только текст и кнопки.
 */
import { formatClientCode, formatPropertyCode, isReadOnlyRole, PROPERTY_TYPE_LABELS, type PermissionId } from "@royal-home/shared";
import { loadAgentAccess } from "../auth/middleware.js";
import { prisma } from "../db.js";
import { clientNamePhoneSafe } from "../lib/clientPhone.js";
import { createNotification } from "../lib/notifications.js";
import { answerPropertyClientOffer, createPropertyClientOffer, setPropertyClientOfferChannel } from "../lib/propertyClientOffers.js";
import { matchingClientsForAssistant, type AssistantClientMatch } from "../lib/propertyMatchingClients.js";
import { logSystemError } from "../lib/systemError.js";
import { findAgentByTelegramChatId } from "../lib/telegramAgentLink.js";
import {
  answerCallbackQuery, editMessageText, sendHtmlMessage, sendMessageWithButtons,
  type TelegramCallbackQuery, type TelegramInlineButton,
} from "./api.js";
import { escapeHtml } from "./assistantReply.js";

type Lang = "ru" | "tg";
type Viewer = { agent: NonNullable<Parameters<typeof matchingClientsForAssistant>[0]["agent"]> };

const copy = {
  ru: {
    title: (n: number) => `🎯 Подходит ${n} ${n % 10 === 1 && n % 100 !== 11 ? "клиенту" : "клиентам"}`,
    none: "🎯 Подходящих клиентов в базе пока нет.",
    own: "⭐ Ваши", colleagues: "👥 У коллег", leads: (name: string) => `ведёт ${name}`, noAgent: "без агента",
    incomplete: "❓ требования неполные", rooms: (n: number) => `${n}к`, upTo: "до", tjs: "сомони",
    more: (n: number) => `И ещё ${n} — в CRM, «Подбор» на карточке объекта.`,
    offer: (name: string, code: string) => `🤝 Предложить: ${name} · ${code}`,
    sent: (name: string) => `Предложила: ${name}. Клиенту ничего не отправлено.`,
    already: (name: string) => `Уже предлагали: ${name}.`,
    refused: { not_found: "Объект или клиент уже не найден", forbidden: "Предложить может тот, чей это объект", not_matching: "Клиент уже не подходит", own_client: "Это ваш клиент", no_agent: "У клиента нет агента" },
  },
  tg: {
    title: (n: number) => `🎯 Ба ${n} мизоҷ мувофиқ аст`,
    none: "🎯 Мизоҷони мувофиқ дар база ҳоло нест.",
    own: "⭐ Мизоҷони шумо", colleagues: "👥 Дар ҳамкорон", leads: (name: string) => `пешбар ${name}`, noAgent: "бе агент",
    incomplete: "❓ талабот пурра нест", rooms: (n: number) => `${n} ҳуҷра`, upTo: "то", tjs: "сомонӣ",
    more: (n: number) => `Боз ${n} — дар CRM, «Интихоб» дар корти объект.`,
    offer: (name: string, code: string) => `🤝 Пешниҳод: ${name} · ${code}`,
    sent: (name: string) => `Ба ${name} пешниҳод шуд. Ба мизоҷ чизе фиристода нашуд.`,
    already: (name: string) => `Аллакай ба ${name} пешниҳод шуда буд.`,
    refused: { not_found: "Объект ё мизоҷ ёфт нашуд", forbidden: "Пешниҳодро соҳиби объект мекунад", not_matching: "Мизоҷ дигар мувофиқ нест", own_client: "Ин мизоҷи шумост", no_agent: "Мизоҷ агент надорад" },
  },
} as const;

const SHOWN_OPEN = 4;
const MAX_OFFER_BUTTONS = 6;
const money = (value: number) => new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 }).format(value);

function matchLines(match: AssistantClientMatch, lang: Lang): string[] {
  const c = copy[lang];
  const code = `<code>${formatClientCode(match.shortId)}</code>`;
  const head = match.own || match.name
    ? `• ${code} ${escapeHtml(match.name ?? "")}${match.own ? "" : ` · ${escapeHtml(c.leads(match.agentName ?? c.noAgent))}`}`
    : `• ${code} · ${escapeHtml(match.agentName ? c.leads(match.agentName) : c.noAgent)}`;
  const reasons = match.reasons.length
    ? match.reasons.map(reason => `${reason.tradeoff ? "⚠️" : "✅"} ${escapeHtml(reason.text)}`).join(" · ")
    : c.incomplete;
  const facts = [
    match.budgetMax != null && `💰 ${c.upTo} ${match.currency === "USD" ? `$${money(match.budgetMax)}` : `${money(match.budgetMax)} ${c.tjs}`}`,
    match.rooms != null && c.rooms(match.rooms),
    match.districtName && `📍 ${escapeHtml(match.districtName)}`,
  ].filter(Boolean).join(" · ");
  return [head, `   ${reasons}`, ...(facts ? [`   ${facts}`] : [])];
}

/** Одно сообщение после создания объекта. Клиентам ничего не уходит. */
export async function sendPropertyMatchesCard(chatId: string, viewer: Viewer, propertyId: string, lang: Lang): Promise<void> {
  const c = copy[lang];
  try {
    const [matches, property] = await Promise.all([
      matchingClientsForAssistant(viewer, propertyId),
      prisma.property.findUnique({ where: { id: propertyId }, select: { shortId: true } }),
    ]);
    const shownCount = matches.own.length + matches.colleagues.length;
    if (!property || !shownCount) { await sendHtmlMessage(chatId, escapeHtml(c.none)); return; }
    const blocks: string[][] = [];
    if (matches.own.length) blocks.push([`<b>${c.own}</b>`, ...matches.own.flatMap(match => matchLines(match, lang))]);
    if (matches.colleagues.length) blocks.push([`<b>${c.colleagues}</b>`, ...matches.colleagues.flatMap(match => matchLines(match, lang))]);
    // Первые клиенты открыто, остальное — свёрнутой цитатой.
    const entries = blocks.flat();
    const entryStarts = entries.map((line, index) => line.startsWith("• ") ? index : -1).filter(index => index >= 0);
    const cut = entryStarts.length > SHOWN_OPEN ? entryStarts[SHOWN_OPEN] : entries.length;
    const open = entries.slice(0, cut);
    const folded = entries.slice(cut);
    const total = Math.max(matches.total, shownCount);
    const html = [
      `<b>${c.title(total)}</b>`,
      ...open,
      ...(folded.length ? [`<blockquote expandable>${folded.join("\n")}</blockquote>`] : []),
      ...(total > shownCount ? [escapeHtml(c.more(total - shownCount))] : []),
    ].join("\n");
    const buttons: TelegramInlineButton[][] = matches.colleagues
      .filter(match => match.agentId && match.agentName)
      .slice(0, MAX_OFFER_BUTTONS)
      .map(match => [{ text: c.offer(match.agentName!, formatClientCode(match.shortId)), callback_data: `pdo:${property.shortId}:${match.shortId}` }]);
    await sendHtmlMessage(chatId, html, undefined, buttons.length ? buttons : undefined);
  } catch (error) {
    void logSystemError("telegram", `Мастер объекта в Telegram: карточка подбора не ушла: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const offerCallback = /^pdo:(\d{1,9}):(\d{1,9})$/u;
const answerCallback = /^pdr:(s|n):([\da-f-]{36})$/u;

async function viewerFor(agentId: string): Promise<(Viewer & { role: string }) | null> {
  const access = await loadAgentAccess(agentId);
  if (!access?.isActive) return null;
  return { role: access.role, agent: { ...access, id: agentId, can: (permission: PermissionId) => access.permissions.has(permission) } as Viewer["agent"] };
}

async function deliverOffer(offerId: string, fromName: string, toAgent: { id: string; fullName: string; telegramChatId: string | null }, propertyId: string, clientId: string) {
  const [property, client, ownerAccess] = await Promise.all([
    prisma.property.findUnique({ where: { id: propertyId }, select: { id: true, shortId: true, type: true, rooms: true, areaSqm: true, price: true, currency: true, district: { select: { name: true } } } }),
    prisma.client.findUnique({ where: { id: clientId }, select: { shortId: true, kind: true, fullName: true } }),
    loadAgentAccess(toAgent.id),
  ]);
  if (!property || !client) return;
  const clientName = clientNamePhoneSafe(client.fullName, Boolean(ownerAccess?.permissions.has("clients.viewPhone")));
  const propertyCode = formatPropertyCode(property.shortId);
  const clientCode = formatClientCode(client.shortId, client.kind);
  const facts = [propertyCode, PROPERTY_TYPE_LABELS[property.type], property.rooms && `${property.rooms}к`, `${Number(property.areaSqm)} м²`,
    `${money(Number(property.price))} ${property.currency === "USD" ? "$" : "сомони"}`, property.district?.name && `📍 ${property.district.name}`].filter(Boolean).join(" · ");
  const text = `🤝 ${fromName} предлагает объект для вашего клиента ${clientCode} ${clientName}:\n${facts}\nКлиенту ничего не отправлено.`;
  const base = process.env.CRM_PUBLIC_URL?.trim().replace(/\/+$/, "") || "https://crm.royalhome.tj";
  const notifyInCrm = () => createNotification({
    agentId: toAgent.id, kind: "property-offer", title: "Коллега предлагает объект для вашего клиента",
    body: `${fromName} предлагает ${propertyCode} для ${clientCode}. Клиенту ничего не отправлено.`,
    url: `/properties/${property.id}`, tag: `property-offer:${offerId}`,
  });
  if (!toAgent.telegramChatId) { await notifyInCrm(); return; }
  try {
    await sendMessageWithButtons(toAgent.telegramChatId, text, [
      [{ text: "📤 Отправлю клиенту", callback_data: `pdr:s:${offerId}` }, { text: "🙅 Не подходит", callback_data: `pdr:n:${offerId}` }],
      [{ text: `Открыть ${propertyCode}`, url: `${base}/properties/${property.id}` }],
    ]);
  } catch (error) {
    void logSystemError("telegram", `Предложение объекта коллеге не ушло в Telegram, записано в CRM: ${error instanceof Error ? error.message : String(error)}`);
    await setPropertyClientOfferChannel(offerId, "CRM");
    await notifyInCrm();
  }
}

/** `pdo:<номер объекта>:<номер клиента>` и ответы владельца `pdr:s|n:<id>`. */
export async function handlePropertyOfferCallback(query: TelegramCallbackQuery): Promise<boolean> {
  const data = query.data ?? "";
  const offer = offerCallback.exec(data);
  const reply = answerCallback.exec(data);
  if (!offer && !reply) return false;
  const answer = (text?: string) => answerCallbackQuery(query.id, text).catch(() => {});
  const chat = query.message?.chat;
  if (chat?.type !== "private" || query.from?.id !== chat.id) { await answer("Кнопка доступна только в личке"); return true; }
  const agent = await findAgentByTelegramChatId(String(chat.id));
  const viewer = agent && await viewerFor(agent.id);
  if (!agent || !viewer || isReadOnlyRole(viewer.role)) { await answer("Недостаточно прав"); return true; }
  try {
    if (reply) {
      const ok = await answerPropertyClientOffer(agent.id, reply[2], reply[1] === "s" ? "WILL_SEND" : "NOT_SUITABLE");
      await answer(ok ? "Записала" : "Уже отвечено");
      const messageId = query.message?.message_id;
      if (ok && messageId) {
        await editMessageText(String(chat.id), messageId, `${query.message?.text ?? ""}\n\n${reply[1] === "s" ? "📤 Отправлю клиенту" : "🙅 Не подходит"}`, null).catch(() => {});
      }
      return true;
    }
    const state = await prisma.telegramDialogState.findUnique({ where: { chatId: String(chat.id) }, select: { payload: true } });
    const lang: Lang = state?.payload && typeof state.payload === "object" && "lang" in state.payload && state.payload.lang === "tg" ? "tg" : "ru";
    const c = copy[lang];
    const [property, client] = await Promise.all([
      prisma.property.findUnique({ where: { shortId: Number(offer![1]) }, select: { id: true } }),
      prisma.client.findUnique({ where: { shortId: Number(offer![2]) }, select: { id: true } }),
    ]);
    if (!property || !client) { await answer(c.refused.not_found); return true; }
    const result = await createPropertyClientOffer(viewer, property.id, client.id);
    if (result.status === "refused") { await answer(c.refused[result.reason]); return true; }
    if (result.status === "already") { await answer(c.already(result.toAgentName)); return true; }
    await deliverOffer(result.offerId, agent.fullName, result.toAgent, property.id, client.id);
    await answer(c.sent(result.toAgent.fullName));
  } catch (error) {
    void logSystemError("telegram", `Предложение объекта коллеге: ${error instanceof Error ? error.message : String(error)}`);
    await answer("Не получилось, попробуйте ещё раз");
  }
  return true;
}

