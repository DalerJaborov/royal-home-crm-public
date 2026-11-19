import { openAsBlob } from "node:fs";
import { stat } from "node:fs/promises";
import { z } from "zod";
import { narrationConfigSchema, narrationMixByCrm } from "@royal-home/shared";
import { prisma } from "../db.js";
import { buildMontajerDelivery, EDITOR_HOLDER_WHERE } from "./videoHandoff.js";
import { usableMontajerWhere } from "./montajerHandover.js";
import { narrationFactsCurrent, narrationHash } from "./propertyNarration.js";
import { localVideoFilePath } from "./localVideoStorage.js";
import { mediaExecutionMode, mediaRecipientHash } from "./mediaExecution.js";
import { sendDocumentFile, sendMessage, TELEGRAM_BOT_SEND_LIMIT_BYTES, TELEGRAM_CAPTION_MAX_CHARS } from "../telegram/api.js";
import { VOICELESS_COPY_HINT, voicelessCopyHint } from "./narrationMontajerNote.js";
import { logSystemError } from "./systemError.js";

const fileSchema = z.object({ id: z.string(), storageKey: z.string(), filename: z.string(), caption: z.string() });
/** mixByCrm — монтажёру сказано «пришлите ролик без голоса»: принятый ролик станет мастером (lib/narrationMaster.ts). */
const planSchema = z.object({ factsHash: z.string(), recipientHash: z.string(), files: z.array(fileSchema).min(1), sourcesHash: z.string(), mixByCrm: z.boolean().optional() });
type Plan = z.infer<typeof planSchema>;
/**
 * ТЕКСТ ОЗВУЧКИ — ОБЫЧНЫМ ТЕКСТОМ, БЕЗ ФАЙЛА .txt (19.11.2026, владелец: «текст зачем отдельным файлом? Можно
 * было просто прилепить и всё как обычный текст а аудио»). Влезает в подпись к mp3 (лимит Telegram 1024) —
 * «<подпись>\n\nТекст:\n<текст>»; не влезает — подпись без текста, а текст следом обычным сообщением
 * «Текст озвучки №N:\n<текст>» (длиннее 4096 sendMessage режет сам). Сообщение-текст в плане — запись с
 * storageKey TEXT_MESSAGE и самим текстом в caption; номер объекта подставляется при отправке.
 */
export const NARRATION_TEXT_MESSAGE = "TEXT";
/** Запись плана до 19.11.2026: текст отдельным файлом .txt. Такие передачи уходят по-новому (upgradeLegacyScript). */
const LEGACY_SCRIPT_FILE = "SCRIPT";
type PlanFile = z.infer<typeof fileSchema>;
function voiceFilesWithText(audio: PlanFile, script: string, textId: string): PlanFile[] {
  const withText = `${audio.caption}\n\nТекст:\n${script}`;
  if (withText.length <= TELEGRAM_CAPTION_MAX_CHARS) return [{ ...audio, caption: withText }];
  return [audio, { id: textId, storageKey: NARRATION_TEXT_MESSAGE, filename: "", caption: script }];
}
/**
 * ПЕРЕДАЧИ, ПОСТАВЛЕННЫЕ ДО 19.11.2026 (план с файлом .txt) — уходят уже по-новому. Ждущая (QUEUED) передача
 * отправляется только здесь, поэтому достаточно переложить её план перед отправкой: подпись mp3 без прежней
 * просьбы о втором файле и с текстом, .txt не шлём. Хранимый план не меняется (с ним сверяется planHash ручной
 * передачи); квитанции пишутся по тем же id (mp3 — id версии, текст — прежний id «-script»). SENT/UNKNOWN
 * повторно не отправляются никогда — их этот путь не касается.
 */
