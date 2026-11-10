import { z } from "zod";
import sharp from "sharp";
import { expenseDateSchema } from "@royal-home/shared";
import { claimAgentAiAction } from "../lib/agentAiActionCap.js";
import {
  claimExpensePreview, decideExpensePhotoDraft, expenseReceiptHash, findExpensePhotoDraft, getExpenseDirector,
  markExpensePreviewDelivered, MAX_EXPENSE_RECEIPT_BYTES, parseExpenseReceiptEvidence, releaseRejectedExpensePreview, stageExpensePhotoDraft,
  type ExpenseReceiptEvidence,
} from "../lib/telegramExpenseReceipts.js";
import { extractExpenseReceipt } from "../ai/assistant/expenseReceiptExtraction.js";
import { readExpensePdfText, renderExpenseReceiptPdf } from "../ai/assistant/mediaProbe.js";
import { expenseRowsFromTable } from "../lib/expenseTableRows.js";
import { loadAssistantSettings } from "../ai/assistant/runtime.js";
import { assistantLanguage } from "../ai/assistant/languageRouting.js";
import type { AssistantMoneyWallet } from "../ai/assistant/moneyBudget.js";
import { downloadAssistantMedia } from "./assistantMedia.js";
import { answerCallbackQuery, editMessageText, sendMessage, sendMessageWithButtons, TelegramApiError, type TelegramCallbackQuery, type TelegramIncomingMessage } from "./api.js";
import { prisma } from "../db.js";
import { todayExpenseDay } from "../lib/expenseWorkspace.js";
import {
  intakeText, knownBatch, normalizeReceiptPhoto, PDF_MAX_BYTES, PDF_MAX_PAGES, pdfPageNotesText, rowsFromPdf, rowsFromSpreadsheet, rowsFromTablePhoto, sourceHashOf, spreadsheetKind, stageExpenseBatch, type SpreadsheetKind,
} from "./assistantExpenseBatchIntake.js";
import { collectExpenseAlbumPhoto, hasExpenseAlbum } from "./assistantExpenseAlbum.js";

const EXPENSE_CALLBACK = /^ef:(yes|no):(ru|tg):([0-9a-f-]{36})$/u;
// Подпись-намерение на четырёх языках (10.11.2026): «расходы за октябрь», «харҷҳо», «xarajatlar», «expenses».
const expenseIntent = /^(?:\/?чек|расход\p{L}*|харҷ\p{L}*|расид|запиши|внеси|сабт\s+кун|xarajat\p{L}*|harajat\p{L}*|expenses?|receipts?)(?=$|[\s:.,!?])/iu;
const dailyExpenseReceipts = 15;
const fileSchema = z.object({ file_id: z.string().min(1).max(1024), file_size: z.number().int().positive().optional() });
const receiptMessage = z.object({
  message_id: z.number().int().positive().max(2_147_483_647),
  chat: z.object({ id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), type: z.literal("private") }),
  from: z.object({ id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), is_bot: z.literal(false).optional() }),
  photo: z.array(fileSchema).min(1).max(20).optional(),
  document: fileSchema.extend({ mime_type: z.string().max(200).optional(), file_name: z.string().max(255).optional() }).optional(),
  caption: z.string().max(2048).optional(),
});

