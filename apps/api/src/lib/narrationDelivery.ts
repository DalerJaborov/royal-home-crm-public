import { openAsBlob } from "node:fs";
import { stat } from "node:fs/promises";
import { z } from "zod";
import { narrationConfigSchema, narrationCurrencyError, narrationMixByCrm } from "@royal-home/shared";
import { prisma, type TxClient } from "../db.js";
import { buildMontajerDelivery, EDITOR_HOLDER_WHERE } from "./videoHandoff.js";
import { usableMontajerWhere } from "./montajerHandover.js";
import { NARRATION_PRICE_NOT_IN_TJS_TEXT, narrationFactsCurrent, narrationHash } from "./propertyNarration.js";
import { localVideoFilePath } from "./localVideoStorage.js";
import { mediaExecutionMode, mediaRecipientHash } from "./mediaExecution.js";
import { sendDocumentFile, sendMessage, TELEGRAM_BOT_SEND_LIMIT_BYTES, TELEGRAM_CAPTION_MAX_CHARS, TelegramApiError } from "../telegram/api.js";
import { VOICELESS_COPY_HINT, voicelessCopyHint } from "./narrationMontajerNote.js";
import { currentMontajerTexts } from "./montajerTexts.js";
import { logSystemError } from "./systemError.js";
import { montageCopyNote, sendMontageCopies } from "./montageObservers.js";

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
/**
 * КОПИЯ ОЗВУЧКИ НАБЛЮДАТЕЛЯМ МОНТАЖА (21.11.2026, владелец: «я получаю копию, а озвучки мне не приходят»).
 * Голос и текст уходили монтажёру прямым sendDocumentFile/sendMessage — мимо общей двери копий
 * (montageObservers.ts::sendMontageCopies), поэтому наблюдатель видел строку «озвучка придёт отдельным
 * mp3», а самого mp3 не видел никогда. Копия — после квитанции монтажёра, тем же файлом и той же
 * подписью с пометкой «Копия. Монтажёр: …»; отказ копии в журнал и не трогает передачу, квитанции
 * и статус (наблюдатель — не адресат передачи).
 */
export function narrationCopyMessages(note: string, file: PlanFile, shortId: number): { caption: string | null; text: string | null } {
  const textMessage = (script: string) => `${note}\n\nТекст озвучки №${shortId}:\n${script}`;
  if (file.storageKey === NARRATION_TEXT_MESSAGE) return { caption: null, text: textMessage(file.caption) };
  const full = `${note}\n\n${file.caption}`;
  if (full.length <= TELEGRAM_CAPTION_MAX_CHARS) return { caption: full, text: null };
  // С пометкой «Копия» подпись с текстом не влезла — текст отдельным сообщением, как у монтажёра.
  const marker = "\n\nТекст:\n";
  const at = file.caption.indexOf(marker);
  const head = at >= 0 ? file.caption.slice(0, at) : file.caption;
  return { caption: `${note}\n\n${head}`.slice(0, TELEGRAM_CAPTION_MAX_CHARS), text: at >= 0 ? textMessage(file.caption.slice(at + marker.length)) : null };
}
async function copyNarrationToObservers(editorId: string, montajerName: string | null, shortId: number, file: PlanFile): Promise<void> {
  try {
    const parts = narrationCopyMessages(montageCopyNote(montajerName), file, shortId);
    await sendMontageCopies(editorId, `озвучка объекта №${shortId}`, async (chatId) => {
      if (parts.caption !== null) {
        const path = localVideoFilePath(file.storageKey);
        if (!path) throw new Error("Invalid storage key");
        await sendDocumentFile(chatId, await openAsBlob(path), file.filename, parts.caption, 60_000, true);
      }
      if (parts.text) await sendMessage(chatId, parts.text, undefined, undefined, { singleAttempt: true });
    });
  } catch (err) {
    void logSystemError("video-handoff", `Копия озвучки объекта №${shortId} наблюдателям не отправилась: ${err instanceof Error ? err.message : String(err)}`);
  }
}
function telegramMessageId(sent: unknown): number | null {
  if (!sent || typeof sent !== "object" || !("message_id" in sent)) return null;
  return typeof sent.message_id === "number" ? sent.message_id : null;
}

