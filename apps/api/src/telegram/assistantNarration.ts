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
import { formatPropertyCode, narrationVariants, type NarrationConfig } from "@royal-home/shared";
import { prisma } from "../db.js";
import { localVideoFilePath } from "../lib/localVideoStorage.js";
import { afterNarrationApproved, approveNarrationVersion, NARRATION_OWNER_ROLES, UNAPPROVED_AWAITS_HUMAN_WHERE, requestAutoNarration, type NarrationDeliveryStart } from "../lib/narrationAutoFlow.js";
import { estimateNarrationPublishAt } from "../lib/videoHandoff.js";
import { isWithinDushanbeWindow } from "../lib/dushanbeTime.js";
import { narrationLastChoiceFor } from "../lib/narrationLastChoice.js";
import { loadNarrationConfiguration, readyVoiceSamples } from "../lib/narrationGeneration.js";
import { ownMusicReady } from "../lib/narrationMusic.js";
import { isPublishedClip } from "../lib/narrationPreview.js";
import { clipCountsAsPublished } from "../lib/publishedClip.js";
import { createNotification } from "../lib/notifications.js";
import { narrationAccessForAgent, type NarrationClicker } from "../lib/staffNarration.js";
import { logSystemError } from "../lib/systemError.js";
import { findAgentByTelegramChatId } from "../lib/telegramAgentLink.js";
import { sendPushToAgent } from "../push.js";
import {
  answerCallbackQuery, editMessageText, isTelegramEnabled, sendDocumentFile, sendMessage, sendMessageWithButtons,
  type TelegramCallbackQuery, type TelegramIncomingMessage, type TelegramInlineButton,
} from "./api.js";

export type Lang = "ru" | "tg";
const EDIT_WINDOW_MS = 15 * 60_000;
const MAX_CHOICES = 8;
/** Кнопка «🎲 Случайный другой шаблон»: `nar:m:<версия>:r`; обычная — `nar:m:<версия>:<код шаблона>` (по коду, а не по номеру). */
const RANDOM_TEMPLATE = "r";
/** Код шаблона в кнопке: у Telegram на callback_data 64 байта (`nar:m:` + 36 + `:` = 43), на код остаётся 21. */
const MAX_TEMPLATE_CODE = 21;
const MAX_TEMPLATE_CHOICES = 12;