const copy = {
  ru: {
    unavailable: "Не получилось разобрать чек. Пришлите его ещё раз.",
    invalidPdf: "Пришлите PDF без пароля: до 30 страниц и до 10 МБ.",
    clarify: "Пришлите чек ещё раз и в подписи уточните только то, что не прочиталось.",
    conflict: "Данные в подписи и на чеке различаются. Проверьте сумму, валюту, дату и назначение, затем пришлите чек ещё раз.",
    noPaidReceipt: "На фото не видно, что оплата прошла. Пришлите чек с итоговой суммой и датой.",
    noPaidPdf: "На чеке не видно одной подтверждённой оплаты с итоговой суммой. Пришлите отдельный чек с суммой и датой.",
    limit: "На сегодня хватит проверок чеков. Расход можно внести в CRM.",
    preview: "Записать расход по чеку?",
    category: "Категория: прочее",
    confirm: "Записать", cancel: "Отмена",
    pending: "Этот чек уже ждёт подтверждения.",
    previewUnconfirmed: "Если кнопки не появятся, пришлите чек снова через 10 минут.",
    previewRejected: "Карточка не отправилась. Пришлите тот же чек ещё раз.",
    recorded: "Записала расход и приложила чек.",
    duplicate: "Этот чек уже есть в обработке.",
    alreadyRecorded: "Этот чек уже записан другой карточкой — второй раз не записываю.",
    cancelled: "Отменила. Расход не записан.",
    expired: "Время на подтверждение вышло. Пришлите чек снова.",
    forbidden: "Записывать чек можно только из привязанной лички директора.",
    uncertain: "Не удалось показать результат. Нажмите кнопку ещё раз.",
    noRate: "Курс доллара в Настройках CRM не задан — долларовый чек не записываю. Задайте курс в Настройках.",
  },
  tg: {
    unavailable: "Расидро хонда натавонистам. Боз фиристед.",
    invalidPdf: "PDF-ро бе рамз фиристед: то 30 саҳифа ва то 10 МБ.",
    clarify: "Расидро боз фиристед. Дар зераш фақат он чизеро нависед, ки хонда нашуд.",
    conflict: "Навиштаатон бо расид як хел нест. Маблағ, асъор, сана ва барои чӣ буданашро санҷеду расидро боз фиристед.",
    noPaidReceipt: "Аз акс маълум нест, ки пардохт шудааст. Расидро бо маблағ ва сана фиристед.",
    noPaidPdf: "Дар ин расид маблағи як пардохти анҷомшуда равшан нест. Як расид бо маблағу сана фиристед.",
    limit: "Имрӯз дигар расидро санҷида наметавонам. Харҷро дар CRM нависед.",
    preview: "Ин харҷро сабт кунам?",
    category: "Гурӯҳ: дигар харҷҳо",
    confirm: "Сабт кун", cancel: "Бекор кун",
    pending: "Ин расид ҳоло дар интизори тасдиқ аст.",
    previewUnconfirmed: "Агар тугмаҳо набароянд, баъд аз 10 дақиқа расидро боз фиристед.",
    previewRejected: "Корт нарафт. Ҳамин расидро боз фиристед.",
    recorded: "Харҷро сабт кардам ва расидро зам кардам.",
    duplicate: "Ин расид аллакай дар санҷиш аст.",
    alreadyRecorded: "Ин расид аллакай бо корти дигар сабт шудааст — дубора сабт намекунам.",
    cancelled: "Бекор шуд. Харҷ сабт нашуд.",
    expired: "Вақти тасдиқ гузашт. Расидро боз фиристед.",
    forbidden: "Расидро фақат директор аз чати шахсии пайвастшуда сабт карда метавонад.",
    uncertain: "Натиҷаро нишон дода натавонистам. Тугмаро боз занед.",
    noRate: "Қурби доллар дар Танзимоти CRM нест — расиди долларӣ сабт намекунам. Қурбро дар Танзимот гузоред.",
  },
} as const;
type Language = keyof typeof copy;
type ReceiptFields = Omit<Awaited<ReturnType<typeof extractExpenseReceipt>>, "kind" | "language">;
const currencyOf = (value: string): ExpenseReceiptEvidence["currency"] | null =>
  /^(?:USD|доллар)$/iu.test(value) ? "USD" : /^(?:TJS|сомон[иӣ])$/iu.test(value) ? "TJS" : null;