function upgradeLegacyScript(files: readonly PlanFile[]): PlanFile[] {
  const script = files.find((f) => f.storageKey === LEGACY_SCRIPT_FILE);
  if (!script) return [...files];
  const audioId = script.id.replace(/-script$/, "");
  const audio = files.find((f) => f.id === audioId);
  if (!audio) return files.map((f) => (f === script ? { ...f, storageKey: NARRATION_TEXT_MESSAGE, filename: "" } : f));
  const voice = voiceFilesWithText({ ...audio, caption: audio.caption.replace(` ${VOICELESS_COPY_HINT}`, "") }, script.caption, script.id);
  return files.flatMap((f) => (f === audio ? voice : f === script ? [] : [f]));
}
function telegramMessageId(sent: unknown): number | null {
  if (!sent || typeof sent !== "object" || !("message_id" in sent)) return null;
  return typeof sent.message_id === "number" ? sent.message_id : null;
}

/** Shared by watchdog and manual reconciliation; a whole batch may exceed 3 minutes. */
export function narrationDeliveryAttemptBudgetMs(plan: unknown): number {
  const parsed = planSchema.safeParse(plan);
  return (parsed.success ? parsed.data.files.length : 1) * 90_000 + 120_000;
}
/**
 * ПОЧЕМУ ГОЛОС НЕ ГОТОВ К ОТПРАВКЕ — РАЗЛИЧИМО (19.11.2026). Раньше любая причина была голым Error,
 * и afterNarrationApproved глотал её как «объект не у монтажёра»: на проде полтора месяца озвучка
 * не уходила ни разу, а журнал ошибок молчал. Текст — для человека (маршрут отдаёт его в карточку),
 * код — для кода: что считать штатным ожиданием, а что поломкой.
 */
export type NarrationDeliveryRefusalCode =
  /** Объекта нет или он удалён. */
  | "PROPERTY_GONE"
  /** Версия не та, не готова или факты объекта с тех пор поменялись. */
  | "VERSION_STALE"
  /** У объекта выбрано «Без озвучки». */
  | "NARRATION_OFF"
  /** Объект сейчас не у монтажёра — штатное ожидание: голос уйдёт, когда встанет. */
  | "NOT_WITH_MONTAJER"
  /** Монтажёр не назначен в Настройках или запрос назвал другого. */
  | "MONTAJER_NOT_ASSIGNED"
  /** Назначенный монтажёр отключён. */
  | "MONTAJER_INACTIVE"
  /** У назначенного монтажёра не подключён Telegram. */
  | "MONTAJER_NO_TELEGRAM"
  /** Просили с исходниками, а исходников нет. */
  | "NO_SOURCES";
export class NarrationDeliveryRefused extends Error {
  constructor(readonly code: NarrationDeliveryRefusalCode, message: string) {
    super(message);
    this.name = "NarrationDeliveryRefused";
  }
}
/** Штатные «пока нельзя», а не поломки: объект ещё не у монтажёра, у объекта «Без озвучки». */
export function narrationDeliveryRefusalIsExpected(code: NarrationDeliveryRefusalCode): boolean {
  return code === "NOT_WITH_MONTAJER" || code === "NARRATION_OFF";
}