const copy = {
  ru: {
    ready: (code: string) => `🎙 Озвучка ролика для ${code} готова. Прослушайте файл выше и одобрите.`,
    text: "Текст", voice: "Голос",
    remade: "Ролик уже вышел со старой озвучкой. После одобрения монтажёр заменит в нём только звук.",
    remadeCrm: "Ролик уже вышел со старой озвучкой. После одобрения ролик с новой озвучкой сразу уйдёт в соцсети (ночью утром в 09:00), старые посты CRM снимет сама.",
    samples: "Образцы голосов: одна и та же фраза. Послушайте и выберите ниже.",
    b: { approve: "✅ Одобрить", edit: "✏️ Править текст", voice: "🎙 Другой голос", template: "📝 Другой шаблон", randomTemplate: "🎲 Случайный другой шаблон" },
    approved: (d: NarrationDeliveryStart) => `✅ Одобрено. ${d === "CRM_REMIX" ? "CRM накладывает новую озвучку, ролик сразу уйдёт в соцсети (ночью утром в 09:00). Время выхода видно в карточке объекта, старые посты CRM снимет сама." : d === "SOUND_REMAKE" ? "Ролик уже вышел: монтажёр заменит в нём только голос, старые посты снимутся, когда выйдет новый." : d === "ADD_VOICE" ? "Ролик уже смонтирован: монтажёр вклеит в него голос, потом ролик выйдет." : d === "QUEUED" ? "Аудио уходит монтажёру." : d === "WAITING_FOR_MONTAGE" ? "Монтажёр получит аудио, когда объект попадёт в монтаж." : d === "PREVIEW" ? "Отправка монтажёру пока выключена в настройках." : d === "DISABLED" ? "Для объекта выбрано «Без озвучки», монтажёру ничего не уходит." : "Монтажёр уже получил эту версию."}`,
    backfill: "Ролик уже в монтаже. Озвучка собрана по шаблону и голосу по умолчанию; после вашего одобрения mp3 уйдёт монтажёру.",
    remind: (code: string) => `🎙 Озвучка для ${code} ждёт вашего одобрения уже три часа. Монтажёр без неё не вклеит голос.`,
    publishAt: (when: string) => `Выйдет примерно ${when}.`,
    remindPublished: (code: string) => `🎙 Новая озвучка для ${code} ждёт вашего одобрения уже сутки. Пока не одобрите, в соцсетях висит ролик со старыми данными.`,
    escalate: (code: string, agent: string) => `🎙 ${agent} шесть часов не одобряет озвучку для ${code}. Можете одобрить сами или напомнить агенту.`,
    remindOwner: (codes: string) => `🎙 Ждут вашего одобрения озвучки роликов, которые уже в монтаже: ${codes}. Прослушайте их выше или в CRM.`,
    disabled: "Для этого объекта выбрано «Без озвучки». Включить можно в карточке объекта.",
    same: "Другого подходящего шаблона нет: текст остался тем же.",
    editPrompt: "Пришлите новый текст озвучки одним сообщением.",
    pickVoice: "Выберите голос:", pickTemplate: "Выберите шаблон:",
    queued: "Хорошо, готовлю новую озвучку и пришлю.",
    stale: "Уже есть новая версия озвучки.", busy: "Предыдущая озвучка ещё готовится. Попробуйте через минуту.",
    forbidden: "Это не ваш объект.", off: "Автоозвучка выключена в настройках.", failed: "Не получилось, попробуйте ещё раз.",
    voiceOnly: "Текст озвучки пришлите, пожалуйста, текстом.",
    editCancelled: "Хорошо, правку текста отменила. Озвучка осталась прежней.",
    male: "муж.", female: "жен.", lastPicked: "последний раз выбран",
  },
  tg: {
    ready: (code: string) => `🎙 Овози видео барои ${code} тайёр аст. Файлро гӯш кунед ва тасдиқ кунед.`,
    text: "Матн", voice: "Овоз",
    remade: "Видео аллакай бо овози кӯҳна баромадааст. Баъди тасдиқ монтажёр танҳо овозашро иваз мекунад.",
    remadeCrm: "Видео аллакай бо овози кӯҳна баромадааст. Баъди тасдиқи шумо видео бо овози нав дарҳол ба шабакаҳои иҷтимоӣ меравад (шабона, пагоҳӣ соати 09:00), постҳои кӯҳнаро CRM худаш нест мекунад.",
    samples: "Намунаи овозҳо: ҳамон як ҷумла. Гӯш кунед ва дар поён интихоб кунед.",
    b: { approve: "✅ Тасдиқ", edit: "✏️ Ислоҳи матн", voice: "🎙 Овози дигар", template: "📝 Қолаби дигар", randomTemplate: "🎲 Қолаби тасодуфии дигар" },
    approved: (d: NarrationDeliveryStart) => `✅ Тасдиқ шуд. ${d === "CRM_REMIX" ? "CRM овози навро мегузорад, видео дарҳол ба шабакаҳои иҷтимоӣ меравад (шабона, пагоҳӣ соати 09:00). Вақти баромадан дар саҳифаи объект аст, постҳои кӯҳнаро CRM худаш нест мекунад." : d === "SOUND_REMAKE" ? "Видео аллакай баромадааст: монтажёр танҳо овозашро иваз мекунад, постҳои кӯҳна вақти баромадани видеои нав гирифта мешаванд." : d === "ADD_VOICE" ? "Видео аллакай монтаж шудааст: монтажёр овозро ба он мегузорад, баъд видео мебарояд." : d === "QUEUED" ? "Овоз ба монтажёр меравад." : d === "WAITING_FOR_MONTAGE" ? "Вақте ки объект ба монтаж мерасад, овоз ба монтажёр меравад." : d === "PREVIEW" ? "Фиристодан ба монтажёр ҳоло дар танзимот хомӯш аст." : d === "DISABLED" ? "Барои ин объект «Бе овоз» интихоб шудааст, ба монтажёр чизе намеравад." : "Монтажёр ин версияро аллакай гирифтааст."}`,
    backfill: "Видео аллакай дар монтаж аст. Овоз аз рӯи қолаб ва овози асосӣ тайёр шуд; баъди тасдиқи шумо mp3 ба монтажёр меравад.",
    remind: (code: string) => `🎙 Овози видео барои ${code} се соат боз тасдиқи шуморо интизор аст. Бе он монтажёр овозро гузошта наметавонад.`,
    publishAt: (when: string) => `Тахминан ${when} мебарояд.`,
    remindPublished: (code: string) => `🎙 Овози нав барои ${code} як шабонарӯз боз тасдиқи шуморо интизор аст. То тасдиқ накунед, дар шабакаҳо видео бо маълумоти кӯҳна мемонад.`,
    escalate: (code: string, agent: string) => `🎙 ${agent} шаш соат боз овози видеоро барои ${code} тасдиқ накардааст. Худатон тасдиқ кунед ё ба агент хотиррасон кунед.`,
    remindOwner: (codes: string) => `🎙 Овози видеоҳое, ки аллакай дар монтаж ҳастанд, тасдиқи шуморо интизоранд: ${codes}. Онҳоро дар боло ё дар CRM гӯш кунед.`,
    disabled: "Барои ин объект «Бе овоз» интихоб шудааст. Онро дар корти объект фаъол кардан мумкин аст.",
    same: "Қолаби мувофиқи дигар нест: матн ҳамон монд.",
    editPrompt: "Матни навро бо як паём фиристед.",
    pickVoice: "Овозро интихоб кунед:", pickTemplate: "Қолабро интихоб кунед:",
    queued: "Хуб, овози навро тайёр мекунам ва мефиристам.",
    stale: "Аллакай версияи нави овоз ҳаст.", busy: "Овози қаблӣ ҳоло тайёр мешавад. Баъд аз як дақиқа боз кӯшиш кунед.",
    forbidden: "Ин объекти шумо нест.", off: "Овоздиҳии худкор дар танзимот хомӯш аст.", failed: "Нашуд, боз кӯшиш кунед.",
    voiceOnly: "Матни овозро бо матн фиристед.",
    editCancelled: "Хуб, тағйири матнро бекор кардам. Овоз ҳамон пешина монд.",
    male: "мард", female: "зан", lastPicked: "бори охир интихоб шуд",
  },
} as const;

