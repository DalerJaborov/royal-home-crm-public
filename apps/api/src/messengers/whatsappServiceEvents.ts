import { z } from "zod";
import { prisma } from "../db.js";
import { describeError } from "../lib/describeError.js";
import { logSystemError } from "../lib/systemError.js";
import { isDuplicateDelivery, markProcessedMessageComplete } from "../lib/webhookDedupe.js";
import { CustomerScopeDenied, resolveCustomerEndpoint, type ScopedCustomerEndpoint } from "../lib/customerConversationScope.js";
import { isCustomerAgentTurnOff } from "../lib/customerAgentChannelOff.js";
import { routeMessengerCallbackRequest, recordCallbackRequest } from "../lib/callbackRequests.js";
import { findClientByPhoneDigits } from "../lib/whatsappPhone.js";
import { logTimelineMany } from "../lib/timeline.js";
import { accountBrandName } from "./accounts.js";
import { sendMessage } from "./meta.js";
import { whatsappCallbackRequestsEnabled, whatsappWelcomeEnabled, whatsappWelcomeText } from "./whatsappCommands.js";

/**
 * СЛУЖЕБНЫЕ СОБЫТИЯ WHATSAPP, НА КОТОРЫЕ CRM ТЕПЕРЬ ОТВЕЧАЕТ (27.11.2026, оба номера: Royal Home и «Арван»).
 *
 * Разбор входящих (meta.ts::whatsappServiceEventReason) по-прежнему не пускает эти события к ядру бота — это не реплики
 * человека. Здесь из них делается ровно то, что нужно, и ничего больше:
 *
 * 1. `request_welcome` — человек впервые открыл чат и ещё ничего не написал. Ответ — одно тёплое приветствие от бренда
 *    своего номера с вопросом «купить или продать». Ни переписки, ни заявки, ни пуша агентам: всё это начнётся, когда
 *    человек напишет сам. Если переписка с ним на этом номере уже есть — молчим: он не новый, ему уже отвечают.
 *    ФАКТ: тип сообщения `request_welcome` и `enable_welcome_message` в Conversational Automation API (справочник
 *    developers.facebook.com/documentation/business-messaging/whatsapp/reference/whatsapp-business-account/
 *    conversational-automation-api, прочитан 27.11.2026). НЕТ ДАННЫХ в нынешней странице «Conversational Components»:
 *    там приветствие больше не описано, форма события — по прежней версии документации и по уже работающему отсеву.
 *
 * 2. `interactive.call_permission_reply` — человек разрешил (или запретил) нам звонить ему в WhatsApp.
 *    ФАКТ (…/whatsapp/calling/user-call-permissions, «User call permission reply webhook», прочитано 27.11.2026):
 *    `call_permission_reply.response` = accept | reject, `is_permanent`, `expiration_timestamp`, `response_source` =
 *    user_action | automatic; `context.id` — наш запрос разрешения или звонок; `callback_permission_status: ENABLED`
 *    в настройках номера показывает человеку этот запрос после его звонка нам (…/calling/call-settings).
 *    Решение: просьба о звонке (CallbackRequest) — только на `accept` от самого человека (`user_action`). `automatic` —
 *    разрешение, которое Meta выдаёт за сам факт звонка клиента; этот звонок CRM уже видит со стороны станции
 *    (журнал звонков, пропущенные), вторую задачу «перезвонить» на каждый звонок не заводим. `reject` — одна строка.
 *
 * Повтор доставки: замок по wamid события (lib/webhookDedupe.ts, канал WHATSAPP_SERVICE) — второе приветствие и вторая
 * просьба не появляются. Вторая линия у просьбы — одна открытая просьба на человека (recordCallbackRequest).
 * Не бросает: вебхук Meta уже получил 200.
 */

const DEDUPE_CHANNEL = "WHATSAPP_SERVICE";
const DEFAULT_BRAND = "Royal Home";