/** Same immutable source builder as the existing montage pipeline. No queue reassignment. */
export async function prepareNarrationDeliveryPlan(propertyId: string, versionId: string, mode: string, requestedEditorId?: string) {
  const [p, version, settings, sources] = await Promise.all([
    prisma.property.findUnique({ where: { id: propertyId }, include: { district: true } }),
    prisma.propertyNarrationVersion.findUnique({ where: { id: versionId } }),
    prisma.settings.findUnique({ where: { id: "singleton" }, select: { videoMontajerAgentId: true, propertyNarrationConfig: true } }),
    buildMontajerDelivery(propertyId),
  ]);
  const editorId = requestedEditorId ?? settings?.videoMontajerAgentId;
  if (!p || p.deletedAt || !sources) throw new NarrationDeliveryRefused("PROPERTY_GONE", "Нужна актуальная озвучка: объект удалён");
  if (p.narrationOff) throw new NarrationDeliveryRefused("NARRATION_OFF", "Для объекта выбрано «Без озвучки»");
  // «Не у монтажёра» — РАНЬШЕ «озвучка устарела» (ревью 19.11): одобрение устаревшей версии у сданного объекта —
  // штатное ожидание, а не тревога директору.
  if (p.videoHandoffStatus !== "SENT_TO_EDITOR" || p.videoHandoffManualSince) throw new NarrationDeliveryRefused("NOT_WITH_MONTAJER", "Сначала передайте объект в работу монтажёру через существующую очередь монтажа");
  if (!version || version.propertyId !== p.id || !version.storageKey || version.status !== "READY" || !narrationFactsCurrent(version, p)) throw new NarrationDeliveryRefused("VERSION_STALE", "Нужна актуальная озвучка");
  if (!editorId || editorId !== settings?.videoMontajerAgentId) throw new NarrationDeliveryRefused("MONTAJER_NOT_ASSIGNED", "Сначала назначьте монтажёра в существующих настройках монтажа");
  // Монтажёр — назначенный в Настройках и не отключённый; роль не важна (lib/montajerHandover.ts::usableMontajerWhere).
  const editor = await prisma.agent.findFirst({ where: usableMontajerWhere(editorId), select: { telegramChatId: true } });
  if (!editor) throw new NarrationDeliveryRefused("MONTAJER_INACTIVE", "Назначенный монтажёр отключён: выберите монтажёра в настройках монтажа");
  if (!editor.telegramChatId) throw new NarrationDeliveryRefused("MONTAJER_NO_TELEGRAM", "У назначенного монтажёра не подключён Telegram");
  // Новый порядок (11.11.2026): голос накладывает CRM, монтажёру озвучка — для длины и темпа.
  const parsedConfig = narrationConfigSchema.safeParse(settings?.propertyNarrationConfig ?? {});
  const mixByCrm = parsedConfig.success && narrationMixByCrm(parsedConfig.data);
  // С 12.11.2026 по умолчанию голос вклеивает монтажёр (музыка и громкость его); сдаёт он один готовый ролик (19.11.2026).
  // «Замените только голос» — только когда наш голос в ролике уже есть, то есть голос монтажёру раньше уходил (SENT).
  // Возврат «вклейте голос» тоже идёт с причиной NARRATION_CHANGED, а голоса в том ролике не было (ревью 19.11).
  const soundOnly = p.videoHandoffRemakeReason === "NARRATION_CHANGED"
    && (await prisma.propertyNarrationDelivery.count({ where: { propertyId: p.id, status: "SENT" } })) > 0;
  // Второй файл «без голоса» не просим (одно решение — narrationMontajerNote.ts::askMontajerForVoicelessCopy).
  const hint = voicelessCopyHint();
  const audioCaption = mixByCrm
    ? `Объект №${p.shortId}. Озвучка, версия ${version.revision}: под неё длина и темп. Пришлите ролик БЕЗ голоса (музыка и звуки можно), голос CRM наложит сама. Ролик не короче озвучки.`
    : soundOnly
      ? `Озвучка к ролику №${p.shortId}, версия ${version.revision}: замените в ролике только голос, музыку и монтаж не трогайте.${hint}`
      : `Озвучка к ролику №${p.shortId}, версия ${version.revision}, одобрена. Вклейте этот голос сами: музыка, громкость и монтаж ваши.${hint}`;
  // Текст озвучки — обычным текстом в подписи к mp3, без файла .txt (владелец 19.11.2026: «текст зачем отдельным файлом?»).
  const files: Plan["files"] = voiceFilesWithText({ id: version.id, storageKey: version.storageKey, filename: `property-${p.shortId}-voice-v${version.revision}.mp3`, caption: audioCaption }, version.script, `${version.id}-text`);
  if (mode === "WITH_SOURCES") {
    if (!sources.videos.length) throw new NarrationDeliveryRefused("NO_SOURCES", "У объекта нет исходников");
    for (const video of sources.videos) files.push({ id: video.id, storageKey: video.storageKey, filename: video.filename, caption: `Объект №${p.shortId}. Исходник. Озвучка v${version.revision}.\n${sources.factsText}` });
  }
  return { editorId, plan: { factsHash: version.factsHash, recipientHash: mediaRecipientHash(editorId, editor.telegramChatId), files,
    sourcesHash: narrationHash(mode === "WITH_SOURCES" ? sources.videos.map(v => [v.id, v.storageKey]) : []), ...(mixByCrm ? { mixByCrm: true } : {}) } satisfies Plan };
}