function amountMinorOf(value: string): number | null {
  const match = /^(\d{1,8})(?:[.,](\d{1,2}))?$/u.exec(value);
  if (!match) return null;
  const amount = Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
  return amount > 0 ? amount : null;
}
function validPaymentDate(value: string | null): value is string {
  return value !== null && expenseDateSchema.safeParse(value).success && value <= todayExpenseDay();
}

function manualFields(caption: string): Partial<ReceiptFields> | false {
  const input = caption.replace(expenseIntent, "").replace(/^\s*[:.]?\s*/u, "");
  const full = /^([\d.,]+)\s+(TJS|USD|сомон[иӣ]|доллар)\s+(\d{4}-\d{2}-\d{2})\s+(?:(?:за|для|барои)\s+)?(.{1,160})$/iu.exec(input);
  if (full) {
    const [, rawAmount, rawCurrency, paymentDate, purpose] = full;
    const amountMinor = amountMinorOf(rawAmount);
    return amountMinor && validPaymentDate(paymentDate)
      ? { amountMinor, currency: currencyOf(rawCurrency), paymentDate, purpose } : false;
  }
  if (!input.includes("=")) return /^\d/u.test(input) ? false : {};
  const fields: Partial<ReceiptFields> = {};
  for (const part of input.split(";")) {
    const match = /^\s*(сумма|маблағ|валюта|асъор|дата|сана|назначение|барои чӣ)\s*=\s*(.{1,160})\s*$/iu.exec(part);
    if (!match) return false;
    const value = match[2].trim();
    const key = match[1].toLowerCase();
    if (key === "сумма" || key === "маблағ") {
      if (fields.amountMinor !== undefined || !(fields.amountMinor = amountMinorOf(value))) return false;
    } else if (key === "валюта" || key === "асъор") {
      if (fields.currency !== undefined || !(fields.currency = currencyOf(value))) return false;
    } else if (key === "дата" || key === "сана") {
      if (fields.paymentDate !== undefined || !validPaymentDate(value)) return false;
      fields.paymentDate = value;
    } else {
      if (fields.purpose !== undefined || !/\p{L}/u.test(value)) return false;
      fields.purpose = value;
    }
  }
  return fields;
}

function conflictsWith(fields: ReceiptFields, manual: Partial<ReceiptFields> | false): boolean {
  return manual === false || (["amountMinor", "currency", "paymentDate", "purpose"] as const).some(key =>
    manual[key] != null && fields[key] != null && String(manual[key]).trim().toLowerCase() !== String(fields[key]).trim().toLowerCase());
}

function askMissing(fields: ReceiptFields, language: Language): string {
  const labels = language === "tg"
    ? ["маблағ=150", "асъор=TJS", "сана=YYYY-MM-DD", "барои чӣ=коғаз"]
    : ["сумма=150", "валюта=TJS", "дата=YYYY-MM-DD", "назначение=бумага"];
  const missing = [!fields.amountMinor, !fields.currency, !validPaymentDate(fields.paymentDate), !fields.purpose || !/\p{L}/u.test(fields.purpose)];
  const items = labels.filter((_, i) => missing[i]);
  const sample = items.length ? items : labels;
  return `${copy[language].clarify} «${language === "tg" ? "Расид" : "Чек"}: ${sample.join("; ")}».`;
}

function preview(evidence: ExpenseReceiptEvidence): string {
  const phrases = copy[evidence.language];
  const amount = new Intl.NumberFormat(evidence.language === "tg" ? "tg-TJ" : "ru-RU", {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  }).format(evidence.amountMinor / 100);
  return [phrases.preview, `${amount} ${evidence.currency} · ${evidence.paymentDate}`,
    evidence.purpose, evidence.vendor, phrases.category].filter(Boolean).join("\n");
}