const permissionSchema = z
  .object({
    response: z.string().optional(),
    is_permanent: z.boolean().optional(),
    expiration_timestamp: z.union([z.string(), z.number()]).optional(),
    response_source: z.string().optional(),
  })
  .passthrough();

const messageSchema = z
  .object({
    id: z.string().optional(),
    from: z.string().optional(),
    type: z.string().optional(),
    context: z.object({ id: z.string().optional() }).passthrough().optional(),
    interactive: z
      .object({ type: z.string().optional(), call_permission_reply: permissionSchema.optional() })
      .passthrough()
      .optional(),
  })
  .passthrough();

const bodySchema = z
  .object({
    object: z.string().optional(),
    entry: z
      .array(
        z
          .object({
            changes: z
              .array(
                z
                  .object({
                    field: z.string().optional(),
                    value: z
                      .object({
                        metadata: z
                          .object({ phone_number_id: z.string().optional(), display_phone_number: z.string().optional() })
                          .passthrough()
                          .optional(),
                        contacts: z.array(z.object({ wa_id: z.string().optional(), profile: z.object({ name: z.string().optional() }).passthrough().optional() }).passthrough()).optional(),
                        messages: z.array(z.unknown()).optional(),
                      })
                      .passthrough()
                      .optional(),
                  })
                  .passthrough()
              )
              .optional(),
          })
          .passthrough()
      )
      .optional(),
  })
  .passthrough();

export interface WhatsappCallPermission {
  response: "accept" | "reject" | string;
  isPermanent: boolean;
  /** Когда истекает (секунды Unix у Meta), null — не дано или навсегда. */
  expiresAt: Date | null;
  source: "user_action" | "automatic" | string | null;
}

export type WhatsappServiceEvent =
  | { kind: "welcome"; messageId: string; from: string; phoneNumberId: string; displayPhone: string | null; name: string | null }
  | { kind: "call_permission"; messageId: string; from: string; phoneNumberId: string; displayPhone: string | null; name: string | null;
      permission: WhatsappCallPermission; contextId: string | null };

/**
 * Чистая: служебные события из тела вебхука. Только наши номера (`ourPhoneIds`; пусто — номера ещё не настроены, не
 * фильтруем, как parseIncoming). Без wamid или номера клиента событие пропускается: без wamid нет защиты от повтора, без
 * номера некому отвечать и некому звонить.
 */
export function parseWhatsappServiceEvents(body: unknown, ourPhoneIds?: string | string[]): WhatsappServiceEvent[] {
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success || parsed.data.object !== "whatsapp_business_account") return [];
  const ours = new Set((Array.isArray(ourPhoneIds) ? ourPhoneIds : ourPhoneIds ? [ourPhoneIds] : []).filter(Boolean));
  const out: WhatsappServiceEvent[] = [];
  for (const entry of parsed.data.entry ?? []) {
    for (const change of entry.changes ?? []) {
      if (change.field && change.field !== "messages") continue;
      const value = change.value;
      const phoneNumberId = value?.metadata?.phone_number_id;
      if (!phoneNumberId || (ours.size > 0 && !ours.has(phoneNumberId))) continue;
      const displayPhone = value?.metadata?.display_phone_number ?? null;
      const names = new Map((value?.contacts ?? []).map((c) => [c.wa_id ?? "", c.profile?.name ?? ""]));
      for (const raw of value?.messages ?? []) {
        const msg = messageSchema.safeParse(raw);
        if (!msg.success || !msg.data.id || !msg.data.from) continue;
        const base = { messageId: msg.data.id, from: msg.data.from, phoneNumberId, displayPhone, name: names.get(msg.data.from) || null };
        if (msg.data.type === "request_welcome") {
          out.push({ kind: "welcome", ...base });
          continue;
        }
        const reply = msg.data.interactive?.type === "call_permission_reply" ? msg.data.interactive.call_permission_reply : undefined;
        if (msg.data.type === "interactive" && reply) {
          const seconds = Number(reply.expiration_timestamp);
          out.push({
            kind: "call_permission",
            ...base,
            contextId: msg.data.context?.id ?? null,
            permission: {
              response: reply.response ?? "",
              isPermanent: reply.is_permanent === true,
              expiresAt: Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000) : null,
              source: reply.response_source ?? null,
            },
          });
        }
      }
    }
  }
  return out;
}

