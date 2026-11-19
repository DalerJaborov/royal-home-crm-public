/**
 * МОНТАЖЁР УПРАВЛЯЕТ ОЧЕРЕДЬЮ ИЗ СВОЕГО БОТА (19.11.2026, владелец: «Дай монтажеру
 * пропускать очередь кнопкой или передвигать её или переходить к другим … чтобы
 * вдруг если он сам что-то уже делал внутри CRM без системы, то можно пропустить
 * через самого бота»).
 *
 * Здесь только решения и тексты, без Telegram: кнопки разбирает и ответы шлёт
 * telegram/montajerBot.ts. Своей логики очереди здесь НЕТ — только двери
 * lib/videoHandoff.ts под её замком:
 *  - «Сделаю позже» и «Взять сейчас» — swapVideoHandoffHolder (одна транзакция);
 *  - «Уже сделан / не нужен» — cancelVideoHandoffQueueEntry (штатное снятие, объект
 *    остаётся на прежнем этапе) с ожидаемым состоянием и пушем руководству;
 *  - «выше / ниже / в начало» — moveVideoHandoffInQueue.
 *
 * Каждое действие проверяет заново: этот сотрудник — назначенный и не отключённый
 * монтажёр (usableMontajerWhere), рубильник включён. Кнопка под старым сообщением
 * или пересланным чужому сотруднику ничего не меняет. Каждое изменение — запись в
 * журнале монтажа (recordMontajerMessage) и в журнале действий (аудит).
 */
import { prisma } from "../db.js";
import type { TelegramInlineButton } from "../telegram/api.js";
import { logAgentAudit } from "./audit.js";
import { usableMontajerWhere } from "./montajerHandover.js";
import { montajerQueueCallback, type MontajerQueueMove } from "./montajerQueueButtons.js";
import { objectLine, OBJECT_LINE_SELECT, type MontajerView } from "./montajerViews.js";
import {
  cancelVideoHandoffQueueEntry,
  dispatchInBackground,
  EDITOR_HOLDER_WHERE,
  moveVideoHandoffInQueue,
  nextInQueue,
  orderedQueue,
  recordMontajerMessage,
  swapVideoHandoffHolder,
} from "./videoHandoff.js";

export const QUEUE_CONTROL_OFF_TEXT = "Управление очередью из бота выключено руководителем. Порядок очереди меняет руководитель в CRM.";
export const NOT_MONTAJER_TEXT = "Этот чат сейчас не назначен монтажёром.";
const PAUSED_TEXT = "⏸ Очередь на паузе, включает руководитель.";

const QUEUE_BUTTON: TelegramInlineButton = { text: "🗂 Очередь", callback_data: "mj:queue" };
const withQueueButton = (text: string): MontajerView => ({ text, buttons: [[QUEUE_BUTTON]] });

type Access =
  | { ok: true; montajerAgentId: string; paused: boolean }
  | { ok: false; view: MontajerView };

/** Рубильник включён? (по умолчанию да). Для кнопок под заданием и в «Очереди». */
export async function montajerQueueControlsOn(): Promise<boolean> {
  const s = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { montajerQueueControlEnabled: true } });
  return s?.montajerQueueControlEnabled !== false;
}

/** Нажал назначенный и действующий монтажёр, и управление не выключено. */
async function access(agentId: string): Promise<Access> {
  const settings = await prisma.settings.findUnique({
    where: { id: "singleton" },
    select: { videoMontajerAgentId: true, montajerQueueControlEnabled: true, videoHandoffQueuePaused: true },
  });
  const isMontajer =
    !!settings?.videoMontajerAgentId &&
    settings.videoMontajerAgentId === agentId &&
    (await prisma.agent.count({ where: usableMontajerWhere(agentId) })) > 0;
  if (!isMontajer) return { ok: false, view: { text: NOT_MONTAJER_TEXT } };
  if (settings?.montajerQueueControlEnabled === false) return { ok: false, view: { text: QUEUE_CONTROL_OFF_TEXT } };
  return { ok: true, montajerAgentId: agentId, paused: settings?.videoHandoffQueuePaused === true };
}

