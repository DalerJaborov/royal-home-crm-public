/**
 * МЕНЮ И КОМАНДЫ МОНТАЖЁРА В БОТЕ (вынесено из telegram/bot.ts и расширено
 * 25.09.2026, владелец: «добавь в меню монтажёра полно функций, что нужно ему:
 * чтобы вживую мог посмотреть любой объект из очереди и так далее»).
 *
 * Кнопки и слова делают ОДНО И ТО ЖЕ: и то и другое превращается в одну
 * команду (MontajerCommand), а её выполняет одна функция runMontajerCommand —
 * кнопка под старым сообщением не должна быть единственным способом что-то
 * сделать, и слово не должно отвечать иначе, чем кнопка.
 *
 * Доступ проверяет вызывающий (bot.ts): чат привязан к назначенному монтажёру
 * (Settings.videoMontajerAgentId). Данные — telegram-независимые, в
 * lib/montajerViews.ts.
 */
import {
  montajerDeadlinesText,
  montajerObjectView,
  montajerPhotos,
  montajerPublishedText,
  montajerQueueView,
  montajerReceiptsText,
  montajerSourcesView,
  type MontajerView,
} from "../lib/montajerViews.js";
import { EDITOR_HOLDER_WHERE, queueStatusForMontajer, resendSourceVideos } from "../lib/videoHandoff.js";
import { sendPhotoAlbumFromDisk, videoFilesWord } from "../lib/telegramModeration.js";
import { prisma } from "../db.js";
import { logSystemError } from "../lib/systemError.js";
import { describeError } from "../lib/describeError.js";
import { type TelegramInlineButton } from "./api.js";
import { sendToMontajer } from "../lib/montageObservers.js";

/** Полные правила передачи — по слову «помощь», а не в каждом сообщении с роликом
 *  (владелец 19.09.2026: компактный текст при передаче). */
export const MONTAJER_HELP_TEXT = [
  "Как передавать готовый ролик:",
  "1. Присылайте его ФАЙЛОМ (документом) в этот чат — если отправить как видео, Telegram пережмёт и качество потеряется. Можно и через CRM-панель объекта.",
  // Обложку монтажёр раньше присылал сам (пункт 2 до 21.09.2026) — фичу сняли:
  // «обложки будем мы с тобой генерировать» (владелец). Публикация сама берёт кадр из ролика.
  "2. В имени файла оставьте номер объекта (как бот его и прислал: «108.mp4»). Без номера, когда ролик могут ждать два объекта, бот спросит кнопками, для какого он.",
  "3. Ошиблись файлом — пришлите правильный в ближайшие три часа, он заменит прежний. Если объект уже опубликован, замена невозможна — позовите администратора.",
  "",
  "Данные объекта (район, этаж, комнаты, цена) — в любой момент по его номеру: напишите «108». Всё остальное — «меню».",
].join("\n");

/**
 * МЕНЮ МОНТАЖЁРА (владелец 19.09.2026, после перемешанных описаний двух квартир:
 * «чтобы там было управление и все нужные функции и чтобы таких ошибок больше не
 * было»; расширено 25.09.2026). Главное — «объект <номер>»: данные карточки по
 * запросу, в любой момент и для любого объекта, а не один раз подписью.
 */
export const MONTAJER_MENU_TEXT = [
  "Меню монтажёра:",
  "• «очередь» — что у вас в работе и что дальше, с адресами; номер — кнопкой.",
  "• «объект 108» (или просто «108») — данные карточки. Работает всегда, даже после публикации.",
  "• «фото 108» — фото объекта альбомом.",
  "• «исходники 108» — список исходных видео со ссылками на скачивание.",
  "• «где 108» — в каких сетях вышел ролик, со ссылками.",
  "• «файлы» — дослать исходники объекта в работе, которые до вас не дошли.",
  "• «сдал» — последние сданные ролики. «сроки» — сколько что ждёт.",
  "• «помощь» — правила передачи готового ролика.",
  "",
  "Надпись на ролике берите только из «объект <номер>» — там ровно то, что в карточке, и ничего придуманного.",
].join("\n");

export const MONTAJER_MENU_BUTTONS: TelegramInlineButton[][] = [
  [
    { text: "🗂 Очередь", callback_data: "mj:queue" },
    { text: "📋 Данные объекта", callback_data: "mj:card" },
  ],
  [
    { text: "✅ Что я сдал", callback_data: "mj:done" },
    { text: "⏱ Сроки", callback_data: "mj:time" },
  ],
  [
    { text: "📥 Дослать файлы", callback_data: "mj:files" },
    { text: "❓ Помощь", callback_data: "mj:help" },
  ],
];