/** «+992 87 791 4444» из «992877914444» — для текста просьбы; не похоже на номер — как есть. */
export function formatBusinessPhone(display: string | null): string | null {
  if (!display) return null;
  const digits = display.replace(/\D/g, "");
  if (digits.length === 12 && digits.startsWith("992")) {
    return `+992 ${digits.slice(3, 5)} ${digits.slice(5, 8)} ${digits.slice(8)}`;
  }
  return digits ? `+${digits}` : display;
}

/** Номер бизнеса и его бренд для людей: «WhatsApp «Арван» (+992 87 791 4444)». */
export function whatsappLineLabel(brand: string, displayPhone: string | null): string {
  const phone = formatBusinessPhone(displayPhone);
  return `WhatsApp «${brand}»${phone ? ` (${phone})` : ""}`;
}

/**
 * Чистая: текст просьбы о звонке — агенту в пуше, в очереди CRM и в карточке. Бренд номера обязателен: у агентства два
 * номера, и агент должен знать, от чьего имени звонить.
 */
export function callbackTopic(input: { brand: string; displayPhone: string | null; name: string | null; isPermanent: boolean }): string {
  const who = input.name?.trim() ? `${input.name.trim()} ` : "Клиент ";
  const how = input.isPermanent ? "Разрешение без срока." : "Разрешение на 7 дней.";
  return `${who}в ${whatsappLineLabel(input.brand, input.displayPhone)} разрешил нам позвонить ему и ждёт звонка. ${how}`;
}

type Endpoint = ScopedCustomerEndpoint;

async function endpointFor(from: string, phoneNumberId: string): Promise<Endpoint | null> {
  try {
    return await resolveCustomerEndpoint({ channel: "WHATSAPP", subscriberId: from, accountExternalId: phoneNumberId });
  } catch (err) {
    if (err instanceof CustomerScopeDenied) return null;
    throw err;
  }
}

/**
 * Переписка этого человека на ЭТОМ номере (или старая, без номера: её нельзя приписать ни одному из двух). Переписка на
 * другом нашем номере сюда не попадает: у каждого номера своя (правило #480).
 */
async function conversationOnLine(from: string, endpoint: Endpoint): Promise<{ id: string; clientId: string | null } | null> {
  return prisma.botConversation.findFirst({
    where: {
      channel: "WHATSAPP",
      subscriberId: from,
      OR: [{ endpointScopeId: endpoint.endpointScopeId }, { endpointScopeId: null }, { endpointScope: { kind: { not: "NORMAL" } } }],
    },
    orderBy: { updatedAt: "desc" },
    select: { id: true, clientId: true },
  });
}

async function brandOf(endpoint: Endpoint): Promise<string> {
  return (await accountBrandName(endpoint.accountId)) ?? DEFAULT_BRAND;
}

async function handleWelcome(event: Extract<WhatsappServiceEvent, { kind: "welcome" }>): Promise<"sent" | "skipped"> {
  if (!whatsappWelcomeEnabled()) return "skipped";
  const endpoint = await endpointFor(event.from, event.phoneNumberId);
  if (!endpoint) {
    console.warn(`[whatsapp-приветствие] номер ${event.phoneNumberId} не настроен в CRM — приветствие не отправлено`);
    return "skipped";
  }
  // Аварийная кнопка «бот молчит на этом канале» (CUSTOMER_AGENT_CHANNEL_OFF) касается и приветствия.
  if (await isCustomerAgentTurnOff({ channel: "WHATSAPP", accountId: endpoint.accountId })) return "skipped";
  if (await conversationOnLine(event.from, endpoint)) return "skipped";
  const text = whatsappWelcomeText(await brandOf(endpoint));
  await sendMessage("WHATSAPP", event.from, text, undefined, {
    origin: "bot",
    recipientName: event.name,
    transport: endpoint,
    answersInbound: true,
  });
  return "sent";
}

