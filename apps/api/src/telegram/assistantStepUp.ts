import { prisma } from "../db.js";
import { decryptSecretSafe } from "../crypto.js";
import { matchTotpStep } from "../lib/totp.js";
import { logAgentAudit } from "../lib/audit.js";
import { getAssistantActionExecutor } from "../lib/assistantActions.js";

/**
 * ПОДТВЕРЖДЕНИЕ КОДОМ GOOGLE AUTHENTICATOR В ЛИЧКЕ С ПОМОЩНИЦЕЙ (10.11.2026).
 *
 * Владелец: «все возможности директора вплоть от создания или удаления работников
 * и изменения прав». В CRM эти действия стоят за подтверждением личности
 * (`requireElevation`, lib/stepUp.ts) — значит и из Telegram их нельзя исполнить
 * одним нажатием кнопки: украденный или оставленный открытым телефон директора
 * иначе раздавал бы права.
 *
 * ПРАВИЛА (каждое — тест в tests/assistant-staff-rights.test.ts):
 *  - только код Google Authenticator из 6 цифр, проверенный той же функцией, что
 *    `/auth/step-up` (lib/totp.ts). ПАРОЛЬ И СМС-КОД ЗДЕСЬ НЕ ПРИНИМАЮТСЯ НИКОГДА:
 *    пароля в CRM нет, а СМС приходит на тот же телефон, где открыт Telegram;
 *  - нет Authenticator — честный отказ (брокер не создаёт карточку, TOTP_REQUIRED);
 *  - код одноразовый: принятый 30-секундный шаг пишется в
 *    `Agent.assistantTotpLastStep` условной записью, тот же или более ранний шаг
 *    второй раз не проходит (и при гонке двух сообщений);
 *  - пять неверных кодов за 15 минут — подтверждение закрыто на 15 минут, карточка
 *    отменяется; счёт ведётся в базе (AssistantStepUpChallenge.attempts) и
 *    переживает перезапуск;
 *  - сообщение с кодом удаляется из чата сразу, до проверки (и при ошибке тоже);
 *  - один код — одно исполнение одной карточки: «подтверждено» не запоминается
 *    ни на минуту, следующая карточка снова спросит код;
 *  - срок ожидания кода — 3 минуты; «Отмена» на карточке гасит и ожидание.
 */

export const STEP_UP_CODE_TTL_MS = 3 * 60_000;
export const STEP_UP_MAX_FAILURES = 5;
export const STEP_UP_LOCK_WINDOW_MS = 15 * 60_000;

export type StepUpLanguage = "ru" | "tg";

const TEXT = {
  prompt: {
    ru: "🔐 Введите 6 цифр из Google Authenticator. Сообщение с кодом сразу удалю из чата.",
    tg: "🔐 Шаш рақами кодро аз Google Authenticator нависед. Паёми кодро баъди санҷиш аз чат нест мекунам.",
  },
  wrong: {
    ru: (left: number) => `✖️ Код не подошёл. Осталось попыток: ${left}.`,
    tg: (left: number) => `✖️ Код дуруст нест. Боз ${left} бор кӯшиш карда метавонед.`,
  },
  replay: {
    ru: "✖️ Этот код уже использован. Дождитесь следующего в приложении.",
    tg: "✖️ Ин код аллакай истифода шуд. Коди навбатиро аз барнома нависед.",
  },
  locked: {
    ru: "⛔ Слишком много неверных кодов. Подтверждение закрыто на 15 минут, карточка отменена.",
    tg: "⛔ Кодҳои нодуруст бисёр шуд. Тасдиқ 15 дақиқа баста аст, корт бекор шуд.",
  },
  noTotp: {
    ru: "Сначала включите Google Authenticator в CRM (Профиль → Безопасность). Без него такие изменения из Telegram не делаю.",
    tg: "Аввал дар CRM Google Authenticator-ро фаъол кунед (Профил → Бехатарӣ). Бе он ин корро аз Telegram намекунам.",
  },
} as const;

export function stepUpText(key: "prompt" | "replay" | "locked" | "noTotp", language: StepUpLanguage): string {
  return TEXT[key][language];
}

