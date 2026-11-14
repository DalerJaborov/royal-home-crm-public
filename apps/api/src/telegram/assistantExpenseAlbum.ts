import { claimAgentAiAction } from "../lib/agentAiActionCap.js";
import { getExpenseDirector, MAX_EXPENSE_RECEIPT_BYTES, parseExpenseReceiptEvidence } from "../lib/telegramExpenseReceipts.js";
import { trackBackgroundTask } from "../lib/shutdownState.js";
import { logSystemError } from "../lib/systemError.js";
import { describeError } from "../lib/describeError.js";
import { assistantLanguage } from "../ai/assistant/languageRouting.js";
import { defaultRootCategory } from "../ai/assistant/expenseArticles.js";
import { extractExpenseReceipt } from "../ai/assistant/expenseReceiptExtraction.js";
import { createAssistantMoneyWallet, type AssistantMoneyWallet } from "../ai/assistant/moneyBudget.js";
import { downloadAssistantMedia } from "./assistantMedia.js";
import {
  intakeText, knownSources, normalizeReceiptPhoto, rowsFromTablePhoto, sourceHashOf, stageExpenseBatch,
  type IntakeLang, type IntakeRow,
} from "./assistantExpenseBatchIntake.js";
import { sendMessage } from "./api.js";

/**
 * АЛЬБОМ ФОТО → ОДНА ПАЧКА РАСХОДОВ (10.11.2026). Telegram присылает альбом отдельными
 * сообщениями с общим media_group_id. Каждое фото скачивается сразу (в очереди чата), а разбор
 * идёт, когда альбом «затих» на ALBUM_QUIET_MS: чеки и таблицы всех фото — в одну карточку.
 * Ключ повтора — хэш всех фото альбома: тот же альбом второй раз не запишется.
 */

export const ALBUM_QUIET_MS = 2_500;
const MAX_ALBUM_PHOTOS = 10;
const DAILY_EXPENSE_PHOTOS = 40;

const NL = String.fromCharCode(10);
const ALBUM_TEXT = {
  ru: {
    photoLines: (n: number, lines: string) => `фото ${n}: не прочитались строки ${lines}`,
    photoReadUpTo: (n: number, last: string) => `фото ${n}: дочитала до строки ${last}, остальное пришлите отдельно`,
    photoUnread: (n: number) => `фото ${n} не разобрала — пришлите его отдельно`,
    photoAlready: (list: string) => `фото ${list} уже записаны — их не повторяю`,
  },
  tg: {
    photoLines: (n: number, lines: string) => `акси ${n}: сатрҳои ${lines} хонда нашуданд`,
    photoReadUpTo: (n: number, last: string) => `акси ${n}: то сатри ${last} хондам, боқимондаро алоҳида фиристед`,
    photoUnread: (n: number) => `акси ${n}-ро хонда натавонистам — алоҳида фиристед`,
    photoAlready: (list: string) => `аксҳои ${list} аллакай сабт шудаанд — такрор намекунам`,
  },
} as const;

interface Album {
  chatId: string; agentId: string; firstMessageId: number; caption: string;
  photos: Buffer[]; timer?: ReturnType<typeof setTimeout>; done?: Promise<void>; finish?: () => void;
  lang: <K extends keyof typeof ALBUM_TEXT.ru>(lang: IntakeLang, key: K, ...args: Parameters<(typeof ALBUM_TEXT.ru)[K]>) => string;
}

function albumPhrase<K extends keyof typeof ALBUM_TEXT.ru>(lang: IntakeLang, key: K, ...args: Parameters<(typeof ALBUM_TEXT.ru)[K]>): string {
  return (ALBUM_TEXT[lang][key] as (...a: unknown[]) => string)(...args);
}
const albums = new Map<string, Album>();
let quietMs = ALBUM_QUIET_MS;
/** Для тестов: короткое ожидание альбома. */
export function setExpenseAlbumQuietForTests(ms: number | null) { quietMs = ms ?? ALBUM_QUIET_MS; }
/** Для тестов: дождаться разбора всех собранных альбомов. */
export async function flushExpenseAlbumsForTests(): Promise<void> {
  await Promise.all([...albums.values()].map((album) => album.done));
}

/** Альбом уже начат подписью-намерением: остальные фото без подписи идут в ту же пачку. */
export function hasExpenseAlbum(chatId: string, groupId: string): boolean {
  return albums.has(`${chatId}:${groupId}`);
}

