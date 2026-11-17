import { formatClientCode, parseShortCode } from "@royal-home/shared";
import { z } from "zod";
import { prisma } from "../../../db.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import { maskAssistantContacts } from "../../../lib/assistantContacts.js";
import { canReadCall, transcriptAccess, type TranscriptAccess } from "../../../lib/callTranscripts.js";
import { cardWhereFromParam } from "../../../lib/cardIdParam.js";
import { dushanbeDateTimeString } from "../../../lib/dushanbeTime.js";
import { visibleInteractionWhere } from "../../../lib/investigationPrivacy.js";
import { incomingInteractionIds } from "../../../lib/telephony/incomingInteractions.js";
import { clientLinesOf } from "../../scenarioTranscript.js";
import { wrapUntrusted } from "../../untrustedContent.js";
import { assistantInvestigationRole, FOREIGN_CLIENT_SCOPE_MESSAGE, type AssistantActor } from "../actor.js";
import type { AssistantReadToolPlugin } from "./types.js";

const normalizeQuery = (text: string) => text.normalize("NFKC").toLowerCase().replaceAll("ё", "е").replace(/\s+/gu, " ").trim();
const argsSchema = z.object({
  clientId: z.string().trim().min(1).max(100),
  query: z.string().trim().min(2).max(80).transform(normalizeQuery).refine(value => /\p{L}{2}/u.test(value)).optional(),
}).strict();
const evidenceLimit = 2_400;
const historyCallLimit = 40;
const historyExcerptLimit = 700;
const historyMatchLimit = 3;
const callOrder: Prisma.InteractionOrderByWithRelationInput[] = [{ createdAt: "desc" }, { id: "desc" }];

function allowsPrivateTranscript(actor: AssistantActor): boolean {
  return (actor.surface === "crm-private" || actor.surface === "telegram-private")
    && Boolean(actor.permissions?.has("calls.transcripts") || actor.permissions?.has("calls.ownTranscripts"));
}

function findMatchingCustomerSpeech(transcript: string | null, query: string) {
  for (const line of clientLinesOf((transcript ?? "").split(/\r?\n/u))) {
    const safeLine = maskAssistantContacts(line);
    const offset = normalizeQuery(safeLine).indexOf(query);
    if (offset >= 0) {
      const start = Math.max(0, Math.min(offset, safeLine.length) - 120);
      return {
        excerptClipped: start > 0 || safeLine.length > historyExcerptLimit,
        customerSpeech: wrapUntrusted("crm_note", safeLine.slice(start), historyExcerptLimit),
      };
    }
  }
  return null;
}

async function searchCallHistory(where: Prisma.InteractionWhereInput, access: TranscriptAccess, assignedAgentId: string | null, query: string) {
  // Read the routed-call markers and transcripts from the same database snapshot.
  const calls = await prisma.$transaction(async (tx) => {
    const candidates = await tx.interaction.findMany({
      where: {
        ...where,
        AND: [
          { OR: [{ outcome: null }, { outcome: { not: "NO_ANSWER" } }] },
          { OR: [{ transcript: { not: null } }, { transcriptRu: { not: null } }] },
        ],
      },
      orderBy: callOrder,
      take: historyCallLimit,
      select: { id: true, agentId: true },
    });
    if (!candidates.length) return [];

    const id = { in: candidates.map(call => call.id) };
    let readable: Prisma.InteractionWhereInput = { id };
    if (!access.all) {
      const viewerId = access.viewerId;
      if (!access.own || !viewerId) return [];
      const ownCalls = candidates.filter(call => call.agentId === viewerId).map(call => call.id);
      const routedCalls = assignedAgentId === viewerId
        ? await incomingInteractionIds(candidates.filter(call => call.agentId !== viewerId).map(call => call.id), tx)
        : new Set<string>();
      if (!ownCalls.length && !routedCalls.size) return [];
      readable = { OR: [
        { id: { in: ownCalls }, agentId: viewerId },
        { id: { in: [...routedCalls] }, client: { assignedAgentId: viewerId } },
      ] };
    }

    return tx.interaction.findMany({
      where: { ...where, ...readable },
      orderBy: callOrder,
      select: { createdAt: true, transcript: true, transcriptRu: true },
    });
  }, { isolationLevel: "RepeatableRead" });

  const matches = [];
  for (const call of calls) {
    const original = findMatchingCustomerSpeech(call.transcript, query);
    const speech = original ?? findMatchingCustomerSpeech(call.transcriptRu, query);
    if (!speech) continue;
    matches.push({
      ...speech,
      callAt: dushanbeDateTimeString(call.createdAt),
      evidenceSource: original ? "Оригинальная расшифровка CRM" : "Сохранённый перевод расшифровки CRM",
    });
    if (matches.length === historyMatchLimit) break;
  }
  return matches;
}

