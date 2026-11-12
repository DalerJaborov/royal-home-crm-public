/**
 * ПРИЁМ ГОТОВОГО РОЛИКА ОТ МОНТАЖЁРА В БОТЕ (вынесено из telegram/bot.ts
 * 25.09.2026 вместе с защитой от путаниц — «чтобы вообще никогда ни описания, ни
 * ролики не путались»).
 *
 * Чей это ролик — решает, по порядку:
 *  1. номер объекта в имени файла или начале подписи (бот сам выдаёт исходники
 *     как «<номер>.mp4», см. montajerFileNumber.ts);
 *  2. если номера нет, а ждущих объектов больше одного (держатель места плюс
 *     недавно сданные или снятые за три часа) — НЕ угадываем: спрашиваем кнопками
 *     «Это №133» / «Это №136» / «Ни то, ни другое». Файл до ответа лежит в
 *     Telegram (на томе своего Bot API), вопрос — в TelegramDialogState, 15 минут;
 *  3. кандидат один — как раньше: держатель, либо пересылка взамен только что
 *     сданного (findResendCandidate).
 * Номер в имени, не совпадающий ни с одним ждущим объектом, — отказ с
 * объяснением и кнопкой «Это всё-таки №<держатель>».
 *
 * Разбор 24.09.2026: файл без номера ложился на текущего держателя, и поздняя
 * правка прошлого объекта уезжала на чужой. Разбор 23.09 (№127): вместо ролика
 * вернулся исходник — это ловят ворота приёма (videoHandoff.ts::checkEditedClip),
 * теперь по исходникам ЛЮБОГО объекта за 30 дней.
 */
import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { channelLabel } from "@royal-home/shared";
import { prisma } from "../db.js";
import type { Prisma } from "../generated/prisma/client.js";
import { videoHandoffDir } from "../upload.js";
import { declaredObjectNumber } from "./montajerFileNumber.js";
import {
  receiveEditedVideo,
  receiveEditedVideoFromFile,
  findResendCandidate,
  RESEND_WINDOW_MS,
  reopenForResend,
  undoReopenForResend,
  EDITOR_HOLDER_WHERE,
  recordMontajerMessage,
  type ReceiveEditedVideoResult,
} from "../lib/videoHandoff.js";
import { isInsideTelegramFilesDir } from "../messengers/attachments.js";
import { logSystemError } from "../lib/systemError.js";
import { describeError } from "../lib/describeError.js";
import { sendToMontajer } from "../lib/montageObservers.js";
import { formatDurationShort } from "../lib/rawVideoFacts.js";
import { dushanbeDateTimeString } from "../lib/dushanbeTime.js";
import {
  resolveTelegramFileMaterialization,
  TELEGRAM_BOT_DOWNLOAD_LIMIT_BYTES,
  maskTelegramFilePath,
  type TelegramInlineButton,
} from "./api.js";
import {
  forgetVoicelessQuestion,
  rememberVoicelessQuestion,
  storeVoicelessCopy,
  voicelessCopyAsk,
  voicelessCopyTarget,
  type VoicelessTarget,
} from "../lib/narrationVoicelessCopy.js";

/** Сколько бот ждёт ответа монтажёра «чей это ролик» (как у модерации). */
export const MONTAJER_RECEIVE_QUESTION_TTL_MS = 15 * 60_000;
const RECEIVE_DIALOG_KIND = "montajer_receive";

/** Что пришло от монтажёра — всё, что нужно, чтобы принять файл сейчас или после ответа. */
export interface MontajerVideoInput {
  chatId: string;
  agentId: string;
  /** update_id входящего — ключ вопроса «чей ролик»: ответ на старый вопрос
   *  (монтажёр прислал следующий файл) не применится к новому файлу. */
  updateId: number;
  fileId: string;
  filename: string;
  caption: string | null;
  albumGroupId?: string;
}

interface ReceiveQuestionPayload {
  updateId: number;
  fileId: string;
  filename: string;
  caption: string | null;
  candidates: number[];
}