async function handleCallPermission(event: Extract<WhatsappServiceEvent, { kind: "call_permission" }>): Promise<"recorded" | "skipped"> {
  const { permission } = event;
  const tail = event.from.slice(-4);
  if (permission.response !== "accept" || permission.source !== "user_action") {
    console.log(`[whatsapp-разрешение-звонка] ответ=${permission.response || "?"} источник=${permission.source ?? "?"} от=•••${tail}` +
      ` номер=${event.phoneNumberId} — просьба не заводится`);
    return "skipped";
  }
  if (!whatsappCallbackRequestsEnabled()) return "skipped";
  const endpoint = await endpointFor(event.from, event.phoneNumberId);
  const brand = endpoint ? await brandOf(endpoint) : DEFAULT_BRAND;
  const conversation = endpoint ? await conversationOnLine(event.from, endpoint) : null;
  const phone = `+${event.from.replace(/\D/g, "")}`;
  let clientId = conversation?.clientId ?? null;
  if (!clientId) {
    const match = await findClientByPhoneDigits(phone);
    clientId = match && !match.deletedAt ? match.id : null;
  }
  const topic = callbackTopic({ brand, displayPhone: event.displayPhone, name: event.name, isPermanent: permission.isPermanent });
  const input = { conversationId: conversation?.id ?? null, clientId, channel: "WHATSAPP", topic, phone };
  // Агент клиента — пуш ему (та же дверь, что у просьбы «перезвоните» в переписке); агента нет — запись в очереди CRM и
  // пуш тем, кто работает с сообщениями. Автодозвон дежурного не участвует: WhatsApp — не канал станции.
  const routed = await routeMessengerCallbackRequest(input);
  if (!routed) await recordCallbackRequest({ ...input, autoConnect: false });
  if (clientId) {
    const owner = await prisma.client.findFirst({ where: { id: clientId, deletedAt: null }, select: { assignedAgentId: true } });
    if (owner) {
      await logTimelineMany([{ clientId, actor: { kind: "system", source: "whatsappCallPermission", subjectAgentId: owner.assignedAgentId ?? null },
        type: "SYSTEM", notes: topic }]);
    }
  }
  return "recorded";
}

/**
 * Разобрать и обработать служебные события вебхука. Каждое — под замком своего wamid: повторная доставка ничего не
 * повторяет. Сбой одного события пишется в журнал ошибок и не мешает остальным.
 */
export async function handleWhatsappServiceEvents(body: unknown, ourPhoneIds?: string | string[]): Promise<number> {
  const events = parseWhatsappServiceEvents(body, ourPhoneIds);
  let handled = 0;
  for (const event of events) {
    try {
      if (await isDuplicateDelivery(DEDUPE_CHANNEL, event.messageId)) continue;
      try {
        const result = event.kind === "welcome" ? await handleWelcome(event) : await handleCallPermission(event);
        if (result === "sent" || result === "recorded") handled++;
      } finally {
        // Отметка «готово» и при отказе: повтор приветствия через минуту хуже, чем одно неотправленное (Meta уже получила
        // 200 и сама событие не повторит; повторить его может только редкая повторная доставка).
        await markProcessedMessageComplete(DEDUPE_CHANNEL, event.messageId);
      }
    } catch (err) {
      void logSystemError("meta", `WhatsApp: ${event.kind === "welcome" ? "приветствие не отправлено" : "разрешение на звонок не записано"}` +
        ` (номер ${event.phoneNumberId}): ${describeError(err)}`, { dedupKey: `wa-service-event-${event.kind}` });
    }
  }
  return handled;
}