/** Нужна ли карточке проверка кодом: хотя бы одно действие связки стоит за step-up. */
export function bundleNeedsStepUp(actions: readonly { tool: string }[]): boolean {
  return actions.some((action) => getAssistantActionExecutor(action.tool)?.stepUp === true);
}

/** Сколько неверных кодов у сотрудника за окно блокировки (по всем ожиданиям). */
async function recentFailures(agentId: string, now: Date): Promise<number> {
  const rows = await prisma.assistantStepUpChallenge.aggregate({
    where: { agentId, createdAt: { gte: new Date(now.getTime() - STEP_UP_LOCK_WINDOW_MS) } },
    _sum: { attempts: true },
  });
  return rows._sum.attempts ?? 0;
}

export type StartStepUpOutcome =
  | { kind: "started"; challengeId: string }
  | { kind: "no_totp" }
  | { kind: "locked" };

/**
 * «Подтвердить» на карточке со step-up: вместо исполнения — ожидание кода.
 * Прежнее ожидание в этом чате гасится (код относится к последней нажатой карточке).
 */
export async function startStepUpChallenge(input: {
  agentId: string;
  chatId: string;
  bundleId: string;
  cardMessageId?: number;
  language: StepUpLanguage;
  now?: Date;
}): Promise<StartStepUpOutcome> {
  const now = input.now ?? new Date();
  const agent = await prisma.agent.findUnique({ where: { id: input.agentId }, select: { totpEnabled: true, totpSecret: true } });
  if (!agent?.totpEnabled || !agent.totpSecret) return { kind: "no_totp" };
  if ((await recentFailures(input.agentId, now)) >= STEP_UP_MAX_FAILURES) return { kind: "locked" };
  const challenge = await prisma.$transaction(async (tx) => {
    await tx.assistantStepUpChallenge.updateMany({
      where: { chatId: input.chatId, status: "PENDING" },
      data: { status: "CANCELLED", closedAt: now },
    });
    return tx.assistantStepUpChallenge.create({
      data: {
        agentId: input.agentId,
        chatId: input.chatId,
        bundleId: input.bundleId,
        cardMessageId: input.cardMessageId ?? null,
        language: input.language,
        expiresAt: new Date(now.getTime() + STEP_UP_CODE_TTL_MS),
      },
    });
  });
  return { kind: "started", challengeId: challenge.id };
}

export async function rememberStepUpPrompt(challengeId: string, promptMessageId: number | undefined): Promise<void> {
  if (!promptMessageId) return;
  await prisma.assistantStepUpChallenge.updateMany({ where: { id: challengeId }, data: { promptMessageId } });
}

/** «Отмена» на карточке: ожидание кода по ней больше не нужно. */
export async function cancelStepUpForBundle(bundleId: string, now = new Date()): Promise<void> {
  await prisma.assistantStepUpChallenge.updateMany({
    where: { bundleId, status: "PENDING" },
    data: { status: "CANCELLED", closedAt: now },
  });
}

/** Шесть цифр, допускаются пробел или дефис посередине («123 456»). Иначе — не код. */
export function parseStepUpCode(text: string | undefined): string | null {
  const flat = (text ?? "").trim().replace(/[\s-]/g, "");
  return /^\d{6}$/.test(flat) ? flat : null;
}

export interface PendingStepUp {
  id: string;
  agentId: string;
  chatId: string;
  bundleId: string;
  cardMessageId: number | null;
  promptMessageId: number | null;
  language: StepUpLanguage;
}

/** Живое ожидание кода в этом чате у этого сотрудника. */
export async function findPendingStepUp(chatId: string, agentId: string, now = new Date()): Promise<PendingStepUp | null> {
  const row = await prisma.assistantStepUpChallenge.findFirst({
    where: { chatId, agentId, status: "PENDING", expiresAt: { gt: now } },
    orderBy: { createdAt: "desc" },
  });
  if (!row) return null;
  return {
    id: row.id,
    agentId: row.agentId,
    chatId: row.chatId,
    bundleId: row.bundleId,
    cardMessageId: row.cardMessageId,
    promptMessageId: row.promptMessageId,
    language: row.language === "tg" ? "tg" : "ru",
  };
}

