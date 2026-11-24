/**
 * КАРТОЧКА ВЫБОРА ГОЛОСА В ШАБНАМ (24.11.2026, правка владельца: «кнопки путают, прежние сообщения не удаляются,
 * некрасиво»). Вся передача в Telegram здесь, тексты и кнопки строит assistantFreeNarration.ts.
 *
 * Правило одно: на экране ровно ОДНО сообщение выбора голоса. Образец, подпись и кнопки живут в нём вместе,
 * а «Дальше / Назад / Муж. / Жен. / язык» правят это же сообщение (editMessageMedia подменяет файл на месте),
 * поэтому чат не засоряется. Если подмена невозможна (у голоса нет образца, правка не прошла), новая карточка
 * отправляется, и только потом прежняя удаляется: пустого чата в середине нет.
 *
 * - file_id образца запоминается: повторный показ голоса уходит мгновенно, без новой загрузки файла.
 * - Нажатия по одному сообщению идут по очереди: быстрые «Дальше, Дальше, Дальше» не обгоняют друг друга.
 * - Сообщение, которое мы уже заменили, помечается: запоздавшее нажатие по нему не создаёт вторую карточку.
 */
import {
  deletePrivateMessage, editAudioCard, editMessageText, sendAudioCard, sendMessageWithButtons,
  type TelegramAudioSource, type TelegramInlineButton, type TelegramSentAudio,
} from "./api.js";
import { logSystemError } from "../lib/systemError.js";

/** Сообщение, которое нажали: `isMedia` — это карточка с образцом (нет `text`), иначе текстовая карточка. */
export type PickerEdit = { messageId: number; isMedia: boolean };

export type VoiceCardArgs = {
  chatId: string;
  edit?: PickerEdit;
  /** `key` — ключ файла в хранилище (по нему помнится file_id), `path` — файл на диске; null — образца нет. */
  sample: { key: string; path: string } | null;
  filename: string;
  title: string;
  performer: string;
  text: string;
  buttons: TelegramInlineButton[][];
};

const FILE_IDS_MAX = 200;
const REPLACED_TTL_MS = 15 * 60_000;
const fileIds = new Map<string, string>();
const replaced = new Map<string, number>();
const queues = new Map<string, Promise<unknown>>();

const messageKey = (chatId: string, messageId: number) => `${chatId}:${messageId}`;

function markReplaced(chatId: string, messageId: number): void {
  const now = Date.now();
  for (const [k, at] of replaced) if (now - at > REPLACED_TTL_MS) replaced.delete(k);
  replaced.set(messageKey(chatId, messageId), now);
}
const wasReplaced = (chatId: string, messageId: number): boolean => {
  const at = replaced.get(messageKey(chatId, messageId));
  return at !== undefined && Date.now() - at <= REPLACED_TTL_MS;
};

function remember(key: string, sent: TelegramSentAudio | null | undefined): void {
  const fileId = sent?.audio?.file_id;
  if (!fileId) return;
  if (fileIds.size >= FILE_IDS_MAX && !fileIds.has(key)) fileIds.delete(fileIds.keys().next().value as string);
  fileIds.set(key, fileId);
}

/** По очереди для одного сообщения: следующее нажатие ждёт, пока закончится предыдущее. */
function inOrder<T>(chatId: string, messageId: number, job: () => Promise<T>): Promise<T> {
  const key = messageKey(chatId, messageId);
  const run = (queues.get(key) ?? Promise.resolve()).catch(() => undefined).then(job);
  queues.set(key, run);
  void run.finally(() => { if (queues.get(key) === run) queues.delete(key); }).catch(() => undefined);
  return run;
}

/**
 * Убрать прежнюю карточку после того, как новая уже в чате. Не вышло (старше 48 часов, сбой сети) — карточка
 * остаётся, но помечена: нажатие по ней молча игнорируется, новую карточку оно не плодит.
 */
