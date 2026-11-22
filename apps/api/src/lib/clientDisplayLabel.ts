import { clientNameParts, clientDisplayName, type ClientDisplayNameInput } from "@royal-home/shared";
import { prisma } from "../db.js";
import { CLIENT_PROFILE_HIDDEN, decideClientCardAccess } from "./clientCardAccess.js";
import { loadClientAnchorFacts } from "./sellerPropertyAnchor.js";
import { clientNamePhoneSafe } from "./clientPhone.js";
import { scopeToOwnAgent } from "../auth/middleware.js";
import type { Request } from "express";

/**
 * ИМЯ КЛИЕНТА ДЛЯ ТЕХ, КТО ПОЛУЧИЛ КЛИЕНТА «ОГРЫЗКОМ» (22.11.2026).
 *
 * Список клиентов и карточка считают `clientDisplayName` из полной карточки. А
 * чаты, звонки, главная, поиск, уведомления получают клиента урезанным —
 * `{ id, shortId, fullName }` — и до 22.11 печатали сырое имя: «Покупатель
 * ПК-000925», «Клиент ПК-0021». Эта функция — вторая дверь той же функции из
 * @royal-home/shared: по id достаёт нужные поля одним запросом, применяет ТОТ ЖЕ
 * замок приёма заявки (до «Принять» требований и объекта интереса не видно) и
 * считает имя тем же правилом. Телефон и канал по праву смотрящего не показываем.
 */
export interface ClientLabelViewer {
  /** Результат scopeToOwnAgent: пусто у того, кто видит всех. */
  ownAgentId?: string;
  /** Право `clients.viewOrigin`: без него «из WhatsApp» в заглушке не пишем. */
  canSeeOrigin: boolean;
}

export interface ClientLabel {
  displayName: string;
  name: string;
  anchor: string | null;
  code: string | null;
}

const MAX_IDS = 500;

export async function loadClientDisplayLabels(
  clientIds: readonly (string | null | undefined)[],
  viewer: ClientLabelViewer,
): Promise<Map<string, ClientLabel>> {
  const ids = [...new Set(clientIds.filter((x): x is string => !!x))].slice(0, MAX_IDS);
  const out = new Map<string, ClientLabel>();
  if (ids.length === 0) return out;

  const rows = await prisma.client.findMany({
    where: { id: { in: ids } },
    select: {
      id: true, shortId: true, fullName: true, kind: true, source: true, address: true,
      desiredRooms: true, budgetMax: true, currency: true, desiredDistrict: { select: { name: true } },
      requestedPropertyId: true, matchedPropertyId: true,
      assignedAgentId: true, lastAgentId: true, acceptedAt: true,
    },
  });
  const open = rows.filter((c) => decideClientCardAccess(viewer.ownAgentId, c, false) === "full");
  const facts = await loadClientAnchorFacts(open);
  for (const c of rows) {
    const full = decideClientCardAccess(viewer.ownAgentId, c, false) === "full";
    const input: ClientDisplayNameInput = {
      ...c,
      ...(full ? {} : CLIENT_PROFILE_HIDDEN),
      address: full ? c.address : null,
      source: viewer.canSeeOrigin ? c.source : null,
    };
    const parts = clientNameParts(input, full ? facts.get(c.id) : undefined);
    out.set(c.id, {
      displayName: clientDisplayName(input, full ? facts.get(c.id) : undefined),
      name: parts.name, anchor: parts.anchor, code: parts.code,
    });
  }
  return out;
}

/** Смотрящий из запроса: область «только свои» и право на канал. */
export function viewerFromRequest(req: Pick<Request, "agent">): ClientLabelViewer {
  return { ownAgentId: scopeToOwnAgent(req), canSeeOrigin: !!req.agent?.can("clients.viewOrigin") };
}

/**
 * КРАТКАЯ ССЫЛКА НА КЛИЕНТА В ОТВЕТЕ (звонок, дело, сделка…): `{ id, shortId, fullName }`
 * плюс `displayName` — «Имя · Якорь» из общей двери. И `fullName`, и `displayName`
 * закрываются по праву на телефон (имя незнакомого звонившего несёт номер).
 */
export function presentClientRef<T extends { id: string; fullName: string }>(
  client: T | null | undefined,
  labels: Map<string, ClientLabel>,
  canSeePhone: boolean,
): (T & { displayName: string }) | null {
  if (!client) return null;
  const shown = labels.get(client.id)?.displayName ?? clientDisplayName({ fullName: client.fullName });
  return {
    ...client,
    fullName: clientNamePhoneSafe(client.fullName, canSeePhone),
    displayName: clientNamePhoneSafe(shown, canSeePhone),
  };
}