/**
 * КВИТАНЦИЯ МОНТАЖЁРУ — ЧЕСТНО (25.09.2026, А7). «Принят, публикую по каналам»
 * говорилось всегда — и когда автопубликация выключена, и когда объект снят с
 * продажи, и когда ролик ждёт слота до завтра. Теперь квитанция говорит ровно
 * то, что будет: во сколько выйдет (слот расписания, lib/publishSchedule.ts) или
 * что публиковаться не будет и почему (receiveEditedVideo::notPublishingReason).
 *
 * Номер объекта — в каждой квитанции (24.09.2026): монтажёр сразу видит, на
 * какой объект лёг файл. Куда именно ушло — дело CRM, не монтажёра (владелец
 * 20.09.2026); результат публикации уходит отдельным уведомлением тем, кто ведёт
 * объект (notifyVideoHandoffPublishResult). Факты принятого файла (23.09.2026,
 * №127) — чтобы было видно, что принят именно смонтированный ролик.
 */
export function handoffReceiptText(result: ReceiveEditedVideoResult, shortId: number, now: Date = new Date()): string {
  if (!result.ok) return `Объект №${shortId}: не получилось принять ролик: ${result.error}`;
  // Проверка готового ролика (25.09.2026, lib/clipReview.ts): слота ещё нет —
  // обещать «публикую» нельзя, публикацию поставит одобрение модератора.
  const base = result.clipReviewPending
    ? `Ролик по объекту №${shortId} принят, ушёл на проверку модератору.`
    : result.notPublishingReason
    ? `Ролик по объекту №${shortId} принят, но публиковаться не будет: ${result.notPublishingReason}`
    : result.scheduledPublishAt
      ? `Ролик по объекту №${shortId} принят, публикую по каналам ${publishWhenText(result.scheduledPublishAt, now)}.`
      : `Ролик по объекту №${shortId} принят, публикую по каналам.`;
  // Старый ролик в вышедших сетях замена не трогает (25.09.2026, Б4) — сказать
  // это прямо, а не обещать «публикую» так, будто заменится везде.
  const oldLeft = result.oldVideoLeftIn?.length
    ? `\nВ сетях ${result.oldVideoLeftIn.map(channelLabel).join(", ")} остался старый ролик — туда новый сам не уйдёт.`
    : "";
  // Ролик без голоса (11.11.2026): голос наложила CRM — одной строкой монтажёру.
  const mixed = result.narrationMixedRevision ? `\nОзвучку (версия ${result.narrationMixedRevision}) CRM наложила сама.` : "";
  if (!result.media) return `${base}${mixed}${oldLeft}`;
  const { media, filename } = result;
  const parts = [filename ? `Файл: ${filename}` : null, media.sizeBytes ? `${Math.round(media.sizeBytes / 1024 / 1024)} МБ` : null];
  if (media.durationSec > 0) parts.push(formatDurationShort(media.durationSec));
  if (media.width && media.height) parts.push(`${media.width}×${media.height}`);
  parts.push(media.hasAudio ? "звук есть" : result.narrationMixedRevision ? "без голоса" : "звука нет");
  return `${base}\n${parts.filter(Boolean).join(", ")}${mixed}${oldLeft}`;
}

/** «в 14:30» сегодня, «26.09 в 14:30» в другой день, «сейчас» — если слот уже настал. */
function publishWhenText(at: Date, now: Date): string {
  if (at.getTime() <= now.getTime() + 60_000) return "сейчас";
  const [date, time] = dushanbeDateTimeString(at).split(" ");
  const [today] = dushanbeDateTimeString(now).split(" ");
  if (date === today) return `в ${time}`;
  const [, month, day] = date!.split("-");
  return `${day}.${month} в ${time}`;
}

/**
 * АЛЬБОМ В ЧАТЕ МОНТАЖЁРА (23.09.2026, находка B2). Части альбома Telegram
 * доставляет ОТДЕЛЬНЫМИ update. Детерминизм важнее удобства: берём только первую
 * часть группы, на остальные отвечаем явно и один раз на группу. Память
 * процесса, не база — группа живёт секунды; TTL 10 минут.
 */
const MONTAJER_ALBUM_TTL_MS = 10 * 60_000;
interface MontajerAlbumEntry {
  firstFilename: string;
  shortId: number | null;
  at: number;
  notified: boolean;
}
const montajerAlbumGroups = new Map<string, MontajerAlbumEntry>();