async function retire(chatId: string, edit: PickerEdit | undefined): Promise<void> {
  if (!edit) return;
  markReplaced(chatId, edit.messageId);
  await deletePrivateMessage(chatId, edit.messageId);
}

const isNotModified = (err: unknown) => /not modified/iu.test(err instanceof Error ? err.message : String(err));

async function presentText(a: VoiceCardArgs): Promise<void> {
  if (a.edit && !a.edit.isMedia) {
    try { await editMessageText(a.chatId, a.edit.messageId, a.text, a.buttons); return; }
    catch (err) { if (isNotModified(err)) return; }
  }
  await sendMessageWithButtons(a.chatId, a.text, a.buttons);
  await retire(a.chatId, a.edit);
}

/** true — карточка с образцом показана (правкой или новой); false — не вышло, вызывающий покажет текстом. */
async function presentAudio(a: VoiceCardArgs, sample: { key: string; path: string }): Promise<boolean> {
  const card = { filename: a.filename, title: a.title, performer: a.performer, caption: a.text, buttons: a.buttons };
  const cached = fileIds.get(sample.key);
  const sources: TelegramAudioSource[] = [...(cached ? [{ fileId: cached }] : []), { path: sample.path }];
  const attempt = async (source: TelegramAudioSource, step: (s: TelegramAudioSource) => Promise<TelegramSentAudio | null>): Promise<{ ok: true; sent: TelegramSentAudio | null } | { ok: false }> => {
    try { return { ok: true, sent: await step(source) }; }
    catch (err) {
      // Устаревший file_id забываем: следующая попытка загрузит файл заново.
      if ("fileId" in source) fileIds.delete(sample.key);
      else void logSystemError("telegram", `Образец голоса в Шабнам: ${err instanceof Error ? err.message : String(err)}`, { dedupKey: "free-narration-sample-card" });
      return { ok: false };
    }
  };
  if (a.edit?.isMedia) {
    const messageId = a.edit.messageId;
    for (const source of sources) {
      const done = await attempt(source, (s) => editAudioCard(a.chatId, messageId, s, card));
      if (done.ok) { remember(sample.key, done.sent); return true; }
    }
  }
  for (const source of sources) {
    const done = await attempt(source, (s) => sendAudioCard(a.chatId, s, card));
    if (done.ok) { remember(sample.key, done.sent); await retire(a.chatId, a.edit); return true; }
  }
  return false;
}

/** Показать карточку голоса: на месте прежней, если можно, иначе новой с удалением прежней. */
export function presentVoiceCard(a: VoiceCardArgs): Promise<void> {
  const run = async () => {
    if (a.edit && wasReplaced(a.chatId, a.edit.messageId)) return;
    if (a.sample && await presentAudio(a, a.sample)) return;
    await presentText(a);
  };
  return a.edit ? inOrder(a.chatId, a.edit.messageId, run) : run();
}

/** Убрать карточку выбора и показать короткое сообщение (отмена, «готовлю»): номер сообщения нужен, чтобы потом его править. */
export async function closeVoiceCard(chatId: string, edit: PickerEdit | undefined, text: string): Promise<number | undefined> {
  if (!edit) return (await sendMessageWithButtons(chatId, text, [])).message_id;
  return inOrder(chatId, edit.messageId, async () => {
    if (!edit.isMedia) { await editMessageText(chatId, edit.messageId, text, null).catch(() => {}); return edit.messageId; }
    const sent = await sendMessageWithButtons(chatId, text, []);
    await retire(chatId, edit);
    return sent.message_id;
  });
}

/** Убрать карточку выбора без замены (файл уже выдан из хранилища, говорить больше нечего). */
export async function dropVoiceCard(chatId: string, edit: PickerEdit | undefined): Promise<void> {
  if (!edit?.isMedia) return;
  await inOrder(chatId, edit.messageId, () => retire(chatId, edit));
}

/** Только для тестов. */
export function resetVoiceCardMemory(): void { fileIds.clear(); replaced.clear(); queues.clear(); }
