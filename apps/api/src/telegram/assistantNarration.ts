/**
 * ОЗВУЧКА РОЛИКА В ШАБНАМ (схема владельца 10.11.2026, сделано 11.11).
 *
 * Готовое аудио приходит агенту ОДИН раз на версию: файл и карточка с кнопками
 * «Одобрить / Править текст / Другой голос / Другой шаблон». Напоминаний нет
 * (решение владельца 10.11 «редко беспокоить людей»): неодобренная озвучка видна
 * в карточке объекта в CRM. Без Telegram — то же уведомлением CRM с пушем.
 *
 * Здесь только текст и кнопки. Одобрение — approveNarrationVersion (та же функция,
 * что у маршрута approve), новая версия — requestAutoNarration (та же дверь
 * генерации и тот же дневной потолок).
 */
import { formatPropertyCode, isReadOnlyRole, type PermissionId } from "@royal-home/shared";
import { loadAgentAccess } from "../auth/middleware.js";
import { prisma } from "../db.js";
import { hasMarketingRole } from "../lib/marketingRole.js";
import { localVideoFilePath } from "../lib/localVideoStorage.js";
import { afterNarrationApproved, approveNarrationVersion, requestAutoNarration, type NarrationDeliveryStart } from "../lib/narrationAutoFlow.js";
import { loadNarrationConfiguration } from "../lib/narrationGeneration.js";
import { createNotification } from "../lib/notifications.js";
import { canManagePropertyAs } from "../lib/propertyAccess.js";
import { logSystemError } from "../lib/systemError.js";
import { findAgentByTelegramChatId } from "../lib/telegramAgentLink.js";
import { sendPushToAgent } from "../push.js";
import {
  answerCallbackQuery, editMessageText, isTelegramEnabled, sendDocumentFile, sendMessage, sendMessageWithButtons,
  type TelegramCallbackQuery, type TelegramIncomingMessage, type TelegramInlineButton,
} from "./api.js";

type Lang = "ru" | "tg";
const EDIT_WINDOW_MS = 15 * 60_000;
const MAX_CHOICES = 8;

const copy = {
  ru: {
    ready: (code: string) => `🎙 Озвучка ролика для ${code} готова. Прослушайте файл выше и одобрите.`,
    text: "Текст", voice: "Голос",
    remade: "Ролик уже смонтирован со старой озвучкой. Нужен новый ролик: в CRM нажмите «Вернуть монтажёру».",
    b: { approve: "✅ Одобрить", edit: "✏️ Править текст", voice: "🎙 Другой голос", template: "📝 Другой шаблон" },
    approved: (d: NarrationDeliveryStart) => `✅ Одобрено. ${d === "QUEUED" ? "Аудио уходит монтажёру." : d === "WAITING_FOR_MONTAGE" ? "Монтажёр получит аудио, когда объект попадёт в монтаж." : d === "PREVIEW" ? "Отправка монтажёру пока выключена в настройках." : "Монтажёр уже получил эту версию."}`,
    editPrompt: "Пришлите новый текст озвучки одним сообщением. Цену не пишите: она в описании под видео.",
    pickVoice: "Выберите голос:", pickTemplate: "Выберите шаблон:",
    queued: "Хорошо, готовлю новую озвучку и пришлю.",
    stale: "Уже есть новая версия озвучки.", busy: "Предыдущая озвучка ещё готовится. Попробуйте через минуту.",
    forbidden: "Это не ваш объект.", off: "Автоозвучка выключена в настройках.", failed: "Не получилось, попробуйте ещё раз.",
    voiceOnly: "Текст озвучки пришлите, пожалуйста, текстом.",
    male: "муж.", female: "жен.",
  },
  tg: {
    ready: (code: string) => `🎙 Овози видео барои ${code} тайёр аст. Файлро гӯш кунед ва тасдиқ кунед.`,
    text: "Матн", voice: "Овоз",
    remade: "Видео аллакай бо овози кӯҳна монтаж шудааст. Агар видеои нав лозим бошад, дар CRM тугмаи «Вернуть монтажёру»-ро пахш кунед.",
    b: { approve: "✅ Тасдиқ", edit: "✏️ Ислоҳи матн", voice: "🎙 Овози дигар", template: "📝 Қолаби дигар" },
    approved: (d: NarrationDeliveryStart) => `✅ Тасдиқ шуд. ${d === "QUEUED" ? "Овоз ба монтажёр меравад." : d === "WAITING_FOR_MONTAGE" ? "Вақте ки объект ба монтаж мерасад, овоз ба монтажёр меравад." : d === "PREVIEW" ? "Фиристодан ба монтажёр ҳоло дар танзимот хомӯш аст." : "Монтажёр ин версияро аллакай гирифтааст."}`,
    editPrompt: "Матни навро бо як паём фиристед. Нархро нанависед: он дар тавсифи зери видео ҳаст.",
    pickVoice: "Овозро интихоб кунед:", pickTemplate: "Қолабро интихоб кунед:",
    queued: "Хуб, овози навро тайёр мекунам ва мефиристам.",
    stale: "Аллакай версияи нави овоз ҳаст.", busy: "Овози қаблӣ ҳоло тайёр мешавад. Баъд аз як дақиқа боз кӯшиш кунед.",
    forbidden: "Ин объекти шумо нест.", off: "Овоздиҳии худкор дар танзимот хомӯш аст.", failed: "Нашуд, боз кӯшиш кунед.",
    voiceOnly: "Матни овозро бо матн фиристед.",
    male: "мард", female: "зан",
  },
} as const;

