import type { ClientKind } from "@royal-home/shared";
import { prisma } from "../db.js";
import { callAiText } from "../ai/client.js";
import { KIND_LABELS_RU } from "../leads.js";
import { findAgentsWithPermission } from "./recipients.js";
import { sendPushToAgent, sendPushToAgents } from "../push.js";
import { logTimeline } from "./timeline.js";
import { canAutomationChangeKind } from "./kindChangePolicy.js";

/**
 * КЛИЕНТ УЖЕ ПРИНЯТ — НО ПИШЕТ ПРО СОВСЕМ ДРУГОЕ (владелец 19.08.2026).
 *
 * Как только у диалога есть привязанная карточка, бот отвечает ОДНОЙ и той же
 * скупой фразой на любое сообщение («агент свяжется») — это осознанно (см.
 * acceptLead: раньше бот в этом режиме сам вёл разговор и один раз уже начал
 * выдумывать несуществующие варианты). Проблема: если клиент на самом деле
 * пишет о ЗАМЕТНО ДРУГОМ деле — например, полгода назад продавал квартиру
 * (заявка закрыта), сейчас пишет «хочу купить» — сообщение либо тонет в общем
 * «агент перезвонит», либо (если и у него нет «?») вообще гасится реакцией-
 * эмодзи и не доходит до агента ни в каком виде.
 *
 * Решение: лёгкий классификатор ПЕРЕД тем, как решить, спрятать ли ответ за
 * реакцией. Бот всё равно ничего не обсуждает по существу (правило не снимается),
 * но агент получает явную пометку «это новый повод», а не тишину.
 */

/** Дешёвый фильтр до вызова ИИ — тот же приём, что у operatorShowingDetector.ts:
 *  гонять классификатор на каждое «спасибо»/«ок» дорого и бессмысленно. Слова
 *  о сделке — сигнал, что стоит присмотреться; ложные срабатывания не страшны. */
const INTENT_HINT_RE = /(продат|продаж|купит|покупк|снять|сдат|аренд|хочу|нужна?\s|интересует|ищу)/i;

/** Совсем короткие реплики («ок», «👍», одно слово) не несут нового запроса —
 *  не тратим вызов ИИ на них, даже если случайно совпало со словом-триггером. */
const MIN_TEXT_LENGTH = 12;

/** Тот же порядок, что REPEAT_CONTACT_DEDUPE_MS в leads.ts — не пишем вторую
 *  такую же пометку, если клиент прислал несколько сообщений подряд об одном
 *  и том же новом деле. */
const NEW_INQUIRY_DEDUPE_MS = 6 * 60 * 60 * 1000;

const SYSTEM_PROMPT =
  "Ты смотришь на ОДНО новое сообщение клиента агентства недвижимости, у которого уже есть заявка " +
  "в работе. Определи: это явно НОВЫЙ, другой повод обратиться (другой тип сделки — например, был " +
  "продавцом, а сейчас пишет как покупатель; или совсем другой объект/район/бюджет, не связанный с " +
  "прежним делом) — или это продолжение/уточнение ТОГО ЖЕ самого дела (вопрос по старой заявке, " +
  "\"когда перезвонят\", благодарность, согласие, уточнение деталей). " +
  "Верни isNewInquiry=false для любого продолжения старого дела — ошибаться в сторону 'старое дело' " +
  "безопаснее, чем ложно поднимать тревогу. kind — BUYER, если явно хочет купить/снять; SELLER — " +
  "явно хочет продать/сдать; иначе null.";

// type как массив (JSON Schema) Gemini отвергает — её схема инструментов это
// OpenAPI-подмножество с одним типом на поле, необязательность только через
// nullable (тот же баг разобран в operatorShowingDetector.ts и topicLock.ts:118).
// До этой правки КАЖДЫЙ вызов detectNewInquiryFromKnownClient получал HTTP 400 —
// детектор нового повода не работал ни разу с 19.08.
const RESULT_SCHEMA = {
  type: "object",
  properties: {
    isNewInquiry: { type: "boolean", description: "Явно другой, новый повод обратиться — не продолжение старого дела" },
    kind: { type: "string", enum: ["BUYER", "SELLER"], nullable: true, description: "Тип нового запроса, если понятен" },
    summary: { type: "string", description: "Новый запрос клиента одной короткой фразой по-русски" },
  },
  required: ["isNewInquiry", "summary"],
} as const;

interface DetectorResult {
  isNewInquiry: boolean;
  kind?: ClientKind | null;
  summary: string;
}

/**
 * Точка входа — вызывается из messengers/conversation.ts на каждое сообщение
 * уже принятого клиента, ДО того как решается, гасить ли ответ реакцией. Не
 * бросает наружу: вызывающий не должен потерять обычный ответ из-за сбоя здесь.
 */
