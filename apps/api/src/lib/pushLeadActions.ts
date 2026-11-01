import crypto from "node:crypto";
import type { PushPayload } from "@royal-home/shared";
import { prisma } from "../db.js";
import { sendPushToAgent } from "../push.js";
import { publishLeadPending } from "./livePublish.js";
import { PUSH_ACTION_TTL_MINUTES } from "./settingsConstants.js";

/**
 * Кнопки «Принять»/«Отклонить» прямо в шторке уведомлений (решение владельца
 * 11.08.2026).
 *
 * ГЛАВНАЯ ТРУДНОСТЬ. Service worker живёт вне вкладки: у него нет JWT и нет
 * доступа к хранилищу приложения, поэтому нажатие кнопки не может обратиться к
 * API от имени агента. Право приезжает вместе с уведомлением — одноразовым
 * маркером внутри зашифрованного payload (Web Push шифрует тело сквозным ключом
 * подписки, сервер доставки его не читает).
 *
 * ПОЧЕМУ ЭТО НЕ ВТОРОЙ ПАРОЛЬ. Маркер: одноразовый (сжигается атомарным
 * updateMany), привязан к паре «агент + клиент», разрешает ровно два действия по
 * ровно одному лиду, живёт минуты из Настроек. Предельный ущерб при утечке —
 * приём или отклонение одного лида, и оба обратимы руками руководителя. В базе
 * лежит только SHA-256: дамп базы действующих маркеров не даёт.
 *
 * iPhone отдельной ветки не требует: Safari поле `actions` игнорирует, уведомление
 * остаётся обычным, нажатие открывает карточку — ровно то, что владелец и просил.
 */

/** Срок жизни маркера действия в уведомлении. */
/** Константа с 01.11.2026 (lib/settingsConstants.ts), колонка Settings не читается. */
export const DEFAULT_PUSH_ACTION_TTL_MINUTES = PUSH_ACTION_TTL_MINUTES;

export interface PushActionRules {
  enabled: boolean;
  ttlMinutes: number;
}

export async function loadPushActionRules(): Promise<PushActionRules> {
  const s = await prisma.settings.findUnique({
    where: { id: "singleton" },
    select: { pushLeadActionsEnabled: true },
  });
  return {
    enabled: s?.pushLeadActionsEnabled ?? true,
    ttlMinutes: DEFAULT_PUSH_ACTION_TTL_MINUTES,
  };
}

export function hashActionToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

/** Выдать маркер на одно действие по лиду. Возвращает сам маркер — он больше нигде не появится. */
export async function issueLeadActionToken(
  agentId: string,
  clientId: string,
  ttlMinutes: number
): Promise<string> {
  const token = crypto.randomBytes(32).toString("base64url");
  await prisma.pushActionToken.create({
    data: {
      tokenHash: hashActionToken(token),
      agentId,
      clientId,
      expiresAt: new Date(Date.now() + ttlMinutes * 60_000),
    },
  });
  return token;
}

export type ConsumeOutcome =
  | { ok: true; agentId: string; clientId: string }
  | { ok: false; reason: "unknown" | "expired" | "used" };

/**
 * Сжечь маркер и вернуть, кому и по какому клиенту он давал право.
 *
 * Сжигание — атомарный `updateMany` по `usedAt: null`, а не «прочитал → записал»:
 * одно и то же уведомление доставляется на ВСЕ устройства агента, и два нажатия
 * подряд — обычное дело, а не редкая гонка.
 */
export async function consumeLeadActionToken(token: string): Promise<ConsumeOutcome> {
  const row = await prisma.pushActionToken.findUnique({
    where: { tokenHash: hashActionToken(token) },
    select: { id: true, agentId: true, clientId: true, expiresAt: true, usedAt: true },
  });
  if (!row) return { ok: false, reason: "unknown" };
  if (row.usedAt) return { ok: false, reason: "used" };
  if (row.expiresAt.getTime() <= Date.now()) return { ok: false, reason: "expired" };

  const burned = await prisma.pushActionToken.updateMany({
    where: { id: row.id, usedAt: null },
    data: { usedAt: new Date() },
  });
  if (burned.count !== 1) return { ok: false, reason: "used" };

  return { ok: true, agentId: row.agentId, clientId: row.clientId };
}

/**
 * Push о новом лиде — единственная точка, через которую он уходит.
 *
 * Раньше `sendPushToAgent` с текстом «Новый лид» вызывался из пяти мест (создание
 * вручную, лид из канала, передача после отказа, снятие за несовершённый звонок,
 * утренняя волна). Кнопки, добавленные в одном из них, в остальных четырёх молча
 * не появились бы — поэтому выдача маркера и сборка `actions` живут здесь, а не
 * в каждом вызывающем.
 *
 * Отказ выдать маркер не отменяет уведомление: агент должен узнать о лиде даже
 * тогда, когда запись маркера не удалась — просто без кнопок.
 */
export async function sendLeadPush(
  agentId: string,
  clientId: string,
  input: Omit<PushPayload, "actions" | "actionToken" | "kind">
): Promise<number> {
  // ЖИВОЕ СОБЫТИЕ «лид ждёт принятия» — ЗДЕСЬ, а не в пяти вызывающих.
  //
  // Ровно по той же причине, по которой здесь собираются кнопки (см. шапку
  // функции): путей, которыми лид предлагается сотруднику, пять — назначение
  // вручную, лид из канала, передача после отказа, снятие за несовершённый
  // звонок, утренняя волна, — и publish, добавленный в одном из них, в
  // остальных четырёх молча не появился бы. Все они зовут sendLeadPush уже
  // ПОСЛЕ коммита своей транзакции, поэтому событие не может пережить откат.
  publishLeadPending(clientId, agentId);

  const payload: PushPayload = { ...input, kind: "lead" };
  const rules = await loadPushActionRules();
  if (!rules.enabled) return sendPushToAgent(agentId, payload);

  let actionToken: string | undefined;
  try {
    actionToken = await issueLeadActionToken(agentId, clientId, rules.ttlMinutes);
  } catch (err) {
    console.error("[push] маркер действия:", err instanceof Error ? err.message : err);
  }

  if (!actionToken) return sendPushToAgent(agentId, payload);

  return sendPushToAgent(agentId, {
    ...payload,
    actionToken,
    actions: [
      { action: "lead-accept", title: "✅ Принять" },
      { action: "lead-decline", title: "❌ Отклонить" },
    ],
  });
}