async function chatLang(chatId: string): Promise<Lang> {
  const state = await prisma.telegramDialogState.findUnique({ where: { chatId }, select: { payload: true } }).catch(() => null);
  return state?.payload && typeof state.payload === "object" && "lang" in state.payload && state.payload.lang === "tg" ? "tg" : "ru";
}

const crmUrl = (propertyId: string) => `${process.env.CRM_PUBLIC_URL?.trim().replace(/\/+$/, "") || "https://crm.royalhome.tj"}/properties/${propertyId}`;
const approvalButtons = (versionId: string, lang: Lang): TelegramInlineButton[][] => [
  [{ text: copy[lang].b.approve, callback_data: `nar:a:${versionId}` }, { text: copy[lang].b.edit, callback_data: `nar:e:${versionId}` }],
  [{ text: copy[lang].b.voice, callback_data: `nar:v:${versionId}` }, { text: copy[lang].b.template, callback_data: `nar:t:${versionId}` }],
];

/** Одно сообщение агенту на готовую версию (зовёт обход narration-auto-flow). */
export async function notifyNarrationApproval(versionId: string): Promise<void> {
  const version = await prisma.propertyNarrationVersion.findUnique({ where: { id: versionId }, include: { property: { select: {
    id: true, shortId: true, assignedAgentId: true, intakeAgentId: true, createdById: true, videoHandoffStatus: true } } } });
  if (!version || version.status !== "READY" || !version.storageKey) return;
  const p = version.property;
  const agentId = p.assignedAgentId ?? p.intakeAgentId ?? p.createdById;
  if (!agentId) return;
  const agent = await prisma.agent.findUnique({ where: { id: agentId }, select: { id: true, isActive: true, telegramChatId: true } });
  if (!agent?.isActive) return;
  const code = formatPropertyCode(p.shortId);
  const remade = p.videoHandoffStatus === "RECEIVED";
  const feed = {
    // Вид «Задачи»: агент может выключить такие пуши в своих настройках уведомлений.
    kind: "task" as const, level: "APPROVAL" as const, title: "Озвучка ролика готова",
    body: `${code}: прослушайте и одобрите озвучку.${remade ? " Ролик уже смонтирован со старой озвучкой." : ""}`,
    // Один тег на объект: новая версия обновляет ту же строку, а не добавляет вторую.
    url: `/properties/${p.id}`, tag: `narration-approval:${p.id}`,
  };
  const path = localVideoFilePath(version.storageKey);
  if (!agent.telegramChatId || !isTelegramEnabled() || !path) {
    await sendPushToAgent(agent.id, feed);
    return;
  }
  const lang = await chatLang(agent.telegramChatId);
  const c = copy[lang];
  const { config } = await loadNarrationConfiguration();
  const voice = config.voices.find((v) => v.id === version.voiceId)?.name;
  try {
    await sendDocumentFile(agent.telegramChatId, { path }, `${code}-ovoz-v${version.revision}.mp3`, `${code} · v${version.revision}`, 60_000, true);
    const text = [c.ready(code), "", `${c.text}: ${version.script}`, voice ? `${c.voice}: ${voice}` : "", remade ? `\n${c.remade}` : ""].filter((line) => line !== "").join("\n");
    await sendMessageWithButtons(agent.telegramChatId, text.slice(0, 3800), [...approvalButtons(version.id, lang), [{ text: `CRM ${code}`, url: crmUrl(p.id) }]]);
    await prisma.propertyNarrationVersion.updateMany({ where: { id: version.id }, data: { approvalChatId: agent.telegramChatId } });
    await createNotification({ agentId: agent.id, ...feed });
  } catch (err) {
    void logSystemError("telegram", `Озвучка: сообщение агенту в Telegram не ушло, записано в CRM: ${err instanceof Error ? err.message : String(err)}`, { dedupKey: "narration-approval-telegram" });
    await sendPushToAgent(agent.id, feed);
  }
}