export async function handleTelegramExpenseReceipt(
  msg: TelegramIncomingMessage, agentId: string, wallet: AssistantMoneyWallet,
): Promise<boolean> {
  if (msg.sender_chat || msg.is_automatic_forward) return false;
  const parsed = receiptMessage.safeParse(msg);
  if (!parsed.success || parsed.data.chat.id !== parsed.data.from.id) return false;
  const { chat, message_id: messageId, photo, document } = parsed.data;
  const caption = parsed.data.caption?.trim() ?? "";
  const explicit = expenseIntent.test(caption);
  const sheet = document ? spreadsheetKind(document) : null;
  const albumPhoto = Boolean(msg.media_group_id && photo && !document && !msg.forward_origin && !msg.forward_from_message_id);
  if ((sheet && !msg.media_group_id) || albumPhoto) {
    // Рубильник помощника — первым, до скачивания и любого платного разбора (ревью 10.11.2026, п. 6).
    if (!(await loadAssistantSettings()).enabled) return false;
    // Таблица Excel/CSV разбирается кодом и показывается карточкой — пересланная тоже. Без подписи —
    // вопрос «Это расходы?» кнопками; подпись про другое — прежний путь файла (п. 7).
    if (sheet) {
      if (explicit) return handleExpenseSpreadsheet({ chatId: String(chat.id), messageId, document: document!, kind: sheet, caption, explicit, agentId });
      if (caption) return false;
      return askIfSpreadsheetIsExpenses({ chatId: String(chat.id), messageId, document: document!, kind: sheet, agentId });
    }
    // Альбом фото — одна пачка на весь альбом, только с подписью-намерением (assistantExpenseAlbum.ts).
    if (explicit || (!caption && hasExpenseAlbum(String(chat.id), msg.media_group_id!))) {
      return collectExpenseAlbumPhoto({ chatId: String(chat.id), agentId, messageId, groupId: msg.media_group_id!, fileId: photo!.at(-1)!.file_id, caption, wallet });
    }
    return false;
  }
  // Never OCR copied photo sources or albums outside the expense flow.
  if (msg.forward_origin || msg.forward_from_message_id || msg.media_group_id) return false;
  if ((caption && !explicit) || (photo && document)) return false;
  const pdf = !!document && (document.mime_type === "application/pdf"
    || ((!document.mime_type || document.mime_type === "application/octet-stream") && /\.pdf$/iu.test(document.file_name ?? "")));
  // An ordinary PDF may be a report or contract. Enter the expense flow only with an explicit caption.
  if (document && (!pdf || !explicit)) return false;
  const item = pdf ? document : photo?.at(-1);
  if (!item) return false;
  const actor = await getExpenseDirector(String(chat.id), agentId);
  if (!actor || !(await loadAssistantSettings()).enabled) return false;
  const captionLanguage = assistantLanguage([{ role: "user", content: caption }]);
  let language: Language = captionLanguage === "tg" || captionLanguage === "mixed" || /^(?:харҷ|расид)/iu.test(caption) ? "tg" : "ru";
  const send = (text: string) => sendMessage(actor.chatId, text, messageId);
  const manual = manualFields(caption);
  let hasDraft = false;
  try {
    let result = await findExpensePhotoDraft(actor, messageId);
    if (!result) {
      const limit = pdf ? PDF_MAX_BYTES : MAX_EXPENSE_RECEIPT_BYTES;
      if (item.file_size && item.file_size > limit) {
        if (explicit) await send(pdf ? copy[language].invalidPdf : copy[language].unavailable);
        return explicit;
      }
      const raw = await downloadAssistantMedia(item.file_id, limit);
      if (!raw.length || raw.length > limit) throw new Error("media_size_rejected");
      // PDF из нескольких страниц или с таблицей в текстовом слое — пачка расходов (10.11.2026).
      if (pdf && await handleExpensePdfBatch({ raw, actor, agentId, messageId, language, wallet, send })) return true;
      if (raw.length > MAX_EXPENSE_RECEIPT_BYTES) throw new Error("media_size_rejected");
      const source = pdf ? raw : await normalizeReceiptPhoto(raw);
      const sourceHash = expenseReceiptHash(source);
      result = await findExpensePhotoDraft(actor, messageId, sourceHash);
      // Та же таблица второй раз: ответ без платного разбора.
      const known = result ? null : await knownBatch(agentId, sourceHash);
      if (known) {
        await send(intakeText(language)[known]);
        return true;
      }
      if (!result) {
        const image = pdf ? await renderExpenseReceiptPdf(source) : source;
        if (image.length > MAX_EXPENSE_RECEIPT_BYTES) throw new Error("expense_receipt_image_limit");
        const cap = await claimAgentAiAction(agentId, "assistant-expense-receipt-ocr", dailyExpenseReceipts);
        if (!cap.allowed) {
          if (explicit) await send(copy[language].limit);
          return explicit;
        }
        const { kind, language: imageLanguage, ...fields } = await extractExpenseReceipt(image, wallet);
        if (!explicit && imageLanguage === "tg") language = "tg";
        if (kind === "expense_list") {
          // Таблица, список или несколько чеков на одном фото — одна карточка «Проверьте N расходов».
          const table = await rowsFromTablePhoto(image, sourceHash, wallet);
          if (!explicit && table.language === "tg") language = "tg";
          if (!table.rows.length) {
            await send(intakeText(language).unreadablePhoto);
            return true;
          }
          await stageExpenseBatch({ chatId: actor.chatId, agentId, rows: table.rows, lang: language, kind: pdf ? "pdf" : "photo", replyTo: messageId,
            notes: { skipped: table.skipped, ...(table.readUpTo ? { readUpTo: table.readUpTo } : {}) } });
          return true;
        }
        if (kind !== "paid_receipt" || (pdf && !fields.amountMinor)) {
          if (explicit || kind === "unclear_receipt") {
            await send(pdf ? copy[language].noPaidPdf : copy[language].noPaidReceipt);
          }
          return explicit || kind === "unclear_receipt";
        }
        if (!validPaymentDate(fields.paymentDate)) fields.paymentDate = null;
        if (manual === false || conflictsWith(fields, manual)) {
          await send(copy[language].conflict);
          return true;
        }
        const combined = { ...fields, ...manual };
        const evidence = parseExpenseReceiptEvidence({ ...combined, language });
        if (!evidence) {
          await send(askMissing(combined, language));
          return true;
        }
        result = await stageExpensePhotoDraft(actor, messageId, source, evidence);
      }
    }
    hasDraft = true;
    if (result.kind === "recorded") {
      await send(copy[language].recorded);
      return true;
    }
    if (result.kind === "duplicate") {
      await send(copy[language].duplicate);
      return true;
    }
    language = result.evidence.language;
    if (conflictsWith(result.evidence, manual)) {
      await send(copy[language].conflict);
      return true;
    }
    if (!(await getExpenseDirector(actor.chatId, agentId))) return true;
    if (result.previewMessageId) {
      await send(copy[language].pending);
      return true;
    }
    const phrases = copy[language];
    const draftId = result.id;
    if (!(await claimExpensePreview(actor, draftId))) {
      await send(phrases.previewUnconfirmed);
      return true;
    }
    const sent = await sendMessageWithButtons(actor.chatId, preview(result.evidence), [[
      { text: phrases.confirm, callback_data: `ef:yes:${language}:${draftId}` },
      { text: phrases.cancel, callback_data: `ef:no:${language}:${draftId}` },
    ]], messageId).catch(async (error: unknown) => {
      // A transport error may follow successful delivery. Keep the claim for this draft's lifetime.
      const rejected = error instanceof TelegramApiError && error.errorCode !== undefined
        && error.errorCode >= 400 && error.errorCode < 500;
      if (rejected) await releaseRejectedExpensePreview(actor, draftId);
      await send(rejected ? phrases.previewRejected : phrases.previewUnconfirmed);
      return null;
    });
    if (sent) await markExpensePreviewDelivered(actor, draftId, sent.message_id);
    return true;
  } catch (error) {
    console.warn("[telegram:assistant] receipt preview unavailable", { kind: pdf ? "pdf" : "photo" });
    const invalidPdf = pdf && error instanceof Error
      && ["media_invalid_pdf", "media_pdf_limit", "media_size_rejected"].includes(error.message);
    if (explicit && !hasDraft) await send(invalidPdf ? copy[language].invalidPdf : copy[language].unavailable).catch(() => {});
    return explicit || hasDraft;
  }
}