export type MontajerCommand =
  | { kind: "menu" }
  | { kind: "help" }
  | { kind: "queue" }
  | { kind: "holderCard" }
  | { kind: "card"; shortId: number }
  | { kind: "photos"; shortId: number }
  | { kind: "sources"; shortId: number }
  | { kind: "sendFiles"; shortId: number }
  | { kind: "published"; shortId: number }
  | { kind: "resendMissing" }
  | { kind: "receipts" }
  | { kind: "deadlines" }
  | { kind: "status" };

const NUMBER = String.raw`№?\s*(\d{1,7})`;
/** «фото 134», «исходники №134», «где 134» — слово и номер объекта. */
const WORD_WITH_NUMBER: Array<{ re: RegExp; kind: "photos" | "sources" | "published" | "card" }> = [
  { re: new RegExp(String.raw`^\s*(?:фото|фотки|фотографии)\s*${NUMBER}\s*$`, "i"), kind: "photos" },
  { re: new RegExp(String.raw`^\s*(?:исходники|исходник|видео)\s*${NUMBER}\s*$`, "i"), kind: "sources" },
  { re: new RegExp(String.raw`^\s*(?:где|вышел|публикации)\s*${NUMBER}\s*$`, "i"), kind: "published" },
  { re: new RegExp(String.raw`^\s*(?:об[ъь]?ект\s*)?${NUMBER}\s*$`, "i"), kind: "card" },
];

/**
 * ТОЧНАЯ КОМАНДА ДЛЯ ДОСЫЛКИ ИСХОДНИКОВ, А НЕ «НАЧИНАЕТСЯ С» (24.09.2026).
 * `/^\s*(файл|пришл|отправ)/i` ловило «пришлю вечером», «файл не открывается» и
 * слало гигабайты на обычную реплику. Ровно три слова.
 */
const MONTAJER_RESEND_COMMANDS = new Set(["повтор", "файлы", "файл"]);

/** Текст монтажёра → команда. Незнакомое — статус очереди (как было с 16.09.2026). */
export function parseMontajerText(text: string): MontajerCommand {
  for (const { re, kind } of WORD_WITH_NUMBER) {
    const m = text.match(re);
    if (m) return { kind, shortId: Number(m[1]) };
  }
  const t = text.trim().toLowerCase();
  if (/^(меню|\/menu|\/start)/.test(t)) return { kind: "menu" };
  if (/^(помощ|помогит|help|\/help)/.test(t)) return { kind: "help" };
  if (/^(очеред|\/queue)/.test(t)) return { kind: "queue" };
  if (MONTAJER_RESEND_COMMANDS.has(t)) return { kind: "resendMissing" };
  if (/^(сдал|сдано|что я сдал|квитанци)/.test(t)) return { kind: "receipts" };
  if (/^(срок|сроки)/.test(t)) return { kind: "deadlines" };
  return { kind: "status" };
}

/** callback_data `mj:*` → команда. `mj:rcv:*` (приём ролика) сюда не приходит. */
export function parseMontajerCallback(data: string): MontajerCommand | null {
  const simple: Record<string, MontajerCommand> = {
    "mj:menu": { kind: "menu" },
    "mj:help": { kind: "help" },
    "mj:queue": { kind: "queue" },
    "mj:card": { kind: "holderCard" },
    "mj:files": { kind: "resendMissing" },
    "mj:done": { kind: "receipts" },
    "mj:time": { kind: "deadlines" },
  };
  if (simple[data]) return simple[data]!;
  const m = data.match(/^mj:(obj|ph|src|sf|pub):(\d{1,7})$/);
  if (!m) return null;
  const shortId = Number(m[2]);
  const kind = ({ obj: "card", ph: "photos", src: "sources", sf: "sendFiles", pub: "published" } as const)[m[1] as "obj" | "ph" | "src" | "sf" | "pub"];
  return { kind, shortId };
}

/** Ответы на команды МЕНЮ (очередь, объект N, помощь, меню...) — диалог
 *  монтажёра с ботом, а не поток контроля владельца: наблюдателям не копируем
 *  (задание А/Б, 25.09.2026, см. sendToMontajer в lib/montageObservers.ts). */
async function reply(chatId: string, view: MontajerView): Promise<void> {
  try {
    await sendToMontajer(chatId, view.text, { copy: false, replyMarkup: view.buttons });
  } catch (err) {
    void logSystemError("video-handoff", `Ответ монтажёру в боте не отправился: ${describeError(err)}`);
  }
}

async function holderShortId(): Promise<number | null> {
  const holder = await prisma.property.findFirst({
    where: EDITOR_HOLDER_WHERE,
    orderBy: { videoHandoffSentAt: "asc" },
    select: { shortId: true },
  });
  return holder?.shortId ?? null;
}