function montajerAlbumEntry(groupId: string): MontajerAlbumEntry | undefined {
  const entry = montajerAlbumGroups.get(groupId);
  if (entry && Date.now() - entry.at > MONTAJER_ALBUM_TTL_MS) {
    montajerAlbumGroups.delete(groupId);
    return undefined;
  }
  return entry;
}

async function askWhichObject(input: MontajerVideoInput, candidates: number[], text: string, withNeither: boolean): Promise<void> {
  const payload: ReceiveQuestionPayload = {
    updateId: input.updateId,
    fileId: input.fileId,
    filename: input.filename,
    caption: input.caption,
    candidates,
  };
  const data = {
    agentId: input.agentId,
    kind: RECEIVE_DIALOG_KIND,
    payload: payload as unknown as Prisma.InputJsonValue,
    expiresAt: new Date(Date.now() + MONTAJER_RECEIVE_QUESTION_TTL_MS),
  };
  await prisma.telegramDialogState.upsert({ where: { chatId: input.chatId }, create: { chatId: input.chatId, ...data }, update: data });
  const buttons: TelegramInlineButton[][] = candidates.map((n) => [{ text: `Это №${n}`, callback_data: `mj:rcv:${input.updateId}:${n}` }]);
  if (withNeither) buttons.push([{ text: "Ни то, ни другое", callback_data: `mj:rcv:${input.updateId}:0` }]);
  await sendToMontajer(input.chatId, text, { copy: true, replyMarkup: buttons }).catch((err) =>
    logSystemError("video-handoff", `Вопрос монтажёру «чей ролик» не отправился: ${describeError(err)}`)
  );
}

/**
 * Ролик в личном чате назначенного монтажёра. Проверка «этот чат — монтажёр»
 * сделана вызывающим (bot.ts). `forcedShortId` — ответ на вопрос «чей ролик»:
 * номер выбран кнопкой, в имени файла его может и не быть.
 */