export async function handleTelegramExpenseReceiptCallback(query: TelegramCallbackQuery): Promise<boolean> {
  if (!query.data?.startsWith("ef:")) return false;
  const match = EXPENSE_CALLBACK.exec(query.data);
  const validId = z.uuid().safeParse(match?.[3]);
  const lang = match?.[2] === "tg" ? "tg" : "ru";
  const phrases = copy[lang];
  const ack = (text: string) => answerCallbackQuery(query.id, text).catch(() => {});
  if (!match || !validId.success || query.message?.chat.type !== "private"
    || !query.from?.id || !Number.isSafeInteger(query.from.id) || query.from.id <= 0 || query.message.chat.id !== query.from.id) {
    await ack(phrases.forbidden);
    return true;
  }
  try {
    const actor = await getExpenseDirector(String(query.from.id));
    if (!actor) { await ack(phrases.forbidden); return true; }
    const result = await decideExpensePhotoDraft(actor, validId.data, match[1] === "yes");
    const text = phrases[result.kind];
    await ack(text);
    if (result.kind !== "forbidden" && query.message.message_id) {
      await editMessageText(actor.chatId, query.message.message_id, text, null).catch(() => {});
    }
  } catch {
    console.warn("[telegram:assistant] receipt confirmation outcome unavailable");
    await ack(phrases.uncertain);
  }
  return true;
}