async function resendMissingText(): Promise<string> {
  const resent = await resendSourceVideos();
  if (resent.ok) return `Досылаю исходники объекта №${resent.shortId}, которые до вас не дошли.`;
  // Уже идёт отправка (25.09.2026, А2) — второй тап не задваивает файлы.
  if (resent.busy) return `Уже отправляю ролики объекта №${resent.shortId} — подождите, пожалуйста.`;
  if (resent.alreadyAll !== undefined) {
    return `Все ${resent.alreadyAll} ${videoFilesWord(resent.alreadyAll)} объекта №${resent.shortId} уже у вас — повторно не шлю. Потеряли у себя — «исходники ${resent.shortId}»: там ссылки и кнопка «📥 Прислать файлами».`;
  }
  return "Сейчас у вас в работе ничего нет — присылать нечего.";
}

/** Выполнить команду монтажёра: ответ текстом, с кнопками или альбомом. */
export async function runMontajerCommand(chatId: string, cmd: MontajerCommand): Promise<void> {
  switch (cmd.kind) {
    case "menu":
      return reply(chatId, { text: MONTAJER_MENU_TEXT, buttons: MONTAJER_MENU_BUTTONS });
    case "help":
      return reply(chatId, { text: MONTAJER_HELP_TEXT });
    case "queue":
      return reply(chatId, await montajerQueueView());
    case "holderCard": {
      // Кнопка отдаёт карточку объекта, который в работе; любой другой — словом
      // «объект <номер>» или кнопкой из «🗂 Очередь».
      const shortId = await holderShortId();
      if (shortId === null) {
        return reply(chatId, {
          text: "Сейчас у вас в работе ничего нет. Данные любого объекта — напишите его номер, например «108», или откройте «🗂 Очередь».",
          buttons: [[{ text: "🗂 Очередь", callback_data: "mj:queue" }]],
        });
      }
      return reply(chatId, await montajerObjectView(shortId));
    }
    case "card":
      return reply(chatId, await montajerObjectView(cmd.shortId));
    case "photos": {
      const photos = await montajerPhotos(cmd.shortId);
      if (!photos.ok) return reply(chatId, { text: photos.text });
      const more = photos.total > photos.photos.length ? ` (первые ${photos.photos.length} из ${photos.total})` : "";
      try {
        await sendPhotoAlbumFromDisk(chatId, photos.photos, `Объект №${photos.shortId} — фото${more}`);
      } catch (err) {
        void logSystemError("video-handoff", `Фото объекта №${cmd.shortId} монтажёру не ушли: ${describeError(err)}`);
        return reply(chatId, { text: `Фото объекта №${cmd.shortId} не получилось прислать сюда — посмотрите в CRM.` });
      }
      return;
    }
    case "sources": {
      const view = await montajerSourcesView(cmd.shortId);
      // Список — отдельным сообщением: со ссылками он бывает длиннее предела
      // Telegram, и sendMessage режет его на части; кнопку в режущийся текст не
      // поставить, поэтому она — следующим коротким сообщением.
      await reply(chatId, { text: view.text });
      if (view.holder) {
        await reply(chatId, {
          text: `Объект №${cmd.shortId} у вас в работе — могу прислать все исходники файлами ещё раз.`,
          buttons: [[{ text: "📥 Прислать файлами", callback_data: `mj:sf:${cmd.shortId}` }]],
        });
      }
      return;
    }
    case "sendFiles": {
      // Файлами — только объект в работе: остальные монтажёру не выданы, и
      // гигабайты чужой очереди ему в чат не шлём (ссылки есть в «Исходниках»).
      const holder = await holderShortId();
      if (holder !== cmd.shortId) {
        return reply(chatId, {
          text: holder
            ? `Файлами присылаю только объект в работе — №${holder}. Для №${cmd.shortId} — ссылки в «исходники ${cmd.shortId}».`
            : `Сейчас у вас в работе ничего нет. Для №${cmd.shortId} — ссылки в «исходники ${cmd.shortId}».`,
        });
      }
      const resent = await resendSourceVideos({ force: true });
      return reply(chatId, {
        text: resent.ok
          ? `Присылаю все исходники объекта №${resent.shortId} файлами.`
          : resent.busy
            ? `Уже отправляю ролики объекта №${resent.shortId} — подождите, пожалуйста.`
            : "Сейчас у вас в работе ничего нет — присылать нечего.",
      });
    }
    case "published":
      return reply(chatId, { text: await montajerPublishedText(cmd.shortId) });
    case "resendMissing":
      return reply(chatId, { text: await resendMissingText() });
    case "receipts":
      return reply(chatId, { text: await montajerReceiptsText() });
    case "deadlines":
      return reply(chatId, { text: await montajerDeadlinesText() });
    case "status":
      // Ничего не узнали — статус очереди плюс одна строка о том, что бот умеет
      // больше: иначе меню существует, но о нём никто не знает.
      return reply(chatId, { text: `${await queueStatusForMontajer()}\n\nНапишите «меню» — что ещё умеет бот.` });
  }
}