async function findByShortId(shortId: number) {
  return prisma.property.findFirst({ where: { shortId, deletedAt: null }, select: { id: true, shortId: true } });
}

async function currentHolder() {
  return prisma.property.findFirst({ where: EDITOR_HOLDER_WHERE, orderBy: { videoHandoffSentAt: "asc" }, select: { id: true, shortId: true } });
}

/** Журнал монтажа и журнал действий — одна запись о действии монтажёра. */
function trace(agentId: string, propertyId: string, action: string, text: string, meta: Record<string, string | number | null> = {}): void {
  void recordMontajerMessage(propertyId, "QUEUE_CONTROL", text);
  logAgentAudit(agentId, action, "Property", propertyId, { ...meta, text, source: "telegram-montajer" });
}

/** «⏭ Пропустить №N» (или слово «пропустить» — тогда N = кто сейчас в работе). */
export async function montajerSkipMenuView(agentId: string, shortId: number | null): Promise<MontajerView> {
  const a = await access(agentId);
  if (!a.ok) return a.view;
  const holder = await currentHolder();
  if (!holder) return withQueueButton("Сейчас у вас в работе ничего нет.");
  if (shortId !== null && holder.shortId !== shortId) return withQueueButton(`Объект №${shortId} уже не у вас. Сейчас у вас №${holder.shortId}.`);
  const n = holder.shortId;
  const hasNext = !!(await nextInQueue(prisma, holder.id));
  const lines = [`Что сделать с №${n}?`];
  const row: TelegramInlineButton[] = [];
  if (a.paused) {
    lines.push(`${PAUSED_TEXT} «Сделаю позже» сейчас нельзя: следующий объект не придёт.`);
  } else if (!hasNext) {
    lines.push("Других объектов в очереди нет, «Сделаю позже» не к чему.");
  } else {
    lines.push(`🕓 «Сделаю позже»: №${n} встанет в конец очереди, вам сразу придёт следующий.`);
    row.push({ text: "🕓 Сделаю позже", callback_data: montajerQueueCallback.skipLater(n) });
  }
  lines.push(`✅ «Уже сделан / не нужен»: №${n} уйдёт из очереди, руководитель получит уведомление. Готовый ролик, если он есть, загружают в карточку объекта в CRM.`);
  row.push({ text: "✅ Уже сделан / не нужен", callback_data: montajerQueueCallback.skipDone(n) });
  return { text: lines.join("\n"), buttons: [row, [{ text: "Отмена", callback_data: montajerQueueCallback.cancel() }]] };
}

/** «🕓 Сделаю позже»: держатель — в конец очереди, место — следующему. */
export async function montajerSkipLater(agentId: string, shortId: number): Promise<MontajerView> {
  const a = await access(agentId);
  if (!a.ok) return a.view;
  const property = await findByShortId(shortId);
  if (!property) return withQueueButton(`Объект №${shortId} не найден.`);
  const result = await swapVideoHandoffHolder({ mode: "defer", holderId: property.id });
  if (!result.ok) {
    const why =
      result.code === "STALE" ? `Объект №${shortId} уже не у вас.`
      : result.code === "PAUSED" ? `${PAUSED_TEXT} №${shortId} остаётся у вас.`
      : result.code === "NOTHING_NEXT" ? `Других объектов в очереди нет, №${shortId} остаётся у вас.`
      : result.error;
    return withQueueButton(why);
  }
  dispatchInBackground(result.seated.id, a.montajerAgentId);
  const position = result.returned?.position ?? 0;
  trace(
    agentId,
    property.id,
    "PROPERTY_VIDEO_HANDOFF_MONTAJER_DEFERRED",
    `Монтажёр пропустил №${shortId}: сделает позже. Объект в очереди ${position}-м, монтажёру выдан №${result.seated.shortId}.`,
    { shortId, position, nextShortId: result.seated.shortId }
  );
  return withQueueButton(`Хорошо, №${shortId} в очереди ${position}-м. Вам идёт №${result.seated.shortId}, файлы придут следом.`);
}

