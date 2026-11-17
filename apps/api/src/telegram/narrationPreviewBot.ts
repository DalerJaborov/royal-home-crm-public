/**
 * ПРОСЛУШАТЬ ПЕРЕД ВЫПУСКОМ В ШАБНАМ (17.11.2026, lib/narrationPreview.ts).
 *
 * CRM наложила новую озвучку на вышедший ролик — хозяину объекта (тот же, кому идёт ролик на
 * подтверждение, clipOwnerAgent) приходит сам новый ролик с тремя кнопками:
 *   ✅ Выпустить  ·  🎙 Другой голос или текст  ·  ↩️ Оставить старый.
 * «Другой голос или текст» сразу присылает кнопки озвучки (`nar:v|t|e:<версия>`, telegram/assistantNarration.ts):
 * новая версия → CRM наложит заново → снова сюда. Решения — те же функции, что у карточки CRM.
 * Без Telegram — уведомление CRM с пушем; молчит — ролик выйдет сам по сроку. Отправляет задача
 * narration-preview-due (lib/narrationPreview.ts → notifyPendingNarrationPreviews), с повтором после падения.
 */
import { formatPropertyCode } from "@royal-home/shared";
import fs from "node:fs";
import path from "node:path";
import { prisma } from "../db.js";
import { videoHandoffDir } from "../upload.js";
import { clipOwnerAgent } from "../lib/clipReview.js";
import { prepareClipForTelegram } from "../lib/clipReviewPreview.js";
import { dushanbeDateTimeString } from "../lib/dushanbeTime.js";
import { probeMediaInfo } from "../lib/ffmpeg.js";
import { declineNarrationPreview, releaseNarrationPreview, type NarrationPreviewNotice } from "../lib/narrationPreview.js";
import { createNotification } from "../lib/notifications.js";
import { logSystemError } from "../lib/systemError.js";
import { sendPushToAgent } from "../push.js";
import { chatLang, clickerFor, type Lang } from "./assistantNarration.js";
import {
  answerCallbackQuery, editMessageCaption, editMessageText, isTelegramEnabled, sendMessage, sendMessageWithButtons, sendVideoFromDisk,
  TELEGRAM_BOT_SEND_LIMIT_BYTES, type TelegramCallbackQuery, type TelegramInlineButton,
} from "./api.js";

const secs = (n: number | null | undefined) => (n == null ? null : Math.round(n));

export const previewCopy = {
  ru: {
    head: (code: string) => `🎬 ${code}: новый ролик с новой озвучкой. Послушайте, прежде чем он выйдет.`,
    lengths: (voice: number, clip: number) => `Голос ${voice} с · ролик ${clip} с`,
    due: (when: string) => `Не решите до ${when} — выйдет сам (ночью с 00:00 до 07:00 не выпускаем).`,
    noDue: "Сам не выйдет — ждёт вашего решения.",
    b: { release: "✅ Выпустить", change: "🎙 Другой голос или текст", keep: "↩️ Оставить старый", voice: "🎙 Другой голос", template: "📝 Другой шаблон", edit: "✏️ Свой текст" },
    released: "✅ Выпускаем: новый ролик встанет в ближайшее время публикации, старые посты снимутся.",
    kept: "↩️ Оставили старый ролик. Новая озвучка на него не наложена.",
    change: "Выберите голос или текст: CRM наложит заново и пришлёт послушать.",
    stale: "Этот ролик уже решён или устарел.", busy: "Прежний ролик прямо сейчас уходит в сети. Нажмите ещё раз через пару минут.", forbidden: "Это не ваш объект.", failed: "Не получилось, попробуйте ещё раз.",
    crmOnly: "Видео сюда не поместилось — посмотрите в CRM.",
  },
  tg: {
    head: (code: string) => `🎬 ${code}: видеои нав бо овози нав. Пеш аз баромадан гӯш кунед.`,
    lengths: (voice: number, clip: number) => `Овоз ${voice} с · видео ${clip} с`,
    due: (when: string) => `Агар то ${when} қарор накунед, худаш мебарояд (шабона аз 00:00 то 07:00 намебарорем).`,
    noDue: "Худаш намебарояд — қарори шуморо интизор аст.",
    b: { release: "✅ Нашр кунед", change: "🎙 Овоз ё матни дигар", keep: "↩️ Кӯҳнаашро монед", voice: "🎙 Овози дигар", template: "📝 Қолаби дигар", edit: "✏️ Матни худатон" },
    released: "✅ Нашр мекунем: видеои нав дар вақти наздиктарини нашр мебарояд, постҳои кӯҳна гирифта мешаванд.",
    kept: "↩️ Видеои кӯҳна монд. Овози нав гузошта нашуд.",
    change: "Овоз ё матнро интихоб кунед: CRM аз нав мегузорад ва барои гӯш кардан мефиристад.",
    stale: "Ин видео аллакай ҳал шудааст ё кӯҳна шудааст.", busy: "Видеои пешина ҳозир ба шабакаҳо меравад. Баъд аз ду-се дақиқа боз пахш кунед.", forbidden: "Ин объекти шумо нест.", failed: "Нашуд, боз кӯшиш кунед.",
    crmOnly: "Видео ба ин ҷо нағунҷид — дар CRM нигоҳ кунед.",
  },
} as const;