const MAX_SPREADSHEET_BYTES = 5_000_000;

/**
 * PDF расходов: страницы с текстом — кодом, сканы — ИИ (rowsFromPdf). Одностраничный PDF без
 * таблицы в тексте остаётся прежним путём «один чек» (false). Тот же файл второй раз — «уже записаны».
 */
async function handleExpensePdfBatch(params: {
  raw: Buffer; actor: { chatId: string }; agentId: string; messageId: number; language: Language;
  wallet: AssistantMoneyWallet; send: (text: string) => Promise<unknown>;
}): Promise<boolean> {
  const { raw, agentId, messageId, wallet, send } = params;
  let language = params.language;
  const texts = await readExpensePdfText(raw, PDF_MAX_PAGES);
  const textRows = texts.length === 1
    ? expenseRowsFromTable(texts[0]!.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean).map((line) => line.split(/\s{2,}|\t/u))).rows.length
    : 0;
  if (texts.length === 1 && textRows < 2) return false;
  const sourceHash = sourceHashOf(raw);
  const known = await knownBatch(agentId, sourceHash);
  if (known) { await send(intakeText(language)[known]); return true; }
  // Сканы читает ИИ — общий дневной предел разборов, как у фото.
  if (texts.some((text) => !/\p{L}/u.test(text))) {
    const cap = await claimAgentAiAction(agentId, "assistant-expense-receipt-ocr", dailyExpenseReceipts);
    if (!cap.allowed) { await send(copy[language].limit); return true; }
  }
  const pdf = await rowsFromPdf(raw, sourceHash, wallet);
  if (pdf.language === "tg") language = "tg";
  if (!pdf.rows.length) { await send([intakeText(language).unreadablePhoto, pdfPageNotesText(language, pdf.pageNotes)].filter(Boolean).join("\n")); return true; }
  await stageExpenseBatch({ chatId: params.actor.chatId, agentId, rows: pdf.rows, lang: language, kind: "pdf", replyTo: messageId, notes: { skipped: pdf.skipped } });
  const notes = pdfPageNotesText(language, pdf.pageNotes);
  if (notes) await send(notes);
  return true;
}

