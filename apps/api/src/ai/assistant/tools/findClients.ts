import { z } from "zod";
import {
  CLIENT_SOURCES,
  CLIENT_STATUSES,
  clientKindLabel,
  formatClientCode,
  formatClientName,
  type PermissionId,
} from "@royal-home/shared";
import { prisma } from "../../../db.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import {
  AGENT_CLIENT_KIND_SCOPE,
  buildClientTextSearchAnd,
  clientFieldFilters,
  pendingDeleteHiddenClientIds,
} from "../../../lib/clientSearchWhere.js";
import { clientNamePhoneSafe, clientPhoneFor, phoneSafeText } from "../../../lib/clientPhone.js";
import { findActiveAgentByName } from "../../../lib/agentNameLookup.js";
import { findDistrictIdByName } from "../../../lib/districtLookup.js";
import { dushanbeDateString } from "../../../lib/dushanbeTime.js";
import { fuzzyClientIds } from "../../../lib/fuzzySearch.js";
import { withHiddenOrigin } from "../../../lib/clientOrigin.js";
import { canSeeTrashedClientContacts, clientTrashScopeFor } from "../../../lib/trashAccess.js";
import { trashActorOf } from "../actor.js";
import { safeField } from "./safeField.js";
import type { AssistantReadToolPlugin } from "./types.js";

/**
 * find_clients — ПОИСК КЛИЕНТОВ ПО ЛЮДЯМ, РАЙОНУ И СЛОВАМ (П3, группа «read»).
 *
 * Расширяет `search_clients`: «клиенты агента Сайфуллоев, связанные с Пахтакор» —
 * `agentName` находит сотрудника, `q` ищется по ФИО/адресу/«заметкам»/желаемому району.
 * Условие поиска строит `lib/clientSearchWhere.ts` — то же, что у GET /clients, чтобы
 * чат и список не разошлись. Права:
 *  - рядовой агент (нет clients.viewAll) видит только СВОИХ и ПРИНЯТЫХ клиентов, только
 *    покупателей/продавцов, как его список в REST; чужого агента фильтром не задать;
 *  - Корзина — только по scope=trash/both и по общему правилу (lib/trashAccess.ts, 07.11.2026):
 *    руководство (archive.view) видит всю, остальные — только свои удалённые карточки, в общей
 *    группе Telegram — никто; карточка с висящей заявкой на удаление — тем, у кого нет
 *    clients.delete (как в списке);
 *  - телефон — по clients.viewPhone и только у принятого лида (как search_clients), поиск
 *    по номеру и нику соцсети — только тому, кому они видны.
 */
const MAX_LIMIT = 20;
const DEFAULT_LIMIT = 10;

/** Слова «я сам» вместо имени агента: «me», «я», «мои», «мне», «ман», «худам» (таджикский). */
const SELF_AGENT_WORDS = new Set(["me", "my", "mine", "myself", "self", "я", "мои", "мой", "моих", "мне", "меня", "сам", "ман", "худам", "аз они ман"]);
export function isSelfAgentName(name: string): boolean {
  return SELF_AGENT_WORDS.has(name.trim().toLowerCase().replace(/[.!?]+$/u, ""));
}

const argsSchema = z.object({
  q: z.string().trim().max(200).optional(),
  agentName: z.string().trim().max(100).optional(),
  districtName: z.string().trim().max(100).optional(),
  status: z.enum(CLIENT_STATUSES).optional(),
  source: z.enum(CLIENT_SOURCES).optional(),
  hot: z.boolean().optional(),
  kind: z.enum(["BUYER", "SELLER"]).optional(),
  scope: z.enum(["live", "trash", "both"]).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
});

const parameters = {
  type: "object",
  properties: {
    q: {
      type: "string",
      description:
        "Слова поиска: имя, номер карточки (ПК-000042 или 42), адрес, район, пожелания клиента из заметок. " +
        "Каждое слово должно найтись; порядок слов не важен. Телефон ищется только тем, кому он виден.",
    },
    agentName: { type: "string", description: "Имя или фамилия агента, за которым закреплены клиенты («Сайфуллоев»); «мои клиенты» — передай «me»" },
    districtName: { type: "string", description: "Район, который клиент ищет («Сино», «Шоҳмансур»)" },
    status: { type: "string", enum: [...CLIENT_STATUSES] },
    source: { type: "string", enum: [...CLIENT_SOURCES] },
    hot: { type: "boolean", description: "true — только горячие клиенты" },
    kind: { type: "string", enum: ["BUYER", "SELLER"], description: "BUYER — покупатели, SELLER — продавцы (собственники)" },
    scope: {
      type: "string",
      enum: ["live", "trash", "both"],
      description:
        "live — живые, trash — Корзина удалённых клиентов, both — оба. Руководство видит всю Корзину клиентов, агент — только свои " +
        "удалённые карточки; в общей группе Telegram Корзина клиентов закрыта.",
    },
    limit: { type: "number", description: `Сколько вернуть (до ${MAX_LIMIT}, по умолчанию ${DEFAULT_LIMIT})` },
  },
};