export function narrationPreviewCaption(lang: Lang, input: { shortId: number; voiceSec: number | null; clipSec: number | null; note: string | null; dueAt: Date | null }): string {
  const c = previewCopy[lang];
  const voice = secs(input.voiceSec), clip = secs(input.clipSec);
  return [c.head(formatPropertyCode(input.shortId)), voice != null && clip != null ? c.lengths(voice, clip) : null, input.note || null,
    input.dueAt ? c.due(dushanbeDateTimeString(input.dueAt)) : c.noDue].filter((l): l is string => !!l).join("\n");
}

export function narrationPreviewButtons(lang: Lang, versionId: string): TelegramInlineButton[][] {
  const b = previewCopy[lang].b;
  return [[{ text: b.release, callback_data: `nrp:a:${versionId}` }], [{ text: b.change, callback_data: `nrp:c:${versionId}` }], [{ text: b.keep, callback_data: `nrp:k:${versionId}` }]];
}

const crmUrl = (propertyId: string) => `${process.env.CRM_PUBLIC_URL?.trim().replace(/\/+$/, "") || "https://crm.royalhome.tj"}/properties/${propertyId}`;

/** Кандидат готов — хозяину объекта. Ошибки Telegram — в журнал и уведомлением CRM. */
export async function notifyNarrationPreview(e: NarrationPreviewNotice): Promise<void> {
  const p = await prisma.property.findUnique({ where: { id: e.propertyId }, select: { id: true, shortId: true, narrationPreviewPath: true, narrationPreviewVersionId: true,
    narrationPreviewDueAt: true, narrationPreviewVoiceSec: true, narrationPreviewClipSec: true } });
  if (!p || p.narrationPreviewVersionId !== e.versionId || !p.narrationPreviewPath) return;
  const owner = await clipOwnerAgent(p.id);
  if (!owner) return;
  const version = await prisma.propertyNarrationVersion.findUnique({ where: { id: e.versionId }, select: { mixNote: true } });
  const code = formatPropertyCode(p.shortId);
  const feed = { kind: "task" as const, level: "APPROVAL" as const, title: "Новый ролик ждёт вашего решения",
    body: `${code}: CRM наложила новую озвучку на вышедший ролик. Послушайте и решите: выпустить, другой голос или оставить старый.`,
    url: `/properties/${p.id}`, tag: `narration-preview:${p.id}` };
  if (!owner.telegramChatId || !isTelegramEnabled()) { await sendPushToAgent(owner.id, feed); return; }
  const chatId = owner.telegramChatId;
  const lang = await chatLang(chatId);
  const caption = narrationPreviewCaption(lang, { shortId: p.shortId, voiceSec: p.narrationPreviewVoiceSec, clipSec: p.narrationPreviewClipSec, note: version?.mixNote ?? null, dueAt: p.narrationPreviewDueAt });
  const buttons = [...narrationPreviewButtons(lang, e.versionId), [{ text: `CRM ${code}`, url: crmUrl(p.id) }]];
  const diskPath = path.join(videoHandoffDir, path.basename(p.narrationPreviewPath));
  let clip: Awaited<ReturnType<typeof prepareClipForTelegram>> | null = null;
  try {
    const stat = await fs.promises.stat(diskPath).catch(() => null);
    if (stat) clip = await prepareClipForTelegram(diskPath, await probeMediaInfo(diskPath).catch(() => null), stat.size, TELEGRAM_BOT_SEND_LIMIT_BYTES);
    if (clip && clip.sizeBytes <= TELEGRAM_BOT_SEND_LIMIT_BYTES) await sendVideoFromDisk(chatId, clip.videoPath, caption, undefined, buttons, clip);
    else await sendMessageWithButtons(chatId, `${caption}\n\n${previewCopy[lang].crmOnly}`, buttons);
    await createNotification({ agentId: owner.id, ...feed });
  } catch (err) {
    void logSystemError("telegram", `Прослушать перед выпуском: ролик ${code} хозяину в Telegram не ушёл, записано в CRM: ${err instanceof Error ? err.message : String(err)}`, { dedupKey: "narration-preview-telegram" });
    await sendPushToAgent(owner.id, feed);
  } finally {
    await clip?.cleanup().catch(() => {});
  }
}