export async function chatLang(chatId: string): Promise<Lang> {
  const state = await prisma.telegramDialogState.findUnique({ where: { chatId }, select: { payload: true } }).catch(() => null);
  return state?.payload && typeof state.payload === "object" && "lang" in state.payload && state.payload.lang === "tg" ? "tg" : "ru";
}

/** Готовая озвучка файлом: одна дверь и для карточки «прослушайте и одобрите», и для просьбы «пришли озвучку». */
async function sendVersionAudioFile(chatId: string, path: string, code: string, revision: number): Promise<void> {
  await sendDocumentFile(chatId, { path }, `${code}-ovoz-v${revision}.mp3`, `${code} · v${revision}`, 60_000, true);
}

/** Что произошло после одобрения, бытовыми словами (та же фраза, что под кнопкой «Одобрить»). */
export const narrationApprovedText = (delivery: NarrationDeliveryStart, lang: Lang = "ru"): string => copy[lang].approved(delivery);

// Сразу к блоку озвучки (#rh-narration, 20.11.2026): блок стоит ниже фото и цены, карточка прокручивает к нему сама.
const crmUrl = (propertyId: string) => `${process.env.CRM_PUBLIC_URL?.trim().replace(/\/+$/, "") || "https://crm.royalhome.tj"}/properties/${propertyId}#rh-narration`;
const approvalButtons = (versionId: string, lang: Lang): TelegramInlineButton[][] => [
  [{ text: copy[lang].b.approve, callback_data: `nar:a:${versionId}` }, { text: copy[lang].b.edit, callback_data: `nar:e:${versionId}` }],
  [{ text: copy[lang].b.voice, callback_data: `nar:v:${versionId}` }, { text: copy[lang].b.template, callback_data: `nar:t:${versionId}` }],
];

/**
 * Владелец для озвучек разового прохода по очереди монтажа (поправка владельца 12.11.2026):
 * активные директора, если их нет — администраторы. Голоса и шаблоны — из настроек, не из кода.
 */
async function narrationOwnerRecipients(): Promise<string[]> {
  for (const role of NARRATION_OWNER_ROLES) {
    const rows = await prisma.agent.findMany({ where: { role, isActive: true }, select: { id: true }, orderBy: { createdAt: "asc" }, take: 5 });
    if (rows.length) return rows.map((r) => r.id);
  }
  return [];
}

/** Одно сообщение на готовую версию (зовёт обход narration-auto-flow): агенту объекта, а
 *  озвучку разового прохода (BACKFILL) — владельцу. Агент сменился — получает нынешний. */
export async function notifyNarrationApproval(versionId: string): Promise<void> {
  const version = await prisma.propertyNarrationVersion.findUnique({ where: { id: versionId }, select: { id: true, source: true } });
  if (!version) return;
  if (version.source === "BACKFILL") {
    for (const ownerId of await narrationOwnerRecipients()) await notifyNarrationApprovalTo(versionId, ownerId, "backfill");
    return;
  }
  await notifyNarrationApprovalTo(versionId, null, "ready");
}

