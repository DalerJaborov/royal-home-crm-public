import { formatClientCode, parseShortCode } from "@royal-home/shared";
import { z } from "zod";
import { prisma } from "../../../db.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import { maskAssistantContacts } from "../../../lib/assistantContacts.js";
import { canReadCall, transcriptAccess } from "../../../lib/callTranscripts.js";
import { cardWhereFromParam } from "../../../lib/cardIdParam.js";
import { dushanbeDateTimeString } from "../../../lib/dushanbeTime.js";
import { visibleInteractionWhere } from "../../../lib/investigationPrivacy.js";
import { incomingInteractionIds } from "../../../lib/telephony/incomingInteractions.js";
import { clientLinesOf } from "../../scenarioTranscript.js";
import { wrapUntrusted } from "../../untrustedContent.js";
import { assistantInvestigationRole, FOREIGN_CLIENT_SCOPE_MESSAGE, type AssistantActor } from "../actor.js";
import type { AssistantReadToolPlugin } from "./types.js";

const argsSchema = z.object({ clientId: z.string().trim().min(1).max(100) }).strict();
const evidenceLimit = 2_400;

function allowsPrivateTranscript(actor: AssistantActor): boolean {
  return (actor.surface === "crm-private" || actor.surface === "telegram-private")
    && Boolean(actor.permissions?.has("calls.transcripts") || actor.permissions?.has("calls.ownTranscripts"));
}

export const getClientLastCallTool: AssistantReadToolPlugin = {
  name: "get_client_last_call",
  level: "A",
  description:
    "Только в личном разговоре, когда сотрудник явно спрашивает, что сказал конкретный клиент в последнем звонке. " +
    "Передай точную карточку клиента. Используй только помеченные реплики клиента из результата и кратко перескажи их на языке сотрудника. " +
    "Назови время звонка. Не выдавай заметку или слова агента за слова клиента. Если расшифровка недоступна или без реплик клиента, так и скажи.",
  parameters: {
    type: "object",
    properties: { clientId: { type: "string", description: "Номер карточки клиента или id из поиска клиентов" } },
    required: ["clientId"],
  },
  statusPhrase: "Проверяю последний звонок…",
  allowed: allowsPrivateTranscript,
  async run(rawArgs, { actor }) {
    if (!allowsPrivateTranscript(actor)) return { error: "Расшифровка звонка здесь недоступна" };
    const parsed = argsSchema.safeParse(rawArgs);
    if (!parsed.success) return { error: "Укажите клиента" };
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
    const call = await prisma.interaction.findFirst({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: { id: true, agentId: true, createdAt: true, outcome: true },
    });
    const clientRef = { code: formatClientCode(client.shortId, client.kind), href: `/clients/${client.shortId}` };
    if (!call) return { client: clientRef, note: "Звонков в доступной истории нет" };
    const result = { client: clientRef, callAt: dushanbeDateTimeString(call.createdAt) };
    const access = transcriptAccess({
      id: actor.id, role: actor.role, can: permission => actor.permissions?.has(permission) ?? false,
    });
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