export async function executeNarrationDelivery(id: string) {
  if (mediaExecutionMode("NARRATION") !== "LIVE") return { status: "PREVIEW" };
  const claimStartedAt = new Date();
  const claim = await prisma.propertyNarrationDelivery.updateMany({ where: { id, status: "QUEUED", executionMode: "LIVE" }, data: { status: "SENDING", claimStartedAt } });
  if (!claim.count) return { status: "NOT_CLAIMED" };
  let attempted = false, acknowledged = 0;
  try {
    const row = await prisma.propertyNarrationDelivery.findUniqueOrThrow({ where: { id } });
    const plan = planSchema.parse(row.plan);
    for (const file of upgradeLegacyScript(plan.files)) {
      // Resolve a bounded local handle before the short DB preflight. No network under locks.
      let blob: Blob | null = null;
      if (file.storageKey !== NARRATION_TEXT_MESSAGE) {
        const path = localVideoFilePath(file.storageKey);
        if (!path) throw new Error("Invalid storage key");
        const size = (await stat(path)).size;
        if (!size || size > TELEGRAM_BOT_SEND_LIMIT_BYTES) throw new Error("File unavailable or exceeds Telegram limit");
        blob = await openAsBlob(path);
      }
      const target = await prisma.$transaction(async tx => {
        await tx.$queryRaw`SELECT id FROM "Property" WHERE id = ${row.propertyId} FOR NO KEY UPDATE`;
        await tx.$queryRaw`SELECT id FROM "PropertyNarrationDelivery" WHERE id = ${id} FOR UPDATE`;
        const currentDelivery = await tx.propertyNarrationDelivery.findUnique({ where: { id } });
        if (currentDelivery?.status !== "SENDING" || currentDelivery.claimStartedAt?.getTime() !== claimStartedAt.getTime()) return { refused: null };
        const p = await tx.property.findUnique({ where: { id: row.propertyId }, include: { district: true } });
        const latest = await tx.propertyNarrationVersion.findFirst({ where: { propertyId: row.propertyId }, orderBy: { revision: "desc" } });
        const settings = await tx.settings.findUnique({ where: { id: "singleton" }, select: { videoMontajerAgentId: true } });
        const editor = row.editorId ? await tx.agent.findFirst({ where: usableMontajerWhere(row.editorId) }) : null;
        const videos = row.mode === "WITH_SOURCES" ? await tx.propertyVideo.findMany({ where: { propertyId: row.propertyId }, orderBy: [{ uploadedAt: "asc" }, { id: "asc" }] }) : [];
        // Версия та же и актуальна, а объект сейчас НЕ у монтажёра (монтажёр нажал «Сделаю позже» или взял другой,
        // 19.11.2026) — передача ЖДЁТ (WAITING): обход озвучки отправит её, когда объект вернётся к монтажёру
        // (narrationAutoFlow.ts::queueNarrationDelivery берёт ту же строку). Раньше она гасла в FAILED, а обход версию
        // с любой передачей больше не брал — объект монтировался без голоса.
        const versionCurrent = !!p && !!latest && latest.id === row.versionId && latest.status === "READY" && latest.factsHash === plan.factsHash && narrationFactsCurrent(latest, p);
        if (mediaExecutionMode("NARRATION") === "LIVE" && p && !p.deletedAt && !p.narrationOff && versionCurrent && (p.videoHandoffStatus === "QUEUED" || (p.videoHandoffStatus === "SENT_TO_EDITOR" && p.videoHandoffManualSince))) return { refused: null, waiting: true };
        // Остальные штатные причины («Без озвучки», объект удалён, версию сменила новая, факты поменялись) — молча, без
        // повтора: новую версию обход отправит сам. Монтажёра сменили, у него пропал Telegram, поменялись исходники —
        // голос не уйдёт сам, нужен журнал.
        if (mediaExecutionMode("NARRATION") !== "LIVE" || !p || p.deletedAt || p.narrationOff || p.videoHandoffStatus !== "SENT_TO_EDITOR" || p.videoHandoffManualSince || !versionCurrent) return { refused: null };
        if (settings?.videoMontajerAgentId !== row.editorId) return { refused: "монтажёра сменили в Настройках после постановки передачи" };
        if (!editor) return { refused: "монтажёр отключён" };
        if (!editor.telegramChatId || mediaRecipientHash(editor.id, editor.telegramChatId) !== plan.recipientHash) return { refused: "у монтажёра сменился или пропал Telegram" };
        if (narrationHash(videos.map(v => [v.id, v.storageKey])) !== plan.sourcesHash) return { refused: "исходники объекта поменялись" };
        return { chatId: editor.telegramChatId, shortId: p.shortId };
      });
      if ("refused" in target) {
        const waiting = "waiting" in target && target.waiting && !acknowledged;
        const status = waiting ? "WAITING" : acknowledged ? "CANCELLED" : "FAILED";
        const lastError = waiting
          ? "Объект сейчас не у монтажёра (вернулся в очередь). Вернётся к нему — голос уйдёт; снимут с монтажа — передача отменится."
          : "Назначение, очередь монтажа, факты, файлы или версия изменились. Полученные квитанции сохранены.";
        const done = await prisma.propertyNarrationDelivery.updateMany({ where: { id, status: "SENDING", claimStartedAt }, data: { status, lastError, ...(waiting ? { claimStartedAt: null } : {}) } });
        if (done.count && status === "FAILED" && target.refused) reportNarrationDeliveryProblem(row.propertyId, id, "FAILED", target.refused);
        return { status };
      }
      attempted = true;
      // An in-flight request may finish after revocation; it cannot authorize a next file.
      let sent: { message_id: number; document?: { file_id?: string } };
      if (blob) {
        const doc = await sendDocumentFile(target.chatId, blob, file.filename, file.caption, 60_000, true);
        if (!doc.message_id) throw new Error("Missing Telegram receipt");
        sent = { message_id: doc.message_id, document: doc.document };
      } else {
        // Текст озвучки, не влезший в подпись, — обычным сообщением; длиннее 4096 sendMessage делит сам.
        const messageId = telegramMessageId(await sendMessage(target.chatId, `Текст озвучки №${target.shortId}:\n${file.caption}`, undefined, undefined, { singleAttempt: true, requireReply: true }));
        if (!messageId) throw new Error("Missing Telegram receipt");
        sent = { message_id: messageId };
      }
      const stillClaimed = await prisma.$transaction(async tx => {
        await tx.$queryRaw`SELECT id FROM "PropertyNarrationDelivery" WHERE id = ${id} FOR UPDATE`;
        const current = await tx.propertyNarrationDelivery.findUnique({ where: { id } });
        if (!current || current.claimStartedAt?.getTime() !== claimStartedAt.getTime()) return false;
        const active = current.status === "SENDING";
        const previous = current.receipts && typeof current.receipts === "object" && !Array.isArray(current.receipts) ? current.receipts : {};
        await tx.propertyNarrationDelivery.updateMany({ where: { id, claimStartedAt }, data: { receipts: { ...previous, [file.id]: { messageId: sent.message_id, fileId: sent.document?.file_id ?? null, receivedAt: new Date().toISOString(), late: !active } } } });
        return active;
      });
      acknowledged++;
      if (!stillClaimed) return { status: "UNKNOWN" };
    }
    const completed = await prisma.propertyNarrationDelivery.updateMany({ where: { id, status: "SENDING", claimStartedAt }, data: { status: "SENT", deliveredAt: new Date() } });
    return { status: completed.count ? "SENT" : "UNKNOWN" };
  } catch (err) {
    const status = attempted ? "UNKNOWN" : "FAILED";
    const done = await prisma.propertyNarrationDelivery.updateMany({ where: { id, status: "SENDING", claimStartedAt }, data: { status, lastError: attempted ? "Проверьте Telegram монтажёра. Автоповтор отключён; квитанции успешных частей сохранены." : "Передача не началась: проверьте локальные файлы и настройки" } });
    if (done.count) {
      const row = await prisma.propertyNarrationDelivery.findUnique({ where: { id }, select: { propertyId: true } });
      if (row) reportNarrationDeliveryProblem(row.propertyId, id, status, err instanceof Error ? err.message : String(err));
    }
    return { status };
  }
}