export type VerifyStepUpOutcome =
  | { kind: "passed" }
  | { kind: "wrong"; left: number; message: string }
  | { kind: "replay"; message: string }
  | { kind: "locked"; message: string }
  | { kind: "no_totp"; message: string }
  | { kind: "gone" };

async function closeChallenge(id: string, status: "LOCKED" | "CANCELLED", now: Date) {
  await prisma.assistantStepUpChallenge.updateMany({ where: { id, status: "PENDING" }, data: { status, closedAt: now } });
}

/** Неверная попытка: +1 к счёту; на пятой — блокировка. */
async function registerFailure(challenge: PendingStepUp, now: Date, reason: "wrong" | "replay"): Promise<VerifyStepUpOutcome> {
  const bumped = await prisma.assistantStepUpChallenge.updateMany({
    where: { id: challenge.id, status: "PENDING" },
    data: { attempts: { increment: 1 } },
  });
  if (bumped.count === 0) return { kind: "gone" };
  logAgentAudit(challenge.agentId, "ASSISTANT_TOTP_FAILED", "Agent", challenge.agentId, { source: "assistant", reason, bundleId: challenge.bundleId });
  const failures = await recentFailures(challenge.agentId, now);
  if (failures >= STEP_UP_MAX_FAILURES) {
    await closeChallenge(challenge.id, "LOCKED", now);
    logAgentAudit(challenge.agentId, "ASSISTANT_TOTP_LOCKED", "Agent", challenge.agentId, { source: "assistant", failures });
    return { kind: "locked", message: TEXT.locked[challenge.language] };
  }
  const left = STEP_UP_MAX_FAILURES - failures;
  return reason === "replay"
    ? { kind: "replay", message: TEXT.replay[challenge.language] }
    : { kind: "wrong", left, message: TEXT.wrong[challenge.language](left) };
}

/**
 * Проверка присланного кода. Ничего не исполняет: «passed» значит, что ожидание
 * закрыто ровно один раз (условная запись PENDING → PASSED) и шаг кода сгорел.
 */
export async function verifyStepUpCode(challenge: PendingStepUp, code: string, now = new Date()): Promise<VerifyStepUpOutcome> {
  if ((await recentFailures(challenge.agentId, now)) >= STEP_UP_MAX_FAILURES) {
    await closeChallenge(challenge.id, "LOCKED", now);
    return { kind: "locked", message: TEXT.locked[challenge.language] };
  }
  const agent = await prisma.agent.findUnique({
    where: { id: challenge.agentId },
    select: { phone: true, isActive: true, totpEnabled: true, totpSecret: true },
  });
  const secret = agent?.totpEnabled && agent.totpSecret ? decryptSecretSafe(agent.totpSecret) : null;
  if (!agent?.isActive || !secret) {
    await closeChallenge(challenge.id, "CANCELLED", now);
    return { kind: "no_totp", message: TEXT.noTotp[challenge.language] };
  }
  // Та же функция, что у /auth/step-up: метка — телефон сотрудника, окно ±1 шаг.
  const step = matchTotpStep(agent.phone, secret, code, now.getTime());
  if (step === null) return registerFailure(challenge, now, "wrong");
  // Одноразовость: шаг принимается, только если он новее последнего принятого.
  const burned = await prisma.agent.updateMany({
    where: { id: challenge.agentId, OR: [{ assistantTotpLastStep: null }, { assistantTotpLastStep: { lt: step } }] },
    data: { assistantTotpLastStep: step },
  });
  if (burned.count === 0) return registerFailure(challenge, now, "replay");
  const claimed = await prisma.assistantStepUpChallenge.updateMany({
    where: { id: challenge.id, status: "PENDING", expiresAt: { gt: now } },
    data: { status: "PASSED", closedAt: now },
  });
  if (claimed.count === 0) return { kind: "gone" };
  logAgentAudit(challenge.agentId, "ASSISTANT_TOTP_PASSED", "Agent", challenge.agentId, { source: "assistant", bundleId: challenge.bundleId });
  return { kind: "passed" };
}