export async function detectNewInquiryFromKnownClient(
  clientId: string,
  text: string
): Promise<void> {
  if (text.trim().length < MIN_TEXT_LENGTH) return;
  if (!INTENT_HINT_RE.test(text)) return;

  const client = await prisma.client.findUnique({
    where: { id: clientId },
    select: {
      id: true,
      shortId: true,
      fullName: true,
      kind: true,
      assignedAgentId: true,
      requirementsNotes: true,
      acceptedAt: true,
    },
  });
  if (!client) return;

  const recent = await prisma.interaction.findFirst({
    where: {
      clientId,
      type: "SYSTEM",
      notes: { startsWith: "Новый запрос клиента" },
      createdAt: { gte: new Date(Date.now() - NEW_INQUIRY_DEDUPE_MS) },
    },
    select: { id: true },
  });
  if (recent) return;

  let result: DetectorResult | null = null;
  try {
    result = await callAiText<DetectorResult>({
      endpoint: "new-inquiry-detect",
      simple: true,
      maxTokens: 200,
      system: SYSTEM_PROMPT,
      user: `Текущий тип клиента в CRM: ${KIND_LABELS_RU[client.kind] ?? client.kind}.\nНовое сообщение клиента: ${text}`,
      schema: RESULT_SCHEMA,
    });
  } catch {
    return;
  }
  if (!result?.isNewInquiry) return;

  const newKind = result.kind ?? null;
  const kindChanged = !!newKind && newKind !== client.kind;
  const oldLabel = KIND_LABELS_RU[client.kind] ?? client.kind;
  /**
   * ТИП МЕНЯЕТ ЧЕЛОВЕК, ИИ ТОЛЬКО ПРЕДЛАГАЕТ (владелец 21.09.2026, lib/kindChangePolicy.ts).
   * Раньше строка ниже писала kind в карточку прямо здесь — при уже принятой
   * карточке (обычный случай для этого детектора: он вообще смотрит только на
   * клиентов, у которых уже есть диалог с привязанной карточкой) это оказывалось
   * тихой сменой покупатель↔продавец без единого следа. Теперь ИИ только
   * решает агент: ИИ у принятой карточки тип не трогает и ничего о нём не пишет и
   * не шлёт (владелец 21.09.2026: «ии не должен ничего отправлять, пусть решает
   * агент сам») — ни поля, ни пометки о смене типа, ни особого пуша.
   */
  const canChangeNow = kindChanged && canAutomationChangeKind({
    acceptedAt: client.acceptedAt,
    currentKind: client.kind,
    nextKind: newKind!,
  });
  const note =
    `Новый запрос клиента (не связан с прежним делом): ${result.summary}` +
    (canChangeNow ? ` — похоже на смену типа: ${oldLabel} → ${KIND_LABELS_RU[newKind!]}` : "");

  // Автор — ИИ (разбор новой реплики, П-10, 17.09.2026), не агент: раньше
  // запись подписывалась ответственным (client.assignedAgentId) и вовсе не
  // писалась у карточки без агента («Interaction.agentId обязателен») — теперь
  // пишется всегда, subjectAgentId просто может быть null.
  const jobs: Promise<unknown>[] = [
    logTimeline({
      clientId,
      actor: { kind: "ai", source: "new-inquiry-detector", subjectAgentId: client.assignedAgentId ?? null },
      type: "SYSTEM",
      notes: note,
    }),
  ];
  if (canChangeNow) {
    const becomingBuyer = newKind === "BUYER";
    jobs.push(
      prisma.client.update({
        where: { id: clientId },
        data: {
          kind: newKind!,
          budgetMin: becomingBuyer ? undefined : null,
          budgetMax: becomingBuyer ? undefined : null,
          desiredDistrictId: becomingBuyer ? undefined : null,
          desiredRooms: becomingBuyer ? undefined : null,
        },
      })
    );
  }
  await Promise.all(jobs).catch((err) => console.error("[новый-запрос] запись не сохранена:", err));

  const pushBody = `${client.fullName} — ${result.summary}`;
  if (client.assignedAgentId) {
    sendPushToAgent(client.assignedAgentId, {
      title: "🔔 Клиент пишет о новом деле",
      body: pushBody,
      url: `/clients/${client.shortId}`,
      tag: `new-inquiry-${clientId}`,
    }).catch((err) => console.error("[push] новый запрос:", err));
  } else {
    const supervisors = await findAgentsWithPermission("clients.assign");
    sendPushToAgents(supervisors, {
      title: "🔔 Клиент без агента пишет о новом деле",
      body: pushBody,
      url: `/clients/${client.shortId}`,
      tag: `new-inquiry-${clientId}`,
    }).catch((err) => console.error("[push] новый запрос без агента:", err));
  }
}