/**
 * Excel или CSV в личке (10.11.2026): таблица разбирается кодом, без ИИ, в одну карточку. Файл без
 * строк «название + сумма» без подписи-намерения — не расходы: отдаём обычному пути.
 */
async function handleExpenseSpreadsheet(params: {
  chatId: string; messageId: number; document: { file_id: string; file_size?: number }; kind: SpreadsheetKind;
  caption: string; explicit: boolean; agentId: string; lang?: Language;
}): Promise<boolean> {
  const { chatId, messageId, document, kind, caption, explicit, agentId } = params;
  const actor = await getExpenseDirector(chatId, agentId);
  if (!actor) return false;
  const captionLanguage = assistantLanguage([{ role: "user", content: caption }]);
  const language: Language = params.lang ?? (captionLanguage === "tg" || captionLanguage === "mixed" || /^(?:харҷ|расид)/iu.test(caption) ? "tg" : "ru");
  const send = (text: string) => sendMessage(chatId, text, messageId);
  if (document.file_size && document.file_size > MAX_SPREADSHEET_BYTES) {
    await send(intakeText(language).broken);
    return true;
  }
  try {
    const bytes = await downloadAssistantMedia(document.file_id, MAX_SPREADSHEET_BYTES);
    const sourceHash = sourceHashOf(bytes);
    const known = await knownBatch(agentId, sourceHash);
    if (known) { await send(intakeText(language)[known]); return true; }
    const table = rowsFromSpreadsheet(kind, bytes);
    if (!table) { await send(intakeText(language).broken); return true; }
    if (!table.rows.length) {
      if (explicit) await send(intakeText(language).empty);
      return explicit;
    }
    await stageExpenseBatch({ chatId, agentId, rows: table.rows, lang: language, kind, replyTo: messageId, notes: { skipped: table.skipped } });
    return true;
  } catch (error) {
    console.warn("[telegram:assistant] spreadsheet expenses unavailable", { kind, cause: error instanceof Error ? error.message : "unknown" });
    await send(intakeText(language).failed).catch(() => {});
    return true;
  }
}

const FILE_QUESTION_TTL_MS = 10 * 60_000;
const FILE_CALLBACK = /^ay:(y|n):(\d{1,10})$/u;
const FILE_QUESTION = {
  ru: { ask: "Это расходы? Разберу таблицу и покажу карточку — ничего не запишу без вашего «Записать».", yes: "✅ Да, расходы", no: "Нет", cancelled: "Хорошо, файл не трогаю.", stale: "Вопрос устарел — пришлите файл ещё раз с подписью «расходы»." },
  tg: { ask: "Ин харҷҳоянд? Ҷадвалро мехонам ва корт нишон медиҳам — бе «Сабт кардан»-и шумо ҳеҷ чиз сабт намешавад.", yes: "✅ Ҳа, харҷ", no: "Не", cancelled: "Хуб, ба файл даст намерасонам.", stale: "Савол кӯҳна шуд — файлро бо навишти «харҷ» боз фиристед." },
} as const;

function questionLang(payload: Record<string, unknown>): Language {
  const history = Array.isArray(payload.messages) ? payload.messages as { role: string; content: string }[] : [];
  return ["tg", "mixed"].includes(assistantLanguage(history.filter((m) => m && typeof m.content === "string"))) ? "tg" : "ru";
}