type ApprovalReason = "ready" | "backfill" | "remind" | "remindPublished" | "escalate";
async function notifyNarrationApprovalTo(versionId: string, recipientId: string | null, reason: ApprovalReason): Promise<boolean> {
  const version = await prisma.propertyNarrationVersion.findUnique({ where: { id: versionId }, include: { property: { select: {
    id: true, shortId: true, assignedAgentId: true, intakeAgentId: true, createdById: true, videoHandoffStatus: true, videoMasterStorageKey: true, videoMasterSource: true, publishedChannels: true, instagramUrl: true } } } });
  if (!version || version.status !== "READY" || !version.storageKey) return false;
  const p = version.property;
  const ownerAgentId = p.assignedAgentId ?? p.intakeAgentId ?? p.createdById;
  const agentId = recipientId ?? ownerAgentId;
  if (!agentId) return false;
  const agent = await prisma.agent.findUnique({ where: { id: agentId }, select: { id: true, isActive: true, telegramChatId: true } });
  if (!agent?.isActive) return false;
  const code = formatPropertyCode(p.shortId);
  const remade = p.videoHandoffStatus === "RECEIVED";
  // Звук в вышедшем ролике меняет CRM: есть ролик без голоса, или вышедший ролик и своя музыка (18.11.2026).
  const { config } = await loadNarrationConfiguration();
  // Мастер машины и чистая картинка своей музыки — не ролик без голоса от монтажёра (ревью 18.11).
  const editorMaster = !!p.videoMasterStorageKey && p.videoMasterSource !== "MACHINE" && p.videoMasterSource !== "MUSIC_BASE";
  const crmVoice = editorMaster || (isPublishedClip(p) && await ownMusicReady(config));
  const ownerName = reason === "escalate" && ownerAgentId ? (await prisma.agent.findUnique({ where: { id: ownerAgentId }, select: { fullName: true } }))?.fullName ?? "Агент" : "Агент";
  const feed = {
    // Вид «Задачи»: агент может выключить такие пуши в своих настройках уведомлений.
    kind: "task" as const, level: "APPROVAL" as const, title: "Озвучка ролика готова",
    body: `${code}: прослушайте и одобрите озвучку.${remade ? (crmVoice ? " После одобрения CRM сама заменит звук в вышедшем ролике." : " После одобрения монтажёр заменит звук в вышедшем ролике.") : ""}`,
    // Один тег на объект: новая версия обновляет ту же строку, а не добавляет вторую.
    url: `/properties/${p.id}#rh-narration`, tag: `narration-approval:${p.id}`,
  };
  const path = localVideoFilePath(version.storageKey);
  if (!agent.telegramChatId || !isTelegramEnabled() || !path) {
    await sendPushToAgent(agent.id, feed);
    return true;
  }
  const lang = await chatLang(agent.telegramChatId);
  const c = copy[lang];
  const voice = config.voices.find((v) => v.id === version.voiceId)?.name;
  try {
    const head = reason === "remind" ? c.remind(code) : reason === "remindPublished" ? c.remindPublished(code) : reason === "escalate" ? c.escalate(code, ownerName) : c.ready(code);
    // Напоминание — без повторного файла: он уже есть в чате выше (или в карточке CRM).
    if (reason === "ready" || reason === "backfill" || reason === "escalate") {
      await sendVersionAudioFile(agent.telegramChatId, path, code, version.revision);
    }
    const text = [head, reason === "backfill" ? c.backfill : "", "", `${c.text}: ${version.script}`, voice ? `${c.voice}: ${voice}` : "", remade ? `\n${crmVoice ? c.remadeCrm : c.remade}` : ""].filter((line) => line !== "").join("\n");
    await sendMessageWithButtons(agent.telegramChatId, text.slice(0, 3800), [...approvalButtons(version.id, lang), [{ text: `CRM ${code}`, url: crmUrl(p.id) }]]);
    if (reason === "ready" || reason === "backfill") await prisma.propertyNarrationVersion.updateMany({ where: { id: version.id }, data: { approvalChatId: agent.telegramChatId } });
    await createNotification({ agentId: agent.id, ...feed });
  } catch (err) {
    void logSystemError("telegram", `Озвучка: сообщение агенту в Telegram не ушло, записано в CRM: ${err instanceof Error ? err.message : String(err)}`, { dedupKey: "narration-approval-telegram" });
    await sendPushToAgent(agent.id, feed);
  }
  return true;
}

/** «в 14:15», «завтра в 09:00» (рус.) / «соати 14:15», «пагоҳ соати 09:00» (тадж.) — по Душанбе. */
function publishTimeWords(at: Date, lang: Lang, now: Date = new Date()): string {
  const day = (x: Date) => x.toLocaleDateString("ru-RU", { timeZone: "Asia/Dushanbe" });
  const time = at.toLocaleTimeString("ru-RU", { timeZone: "Asia/Dushanbe", hour: "2-digit", minute: "2-digit" });
  const tomorrow = day(at) !== day(now);
  return lang === "tg" ? `${tomorrow ? "пагоҳ " : ""}соати ${time}` : `${tomorrow ? "завтра " : ""}в ${time}`;
}