export async function handleMontajerVideo(input: MontajerVideoInput, forcedShortId?: number): Promise<void> {
  const { chatId, filename } = input;

  // Передача через бота выключена в Настройках (25.09.2026, А8) — говорим прямо,
  // а не принимаем файл, которого никто не ждёт по этому пути.
  const settings = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { videoHandoffEnabled: true } });
  if (!settings?.videoHandoffEnabled) {
    await sendToMontajer(
      chatId,
      "Передача роликов через бота сейчас выключена в Настройках CRM — файл не принят. Загрузите готовый ролик через карточку объекта в CRM или спросите администратора.",
      { copy: false }
    ).catch(() => {});
    return;
  }

  // Альбом: вторая и следующие части той же группы не скачиваем и не даём им
  // переоткрыть объект — берём только первую (см. montajerAlbumGroups).
  const albumGroupId = input.albumGroupId;
  if (albumGroupId && forcedShortId === undefined) {
    const entry = montajerAlbumEntry(albumGroupId);
    if (entry) {
      if (!entry.notified) {
        entry.notified = true;
        await sendToMontajer(
          chatId,
          `Из альбома взят только первый файл (${entry.firstFilename}). Нужен другой — пришлите его отдельным сообщением.`,
          { copy: false }
        ).catch(() => {});
        void logSystemError(
          "video-handoff",
          `Монтажёр прислал альбом для объекта №${entry.shortId ?? "?"}: взят первый файл, остальные проигнорированы`
        );
      }
      return;
    }
  }

  // ТОТ ЖЕ РОЛИК БЕЗ ГОЛОСА (12.11.2026, lib/narrationVoicelessCopy.ts): после кнопки
  // «Пришлю без голоса» или с подписью «без голоса 123» файл становится мастером для
  // смены голоса, а не новым готовым роликом. Не подошёл по длине после кнопки — дальше
  // обычный приём: монтажёр мог забыть и прислать готовый ролик следующего объекта.
  if (forcedShortId === undefined) {
    const voiceless = await voicelessCopyTarget(input).catch(() => null);
    if (voiceless && (await handleVoicelessCopy(input, voiceless))) return;
  }

  // Метка reopenForResend (задание F, 24.09.2026) — undoReopenForResend сверяет
  // её перед откатом, чтобы не задеть чужую передачу.
  let reopenedForResend: Date | null = null;
  const holder = await prisma.property.findFirst({
    // EDITOR_HOLDER_WHERE: не удалён и не открыт для ручной загрузки из CRM.
    where: EDITOR_HOLDER_WHERE,
    orderBy: { videoHandoffSentAt: "asc" },
    select: { id: true, shortId: true },
  });
  let property: { id: string; shortId: number } | null = holder;

  const declared = forcedShortId ?? declaredObjectNumber(filename, input.caption);

  // Файл без номера идёт держателю места монтажёра — вопрос «для какого объекта»
  // убран по требованию владельца (29.09.2026): он не заводил его и он зависал.

  /**
   * ФАЙЛ ПОДПИСАН НОМЕРОМ ДРУГОГО ОБЪЕКТА (24.09.2026, проверка по классам).
   * Место монтажёра освобождается в момент приёма, и следующий объект уходит
   * ему через секунды. Исправленный или поздний файл прежнего объекта раньше
   * ложился на нового держателя места и публиковался под чужим объявлением.
   */
  if (declared != null && property?.shortId !== declared) {
    const target = await prisma.property.findFirst({
      where: { shortId: declared, deletedAt: null },
      select: {
        id: true,
        shortId: true,
        videoHandoffStatus: true,
        videoHandoffManualSince: true,
        videoHandoffSentAt: true,
        publishedChannels: true,
      },
    });
    const inWork = property ? ` Сейчас у вас в работе №${property.shortId}.` : "";
    if (target?.videoHandoffStatus === "SENT_TO_EDITOR" && !target.videoHandoffManualSince) {
      // Объект с этим номером сам держит место (двое держателей — наследие
      // старой гонки): файл его, а не того, кого нашли первым.
      property = { id: target.id, shortId: target.shortId };
    } else if (
      target?.videoHandoffStatus === "RECEIVED" &&
      target.videoHandoffSentAt &&
      target.videoHandoffSentAt.getTime() >= Date.now() - RESEND_WINDOW_MS
    ) {
      if ((target.publishedChannels ?? []).length > 0) {
        await sendToMontajer(
          chatId,
          `Объект №${declared} уже опубликован — сама Meta не даёт заменить видео у вышедшего поста. Если файл реально не тот, позовите администратора.${inWork}`,
          { copy: false }
        ).catch(() => {});
        return;
      }
      const reopenedAt = await reopenForResend(target.id, { besideHolder: !!property });
      if (!reopenedAt) {
        await sendToMontajer(chatId, `Не получилось открыть объект №${declared} для замены ролика — попробуйте ещё раз.${inWork}`, {
          copy: false,
        }).catch(() => {});
        return;
      }
      property = { id: target.id, shortId: target.shortId };
      reopenedForResend = reopenedAt;
    } else {
      // Номер есть, но этот объект ролика от вас не ждёт — на чужой объект
      // файл не кладём ни в каком случае. Держатель есть и номер набран не
      // кнопкой — предлагаем кнопку «Это всё-таки №<держатель>» (ошибка в имени).
      const what = target ? `Объект №${declared} сейчас не ждёт от вас ролик.` : `Объекта №${declared} в CRM нет.`;
      const text = `${what}${inWork} Файл не принят. Если это ролик для объекта в работе — пришлите его с номером этого объекта в имени файла или в подписи.`;
      if (holder && forcedShortId === undefined) {
        await askWhichObject(input, [holder.shortId], `${text}\nИли нажмите кнопку, если это всё-таки ролик для №${holder.shortId}.`, false);
      } else {
        await sendToMontajer(chatId, text, { copy: false }).catch(() => {});
      }
      void logSystemError(
        "video-handoff",
        `Монтажёр прислал файл «${filename}» с номером №${declared}, а этот объект ролика не ждёт${property ? ` (в работе №${property.shortId})` : ""} — не принят`
      );
      return;
    }
  }

  // Ничего не ждёт прямо сейчас — возможно, это не новый ролик, а попытка
  // переслать исправленный файл взамен только что принятого (владелец,
  // 14.09.2026: «может ошибиться файлом»). Окно и условие — lib/videoHandoff.ts.
  if (!property) {
    const resend = await findResendCandidate();
    if (resend?.alreadyPublished) {
      await sendToMontajer(
        chatId,
        "Этот объект уже опубликован — сама Meta не даёт заменить видео у вышедшего поста. Если файл реально не тот, позовите администратора, автоматически это не починить.",
        { copy: false }
      ).catch(() => {});
      return;
    }
    if (resend) {
      const reopenedAt = await reopenForResend(resend.propertyId);
      if (reopenedAt) {
        property = { id: resend.propertyId, shortId: resend.shortId };
        reopenedForResend = reopenedAt;
      }
    }
  }

  if (!property) {
    await sendToMontajer(chatId, "Не вижу объекта, который сейчас ждёт от вас ролик.", { copy: false }).catch(() => {});
    return;
  }

  if (albumGroupId) {
    montajerAlbumGroups.set(albumGroupId, { firstFilename: filename, shortId: property.shortId, at: Date.now(), notified: false });
  }

  // Путь на диске своего Bot API (kind "path") НЕ читаем в буфер (23.09.2026,
  // находка B3: 480-МБ .mov в память уже уводил api через OOM).
  const material = await resolveTelegramFileMaterialization(input.fileId, TELEGRAM_BOT_DOWNLOAD_LIMIT_BYTES);
  if (!material) {
    // Пересылка уже переоткрыла объект — без отката он вечно «на монтаже».
    if (reopenedForResend) await undoReopenForResend(property.id, reopenedForResend);
    await sendToMontajer(chatId, "Не получилось скачать файл — попробуйте ещё раз или загрузите через CRM-панель объекта.", {
      copy: false,
    }).catch(() => {});
    return;
  }
  let result: ReceiveEditedVideoResult;
  if (material.kind === "path") {
    // Файл на диске Bot API — не наш: копируем потоком во временную копию внутри
    // videoHandoffDir и отдаём ЕЁ. Исходник на томе удаляем ПОСЛЕ успешной копии
    // (24.09.2026: том никто не чистил, диск VPS был забит на 96%).
    const tmpPath = path.join(videoHandoffDir, `montajer-${randomUUID()}${path.extname(material.path) || ".mp4"}`);
    try {
      await pipeline(fs.createReadStream(material.path), fs.createWriteStream(tmpPath));
    } catch (err) {
      await fs.promises.rm(tmpPath, { force: true }).catch(() => {});
      void logSystemError("video-handoff", `Объект ${property.id}: не скопировал файл монтажёра с диска Bot API: ${describeError(err)}`);
      if (reopenedForResend) await undoReopenForResend(property.id, reopenedForResend);
      await sendToMontajer(
        chatId,
        "Не получилось сохранить файл на сервере — попробуйте ещё раз или загрузите через CRM-панель объекта.",
        { copy: false }
      ).catch(() => {});
      return;
    }
    // Удаляем только путь ВНУТРИ тома своего сервера (TELEGRAM_LOCAL_FILES_DIR);
    // путь в логе — только маскированный (--local кладёт токен бота в путь).
    if (isInsideTelegramFilesDir(material.path)) {
      await fs.promises.rm(material.path, { force: true }).catch((err) => {
        console.error(
          `[video-handoff] исходник на томе Bot API не удалён (${maskTelegramFilePath(material.path)}):`,
          err instanceof Error ? err.message : err
        );
      });
    }
    result = await receiveEditedVideoFromFile(property.id, tmpPath, filename);
  } else {
    result = await receiveEditedVideo(property.id, material.buffer, filename);
  }
  // Пересылка не принята — объект не должен остаться держать место монтажёра.
  if (!result.ok && reopenedForResend) await undoReopenForResend(property.id, reopenedForResend);
  const receiptText = handoffReceiptText(result, property.shortId);
  // Голос вклеил монтажёр — один раз просим тот же ролик без голоса (12.11.2026), кнопками.
  const ask = result.ok ? await voicelessCopyAsk(property.id).catch(() => null) : null;
  await sendToMontajer(chatId, ask ? `${receiptText}\n\n${ask.text}` : receiptText, {
    copy: true,
    propertyShortId: property.shortId,
    ...(ask ? { replyMarkup: ask.buttons } : {}),
  }).catch(() => {});
  void recordMontajerMessage(property.id, "RECEIPT", receiptText);
}