/**
 * ОТКАЗ САМОЙ ОТПРАВКИ — В ЖУРНАЛ ОШИБОК (ревью 19.11.2026). Автоповтора у передачи нет намеренно: FAILED значит
 * «до Telegram не дошло», но повтор тех же условий (нет файла, сменили монтажёра) упадёт так же, а UNKNOWN мог
 * дойти — повтор дал бы монтажёру второй файл. Поэтому — запись с номером объекта и что сделать человеку:
 * FAILED — передать вручную в карточке; UNKNOWN — сначала сверка («Сверка неопределённой доставки»), потом вручную.
 * Сторож обхода (narrationAutoFlow.ts::watchStuckVoiceDeliveries) повторяет напоминание, пока голос не ушёл.
 */
export function reportNarrationDeliveryProblem(propertyId: string, deliveryId: string, status: "FAILED" | "UNKNOWN", reason: string) {
  void (async () => {
    const p = await prisma.property.findUnique({ where: { id: propertyId }, select: { shortId: true } });
    const what = status === "FAILED"
      ? "голос монтажёру не ушёл. Автоповтора нет — передайте вручную: карточка объекта → «Передача монтажёру вручную»"
      : "неизвестно, дошёл ли голос до монтажёра. Сверьте в карточке объекта («Сверка неопределённой доставки»), затем при необходимости передайте вручную";
    await logSystemError("api", `Озвучка объекта №${p?.shortId ?? "?"}: ${what}. Причина: ${reason}`, { dedupKey: `narration-delivery-outcome:${deliveryId}:${status}`, dedupWindowMs: 6 * 60 * 60_000 });
  })().catch(() => undefined);
}