const REMIND_AFTER_MS = 3 * 3_600_000;
/** Ролик уже вышел (18.11.2026, владелец: «беспокоить редко»): одно напоминание через сутки, без руководителя. */
const REMIND_PUBLISHED_AFTER_MS = 24 * 3_600_000;
/** Кто «руководитель» агента для второго напоминания: руководитель продаж, иначе директор (решение по умолчанию). */
async function narrationEscalationRecipients(): Promise<string[]> {
  for (const role of ["HEAD_OF_SALES", "DIRECTOR"] as const) {
    const rows = await prisma.agent.findMany({ where: { role, isActive: true }, select: { id: true }, orderBy: { createdAt: "asc" }, take: 3 });
    if (rows.length) return rows.map((r) => r.id);
  }
  return [];
}

/**
 * НАПОМИНАНИЯ ОБ ОДОБРЕНИИ (12.11.2026, решение владельца). Озвучка готова и три часа не
 * одобрена — одно напоминание агенту (нынешнему: сменился агент — напомнят новому); ещё три
 * часа — одно сообщение руководителю. Автоодобрения нет. Только с 09:00 до 20:00 по Душанбе.
 * Озвучки разового прохода (одобряет владелец) — одним общим напоминанием владельцу, без
 * эскалации. Отметка ставится ДО отправки: два тика не пришлют второе.
 */
export async function remindPendingNarrationApprovals(now: Date = new Date()): Promise<number> {
  if (!isWithinDushanbeWindow("09:00", "20:00", now)) return 0;
  const due = new Date(now.getTime() - REMIND_AFTER_MS);
  const pending = await prisma.propertyNarrationVersion.findMany({
    // Только то, что агент может утвердить — фильтром в запросе (четвёртое ревью 18.11), иначе пропущенные без отметки
    // строки навсегда занимали бы голову очереди.
    where: { status: "READY", approvedAt: null, approvalNotifiedAt: { lte: due }, approvalEscalatedAt: null, ...UNAPPROVED_AWAITS_HUMAN_WHERE,
      property: { deletedAt: null, narrationOff: false, status: { notIn: ["SOLD", "WITHDRAWN"] } } },
    orderBy: { approvalNotifiedAt: "asc" }, take: 40,
    select: { id: true, propertyId: true, source: true, approvalRemindedAt: true, approvalNotifiedAt: true, status: true, storageKey: true, approvedAt: true,
      property: { select: { shortId: true, publishedChannels: true, instagramUrl: true } } },
  });
  let sent = 0;
  const ownerCodes: string[] = [];
  for (const row of pending) {
    const latest = await prisma.propertyNarrationVersion.findFirst({ where: { propertyId: row.propertyId }, orderBy: { revision: "desc" }, select: { id: true } });
    // Устаревшая версия напоминаний больше не получит никогда — отметка, чтобы не стоять в голове очереди (четвёртое ревью).
    if (latest?.id !== row.id) { await prisma.propertyNarrationVersion.updateMany({ where: { id: row.id, approvalEscalatedAt: null }, data: { approvalEscalatedAt: now } }); continue; }
    // Ролик уже вышел: новая озвучка ждёт «Утвердить и выпустить» — одно напоминание через сутки, и всё.
    if (await clipCountsAsPublished(row.propertyId, row.property)) {
      if (row.approvalRemindedAt || !row.approvalNotifiedAt || now.getTime() - row.approvalNotifiedAt.getTime() < REMIND_PUBLISHED_AFTER_MS) continue;
      const claimed = await prisma.propertyNarrationVersion.updateMany({ where: { id: row.id, approvalRemindedAt: null }, data: { approvalRemindedAt: now, approvalEscalatedAt: now } });
      if (claimed.count && await notifyNarrationApprovalTo(row.id, null, "remindPublished")) sent++;
      continue;
    }
    if (row.source === "BACKFILL") {
      if (row.approvalRemindedAt) continue;
      const claimed = await prisma.propertyNarrationVersion.updateMany({ where: { id: row.id, approvalRemindedAt: null }, data: { approvalRemindedAt: now, approvalEscalatedAt: now } });
      if (claimed.count) ownerCodes.push(formatPropertyCode(row.property.shortId));
      continue;
    }
    if (!row.approvalRemindedAt) {
      const claimed = await prisma.propertyNarrationVersion.updateMany({ where: { id: row.id, approvalRemindedAt: null }, data: { approvalRemindedAt: now } });
      if (claimed.count && await notifyNarrationApprovalTo(row.id, null, "remind")) sent++;
      continue;
    }
    if (row.approvalRemindedAt.getTime() > due.getTime()) continue;
    const claimed = await prisma.propertyNarrationVersion.updateMany({ where: { id: row.id, approvalEscalatedAt: null }, data: { approvalEscalatedAt: now } });
    if (!claimed.count) continue;
    for (const managerId of await narrationEscalationRecipients()) if (await notifyNarrationApprovalTo(row.id, managerId, "escalate")) sent++;
  }
  if (ownerCodes.length) {
    for (const ownerId of await narrationOwnerRecipients()) {
      const owner = await prisma.agent.findUnique({ where: { id: ownerId }, select: { id: true, telegramChatId: true } });
      if (!owner) continue;
      const lang: Lang = owner.telegramChatId ? await chatLang(owner.telegramChatId) : "ru";
      const text = copy[lang].remindOwner(ownerCodes.join(", "));
      if (owner.telegramChatId && isTelegramEnabled()) await sendMessage(owner.telegramChatId, text).catch(() => sendPushToAgent(owner.id, { kind: "task", title: "Озвучки ждут одобрения", body: text, url: "/properties", tag: "narration-owner-remind" }));
      else await sendPushToAgent(owner.id, { kind: "task", title: "Озвучки ждут одобрения", body: text, url: "/properties", tag: "narration-owner-remind" });
      sent++;
    }
  }
  return sent;
}