/** Файл Telegram — во временную копию внутри videoHandoffDir (как у готового ролика). null — не скачался. */
async function telegramFileToTemp(fileId: string): Promise<string | null> {
  const material = await resolveTelegramFileMaterialization(fileId, TELEGRAM_BOT_DOWNLOAD_LIMIT_BYTES);
  if (!material) return null;
  const ext = material.kind === "path" ? path.extname(material.path) || ".mp4" : ".mp4";
  const tmpPath = path.join(videoHandoffDir, `voiceless-${randomUUID()}${ext}`);
  try {
    if (material.kind === "path") await pipeline(fs.createReadStream(material.path), fs.createWriteStream(tmpPath));
    else await fs.promises.writeFile(tmpPath, material.buffer);
  } catch {
    await fs.promises.rm(tmpPath, { force: true }).catch(() => {});
    return null;
  }
  if (material.kind === "path" && isInsideTelegramFilesDir(material.path)) await fs.promises.rm(material.path, { force: true }).catch(() => {});
  return tmpPath;
}

/** true — файл разобран как «без голоса» (принят или отказ сказан); false — принимать обычным роликом. */
async function handleVoicelessCopy(input: MontajerVideoInput, target: VoicelessTarget): Promise<boolean> {
  const tmpPath = await telegramFileToTemp(input.fileId);
  if (!tmpPath) {
    await sendToMontajer(input.chatId, "Не получилось скачать файл без голоса — пришлите его ещё раз.", { copy: false }).catch(() => {});
    return true;
  }
  try {
    const stored = await storeVoicelessCopy(target.propertyId, tmpPath, { ignoreDuration: target.via === "choice" });
    if (!stored.ok && stored.code === "MISMATCH" && target.via === "button") {
      // После кнопки пришёл не тот же по длине ролик (ревью 12.11.2026): не гадаем — спрашиваем
      // монтажёра кнопками, иначе ролик без голоса мог бы выйти в сети как готовый.
      await rememberVoicelessChoice(input, target);
      await sendToMontajer(input.chatId, `${stored.error}\nЧто это за файл?`, {
        copy: false,
        replyMarkup: [[
          { text: `Это №${target.shortId} без голоса`, callback_data: `mj:nvc:v:${input.updateId}` },
          { text: "Это новый готовый ролик", callback_data: `mj:nvc:f:${input.updateId}` },
        ]],
      }).catch(() => {});
      return true;
    }
    await forgetVoicelessQuestion(input.chatId);
    const text = stored.ok
      ? `Ролик №${stored.shortId} без голоса сохранён. Поменяется цена — CRM сама заменит голос, музыку не тронет. Спасибо!`
      : `Объект №${target.shortId}: ${stored.error}`;
    await sendToMontajer(input.chatId, text, { copy: true, propertyShortId: target.shortId }).catch(() => {});
    return true;
  } catch (err) {
    void logSystemError("video-handoff", `Объект №${target.shortId}: ролик без голоса не сохранён: ${describeError(err)}`);
    await sendToMontajer(input.chatId, "Не получилось сохранить ролик без голоса — попробуйте ещё раз.", { copy: false }).catch(() => {});
    return true;
  } finally {
    await fs.promises.rm(tmpPath, { force: true }).catch(() => {});
  }
}