/** Одна отправка файла голоса (60 с) и запас на файл в бюджете попытки (narrationDeliveryAttemptBudgetMs). */
const NARRATION_SEND_TIMEOUT_MS = 60_000;
const NARRATION_FILE_BUDGET_MS = 90_000;
/**
 * 429 — TELEGRAM ТОЧНО НЕ ПРИНЯЛ, ПОВТОР БЕЗОПАСЕН (ревью 21.11.2026). Голос идёт одной попыткой (singleAttempt):
 * повтор после обрыва или таймаута мог бы дать монтажёру второй mp3. Но «слишком часто» (429) — однозначный
 * отказ, файла у монтажёра нет; а mp3 идёт сразу за файлами ролика в тот же чат и в лимит упирается первым.
 * Раньше такой отказ уводил передачу в UNKNOWN без повтора — голос терялся. Ждём, сколько просит Telegram
 * (retry_after + 1 с), и повторяем — до двух раз и только пока ожидание с новой попыткой укладывается в бюджет
 * файла (иначе сторож зависших счёл бы живую отправку зависшей). Остальные ошибки — как были, без повтора.
 */
const NARRATION_RATE_LIMIT_RETRIES = 2;
export async function retryTelegramRateLimit<T>(send: () => Promise<T>, wait: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  now: () => number = Date.now): Promise<T> {
  const started = now();
  for (let attempt = 0; ; attempt++) {
    try {
      return await send();
    } catch (err) {
      const after = err instanceof TelegramApiError && err.errorCode === 429 ? err.retryAfterSec : undefined;
      const waitMs = typeof after === "number" && after >= 0 ? after * 1000 + 1000 : null;
      const fits = waitMs !== null && now() - started + waitMs + NARRATION_SEND_TIMEOUT_MS <= NARRATION_FILE_BUDGET_MS - 5_000;
      if (!fits || attempt >= NARRATION_RATE_LIMIT_RETRIES) throw err;
      await wait(waitMs!);
    }
  }
}

/** Shared by watchdog and manual reconciliation; a whole batch may exceed 3 minutes. Per file: one bounded 60s
 *  request (429 retries stay inside it, retryTelegramRateLimit), plus margin. */