/** Образцы голосов файлами — только уже готовые (их платно один раз готовит руководство). */
export async function sendVoiceSamples(chatId: string, config: Awaited<ReturnType<typeof loadNarrationConfiguration>>["config"], lang: Lang, intro: string, onlyVoiceId?: string): Promise<number> {
  const ready = new Map((await readyVoiceSamples(config)).filter((s) => s.lang === lang).map((s) => [s.voiceId, s.storageKey]));
  const voices = config.voices.slice(0, MAX_CHOICES).filter((v) => ready.has(v.id) && (!onlyVoiceId || v.id === onlyVoiceId));
  if (!voices.length) return 0;
  await sendMessage(chatId, intro);
  let sent = 0;
  for (const voice of voices) {
    const path = localVideoFilePath(ready.get(voice.id)!);
    if (!path) continue;
    const ok = await sendDocumentFile(chatId, { path }, `ovoz-${voice.id.slice(0, 12)}.mp3`, voice.name, 60_000, true).then(() => true)
      .catch((err) => { void logSystemError("telegram", `Образец голоса не ушёл в Шабнам: ${err instanceof Error ? err.message : String(err)}`, { dedupKey: "narration-voice-sample-send" }); return false; });
    if (ok) sent++;
  }
  return sent;
}

/**
 * Файлы озвучки по ПРОСЬБЕ человека словами (инструмент send_narration_audio, 18.11.2026): готовая версия
 * объекта или образцы голосов в его личный чат. Тот же файл и подпись, что у карточки «прослушайте и одобрите».
 */
export async function sendNarrationAudioToAgent(agentId: string, what: { versionId: string } | { samples: { voiceId?: string } }): Promise<{ sent: number; reason?: "NO_CHAT" | "NO_FILE" }> {
  const agent = await prisma.agent.findUnique({ where: { id: agentId }, select: { telegramChatId: true } });
  if (!agent?.telegramChatId || !isTelegramEnabled()) return { sent: 0, reason: "NO_CHAT" };
  const chatId = agent.telegramChatId;
  if ("versionId" in what) {
    const version = await prisma.propertyNarrationVersion.findUnique({ where: { id: what.versionId }, select: { revision: true, status: true, storageKey: true, property: { select: { shortId: true } } } });
    const path = version?.status === "READY" && version.storageKey ? localVideoFilePath(version.storageKey) : null;
    if (!version || !path) return { sent: 0, reason: "NO_FILE" };
    await sendVersionAudioFile(chatId, path, formatPropertyCode(version.property.shortId), version.revision);
    return { sent: 1 };
  }
  const lang = await chatLang(chatId);
  const { config } = await loadNarrationConfiguration();
  const sent = await sendVoiceSamples(chatId, config, lang, copy[lang].samples, what.samples.voiceId);
  return sent ? { sent } : { sent: 0, reason: "NO_FILE" };
}

export type Clicker = NarrationClicker;
export async function clickerFor(chatId: string, propertyId: string): Promise<Clicker | null> {
  const agent = await findAgentByTelegramChatId(chatId);
  return agent ? narrationAccessForAgent(agent.id, propertyId) : null;
}