const VOICELESS_CHOICE_KIND = "montajer_voiceless_choice";
type VoicelessChoicePayload = { input: MontajerVideoInput; propertyId: string; shortId: number };
async function rememberVoicelessChoice(input: MontajerVideoInput, target: VoicelessTarget): Promise<void> {
  const data = { agentId: input.agentId, kind: VOICELESS_CHOICE_KIND, expiresAt: new Date(Date.now() + MONTAJER_RECEIVE_QUESTION_TTL_MS),
    payload: { input: { ...input, albumGroupId: undefined }, propertyId: target.propertyId, shortId: target.shortId } as unknown as Prisma.InputJsonValue };
  await prisma.telegramDialogState.upsert({ where: { chatId: input.chatId }, create: { chatId: input.chatId, ...data }, update: data });
}

/** «Это №N без голоса» / «Это новый готовый ролик» (`mj:nvc:v|f:<updateId>`) — ответ на несовпавшую длину. */
async function handleVoicelessChoice(chatId: string, agentId: string, kind: "v" | "f", updateId: number): Promise<void> {
  const row = await prisma.telegramDialogState.findUnique({ where: { chatId } });
  const payload = row?.kind === VOICELESS_CHOICE_KIND ? (row.payload as unknown as VoicelessChoicePayload) : null;
  if (!row || !payload || row.agentId !== agentId || row.expiresAt <= new Date() || payload.input.updateId !== updateId) {
    await sendToMontajer(chatId, "Этот вопрос уже устарел — пришлите файл ещё раз.", { copy: false }).catch(() => {});
    return;
  }
  await prisma.telegramDialogState.deleteMany({ where: { chatId, kind: VOICELESS_CHOICE_KIND } });
  if (kind === "v") {
    await handleVoicelessCopy(payload.input, { propertyId: payload.propertyId, shortId: payload.shortId, via: "choice" });
    return;
  }
  // Новый готовый ролик — обычный приём (вопрос «без голоса» уже снят, файл им не станет).
  await handleMontajerVideo(payload.input);
}