/** Передача, которая сама уже не завершится: UNKNOWN (нужна сверка) или SENDING дольше бюджета попытки. */
export function narrationDeliveryStalled(d: { status: string; claimStartedAt: Date | null; plan: unknown }, now: Date = new Date()): boolean {
  if (d.status === "UNKNOWN") return true;
  return d.status === "SENDING" && !!d.claimStartedAt && now.getTime() - d.claimStartedAt.getTime() > narrationDeliveryAttemptBudgetMs(d.plan);
}
/**
 * ОЗВУЧКА ПЕРЕХОДИТ К ТЕКУЩЕМУ МОНТАЖЁРУ (решение владельца 11.11.2026: «когда
 * удаляем монтажёра, всё идёт к новому»). Посылка озвучки привязана к editorId
 * своей строки: при смене монтажёра ждущая посылка гасла на сверке перед отправкой
 * («назначение изменилось»), а доставленная оставалась у прежнего — новый
 * монтажёр монтировал держателя места без озвучки.
 *
 * Для держателя места (тот же, кого досылает montajerHandover.ts) и его последней
 * готовой версии: если озвучка была отправлена или ждала отправки ДРУГОМУ
 * монтажёру, а у текущего её нет — ставим текущему свою посылку AUDIO_ONLY
 * (исходники уходят основной передачей очереди). Ждущую посылку прежнему
 * гасим, пока она не начата. Ключ requestKey выводится из исходной строки и
 * текущего монтажёра — повторный тик вторую посылку не заведёт. Посылки
 * в полёте (SENDING) и требующие сверки (UNKNOWN) не трогаем: автоповтора нет.
 * Пока внешняя отправка выключена (PREVIEW), не делаем ничего.
 */