export async function collectExpenseAlbumPhoto(params: {
  chatId: string; agentId: string; messageId: number; groupId: string; fileId: string; caption: string; wallet: AssistantMoneyWallet;
}): Promise<boolean> {
  const actor = await getExpenseDirector(params.chatId, params.agentId);
  if (!actor) return false;
  const key = `${params.chatId}:${params.groupId}`;
  let album = albums.get(key);
  if (!album) {
    album = { chatId: params.chatId, agentId: params.agentId, firstMessageId: params.messageId, caption: params.caption, photos: [], lang: albumPhrase };
    const created = album;
    created.done = trackBackgroundTask(new Promise<void>((resolve) => { created.finish = resolve; }));
    albums.set(key, album);
  }
  if (params.caption && !album.caption) album.caption = params.caption;
  if (album.photos.length < MAX_ALBUM_PHOTOS) {
    try {
      const raw = await downloadAssistantMedia(params.fileId, MAX_EXPENSE_RECEIPT_BYTES);
      album.photos.push(await normalizeReceiptPhoto(raw));
    } catch {
      // Неоткрывшееся фото альбома не роняет остальные: оно просто не попадёт в пачку.
    }
  }
  if (album.timer) clearTimeout(album.timer);
  const current = album;
  current.timer = setTimeout(() => {
    albums.delete(key);
    void processAlbum(current).catch(async (error: unknown) => {
      await logSystemError("telegram", `Расходы из альбома: ${describeError(error)}`);
    }).finally(() => current.finish?.());
  }, quietMs);
  return true;
}

async function processAlbum(album: Album): Promise<void> {
  const captionLanguage = assistantLanguage([{ role: "user", content: album.caption }]);
  let lang: IntakeLang = captionLanguage === "tg" || captionLanguage === "mixed" ? "tg" : "ru";
  const send = (text: string) => sendMessage(album.chatId, text, album.firstMessageId);
  if (!album.photos.length) { await send(intakeText(lang).unreadablePhoto); return; }
  if (!(await getExpenseDirector(album.chatId, album.agentId))) return;
  // Ключ — по КАЖДОМУ фото (ревью 10.11.2026): чек, уже записанный отдельно или в другом альбоме,
  // второй раз не пишется; остальные фото альбома идут как обычно.
  const hashes = album.photos.map((photo) => sourceHashOf(photo));
  const known = await knownSources(album.agentId, hashes);
  if (hashes.every((hash) => known.has(hash))) {
    await send(intakeText(lang)[known.get(hashes[0]!)!]);
    return;
  }
  const cap = await claimAgentAiAction(album.agentId, "assistant-expense-album-ocr", DAILY_EXPENSE_PHOTOS);
  if (!cap.allowed) { await send(lang === "tg" ? "Имрӯз дигар аксҳоро санҷида наметавонам. Харҷро дар CRM нависед." : "На сегодня хватит разборов фото. Расходы можно внести в CRM."); return; }
  const wallet = createAssistantMoneyWallet();
  const rows: IntakeRow[] = [];
  const problems: string[] = [];
  const already: number[] = [];
  for (const [index, photo] of album.photos.entries()) {
    const hash = hashes[index]!;
    if (known.has(hash)) { already.push(index + 1); continue; }
    const read = await extractExpenseReceipt(photo, wallet).catch(() => null);
    if (read?.language === "tg" && !album.caption) lang = "tg";
    if (read?.kind === "paid_receipt") {
      const evidence = parseExpenseReceiptEvidence({ ...read, language: read.language === "tg" ? "tg" : "ru" });
      if (evidence) {
        rows.push({ title: evidence.purpose, amount: evidence.amountMinor / 100, currency: evidence.currency, date: evidence.paymentDate,
          category: defaultRootCategory(evidence.purpose), ...(evidence.vendor ? { counterparty: evidence.vendor } : {}),
          sourceText: `фото ${index + 1}: чек ${evidence.purpose} ${evidence.amountMinor / 100} ${evidence.currency}`, sourceHash: hash, sourceIndex: 0 });
        continue;
      }
    }
    if (read?.kind === "expense_list") {
      const table = await rowsFromTablePhoto(photo, hash, wallet).catch(() => null);
      if (table?.rows.length) {
        rows.push(...table.rows.map((row) => ({ ...row, sourceText: `фото ${index + 1}, ${row.sourceText ?? ""}`.slice(0, 500) })));
        if (table.skipped.length) problems.push(album.lang(lang, "photoLines", index + 1, table.skipped.map((s) => s.line).join(", ")));
        if (table.readUpTo) problems.push(album.lang(lang, "photoReadUpTo", index + 1, String(table.readUpTo)));
        continue;
      }
    }
    problems.push(album.lang(lang, "photoUnread", index + 1));
  }
  if (already.length) problems.unshift(album.lang(lang, "photoAlready", already.join(", ")));
  if (!rows.length) { await send([intakeText(lang).unreadablePhoto, ...problems].join(NL)); return; }
  await stageExpenseBatch({ chatId: album.chatId, agentId: album.agentId, rows, lang, kind: "album", replyTo: album.firstMessageId });
  // Номера здесь — фото альбома, а не строки, поэтому отдельной строкой, а не пометкой карточки.
  if (problems.length) await send(problems.map((p) => `⚠️ ${p}`).join(NL));
}