/**
 * Шаблоны кнопки «Другой шаблон» (16.11.2026): язык версии и тип объекта, затем другой язык. Один и тот же список
 * строит и показ кнопок (`t`), и разбор нажатия (`m`): номер кнопки указывает в него.
 */
export function narrationTemplateChoices(config: Pick<NarrationConfig, "templates">, versionLang: string | null | undefined, propertyType: string | null | undefined) {
  const templates = config.templates ?? [];
  const lang = versionLang === "ru" ? "ru" : "tg";
  return [...narrationVariants(templates, lang, propertyType), ...narrationVariants(templates, lang === "tg" ? "ru" : "tg", propertyType)]
    .filter((t) => t.id.length <= MAX_TEMPLATE_CODE).slice(0, MAX_TEMPLATE_CHOICES);
}

const CALLBACK = /^nar:(a|e|v|t|p|m):([\da-f-]{36})(?::([a-z\d-]{1,21}))?$/u;

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
    const version = await prisma.propertyNarrationVersion.findUnique({ where: { id: match[2] }, select: { id: true, propertyId: true, revision: true, language: true } });
    if (!version) { await answer(c.stale); return true; }
    const clicker = await clickerFor(chatId, version.propertyId);
    if (!clicker) { await answer(c.forbidden); return true; }
    const latest = await prisma.propertyNarrationVersion.findFirst({ where: { propertyId: version.propertyId }, orderBy: { revision: "desc" }, select: { id: true } });
    if (latest?.id !== version.id) { await answer(c.stale); return true; }
    const action = match[1];
    if (action === "a") {
      const result = await approveNarrationVersion({ propertyId: version.propertyId, versionId: version.id, expectedRevision: version.revision, actorId: clicker.agentId, isManager: clicker.isManager, actorRole: clicker.role });
      if (result !== "AUDIO_APPROVED") { await answer(result === "FORBIDDEN" ? c.forbidden : c.stale); return true; }
      const delivery = await afterNarrationApproved(version.propertyId, version.id);
      await answer(lang === "tg" ? "Тасдиқ шуд" : "Одобрено");
      // Ролик уже вышел: когда выйдет новый (примерно; точное время — в карточке, когда голос наложен).
      const when = delivery === "CRM_REMIX" ? await estimateNarrationPublishAt(version.propertyId).catch(() => null) : null;
      const reply = `${c.approved(delivery)}${when ? ` ${c.publishAt(publishTimeWords(when, lang))}` : ""}`;
      const messageId = query.message?.message_id;
      if (messageId) await editMessageText(chatId, messageId, `${query.message?.text ?? ""}\n\n${reply}`, null).catch(() => {});
      else await sendMessage(chatId, reply);
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
      const last = await narrationLastChoiceFor(clicker.agentId, config);
      const choices = action === "t" ? narrationTemplateChoices(config, version.language, (await prisma.property.findUnique({ where: { id: version.propertyId }, select: { type: true } }))?.type) : [];
      const buttons: TelegramInlineButton[][] = action === "v"
        ? config.voices.slice(0, MAX_CHOICES).map((v, i) => [{ text: `${v.gender ? `${v.name} · ${c[v.gender]}` : v.name}${v.id === last.voiceId ? ` · ${c.lastPicked}` : ""}`, callback_data: `nar:p:${version.id}:${i}` }])
        : [[{ text: c.b.randomTemplate, callback_data: `nar:m:${version.id}:${RANDOM_TEMPLATE}` }],
          ...choices.map((t) => [{ text: `${t.name} · ${t.lang === "tg" ? "тоҷикӣ" : "рус."}${t.id === last.templateId ? ` · ${c.lastPicked}` : ""}`, callback_data: `nar:m:${version.id}:${t.id}` }])];
      await answer();
      // «Другой голос»: сначала образцы — одна и та же фраза каждым голосом (готовые, без затрат).
      if (action === "v") await sendVoiceSamples(chatId, config, version.language === "ru" ? "ru" : "tg", c.samples);
      await sendMessageWithButtons(chatId, action === "v" ? c.pickVoice : c.pickTemplate, buttons);
      return true;
    }
    const code = match[3] ?? "";
    const voiceId = action === "p" ? config.voices[Number(code)]?.id : undefined;
    // «Случайный другой шаблон»: новый шаблон и новая концовка, не равные прошлым (ядро chooseNarration).
    const reroll = action === "m" && code === RANDOM_TEMPLATE;
    const templateId = action === "m" && !reroll
      ? narrationTemplateChoices(config, version.language, (await prisma.property.findUnique({ where: { id: version.propertyId }, select: { type: true } }))?.type).find((t) => t.id === code)?.id : undefined;
    if (!voiceId && !templateId && !reroll) { await answer(c.stale); return true; }
    const outcome = await requestAutoNarration({ propertyId: version.propertyId, actorId: clicker.agentId, source: "AGENT", voiceId, templateId, reroll, expectedRevision: version.revision, debounceMs: 0, config });
    await answer(outcome.status === "QUEUED" ? c.queued : outcome.status === "BUSY" ? c.busy : outcome.status === "OFF" ? c.off : outcome.status === "DISABLED" ? c.disabled : outcome.status === "UNCHANGED" ? c.same : c.stale);
    if (outcome.status === "QUEUED") await sendMessage(chatId, c.queued);
  } catch (err) {
    void logSystemError("telegram", `Озвучка, кнопка Шабнам: ${err instanceof Error ? err.message : String(err)}`, { dedupKey: "narration-callback" });
    await answer(c.failed);
  }
  return true;
}