/** Кнопки «🎵 Пришлю без голоса» (`mj:nv:<номер>`) и «Не сейчас» (`mj:nvx:<номер>`). */
export async function handleVoicelessCopyCallback(chatId: string, agentId: string, data: string): Promise<void> {
  const choice = data.match(/^mj:nvc:(v|f):(\d+)$/);
  if (choice) return handleVoicelessChoice(chatId, agentId, choice[1] as "v" | "f", Number(choice[2]));
  const match = data.match(/^mj:(nv|nvx):(\d{1,7})$/);
  if (!match) return;
  const shortId = Number(match[2]);
  if (match[1] === "nvx") {
    await forgetVoicelessQuestion(chatId);
    await sendToMontajer(chatId, `Хорошо. Если цена №${shortId} поменяется, новый голос вклеите вы.`, { copy: false }).catch(() => {});
    return;
  }
  const p = await prisma.property.findFirst({ where: { shortId, deletedAt: null }, select: { id: true } });
  if (!p) {
    await sendToMontajer(chatId, `Объекта №${shortId} в CRM нет.`, { copy: false }).catch(() => {});
    return;
  }
  await rememberVoicelessQuestion(chatId, agentId, p.id, shortId);
  await sendToMontajer(chatId, `Жду ролик №${shortId} без голоса: пришлите его файлом в течение часа.`, { copy: false }).catch(() => {});
}

/**
 * Ответ на «чей это ролик» — `mj:rcv:<updateId>:<номер>` (0 — «ни то, ни
 * другое»). Вопрос устарел (15 минут, другой файл, выбор не из предложенных) —
 * просим прислать файл заново, ничего не принимая.
 */
export async function handleMontajerReceiveCallback(chatId: string, agentId: string, data: string): Promise<void> {
  const match = data.match(/^mj:rcv:(\d+):(\d+)$/);
  const row = await prisma.telegramDialogState.findUnique({ where: { chatId } });
  const payload = row?.kind === RECEIVE_DIALOG_KIND ? (row.payload as unknown as ReceiveQuestionPayload) : null;
  const fresh = !!row && !!payload && row.agentId === agentId && row.expiresAt > new Date();
  const updateId = match ? Number(match[1]) : NaN;
  const chosen = match ? Number(match[2]) : NaN;
  if (!match || !fresh || payload!.updateId !== updateId || (chosen !== 0 && !payload!.candidates.includes(chosen))) {
    await sendToMontajer(chatId, "Этот вопрос уже устарел — пришлите файл ещё раз, с номером объекта в имени.", {
      copy: false,
    }).catch(() => {});
    return;
  }
  await prisma.telegramDialogState.deleteMany({ where: { chatId, kind: RECEIVE_DIALOG_KIND } });
  if (chosen === 0) {
    await sendToMontajer(
      chatId,
      `Файл «${payload!.filename}» не принят. Пришлите его с номером объекта в имени файла («133.mp4») или в подписи.`,
      { copy: false }
    ).catch(() => {});
    return;
  }
  await handleMontajerVideo(
    {
      chatId,
      agentId,
      updateId: payload!.updateId,
      fileId: payload!.fileId,
      filename: payload!.filename,
      caption: payload!.caption,
    },
    chosen
  );
}
