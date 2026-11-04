import { CLIENT_KIND_LABELS, CLIENT_SOURCE_LABELS, CLIENT_SOURCES, clientPhoneSchema } from "@royal-home/shared";
import { z } from "zod";
import { prisma, type TxClient } from "../../../db.js";
import { Prisma } from "../../../generated/prisma/client.js";
import { AssistantActionError, type AssistantActionExecutor } from "../../../lib/assistantActions.js";
import { maskClientPhone, phoneSafeText } from "../../../lib/clientPhone.js";
import { fullPhoneIdentity } from "../../../lib/clientPhoneFacts.js";
import { findPhoneOwners, phoneTail } from "../../../lib/clientPhones.js";
import { findFuzzyDuplicateCandidate } from "../../../lib/duplicateReview.js";
import { findStaffPhone } from "../../../lib/staffPhoneGuard.js";
import { SELF_CREATED_ASSIGN_REASON } from "../../../services/leads/firstCall.js";
import { plainField } from "./safeField.js";
import { asPluginExecutor, loadToolActor } from "./showingToolSupport.js";
import type { AssistantWriteToolPlugin } from "./types.js";
import { privateWriteAllowed } from "./privateWriteAllowed.js";

const argsSchema = z.object({
  fullName: z.string().trim().min(2).max(120),
  phone: clientPhoneSchema,
  source: z.enum(CLIENT_SOURCES),
  kind: z.enum(["BUYER", "SELLER"]).default("BUYER"),
  requirementsNotes: z.string().trim().min(1).max(2000).optional(),
}).strict();

type Args = z.infer<typeof argsSchema>;
type CheckDb = Pick<TxClient, "$queryRaw" | "agent">;
const clientResultSchema = z.object({ clientId: z.string().uuid() });

const duplicate = () => new AssistantActionError(409, "CLIENT_PHONE_IN_USE", "Клиент с этим номером уже есть в CRM.");

async function checkNewClient(args: Args, db: CheckDb = prisma) {
  const existing = (await findPhoneOwners([args.phone], { includeDeleted: true, limit: 1, db }))[0];
  if (existing) {
    if (!existing.deletedAt) throw duplicate();
    throw new AssistantActionError(409, "CLIENT_IN_TRASH", "Клиент с этим номером в Корзине. Восстановите карточку в CRM.");
  }
  if (await findStaffPhone([args.phone], db)) {
    throw new AssistantActionError(409, "STAFF_PHONE", "Этот номер принадлежит сотруднику. Укажите номер клиента.");
  }
  if (await findFuzzyDuplicateCandidate(args.fullName, args.phone, undefined, db)) {
    throw new AssistantActionError(409, "POSSIBLE_DUPLICATE", "В CRM уже есть похожий клиент. Проверьте имя и номер перед созданием.");
  }
}