export const getClientLastCallTool: AssistantReadToolPlugin = {
  name: "get_client_last_call",
  level: "A",
  description:
    "Только в личном разговоре, когда сотрудник явно спрашивает, что сказал конкретный клиент в звонке. " +
    "Передай точную карточку клиента. Без query проверь только последний звонок. " +
    "Для поиска темы в прошлых звонках передай в query одно ключевое слово, его основу или короткую точную фразу. " +
    "Используй только помеченные реплики клиента из результата и кратко перескажи их на языке сотрудника. " +
    "Назови время звонка. Не выдавай заметку или слова агента за слова клиента. Если расшифровка недоступна или без реплик клиента, так и скажи.",
  parameters: {
    type: "object",
    properties: {
      clientId: { type: "string", description: "Номер карточки клиента или id из поиска клиентов" },
      query: { type: "string", description: "Тема для поиска в сохранённых звонках. Опусти для последнего звонка" },
    },
    required: ["clientId"],
  },
  statusPhrase: "Проверяю звонки клиента…",
  allowed: allowsPrivateTranscript,
  async run(rawArgs, { actor }) {
    if (!allowsPrivateTranscript(actor)) return { error: "Расшифровка звонка здесь недоступна" };
    const parsed = argsSchema.safeParse(rawArgs);
    if (!parsed.success) return { error: "Укажите карточку клиента и, если нужна история, короткую тему поиска" };
    const shortCode = parseShortCode(parsed.data.clientId);
    const clientWhere = cardWhereFromParam(shortCode === null ? parsed.data.clientId : String(shortCode));
    if (!clientWhere) return { error: "Клиент не найден" };

    // Same client visibility as get_client_history before checking the separate call ACL.
    const ownScope = actor.canViewAllClients ? undefined : actor.id;
    const client = await prisma.client.findUnique({
      where: clientWhere,
      select: { id: true, shortId: true, kind: true, assignedAgentId: true, acceptedAt: true, deletedAt: true },
    });
    if (!client || client.deletedAt || (ownScope && client.acceptedAt === null)) return { error: "Клиент не найден" };
    if (ownScope && client.assignedAgentId !== ownScope) return { error: FOREIGN_CLIENT_SCOPE_MESSAGE };

    const scope: Prisma.ClientWhereInput = {
      deletedAt: null,
      ...(ownScope ? { acceptedAt: { not: null }, assignedAgentId: ownScope } : {}),
    };
    const where: Prisma.InteractionWhereInput = {
      clientId: client.id,
      client: scope,
      type: "CALL",
      ...visibleInteractionWhere(assistantInvestigationRole(actor)),
    };
    const clientRef = { code: formatClientCode(client.shortId, client.kind), href: `/clients/${client.shortId}` };
    const access = transcriptAccess({
      id: actor.id, role: actor.role, can: permission => actor.permissions?.has(permission) ?? false,
    });
    if (parsed.data.query) {
      const matches = await searchCallHistory(where, access, client.assignedAgentId, parsed.data.query);
      return {
        client: clientRef, matches,
        scope: `Поиск по доступным записям среди ${historyCallLimit} последних звонков с сохранённым текстом`,
        ...(matches.length ? {} : { note: "В доступных расшифровках совпадений по теме нет" }),
      };
    }

    const call = await prisma.interaction.findFirst({
      where,
      orderBy: callOrder,
      select: { id: true, agentId: true, createdAt: true, outcome: true },
    });
    if (!call) return { client: clientRef, note: "Звонков в доступной истории нет" };
    const result = { client: clientRef, callAt: dushanbeDateTimeString(call.createdAt) };
    const routedToOwnClient = !access.all && access.own && call.agentId !== actor.id
      && client.assignedAgentId === actor.id && (await incomingInteractionIds([call.id])).has(call.id);
    if (!canReadCall(access, call.agentId, routedToOwnClient)) {
      return { ...result, note: "Расшифровка последнего звонка недоступна" };
    }
    if (call.outcome === "NO_ANSWER") return { ...result, note: "Последний звонок отмечен как «без ответа»" };

    // Recheck row ownership and client assignment at the actual transcript read.
    const evidence = await prisma.interaction.findFirst({
      where: {
        ...where,
        id: call.id,
        ...(access.all ? {} : { agentId: call.agentId }),
        ...(routedToOwnClient ? { client: { ...scope, assignedAgentId: actor.id } } : {}),
      },
      select: { transcript: true, transcriptRu: true },
    });
    const original = evidence?.transcript?.trim();
    const transcript = original || evidence?.transcriptRu?.trim();
    if (!transcript) return { ...result, note: "Текст последнего звонка пока недоступен" };
    const customerText = maskAssistantContacts(clientLinesOf(transcript.split(/\r?\n/u)).join("\n"));
    if (!customerText) return { ...result, note: "В расшифровке нет отдельно размеченных реплик клиента" };
    return {
      ...result,
      evidenceSource: original ? "Оригинальная расшифровка CRM" : "Сохранённый перевод расшифровки CRM",
      excerptClipped: customerText.length > evidenceLimit,
      customerSpeech: wrapUntrusted("crm_note", customerText, evidenceLimit),
    };
  },
};