export async function handOverNarrationToCurrentMontajer(currentEditorId: string): Promise<boolean> {
  if (mediaExecutionMode("NARRATION") !== "LIVE") return false;
  const holder = await prisma.property.findFirst({ where: EDITOR_HOLDER_WHERE, select: { id: true } });
  if (!holder) return false;
  const latest = await prisma.propertyNarrationVersion.findFirst({ where: { propertyId: holder.id }, orderBy: { revision: "desc" } });
  if (!latest || latest.status !== "READY") return false;
  const rows = await prisma.propertyNarrationDelivery.findMany({
    where: { propertyId: holder.id, versionId: latest.id },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
  if (rows.some((r) => r.editorId === currentEditorId && ["QUEUED", "SENDING", "SENT", "UNKNOWN", "CANCELLED"].includes(r.status))) return false;
  if (rows.some((r) => r.status === "SENDING" || r.status === "UNKNOWN")) return false;
  const source = rows.find((r) => r.editorId && r.editorId !== currentEditorId && (r.status === "SENT" || r.status === "QUEUED"));
  if (!source) return false;
  let prepared: Awaited<ReturnType<typeof prepareNarrationDeliveryPlan>>;
  try {
    prepared = await prepareNarrationDeliveryPlan(holder.id, latest.id, "AUDIO_ONLY", currentEditorId);
  } catch (err) {
    // Нет Telegram у монтажёра, факты устарели и т.п. — отправлять нечего; сверка повторится тиком.
    // Не штатная причина — в журнал ошибок, не тишина (19.11.2026: так же молча гас голос при роли MARKETING).
    if (!(err instanceof NarrationDeliveryRefused && narrationDeliveryRefusalIsExpected(err.code))) {
      void logSystemError("api", `Озвучка: новому монтажёру голос не передан — ${err instanceof Error ? err.message : String(err)}`,
        { dedupKey: `narration-handover-refused:${holder.id}:${err instanceof NarrationDeliveryRefused ? err.code : "UNEXPECTED"}`, dedupWindowMs: 6 * 60 * 60_000 });
    }
    return false;
  }
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Property" WHERE id = ${holder.id} FOR UPDATE`;
    if (source.status === "QUEUED") {
      await tx.propertyNarrationDelivery.updateMany({
        where: { id: source.id, status: "QUEUED" },
        data: { status: "CANCELLED", lastError: "Монтажёра сменили — озвучка передана текущему монтажёру" },
      });
    }
    if (await tx.propertyNarrationDelivery.count({ where: { propertyId: holder.id, status: { in: ["QUEUED", "SENDING", "UNKNOWN"] } } })) return false;
    const requestKey = `montajer-handover:${source.id}:${currentEditorId}`;
    if (await tx.propertyNarrationDelivery.findUnique({ where: { requestKey }, select: { id: true } })) return false;
    await tx.propertyNarrationDelivery.create({
      data: {
        propertyId: holder.id,
        versionId: latest.id,
        editorId: prepared.editorId,
        mode: "AUDIO_ONLY",
        requestKey,
        createdById: source.createdById,
        plan: prepared.plan,
        status: "QUEUED",
        executionMode: "LIVE",
      },
    });
    return true;
  });
}

export async function executeQueuedNarrationDeliveries(now = new Date()) {
  if (mediaExecutionMode("NARRATION") !== "LIVE") return;
  // A legitimate multi-file batch can exceed three minutes. Each file is one bounded
  // 60s request plus 30s file/preflight/receipt margin; no network under DB locks.
  const pending = await prisma.propertyNarrationDelivery.findMany({ where: { status: "SENDING", claimStartedAt: { lt: new Date(now.getTime() - 180_000) } }, select: { id: true, propertyId: true, status: true, claimStartedAt: true, plan: true } });
  for (const row of pending) {
    if (!narrationDeliveryStalled(row, now)) continue;
    const done = await prisma.propertyNarrationDelivery.updateMany({ where: { id: row.id, status: "SENDING", claimStartedAt: row.claimStartedAt }, data: { status: "UNKNOWN", lastError: "Прерванная передача; нужна сверка с Telegram монтажёра" } });
    if (done.count) reportNarrationDeliveryProblem(row.propertyId, row.id, "UNKNOWN", "отправка прервалась (процесс остановлен или завис)");
  }
  const rows = await prisma.propertyNarrationDelivery.findMany({ where: { status: "QUEUED", executionMode: "LIVE" }, orderBy: { createdAt: "asc" }, take: 20, select: { id: true } });
  for (const row of rows) await executeNarrationDelivery(row.id);
}