const executor: AssistantActionExecutor<Args> = {
  tool: "create_client",
  channels: ["crm", "telegram"],
  privateTelegram: true,
  transactional: true,
  parseArgs(raw) {
    const parsed = argsSchema.safeParse(raw);
    if (!parsed.success) {
      const fields = parsed.error.flatten().fieldErrors;
      const question = fields.fullName && fields.phone ? "Как зовут клиента и какой у него номер?"
        : fields.fullName ? "Как зовут клиента?"
        : fields.phone ? "Какой у клиента номер?"
        : fields.source ? "Откуда пришёл клиент?"
        : "Уточните данные клиента.";
      throw new AssistantActionError(400, "BAD_ARGS", question);
    }
    const phone = parsed.data.phone.trim();
    const digits = phone.replace(/\D/g, "");
    if (!/^\+?[\d ()-]+$/u.test(phone) ||
      !(digits.length === 9 || digits.length === 12 && digits.startsWith("992") ||
        phone.startsWith("+") && digits.length >= 10 && digits.length <= 15 && digits[0] !== "0")) {
      throw new AssistantActionError(400, "BAD_PHONE", "Уточните номер клиента. Для иностранного номера нужен код страны.");
    }
    return { ...parsed.data, phone: `+${fullPhoneIdentity(phone)}` };
  },
  async authorize(_args, actionActor, action) {
    const { actor } = await loadToolActor(actionActor, prisma);
    if (action.status !== "EXECUTED") return;
    const result = clientResultSchema.safeParse(action.result);
    const visible = result.success && await prisma.client.findUnique({
      where: {
        id: result.data.clientId,
        deletedAt: null,
        ...(!actor.canViewAllClients ? { assignedAgentId: actor.id, acceptedAt: { not: null } } : {}),
      },
      select: { id: true },
    });
    if (!visible) throw new AssistantActionError(403, "FORBIDDEN", "Нет доступа к карточке клиента.");
  },
  async snapshot(args, actionActor, tx) {
    if (tx) await tx.$queryRaw`SELECT "id" FROM "Agent" WHERE "id" = ${actionActor.agentId} FOR SHARE`;
    const db = tx ?? prisma;
    await loadToolActor(actionActor, db);
    await checkNewClient(args, db);
    return { newClient: true };
  },
  async buildPreview(args, _snapshot, actionActor) {
    const { actor } = await loadToolActor(actionActor, prisma);
    return {
      title: "Создать клиента",
      was: {},
      becomes: {
        Имя: plainField(phoneSafeText(args.fullName, actor.canViewPhone)),
        Телефон: maskClientPhone(args.phone),
        Карточка: CLIENT_KIND_LABELS[args.kind],
        Источник: CLIENT_SOURCE_LABELS[args.source],
        ...(args.requirementsNotes ? { Заметка: plainField(phoneSafeText(args.requirementsNotes, actor.canViewPhone)) } : {}),
      },
    };
  },
  async execute(args, actionActor, { tx }) {
    if (!tx) throw new Error("create_client requires the confirmation transaction");
    const { actor, agentName } = await loadToolActor(actionActor, tx);
    try {
      // Serialize equivalent phone formats and align with conversation phone capture.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`client-phone:${fullPhoneIdentity(args.phone)}`}))`;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`client-phone-tail:${phoneTail(args.phone)}`}))`;
      await checkNewClient(args, tx);
      const now = new Date();
      const created = await tx.client.create({
        data: {
          ...args,
          assignedAgentId: actor.id,
          assignedAt: now,
          acceptedAt: now,
          assignReason: SELF_CREATED_ASSIGN_REASON,
          ...(args.kind === "BUYER" ? { requirementsFieldsKind: "BUYER" } : {}),
        },
        select: { id: true, shortId: true },
      });
      const audit = { agentId: actor.id, agentName, entityType: "Client", entityId: created.id };
      await tx.auditLog.createMany({ data: [
        {
          ...audit,
          action: "CLIENT_CREATE",
          meta: { source: "assistant.create_client", shortId: created.shortId, kind: args.kind, assignedAgentId: actor.id },
        },
        {
          ...audit,
          action: "CLIENT_AGENT_CHANGE",
          meta: { source: "assistant.create_client", from: null, to: actor.id, reason: "Карточка создана и сразу назначена" },
        },
      ] });
      return {
        result: { clientId: created.id, shortId: created.shortId, href: `/clients/${created.shortId}` },
        audit: { entityType: "Client", entityId: created.id },
      };
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") throw duplicate();
      throw error;
    }
  },
};

export const createClientTool: AssistantWriteToolPlugin = {
  name: "create_client",
  level: "C",
  allowed: privateWriteAllowed,
  statusPhrase: "Готовлю карточку клиента…",
  description:
    "Создать нового клиента на имя сотрудника, который просит. Только прямая просьба самого сотрудника. " +
    "Нужны имя, продиктованный или написанный телефон и откуда пришёл клиент. Не подставляй источник TELEGRAM из-за того, что сотрудник пишет боту. " +
    "Если чего-то не хватает, задай один короткий вопрос обо всех недостающих данных. Не додумывай цифры, имя или источник. " +
    "Если продажа прямо не указана, карточка покупателя. Пожелания запиши только со слов сотрудника. Перед созданием покажи карточку на подтверждение.",
  parameters: {
    type: "object",
    properties: {
      fullName: { type: "string", description: "Имя клиента как сказал сотрудник" },
      phone: { type: "string", description: "Продиктованный или написанный номер клиента" },
      source: { type: "string", enum: [...CLIENT_SOURCES], description: "Источник клиента, указанный сотрудником" },
      kind: { type: "string", enum: ["BUYER", "SELLER"], description: "Покупатель или продавец" },
      requirementsNotes: { type: "string", description: "Что ищет клиент или другие указанные пожелания" },
    },
    required: ["fullName", "phone", "source"],
  },
  executor: asPluginExecutor(executor),
};