type Clicker = { agentId: string; isManager: boolean };
async function clickerFor(chatId: string, propertyId: string): Promise<Clicker | null> {
  const agent = await findAgentByTelegramChatId(chatId);
  const access = agent && await loadAgentAccess(agent.id);
  if (!agent || !access?.isActive || isReadOnlyRole(access.role) || access.role === "EDITOR") return null;
  const property = await prisma.property.findUnique({ where: { id: propertyId }, select: { assignedAgentId: true, intakeAgentId: true, createdById: true, deletedAt: true } });
  if (!property || property.deletedAt) return null;
  if (!canManagePropertyAs({ agentId: agent.id, can: (perm: PermissionId) => access.permissions.has(perm) }, property)) return null;
  return { agentId: agent.id, isManager: hasMarketingRole(access.role) };
}

const CALLBACK = /^nar:(a|e|v|t|p|m):([\da-f-]{36})(?::(\d{1,2}))?$/u;

/** `nar:a|e|v|t:<версия>` и выбор `nar:p|m:<версия>:<номер>`. true — это наша кнопка. */
export async function handleNarrationCallback(query: TelegramCallbackQuery): Promise<boolean> {
  const match = CALLBACK.exec(query.data ?? "");
  if (!match) return false;
  const answer = (text?: string) => answerCallbackQuery(query.id, text).catch(() => {});
  const chat = query.message?.chat;
  if (chat?.type !== "private" || query.from?.id !== chat.id) { await answer(); return true; }
  const chatId = String(chat.id);
  const lang = await chatLang(chatId);
  const c = copy[lang];
  try {
    const version = await prisma.propertyNarrationVersion.findUnique({ where: { id: match[2] }, select: { id: true, propertyId: true, revision: true } });
    if (!version) { await answer(c.stale); return true; }
    const clicker = await clickerFor(chatId, version.propertyId);
    if (!clicker) { await answer(c.forbidden); return true; }
    const latest = await prisma.propertyNarrationVersion.findFirst({ where: { propertyId: version.propertyId }, orderBy: { revision: "desc" }, select: { id: true } });
    if (latest?.id !== version.id) { await answer(c.stale); return true; }
    const action = match[1];
    if (action === "a") {
      const result = await approveNarrationVersion({ propertyId: version.propertyId, versionId: version.id, expectedRevision: version.revision, actorId: clicker.agentId, isManager: clicker.isManager });
      if (result !== "AUDIO_APPROVED") { await answer(result === "FORBIDDEN" ? c.forbidden : c.stale); return true; }
      const delivery = await afterNarrationApproved(version.propertyId, version.id);
      await answer(lang === "tg" ? "Тасдиқ шуд" : "Одобрено");
      const messageId = query.message?.message_id;
      if (messageId) await editMessageText(chatId, messageId, `${query.message?.text ?? ""}\n\n${c.approved(delivery)}`, null).catch(() => {});
      else await sendMessage(chatId, c.approved(delivery));
      return true;
    }
    if (action === "e") {
      await prisma.propertyNarrationVersion.updateMany({ where: { id: version.id }, data: { approvalChatId: chatId, editRequestedAt: new Date() } });
      await answer();
      await sendMessage(chatId, c.editPrompt);
      return true;
    }
    const { config } = await loadNarrationConfiguration();
    if (action === "v" || action === "t") {
      const buttons: TelegramInlineButton[][] = action === "v"
        ? config.voices.slice(0, MAX_CHOICES).map((v, i) => [{ text: v.gender ? `${v.name} · ${c[v.gender]}` : v.name, callback_data: `nar:p:${version.id}:${i}` }])
        : (config.templates ?? []).slice(0, MAX_CHOICES).map((t, i) => [{ text: `${t.name} · ${t.lang === "tg" ? "тоҷикӣ" : "рус."}`, callback_data: `nar:m:${version.id}:${i}` }]);
      await answer();
      await sendMessageWithButtons(chatId, action === "v" ? c.pickVoice : c.pickTemplate, buttons);
      return true;
    }
    const index = Number(match[3]);
    const voiceId = action === "p" ? config.voices[index]?.id : undefined;
    const templateId = action === "m" ? config.templates?.[index]?.id : undefined;
    if (!voiceId && !templateId) { await answer(c.stale); return true; }
    const outcome = await requestAutoNarration({ propertyId: version.propertyId, actorId: clicker.agentId, source: "AGENT", voiceId, templateId, expectedRevision: version.revision, debounceMs: 0, config });
    await answer(outcome.status === "QUEUED" ? c.queued : outcome.status === "BUSY" ? c.busy : outcome.status === "OFF" ? c.off : c.stale);
    if (outcome.status === "QUEUED") await sendMessage(chatId, c.queued);
  } catch (err) {
    void logSystemError("telegram", `Озвучка, кнопка Шабнам: ${err instanceof Error ? err.message : String(err)}`, { dedupKey: "narration-callback" });
    await answer(c.failed);
  }
  return true;
}