export const findClientsTool: AssistantReadToolPlugin = {
  name: "find_clients",
  level: "A",
  description:
    "Найти клиентов по сочетанию условий: слова (имя, адрес, район, пожелания), агент, район поиска, статус, " +
    "источник, горячие. Зови, когда просят подборку («клиенты агента X, связанные с районом Y», «горячие клиенты " +
    "из Instagram»). Для простого «найди клиента по имени/номеру» хватает search_clients. НЕ зови для объектов " +
    "(find_property) и для одной известной карточки (get_client_card). Возвращает до 20 клиентов со ссылками.",
  parameters,
  statusPhrase: "Ищу клиентов…",
  async run(rawArgs, { actor }) {
    const parsed = argsSchema.safeParse(rawArgs);
    if (!parsed.success) return { error: "Неверные параметры поиска клиентов" };
    const args = parsed.data;
    const ownScope = actor.canViewAllClients ? undefined : actor.id;
    const has = (permission: PermissionId) => actor.permissions?.has(permission) ?? false;

    // Агент по имени — общий поиск сотрудника (lib/agentNameLookup.ts, тот же, что у передачи
    // клиента): ровно один активный — он; не нашёлся или несколько — отказ со списком, за человека
    // не выбираем и по всему агентству вместо «того самого» не отвечаем.
    let agentIds: string[] | undefined;
    let agentsMatched: string[] | undefined;
    if (args.agentName && isSelfAgentName(args.agentName)) {
      // «Мои клиенты»: модель передаёт «me», «я», «мои» — это сам спрашивающий (журнал прода
      // 05–07.11: «me» давало ошибку, и модель отдавала общий список вместо своих).
      agentIds = [actor.id];
    } else if (args.agentName) {
      const match = await findActiveAgentByName(args.agentName);
      if (match.kind === "none") return { error: `Сотрудника «${args.agentName}» нет среди активных — уточните имя` };
      if (match.kind === "many") {
        return {
          error: `Под «${args.agentName}» подходят несколько сотрудников — уточните`,
          candidates: match.candidates.map((c) => c.fullName),
        };
      }
      agentIds = [match.agent.id];
      agentsMatched = [match.agent.fullName];
      // Рядовой агент чужих клиентов не видит: фильтр по другому агенту — пустой ответ, а не обход.
      if (ownScope && !agentIds.includes(ownScope)) {
        return { total: 0, shown: 0, items: [], agentsMatched, note: "Вам доступны только ваши клиенты" };
      }
    }

    let districtId: string | undefined;
    if (args.districtName) {
      districtId =
        (await findDistrictIdByName(args.districtName)) ??
        (
          await prisma.district.findFirst({
            where: { name: { contains: args.districtName, mode: "insensitive" } },
            select: { id: true },
          })
        )?.id;
      if (!districtId) return { error: `Района «${args.districtName}» нет в справочнике — уточните название` };
    }

    // Корзина клиентов — общее правило (lib/trashAccess.ts): руководство (право «Архив») — вся,
    // остальные — только СВОИ удалённые карточки, в общей группе Telegram — никакая. Проверка
    // здесь, на сервере.
    const trashScope = clientTrashScopeFor(trashActorOf(actor));
    const trashContacts = canSeeTrashedClientContacts(trashActorOf(actor));
    const wantedScope = args.scope ?? "live";
    if (wantedScope === "trash" && trashScope === "none") {
      return { error: "Удалённых клиентов в общей группе не показываю — спросите меня в личном чате." };
    }
    const scope = trashScope === "none" ? "live" : wantedScope;
    const where: Prisma.ClientWhereInput = {
      ...(scope === "live" ? { deletedAt: null } : scope === "trash" ? { deletedAt: { not: null } } : {}),
      ...clientFieldFilters({ kind: args.kind, status: args.status, source: args.source, districtId, hot: args.hot }),
    };
    const and: Prisma.ClientWhereInput[] = [];
    // Не руководство: из Корзины — только карточки, закреплённые за самим спросившим.
    if (trashScope === "own" && scope !== "live") and.push({ OR: [{ deletedAt: null }, { assignedAgentId: actor.id }] });
    if (ownScope) {
      // Свои, принятые, только покупатели/продавцы — как личный список агента.
      where.assignedAgentId = ownScope;
      where.acceptedAt = { not: null };
      where.OR = AGENT_CLIENT_KIND_SCOPE;
    } else if (agentIds) {
      where.assignedAgentId = { in: agentIds };
    }
    const hiddenIds = await pendingDeleteHiddenClientIds({ ownAgentId: ownScope, canDelete: has("clients.delete") });
    if (hiddenIds.length > 0) where.id = { notIn: hiddenIds };
    const textAnd = await buildClientTextSearchAnd(args.q, {
      canSearchByPhone: actor.canViewPhone,
      canSearchByOrigin: has("clients.viewOrigin"),
    });
    // Условие Корзины держится и в запасном проходе по опечаткам ниже (он заменяет только слова;
    // сам fuzzyClientIds сейчас ищет лишь живых, но условие не должно зависеть от этого).
    const trashAnd = [...and];
    if (textAnd) and.push(...textAnd);
    if (and.length > 0) where.AND = and;

    const include = {
      desiredDistrict: { select: { name: true } },
      assignedAgent: { select: { fullName: true } },
    } satisfies Prisma.ClientInclude;
    const find = (w: Prisma.ClientWhereInput) =>
      Promise.all([
        prisma.client.findMany({
          where: w,
          include,
          orderBy: [{ lastContactAt: "desc" }, { id: "asc" }],
          take: args.limit,
        }),
        prisma.client.count({ where: w }),
      ]);

    let [rows, total] = await find(where);
    let approximate = false;
    // Опечатка в имени («Сайфулоев»): запасной проход по триграммам, как у списка клиентов.
    if (total === 0 && args.q && textAnd) {
      const fuzzyIds = await fuzzyClientIds(args.q);
      if (fuzzyIds.length > 0) {
        [rows, total] = await find({ ...where, AND: [...trashAnd, { id: { in: fuzzyIds } }] });
        approximate = total > 0;
      }
    }

    const canSeeOrigin = actor.permissions?.has("clients.viewOrigin") ?? false;
    return {
      total,
      shown: rows.length,
      searched: {
        scope,
        ...(trashScope === "own" && scope !== "live" ? { trashOwnOnly: "Из Корзины показаны только ваши карточки" } : {}),
        ...(trashScope === "none" && wantedScope === "both"
          ? { trashNotChecked: "Удалённых клиентов в общей группе не смотрела — это в личном чате" }
          : {}),
      },
      ...(agentsMatched ? { agentsMatched } : {}),
      ...(approximate ? { note: "Точных совпадений нет — показаны похожие по написанию" } : {}),
      items: rows.map((raw) => {
        // Источник и ник — по правилу REST (lib/clientOrigin.ts): без clients.viewOrigin
        // источник скрыт, имя-ник заменено — как в списке клиентов.
        const c = withHiddenOrigin(raw, canSeeOrigin);
        // Удалённый клиент: хозяин-агент видит карточку без телефона и других контактов, контакты —
        // только руководству с «Архивом» (решение владельца 07.11.2026, lib/trashAccess.ts).
        const contacts = actor.canViewPhone && (c.deletedAt === null || trashContacts);
        return {
          id: c.id,
          code: formatClientCode(c.shortId, c.kind),
          href: `/clients/${c.shortId}`,
          // Имя — с ролью (как на экранах) и без номера внутри; всё присланное — в границах «данные».
          name: safeField(clientNamePhoneSafe(formatClientName(c), contacts)),
          kind: clientKindLabel(c),
          status: c.status,
          source: c.source,
          phone: c.deletedAt !== null && !trashContacts ? null : clientPhoneFor(c.phone, contacts && c.acceptedAt !== null),
          pendingAcceptance: c.acceptedAt === null,
          agent: c.assignedAgent?.fullName ?? null,
          desiredDistrict: c.desiredDistrict?.name ?? null,
          desiredRooms: c.desiredRooms,
          budgetMin: c.budgetMin ? Number(c.budgetMin) : null,
          budgetMax: c.budgetMax ? Number(c.budgetMax) : null,
          currency: c.currency,
          address: c.deletedAt !== null && !trashContacts ? null : safeField(phoneSafeText(c.address, contacts), 200),
          notes: safeField(phoneSafeText(c.requirementsNotes, contacts), 200),
          hot: c.hotSince !== null,
          inTrash: c.deletedAt !== null,
          ...(c.deletedAt ? { deletedAt: dushanbeDateString(c.deletedAt) } : {}),
          lastContact: dushanbeDateString(c.lastContactAt),
        };
      }),
    };
  },
};