const CALLBACK = /^nrp:(a|c|k):([\da-f-]{36})$/u;

/** `nrp:a|c|k:<версия>` — «Выпустить» / «Другой голос или текст» / «Оставить старый». true — кнопка наша. */
export async function handleNarrationPreviewCallback(query: TelegramCallbackQuery): Promise<boolean> {
  const match = CALLBACK.exec(query.data ?? "");
  if (!match) return false;
  const answer = (text?: string) => answerCallbackQuery(query.id, text).catch(() => {});
  const chat = query.message?.chat;
  if (chat?.type !== "private" || query.from?.id !== chat.id) { await answer(); return true; }
  const chatId = String(chat.id);
  const lang = await chatLang(chatId);
  const c = previewCopy[lang];
  try {
    const versionId = match[2];
    const version = await prisma.propertyNarrationVersion.findUnique({ where: { id: versionId }, select: { propertyId: true } });
    if (!version) { await answer(c.stale); return true; }
    const clicker = await clickerFor(chatId, version.propertyId);
    if (!clicker) { await answer(c.forbidden); return true; }
    const actor = { agentId: clicker.agentId, source: "telegram" as const };
    const action = match[1];
    const result = action === "a" ? await releaseNarrationPreview(version.propertyId, versionId, actor)
      : await declineNarrationPreview(version.propertyId, versionId, actor, action === "k" ? "KEEP_OLD" : "CHANGE");
    if (result === "STALE") { await answer(c.stale); return true; }
    // Решение не принято — кнопки остаются, человек нажмёт ещё раз.
    if (result === "BUSY") { await answer(c.busy); return true; }
    const line = action === "a" ? c.released : action === "k" ? c.kept : c.change;
    await answer(action === "a" ? c.b.release : action === "k" ? c.b.keep : c.b.change);
    // Кнопки под роликом убираем: решение принято, второе нажатие ничего бы не сделало.
    const messageId = query.message?.message_id;
    if (messageId) await editMessageCaption(chatId, messageId, `${query.message?.caption ?? query.message?.text ?? ""}\n\n${line}`, null, true).catch(() => {});
    if (action === "c") {
      await sendMessageWithButtons(chatId, c.change, [
        [{ text: c.b.voice, callback_data: `nar:v:${versionId}` }, { text: c.b.template, callback_data: `nar:t:${versionId}` }],
        [{ text: c.b.edit, callback_data: `nar:e:${versionId}` }],
      ]);
    } else if (!messageId) await sendMessage(chatId, line);
  } catch (err) {
    void logSystemError("telegram", `Прослушать перед выпуском, кнопка: ${err instanceof Error ? err.message : String(err)}`, { dedupKey: "narration-preview-callback" });
    await answer(c.failed);
  }
  return true;
}