export function narrationDeliveryAttemptBudgetMs(plan: unknown): number {
  const parsed = planSchema.safeParse(plan);
  return (parsed.success ? parsed.data.files.length : 1) * NARRATION_FILE_BUDGET_MS + 120_000;
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
  | "NO_SOURCES"
  /** В тексте версии цена в долларах (21.11.2026): такой голос монтажёру не уходит. */
  | "PRICE_NOT_IN_TJS";
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

/** Отказ «ролик ещё не дошёл» — человеку в карточке: что будет и что сделать, если ждать нельзя. */
export const NARRATION_WAITS_FOR_VIDEO_TEXT = "Ролик ещё не дошёл до монтажёра: голос уйдёт сам сразу следом за ним. Срочно — передайте голос вместе с исходниками";
/** Передача, которой нужно видео у монтажёра: только голос (AUDIO_ONLY). С исходниками видео едет в ней самой. */
export function narrationWaitsForVideo(mode: string): boolean {
  return mode !== "WITH_SOURCES";
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
  // ГОЛОС — ТОЛЬКО СЛЕДОМ ЗА ВИДЕО (21.11.2026, объект №211): место монтажёра занято раньше, чем дошли файлы
  // (dispatchToEditor пишет videoHandoffDeliveredAt только когда КАЖДЫЙ файл у монтажёра). mp3 до видео терялся:
  // монтажёр получал голос на сутки раньше ролика. Видео ещё не дошло — ждём, голос уйдёт сразу за ним.
  // Только для голоса без исходников: передача С ИСХОДНИКАМИ из карточки и есть ручной путь на случай, когда
  // автоотправка видео сломалась (ревью 21.11) — её не держим.
  if (!p.videoHandoffDeliveredAt && narrationWaitsForVideo(mode)) throw new NarrationDeliveryRefused("NOT_WITH_MONTAJER", NARRATION_WAITS_FOR_VIDEO_TEXT);
  if (!version || version.propertyId !== p.id || !version.storageKey || version.status !== "READY" || !narrationFactsCurrent(version, p)) throw new NarrationDeliveryRefused("VERSION_STALE", "Нужна актуальная озвучка");
  // Одобренная до сторожа версия с долларами (21.11.2026) монтажёру не уходит ни одним путём.
  if (narrationCurrencyError(version.script)) throw new NarrationDeliveryRefused("PRICE_NOT_IN_TJS", `Озвучка не отправлена: ${NARRATION_PRICE_NOT_IN_TJS_TEXT}`);
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
  // Слова подписи — lib/montajerTexts.ts (короткий вид 28.11.2026: «Объект №N · 🎙 голос, версия R. Вклейте его сами…»).
  const texts = await currentMontajerTexts();
  const audioCaption = texts.voiceCaption(p.shortId, version.revision, mixByCrm ? "mix" : soundOnly ? "soundOnly" : "plain", voicelessCopyHint());
  // Текст озвучки — обычным текстом в подписи к mp3, без файла .txt (владелец 19.11.2026: «текст зачем отдельным файлом?»).
  const files: Plan["files"] = voiceFilesWithText({ id: version.id, storageKey: version.storageKey, filename: `property-${p.shortId}-voice-v${version.revision}.mp3`, caption: audioCaption }, version.script, `${version.id}-text`);
  if (mode === "WITH_SOURCES") {
    if (!sources.videos.length) throw new NarrationDeliveryRefused("NO_SOURCES", "У объекта нет исходников");
    for (const video of sources.videos) files.push({ id: video.id, storageKey: video.storageKey, filename: video.filename, caption: texts.sourceWithVoiceCaption(p.shortId, version.revision, sources.factsText) });
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
  // Копии наблюдателям — ПОСЛЕ передачи, вне её бюджета времени (сторож зависших передач меряет SENDING).
  const copies: Array<() => Promise<void>> = [];
  const flushCopies = async () => { for (const copy of copies.splice(0)) await copy(); };
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
        // Место у монтажёра, а видео нового круга ещё не дошло (21.11.2026) — тоже ждём: голос не обгоняет ролик.
        if (mediaExecutionMode("NARRATION") === "LIVE" && p && !p.deletedAt && !p.narrationOff && versionCurrent
          && (p.videoHandoffStatus === "QUEUED" || (p.videoHandoffStatus === "SENT_TO_EDITOR" && (p.videoHandoffManualSince || (!p.videoHandoffDeliveredAt && narrationWaitsForVideo(row.mode)))))) return { refused: null, waiting: true };
        // Остальные штатные причины («Без озвучки», объект удалён, версию сменила новая, факты поменялись) — молча, без
        // повтора: новую версию обход отправит сам. Монтажёра сменили, у него пропал Telegram, поменялись исходники —
        // голос не уйдёт сам, нужен журнал.
        if (mediaExecutionMode("NARRATION") !== "LIVE" || !p || p.deletedAt || p.narrationOff || p.videoHandoffStatus !== "SENT_TO_EDITOR" || p.videoHandoffManualSince || (!p.videoHandoffDeliveredAt && narrationWaitsForVideo(row.mode)) || !versionCurrent) return { refused: null };
        if (settings?.videoMontajerAgentId !== row.editorId) return { refused: "монтажёра сменили в Настройках после постановки передачи" };
        if (!editor) return { refused: "монтажёр отключён" };
        if (!editor.telegramChatId || mediaRecipientHash(editor.id, editor.telegramChatId) !== plan.recipientHash) return { refused: "у монтажёра сменился или пропал Telegram" };
        if (narrationHash(videos.map(v => [v.id, v.storageKey])) !== plan.sourcesHash) return { refused: "исходники объекта поменялись" };
        return { chatId: editor.telegramChatId, shortId: p.shortId, editorId: editor.id, montajerName: editor.fullName };
      });
      if ("refused" in target) {
        const waiting = "waiting" in target && target.waiting && !acknowledged;
        const status = waiting ? "WAITING" : acknowledged ? "CANCELLED" : "FAILED";
        const lastError = waiting
          ? "Ролика у монтажёра сейчас нет (объект в очереди или файлы ещё идут). Дойдёт ролик — голос уйдёт следом; снимут с монтажа — передача отменится."
          : "Назначение, очередь монтажа, факты, файлы или версия изменились. Полученные квитанции сохранены.";
        const done = await prisma.propertyNarrationDelivery.updateMany({ where: { id, status: "SENDING", claimStartedAt }, data: { status, lastError, ...(waiting ? { claimStartedAt: null } : {}) } });
        if (done.count && status === "FAILED" && target.refused) reportNarrationDeliveryProblem(row.propertyId, id, "FAILED", target.refused);
        await flushCopies();
        return { status };
      }
      attempted = true;
      // An in-flight request may finish after revocation; it cannot authorize a next file.
      let sent: { message_id: number; document?: { file_id?: string } };
      if (blob) {
        const fileBlob = blob;
        const doc = await retryTelegramRateLimit(() => sendDocumentFile(target.chatId, fileBlob, file.filename, file.caption, 60_000, true));
        if (!doc.message_id) throw new Error("Missing Telegram receipt");
        sent = { message_id: doc.message_id, document: doc.document };
      } else {
        // Текст озвучки, не влезший в подпись, — обычным сообщением; длиннее 4096 sendMessage делит сам.
        const messageId = telegramMessageId(await retryTelegramRateLimit(() => sendMessage(target.chatId, `Текст озвучки №${target.shortId}:\n${file.caption}`, undefined, undefined, { singleAttempt: true, requireReply: true })));
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
      // Монтажёр файл получил — копия наблюдателям (владелец). Только после квитанции и только этот файл.
      const copied = { ...target, file };
      copies.push(() => copyNarrationToObservers(copied.editorId, copied.montajerName, copied.shortId, copied.file));
      if (!stillClaimed) { await flushCopies(); return { status: "UNKNOWN" }; }
    }
    const completed = await prisma.propertyNarrationDelivery.updateMany({ where: { id, status: "SENDING", claimStartedAt }, data: { status: "SENT", deliveredAt: new Date() } });
    await flushCopies();
    return { status: completed.count ? "SENT" : "UNKNOWN" };
  } catch (err) {
    // Что монтажёр уже получил, наблюдатель тоже видит; копия никогда не меняет исход передачи.
    await flushCopies().catch(() => undefined);
    // Telegram ответил отказом (TelegramApiError — ok:false, в том числе 429 после повторов) и ничего ещё не принял —
    // голос точно не дошёл: FAILED («передайте вручную»), а не «неизвестно, сверьте» (ревью 21.11.2026).
    const status = attempted && !(acknowledged === 0 && err instanceof TelegramApiError) ? "UNKNOWN" : "FAILED";
    const done = await prisma.propertyNarrationDelivery.updateMany({ where: { id, status: "SENDING", claimStartedAt }, data: { status, lastError: status === "UNKNOWN" ? "Проверьте Telegram монтажёра. Автоповтор отключён; квитанции успешных частей сохранены."
      : attempted ? "Telegram отказал, голос монтажёру не ушёл. Автоповтора нет — передайте вручную." : "Передача не началась: проверьте локальные файлы и настройки" } });
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
 * КОГДА ВИДЕО ТЕКУЩЕЙ ВЫДАЧИ ДОШЛО ДО ЭТОГО МОНТАЖЁРА (21.11.2026, объект №211). Голос монтажёру идёт
 * только следом за видео, и выдача видео — это его «номер круга»: первая отправка, очередь, «Пропустить» /
 * «Взять другой» из бота, перемонтаж, смена монтажёра — каждый путь шлёт файлы через dispatchToEditor,
 * а он ставит на каждом дошедшем файле отметку PropertyVideo.montajerDeliveredAt / montajerDeliveredToId
 * (новый круг их гасит: videoHandoff.ts::resetMontajerDeliveryMarks). Самая поздняя отметка ЭТОГО монтажёра —
 * момент выдачи. null — видео этой выдачи у него нет: объект не держит место, файлы ещё идут
 * (videoHandoffDeliveredAt пуст), открыт под ручной приём или файлы ушли другому монтажёру.
 * Отметок нет совсем (видео доставлено до 25.09.2026, когда их ввели) — момент полной доставки.
 * Отметка двигается, только когда файл реально ушёл, поэтому слово «файлы» без недошедших её не трогает.
 */
export async function videoIssuedToEditorAt(db: Pick<TxClient, "property" | "propertyVideo">, propertyId: string, editorId: string): Promise<Date | null> {
  const p = await db.property.findFirst({ where: { id: propertyId, ...EDITOR_HOLDER_WHERE }, select: { videoHandoffDeliveredAt: true } });
  if (!p?.videoHandoffDeliveredAt) return null;
  const [mine, any] = await Promise.all([
    db.propertyVideo.aggregate({ where: { propertyId, montajerDeliveredToId: editorId, montajerDeliveredAt: { not: null } }, _max: { montajerDeliveredAt: true } }),
    db.propertyVideo.count({ where: { propertyId, montajerDeliveredAt: { not: null } } }),
  ]);
  if (mine._max.montajerDeliveredAt) return mine._max.montajerDeliveredAt;
  return any ? null : p.videoHandoffDeliveredAt;
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