/** Файл без подписи: спросить кнопками, а файл запомнить в состоянии диалога (история не теряется). */
async function askIfSpreadsheetIsExpenses(params: {
  chatId: string; messageId: number; document: { file_id: string; file_size?: number }; kind: SpreadsheetKind; agentId: string;
}): Promise<boolean> {
  if (!(await getExpenseDirector(params.chatId, params.agentId))) return false;
  const state = await prisma.telegramDialogState.findUnique({ where: { chatId: params.chatId } });
  if (state && state.kind !== "assistant" && state.expiresAt > new Date()) return false;
  const live = state && state.kind === "assistant" && state.agentId === params.agentId && state.expiresAt > new Date();
  const payload = live ? state.payload as Record<string, unknown> : { messages: [] };
  const data = {
    agentId: params.agentId, kind: "assistant",
    payload: { ...payload, expenseFile: { messageId: params.messageId, fileId: params.document.file_id, fileSize: params.document.file_size ?? null, kind: params.kind, until: Date.now() + FILE_QUESTION_TTL_MS, lang: questionLang(payload) } } as object,
    expiresAt: new Date(Math.max(Date.now() + FILE_QUESTION_TTL_MS, live ? state.expiresAt.getTime() : 0)),
  };
  await prisma.telegramDialogState.upsert({ where: { chatId: params.chatId }, create: { chatId: params.chatId, ...data }, update: data });
  // Язык вопроса — язык разговора (подписи у файла нет): по последним словам человека в этом чате.
  const history = Array.isArray(payload.messages) ? payload.messages as { role: string; content: string }[] : [];
  const lang: Language = ["tg", "mixed"].includes(assistantLanguage(history.filter((m) => m && typeof m.content === "string"))) ? "tg" : "ru";
  const q = FILE_QUESTION[lang];
  await sendMessageWithButtons(params.chatId, q.ask, [[
    { text: q.yes, callback_data: `ay:y:${params.messageId}` },
    { text: q.no, callback_data: `ay:n:${params.messageId}` },
  ]], params.messageId);
  return true;
}

/** Кнопки «Это расходы?»: «Да» — разбор файла тем же путём, что с подписью; «Нет» — ничего. */
export async function handleExpenseFileQuestionCallback(query: TelegramCallbackQuery, agentId: string | null): Promise<boolean> {
  if (!query.data?.startsWith("ay:")) return false;
  const match = FILE_CALLBACK.exec(query.data);
  const chat = query.message?.chat;
  const ack = (text?: string) => answerCallbackQuery(query.id, text).catch(() => {});
  if (!match || !chat || chat.type !== "private" || !agentId || chat.id !== query.from?.id) { await ack(); return true; }
  const chatId = String(chat.id);
  const state = await prisma.telegramDialogState.findUnique({ where: { chatId } });
  const payload = state?.kind === "assistant" && state.agentId === agentId ? state.payload as Record<string, unknown> : null;
  const file = payload?.expenseFile as { messageId?: unknown; fileId?: unknown; fileSize?: unknown; kind?: unknown; until?: unknown; lang?: unknown } | undefined;
  const lang: Language = file?.lang === "tg" ? "tg" : "ru";
  const q = FILE_QUESTION[lang];
  if (!payload || !file || file.messageId !== Number(match[2]) || typeof file.fileId !== "string" || Number(file.until) < Date.now()
    || (file.kind !== "csv" && file.kind !== "xlsx" && file.kind !== "xls")) {
    await ack(q.stale);
    return true;
  }
  const { expenseFile: _f, ...rest } = payload;
  void _f;
  await prisma.telegramDialogState.update({ where: { chatId }, data: { payload: rest as object } });
  if (query.message?.message_id) await editMessageText(chatId, query.message.message_id, match[1] === "y" ? q.yes : q.cancelled, null).catch(() => {});
  await ack();
  if (match[1] !== "y") return true;
  if (!(await loadAssistantSettings()).enabled) return true;
  await handleExpenseSpreadsheet({
    chatId, messageId: Number(file.messageId), agentId, caption: "", explicit: true, kind: file.kind, lang,
    document: { file_id: file.fileId, ...(typeof file.fileSize === "number" ? { file_size: file.fileSize } : {}) },
  });
  return true;
}