/** «✅ Уже сделан / не нужен» — у держателя (`expect: holder`) или у ждущего (`queued`). */
export async function montajerMarkDone(agentId: string, shortId: number, expect: "holder" | "queued"): Promise<MontajerView> {
  const a = await access(agentId);
  if (!a.ok) return a.view;
  const property = await findByShortId(shortId);
  if (!property) return withQueueButton(`Объект №${shortId} не найден.`);
  const result = await cancelVideoHandoffQueueEntry(property.id, { expect, byMontajer: true });
  if (!result.ok) {
    return withQueueButton(
      result.code === "NOT_FOUND" ? `Объект №${shortId} не найден.`
      : expect === "holder" ? `Объект №${shortId} уже не у вас.`
      : `Объекта №${shortId} уже нет в очереди.`
    );
  }
  logAgentAudit(agentId, "PROPERTY_VIDEO_HANDOFF_MONTAJER_DONE", "Property", property.id, {
    shortId,
    wasHolder: expect === "holder",
    text: `Монтажёр пропустил №${shortId}: уже сделан или не нужен`,
    source: "telegram-montajer",
  });
  const lines = [`Готово: №${shortId} снят из очереди, руководителю сообщил.`];
  if (expect === "holder") {
    const next = await currentHolder();
    if (next) lines.push(`Следующий у вас: №${next.shortId}, файлы придут следом.`);
    else if (a.paused) lines.push(`${PAUSED_TEXT} Следующий пока не придёт.`);
    else lines.push("В очереди больше никого.");
  }
  return withQueueButton(lines.join(" "));
}

/** Номер ждущего из «🗂 Очередь» — что с ним можно сделать. */
export async function montajerQueueItemView(agentId: string, shortId: number, notice?: string): Promise<MontajerView> {
  const a = await access(agentId);
  if (!a.ok) return a.view;
  const property = await prisma.property.findFirst({
    where: { shortId, deletedAt: null },
    select: { ...OBJECT_LINE_SELECT, videoHandoffStatus: true, videoHandoffManualSince: true, videoHandoffHeldAt: true, videoHandoffHoldReason: true, videoHandoffRemakeReason: true },
  });
  if (!property) return withQueueButton(`Объект №${shortId} не найден.`);
  if (property.videoHandoffStatus === "SENT_TO_EDITOR" && !property.videoHandoffManualSince) {
    return {
      text: `Объект №${shortId} сейчас у вас в работе.`,
      buttons: [[{ text: `⏭ Пропустить №${shortId}`, callback_data: montajerQueueCallback.skip(shortId) }, QUEUE_BUTTON]],
    };
  }
  if (property.videoHandoffStatus !== "QUEUED") return withQueueButton(`Объекта №${shortId} уже нет в очереди.`);

  const [queue, holder] = await Promise.all([orderedQueue(), currentHolder()]);
  const position = queue.findIndex((q) => q.id === property.id) + 1;
  const lines = [...(notice ? [notice, ""] : []), objectLine(property), `В очереди ${position}-м из ${queue.length}.`];
  if (property.videoHandoffRemakeReason) lines.push("🔁 Переделка.");
  if (property.videoHandoffHeldAt) {
    lines.push(`⏸ Отложен руководителем${property.videoHandoffHoldReason ? ` (${property.videoHandoffHoldReason})` : ""}: взять его сейчас нельзя.`);
  } else if (a.paused) {
    lines.push(`${PAUSED_TEXT} Взять сейчас нельзя.`);
  }

  const buttons: TelegramInlineButton[][] = [];
  if (!property.videoHandoffHeldAt && !a.paused) {
    buttons.push([{ text: `▶️ Взять №${shortId} сейчас`, callback_data: montajerQueueCallback.take(shortId, holder?.shortId ?? null) }]);
  }
  const moves: TelegramInlineButton[] = [];
  if (position > 1) {
    moves.push({ text: "⏫ В начало", callback_data: montajerQueueCallback.move(shortId, "front") });
    moves.push({ text: "⬆️ Выше", callback_data: montajerQueueCallback.move(shortId, "up") });
  }
  if (position < queue.length) moves.push({ text: "⬇️ Ниже", callback_data: montajerQueueCallback.move(shortId, "down") });
  if (moves.length > 0) buttons.push(moves);
  buttons.push([{ text: "✅ Уже сделан / не нужен", callback_data: montajerQueueCallback.queuedDone(shortId) }]);
  buttons.push([{ text: "📋 Данные", callback_data: `mj:obj:${shortId}` }, QUEUE_BUTTON]);
  return { text: lines.join("\n"), buttons };
}