/** Текст после «Править текст» (15 минут) — новая версия озвучки. true — сообщение наше. */
export async function handleNarrationTextReply(msg: TelegramIncomingMessage, agent: { id: string }): Promise<boolean> {
  if (msg.chat.type !== "private") return false;
  const chatId = String(msg.chat.id);
  const pending = await prisma.propertyNarrationVersion.findFirst({
    where: { approvalChatId: chatId, editRequestedAt: { gte: new Date(Date.now() - EDIT_WINDOW_MS) } },
    orderBy: { editRequestedAt: "desc" }, select: { id: true, propertyId: true, revision: true },
  });
  if (!pending) return false;
  const lang = await chatLang(chatId);
  const c = copy[lang];
  const text = (msg.text ?? "").trim();
  if (!text) {
    if (msg.voice || msg.audio) { await sendMessage(chatId, c.voiceOnly); return true; }
    return false;
  }
  // Ожидание снимается сразу: следующий обычный вопрос Шабнам уже не станет озвучкой.
  await prisma.propertyNarrationVersion.updateMany({ where: { id: pending.id }, data: { editRequestedAt: null } });
  const clicker = await clickerFor(chatId, pending.propertyId);
  if (!clicker || clicker.agentId !== agent.id) { await sendMessage(chatId, c.forbidden); return true; }
  try {
    const outcome = await requestAutoNarration({ propertyId: pending.propertyId, actorId: agent.id, source: "AGENT", script: text, expectedRevision: pending.revision, debounceMs: 0 });
    await sendMessage(chatId, outcome.status === "QUEUED" ? c.queued : outcome.status === "INVALID" ? outcome.error : outcome.status === "BUSY" ? c.busy : outcome.status === "OFF" ? c.off : c.stale);
  } catch (err) {
    void logSystemError("telegram", `Озвучка, новый текст из Шабнам: ${err instanceof Error ? err.message : String(err)}`, { dedupKey: "narration-text-reply" });
    await sendMessage(chatId, c.failed);
  }
  return true;
}