/** Короткая фраза отказа от правки текста: «отмена», «не надо», «стоп», «бекор». Без \w/\b — они молчат по кириллице. */
const EDIT_CANCEL = /^(отмен[а-яё]*|отстав[а-яё]*|не\s+надо|не\s+нужно|стоп|cancel|бекор[а-яӣӯқғҳҷ\s]*|лағв[а-яӣӯқғҳҷ]*|нахостам|не\s+меняй[а-яё]*)[.!\s]*$/iu;
export function isEditCancel(text: string): boolean {
  const t = text.trim().toLowerCase();
  return t.length <= 30 && EDIT_CANCEL.test(t);
}

/** Голосовое → текст (в Шабнам это её расшифровка с дневным потолком и учётом денег); без неё голосовое просит текст. */
export type NarrationTranscriber = (msg: TelegramIncomingMessage) => Promise<{ text: string } | { error: string }>;

/**
 * Текст после «Править текст» (15 минут) — новая версия озвучки. true — сообщение наше. Голосовое сообщение
 * расшифровывается и идёт тем же путём (18.11.2026: «правь голосом»): сказанное читается словами человека, а не
 * пересказом, и сразу уходит в новую версию, как набранный текст.
 */
export async function handleNarrationTextReply(msg: TelegramIncomingMessage, agent: { id: string }, transcribe?: NarrationTranscriber): Promise<boolean> {
  if (msg.chat.type !== "private") return false;
  const chatId = String(msg.chat.id);
  const pending = await prisma.propertyNarrationVersion.findFirst({
    where: { approvalChatId: chatId, editRequestedAt: { gte: new Date(Date.now() - EDIT_WINDOW_MS) } },
    orderBy: { editRequestedAt: "desc" }, select: { id: true, propertyId: true, revision: true },
  });
  if (!pending) return false;
  const lang = await chatLang(chatId);
  const c = copy[lang];
  let text = (msg.text ?? "").trim();
  if (!text) {
    if (!msg.voice && !msg.audio) return false;
    const heard: { text: string } | { error: string } = transcribe
      ? await transcribe(msg).catch((err) => ({ error: err instanceof Error ? err.message : String(err) }))
      : { error: "" };
    const heardText = "text" in heard ? heard.text.trim() : "";
    // Не расшифровалось (или расшифровщика нет): причина человеку, окно правки остаётся — можно повторить.
    if (!heardText) { await sendMessage(chatId, ("error" in heard && heard.error) || c.voiceOnly); return true; }
    text = heardText;
  }
  // Ожидание снимается сразу: следующий обычный вопрос Шабнам уже не станет озвучкой.
  await prisma.propertyNarrationVersion.updateMany({ where: { id: pending.id }, data: { editRequestedAt: null } });
  // «Отмена» (словом или голосом) — не новый текст озвучки, а отказ от правки.
  if (isEditCancel(text)) { await sendMessage(chatId, c.editCancelled); return true; }
  const clicker = await clickerFor(chatId, pending.propertyId);
  if (!clicker || clicker.agentId !== agent.id) { await sendMessage(chatId, c.forbidden); return true; }
  try {
    const outcome = await requestAutoNarration({ propertyId: pending.propertyId, actorId: agent.id, source: "AGENT", script: text, expectedRevision: pending.revision, debounceMs: 0 });
    await sendMessage(chatId, outcome.status === "QUEUED" ? c.queued : outcome.status === "INVALID" ? outcome.error : outcome.status === "BUSY" ? c.busy : outcome.status === "OFF" ? c.off : outcome.status === "DISABLED" ? c.disabled : c.stale);
  } catch (err) {
    void logSystemError("telegram", `Озвучка, новый текст из Шабнам: ${err instanceof Error ? err.message : String(err)}`, { dedupKey: "narration-text-reply" });
    await sendMessage(chatId, c.failed);
  }
  return true;
}