/** «▶️ Взять №M сейчас» — M монтажёру, прежний держатель первым в очередь. */
export async function montajerTakeNow(agentId: string, shortId: number, expectedHolderShortId: number): Promise<MontajerView> {
  const a = await access(agentId);
  if (!a.ok) return a.view;
  const target = await findByShortId(shortId);
  if (!target) return withQueueButton(`Объект №${shortId} не найден.`);
  // Ожидаемый держатель — по номеру из кнопки; удалённый тоже ищем, чтобы сверка
  // честно сказала «изменилась», а не приняла его за «никого».
  const expectedHolder =
    expectedHolderShortId > 0
      ? (await prisma.property.findFirst({ where: { shortId: expectedHolderShortId }, select: { id: true } }))?.id ?? `missing-${expectedHolderShortId}`
      : null;
  const result = await swapVideoHandoffHolder({ mode: "take", takeId: target.id, expectedHolderId: expectedHolder });
  if (!result.ok) {
    const why =
      result.code === "STALE" ? "Очередь только что изменилась, откройте её заново."
      : result.code === "PAUSED" ? `${PAUSED_TEXT} Взять сейчас нельзя.`
      : result.code === "HELD" ? `Объект №${shortId} отложен руководителем, взять его нельзя.`
      : `Объекта №${shortId} уже нет в очереди.`;
    return withQueueButton(why);
  }
  dispatchInBackground(result.seated.id, a.montajerAgentId);
  const returned = result.returned;
  trace(
    agentId,
    target.id,
    "PROPERTY_VIDEO_HANDOFF_MONTAJER_TOOK",
    `Монтажёр взял №${shortId} вне очереди${returned ? `, №${returned.shortId} вернулся в очередь ${returned.position}-м` : ""}.`,
    { shortId, returnedShortId: returned?.shortId ?? null }
  );
  if (returned) {
    trace(
      agentId,
      returned.id,
      "PROPERTY_VIDEO_HANDOFF_MONTAJER_DEFERRED",
      `Монтажёр отложил №${returned.shortId}: взял вместо него №${shortId}. Объект в очереди ${returned.position}-м.`,
      { shortId: returned.shortId, position: returned.position, nextShortId: shortId }
    );
  }
  return withQueueButton(
    `Готово: №${shortId} теперь у вас, файлы придут следом.${returned ? ` №${returned.shortId} вернулся в очередь ${returned.position}-м.` : ""}`
  );
}

/** «⬆️ Выше / ⬇️ Ниже / ⏫ В начало» — ждущий объект. */
export async function montajerMoveQueued(agentId: string, shortId: number, to: MontajerQueueMove): Promise<MontajerView> {
  const a = await access(agentId);
  if (!a.ok) return a.view;
  const property = await findByShortId(shortId);
  if (!property) return withQueueButton(`Объект №${shortId} не найден.`);
  const result = await moveVideoHandoffInQueue(property.id, { to });
  if (!result.ok) {
    return withQueueButton(
      result.code === "HOLDER_CANNOT_MOVE"
        ? `Объект №${shortId} у вас в работе, его место не двигается. Есть «⏭ Пропустить».`
        : `Объекта №${shortId} уже нет в очереди.`
    );
  }
  if (result.from !== result.to) {
    trace(
      agentId,
      property.id,
      "PROPERTY_VIDEO_HANDOFF_MONTAJER_MOVED",
      `Монтажёр передвинул №${shortId} в очереди: был ${result.from}-м, стал ${result.to}-м.`,
      { shortId, from: result.from, to: result.to }
    );
  }
  return montajerQueueItemView(agentId, shortId, result.from !== result.to ? `Передвинул: №${shortId} теперь ${result.to}-й.` : `№${shortId} уже на этом месте.`);
}

export function montajerCancelView(): MontajerView {
  return withQueueButton("Хорошо, ничего не меняю.");
}
