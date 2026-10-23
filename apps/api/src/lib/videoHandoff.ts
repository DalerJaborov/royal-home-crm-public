/**
 * РУЧНАЯ ПЕРЕДАЧА ВИДЕО МОНТАЖЁРУ ЧЕРЕЗ TELEGRAM (01.09.2026, владелец: «монтажёр
 * пусть просто добавляет видео в CRM или отвечает боту»).
 *
 * ЕДИНСТВЕННЫЙ путь подготовки ролика с 04.09.2026: параллельный автомонтаж
 * (lib/reelsAutoMontage.ts + вторая модерация «Публикации») удалён целиком по
 * решению владельца, см. docs/video-pipeline-handoff-only-04-09-2026.md. Точка
 * входа прежняя (routes/properties/moderation.ts, момент когда фото+видео
 * одобрены и объект входит в EDITING), рубильник — Settings.videoHandoffEnabled.
 *
 * ОЧЕРЕДЬ СТРОГО ПО ОДНОМУ (владелец: «чтобы не перепутать объекты»). У
 * монтажёра в любой момент лежит максимум один необработанный ролик — следующий
 * объект физически не отправляется, пока текущий не закрыт videoHandoffStatus
 * → RECEIVED. Роль очереди играет сама таблица Property: под замком — простой
 * SELECT ... WHERE videoHandoffStatus='SENT_TO_EDITOR' LIMIT 1, отдельной модели
 * очереди не заводили.
 *
 * ФОРМАТ ФАЙЛА — ДОКУМЕНТОМ, НЕ ВИДЕО. sendVideo пережимает под плеер-превью
 * Telegram даже отправленный файлом — монтажёр получил бы уже испорченный
 * исходник. sendDocumentFile передаёт байты без сжатия (см. telegram/api.ts).
 *
 * ПОТОЛКИ TELEGRAM — ИХ ДВА И ОНИ РАЗНЫЕ, до 12.09.2026 здесь стоял не тот.
 * Отправка ботом: 50 МБ в облаке, 2 ГБ на своём Bot API сервере. Скачивание
 * ботом: 20 МБ в облаке, без предела на своём. Отсюда бралось
 * TELEGRAM_BOT_DOWNLOAD_LIMIT_BYTES — то есть отправка монтажёру была зажата
 * вдвое сильнее, чем нужно, и ролики 20–50 МБ не доходили файлом вовсе.
 * Теперь предел отправки берётся из TELEGRAM_BOT_SEND_LIMIT_BYTES, а всё, что
 * тяжелее, уходит ссылкой на скачивание — не «зайдите поищите», а прямой
 * ссылкой с Content-Disposition: attachment (иначе Safari на iPhone откроет
 * файл плеером вместо загрузки).
 */
import fs from "node:fs";
import { rawVideoPublicationMarks } from "./publishedRawVideoRetention.js";
import path from "node:path";
import crypto from "node:crypto";
import { prisma, type TxClient } from "../db.js";
import type { Prisma, PropertyVideo } from "../generated/prisma/client.js";
import type { VideoHandoffMoveBody, VideoHandoffQueueState, PropertyVideoHandoffCard } from "@royal-home/shared";
import { logSystemError } from "./systemError.js";
import { montageCopyNote, sendMontageCopies, montageNotificationRecipients, sendToMontajer } from "./montageObservers.js";
import { describeError } from "./describeError.js";
import { publishApprovedPost } from "./socialPublish.js";
import { crosspostAfterFacebookPublish } from "./facebookCrosspost.js";
import { publishPropertyInstagramStories } from "./instagramStories.js";
import { publishAfterEditingComplete, blockersForSale } from "./propertyPipeline.js";
import {
  reelsCaptionValuesFromProperty,
  generateReelsCaptionFromTemplates,
  withPostFooter,
  applyContactFooter,
  priceInTjsOnly,
} from "./reelsCaptionTemplate.js";
import { makePropertyCover } from "./video/coverOpenAi.js";
import { loadMoneyContext } from "./money.js";
import { videoHandoffDir } from "../upload.js";
import { localVideoFilePath } from "./localVideoStorage.js";
import { legacyHandoffCoverPath } from "./diskCleanup.js";
import { describeRawVideo } from "./rawVideoFacts.js";
import { sendDocumentFile, sendDocument, sendMessage, TELEGRAM_BOT_SEND_LIMIT_BYTES } from "../telegram/api.js";
import { probeMediaInfo, type MediaInfo } from "./ffmpeg.js";
import { crmPublicBase } from "./crmPublicUrl.js";
import { signVideoDownloadToken } from "../auth/jwt.js";
import { sendPushToAgent, sendPushToAgents } from "../push.js";
import { enqueueBackgroundJob } from "../jobs/enqueue.js";
import {
  TIKTOK_PUBLISH_RETRY_JOB_TYPE,
  TIKTOK_PUBLISH_RETRY_MAX_ATTEMPTS,
  TIKTOK_PUBLISH_RETRY_FIRST_DELAY_MS,
  tiktokPublishRetryDedupeKey,
} from "../jobs/tiktokPublishRetryPolicy.js";
import { nextPublishSlot } from "./publishSchedule.js";
import { loadOccupiedPublishSlots } from "./publishSlots.js";
import { updatePublishedMarks } from "./publishedMarks.js";
import { loadPublishScheduleRules } from "./publishScheduleRules.js";
import { PROPERTY_PIPELINE_STATUSES, PUBLISH_AT_MAX_DAYS, VIDEO_REMAKE_REASON_LABELS, type VideoRemakeReason } from "@royal-home/shared";
import { sendAgentSharePost } from "./agentSharePost.js";
import { requestPultSnapshot } from "./pultCacheHook.js";

/**
 * ЗАДАНИЕ «ПУБЛИКАЦИЯ ПРИНЯТОГО РОЛИКА» (21.09.2026, случай №114) — тип,
 * потолок попыток и ключ дедупликации одной точкой, чтобы `receiveEditedVideo`
 * (ставит), `jobs/videoHandoffPublish.ts` (реестр обработчика, читает тип по
 * этой же константе) и сторож (проверяет, нет ли уже живого задания) не
 * разъехались в трёх местах на одну опечатку.
 */
export const VIDEO_HANDOFF_PUBLISH_JOB_TYPE = "video-handoff-publish";
/** 2м → 4м → 8м → 8м → 8м → 8м, итого ~38 минут до честной сдачи — тот же
 *  порядок величины, что и ручное вмешательство после алярма, но без него
 *  сперва: сеть до соцсетей может моргнуть и восстановиться сама. */
export const VIDEO_HANDOFF_PUBLISH_MAX_ATTEMPTS = 6;
export function videoHandoffPublishDedupeKey(propertyId: string): string {
  return `${VIDEO_HANDOFF_PUBLISH_JOB_TYPE}:${propertyId}`;
}

/** Подпись к ролику для монтажёра — то же самое, что уже пишет карточка объекта,
 *  просто человеку в Telegram, а не в базу. Не публичный текст (не публикуется
 *  никуда), поэтому берём просто читаемое перечисление фактов, без шаблонов. */
/**
 * ИМЯ ФАЙЛА ДЛЯ МОНТАЖЁРА — НОМЕР ОБЪЕКТА, И ТОЛЬКО ОН (владелец 21.09.2026,
 * после разбора перепутанных роликов №108 и №109; уточнение тем же днём —
 * «ОБ-000 тоже можно убрать, просто номер объекта и всё»).
 *
 * Монтажёр скачивает файлы себе и работает уже с ними, а приходят они как
 * `IMG_0241.mov` — по имени невозможно понять, к какой квартире ролик. Пока
 * файлы лежат в чате, спасает подпись; на диске подписи нет. Номер объекта в
 * самом имени закрывает это физически — ровно тот же номер, что и в тексте
 * («Объект №115»), однозначно ведёт к карточке. Исходное имя файла (`IMG_0241`)
 * само по себе ничего не говорит ни владельцу, ни монтажёру, поэтому его
 * убрали целиком — оставлять шум рядом с полезным номером незачем.
 *
 * Расширение сохраняем от исходного файла — формат монтажёру по-прежнему важен.
 */
export function montajerFileName(shortId: number, index: number, total: number, original: string): string {
  const dot = original.lastIndexOf(".");
  const ext = dot > 0 ? original.slice(dot) : "";
  const part = total > 1 ? `_${index + 1}из${total}` : "";
  return `${shortId}${part}${ext}`;
}

/**
 * ПЕРВАЯ СТРОКА ПОДПИСИ КАЖДОГО ФАЙЛА МОНТАЖЁРУ (25.09.2026, владелец: «чтобы
 * вообще никогда ни описания, ни ролики не путались»). Номер объекта и место
 * файла в наборе — в самом начале, для ЛЮБОГО числа файлов, включая один:
 * Telegram режет подпись с конца (1024 знака), так что номер не потеряется, и
 * пролистав на соседний файл, монтажёр видит номер раньше фактов.
 */
export function montajerFileCaptionHead(shortId: number, index: number, total: number, rawFacts?: string | null): string {
  return `Объект №${shortId} · файл ${index + 1} из ${total}${rawFacts ? ` · ${rawFacts}` : ""}`;
}

/** «из 1 файла», «из 15 файлов», «из 21 файла» — родительный после «из». */
function filesAfterIz(count: number): string {
  return count % 10 === 1 && count % 100 !== 11 ? "файла" : "файлов";
}

/**
 * КОНТРОЛЬНОЕ СООБЩЕНИЕ ПОСЛЕ ОТПРАВКИ (25.09.2026, №119: ушло 16, а видно было
 * «один»). Монтажёр сверяет число со своими файлами, а не верит на слово, что
 * «всё ушло»; недошедшее сторож досылает сам — так и сказано.
 */
export function montajerDeliveryControlText(shortId: number, deliveredCount: number, total: number): string {
  return deliveredCount >= total
    ? `Отправлено ${total} из ${total} ${filesAfterIz(total)} объекта №${shortId}.`
    : `Объект №${shortId}: дошло ${deliveredCount} из ${total} ${filesAfterIz(total)}, остальное дошлю автоматически.`;
}

export async function propertyFactsForMontajer(propertyId: string): Promise<string> {
  const property = await prisma.property.findUnique({
    where: { id: propertyId },
    include: {
      district: true,
      // Кто ведёт объект — монтажёру, чтобы было у кого спросить, не разыскивая
      // ответственного через администратора (решение владельца 21.09.2026).
      intakeAgent: { select: { fullName: true } },
      assignedAgent: { select: { fullName: true } },
    },
  });
  if (!property) return "";
  const v = reelsCaptionValuesFromProperty({
    type: property.type,
    rooms: property.rooms,
    areaSqm: property.areaSqm,
    floor: property.floor,
    totalFloors: property.totalFloors,
    price: property.price,
    currency: property.currency,
    condition: property.condition,
    stage: property.stage ?? null,
    marketType: property.marketType ?? null,
    districtName: property.district?.name ?? "",
    phone: null,
    address: property.address,
  });
  /**
   * МОНТАЖЁРУ — ТОЛЬКО СОМОНИ (владелец 23.09.2026: «монтажёру пусть цена идёт
   * только в сомони, а в автопостинге и в сомони, и в $»).
   *
   * Цена внутри кадра — та, что монтажёр наберёт с этой строки, и две суммы в
   * ней означают ровно одно: половина роликов выйдет с долларами на картинке.
   * Публичная подпись под постом продолжает показывать обе (buildPriceDisplay) —
   * это разные тексты для разных людей, и различие здесь намеренное.
   */
  const priceForMontajer = priceInTjsOnly(property.price, property.currency, await loadMoneyContext());
  // Владелец 16.09.2026 (второй заход) — назвал ровно семь фактов, каждый
  // отдельной строкой, теми же названиями, что в карточке объекта: Район,
  // Адрес, Этаж, Этажность (отдельно от этажа, не "X из Y" одной строкой),
  // Площадь, Комнаты, Цена. "Ориентир" переименован в "Адрес" ранее тем же
  // днём — то же самое поле property.address, просто в публичных
  // Reels-шаблонах его называют "ориентир", а тут текст не публичный.
  /**
   * АГЕНТ — ОДНОЙ СТРОКОЙ ПОСЛЕ НОМЕРА (владелец 21.09.2026: «чтобы имя агента
   * тоже уходило вместе с информацией про объект и номером объекта»).
   *
   * Берём того, кто реально ведёт объект: назначенный агент, а если его нет —
   * тот, кто объект завёл. Порядок именно такой: монтажёр спрашивает про
   * материал того, за кем объект закреплён СЕЙЧАС, а не того, кто когда-то его
   * создал. Ни одного из двух нет — строка не печатается вовсе, как и любой
   * пустой факт выше.
   */
  const agentName = property.assignedAgent?.fullName ?? property.intakeAgent?.fullName ?? null;
  const lines = [
    `Объект №${property.shortId}`,
    agentName ? `Агент: ${agentName}` : null,
    v.district ? `Район: ${v.district}` : null,
    v.address ? `Адрес: ${v.address}` : null,
    v.floor ? `Этаж: ${v.floor}` : null,
    v.totalFloors ? `Этажность: ${v.totalFloors}` : null,
    v.areaSqm ? `Площадь: ${v.areaSqm} м²` : null,
    v.rooms ? `Комнаты: ${v.rooms}` : null,
    priceForMontajer ? `Цена: ${priceForMontajer}` : null,
  ].filter((l): l is string => l !== null);
  return lines.join("\n");
}

/** Что передать в buildMontajerMessageText, чтобы собрать перемонтажное сообщение
 *  вместо обычной передачи. */
export interface RemakeMessageContext {
  reason: VideoRemakeReason;
  comment?: string | null;
}

/** «Label: value» → Map — единственный формат, в котором пишет propertyFactsForMontajer.
 *  Первая строка ("Объект №N") пропускается — она не факт карточки, а её сравнивать не с чем. */
function parseFactLines(factsText: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of factsText.split("\n").slice(1)) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    map.set(line.slice(0, idx).trim(), line.slice(idx + 1).trim());
  }
  return map;
}

/**
 * Что изменилось в карточке с прошлой передачи монтажёру — используется только
 * для WRONG_CAPTION/CARD_DATA_CHANGED (owner 20.09.2026, п.6 задания): монтажёр
 * должен видеть, ЧТО именно поправить, а не искать разницу сам. `null`, если
 * сравнивать не с чем (первая передача этого объекта вообще) — пустую заглушку
 * не печатаем, просто не показываем блок.
 */
function cardFactsDiff(oldFactsText: string | null, newFactsText: string): string[] | null {
  if (!oldFactsText) return null;
  const oldMap = parseFactLines(oldFactsText);
  const newMap = parseFactLines(newFactsText);
  const changes: string[] = [];
  for (const label of new Set([...oldMap.keys(), ...newMap.keys()])) {
    const oldVal = oldMap.get(label);
    const newVal = newMap.get(label);
    if (oldVal === newVal) continue;
    if (oldVal === undefined) changes.push(`${label}: добавилось — ${newVal}`);
    else if (newVal === undefined) changes.push(`${label}: было «${oldVal}», теперь не указано`);
    else changes.push(`${label}: «${oldVal}» → «${newVal}»`);
  }
  return changes;
}

/**
 * СОБИРАЕТ ТЕКСТ, КОТОРЫЙ УХОДИТ МОНТАЖЁРУ — одна функция для настоящей отправки
 * (dispatchToEditor) И для превью (GET /:id/montajer-preview), намеренно, а не
 * две копии (владелец 20.09.2026: «я хочу видеть, что отправляется монтажёру, а
 * то бывали ошибки, я каждый раз скриншот у него просил» — копия текста
 * разойдётся с оригиналом в первый же месяц, и превью станет красивым враньём).
 *
 * Обычная передача (remake не передан) — факты карточки плюс статус очереди
 * (queueStatusLine). Строку правил передачи (файлом, обложка отдельно, «меню»)
 * убрали из карточки целиком (владелец 21.09.2026: «лишнюю информацию удали из
 * карточки телеграма монтажёру») — карточка несёт только факты объекта и
 * очередь, правила монтажёр по-прежнему получает словом «помощь» (telegram/bot.ts).
 *
 * Перемонтаж (owner 20.09.2026, вторая правка задания — «строго минимум, ничего
 * лишнего»): ПОМЕТКА + номер объекта, причина словами, комментарий владельца
 * (если есть), при WRONG_CAPTION/CARD_DATA_CHANGED — что изменилось в карточке,
 * и факты. Без очереди, без номера захода — этого монтажёру знать незачем,
 * только затемняет главное.
 */
export async function buildMontajerMessageText(
  propertyId: string,
  remake?: RemakeMessageContext | null
): Promise<string> {
  const [facts, property, silentVideos] = await Promise.all([
    propertyFactsForMontajer(propertyId),
    prisma.property.findUnique({
      where: { id: propertyId },
      select: { shortId: true, videoHandoffLastFactsText: true },
    }),
    prisma.propertyVideo.findMany({
      where: { propertyId, hasAudio: false },
      select: { filename: true },
      orderBy: { uploadedAt: "asc" },
    }),
  ]);
  if (!facts) return "";

  /// БЕЗ ЗВУКА — отдельной строкой в конец (23.09.2026, задание C, объект №127):
  /// звук отсутствовал уже при загрузке агентом, и это не увидел никто до
  /// самого монтажа. Одна строка на все беззвучные исходники сразу.
  const silentNote = silentVideos.length
    ? `⚠ Без звука: ${silentVideos.map((v) => v.filename).join(", ")} — звук/музыку наложите при монтаже`
    : null;

  if (!remake) {
    const queueLine = await queueStatusLine(propertyId);
    return `${facts}${queueLine}${silentNote ? `\n\n${silentNote}` : ""}`;
  }

  const lines = [
    `🔁 ПЕРЕМОНТАЖ, объект №${property?.shortId ?? "?"}`,
    `Причина: ${VIDEO_REMAKE_REASON_LABELS[remake.reason]}`,
  ];
  if (remake.comment) lines.push(remake.comment);
  if (remake.reason === "WRONG_CAPTION" || remake.reason === "CARD_DATA_CHANGED") {
    const diff = cardFactsDiff(property?.videoHandoffLastFactsText ?? null, facts);
    if (diff && diff.length > 0) {
      lines.push("", "Что изменилось в карточке:", ...diff.map((d) => `• ${d}`));
    }
  }
  lines.push("", facts);
  if (silentNote) lines.push("", silentNote);
  return lines.join("\n");
}

/** "HANDOFF" — первая передача на монтаж, "REMAKE" — перемонтаж с причиной,
 *  "CANCELLED" — сняли с монтажа, "PROPERTY_DELETED" — объект удалён, пока
 *  монтажёр его держал, "RECEIPT" — квитанция после приёма готового файла,
 *  "FACTS_CHANGED" — агент поправил карточку, пока ролик у монтажёра (07.10.2026). */
export type MontajerMessageKind = "HANDOFF" | "REMAKE" | "CANCELLED" | "PROPERTY_DELETED" | "RECEIPT" | "FACTS_CHANGED";

/**
 * ЖУРНАЛ ВСЕГО, ЧТО CRM ОТПРАВИЛА МОНТАЖЁРУ (20.09.2026, владелец: «я хочу
 * видеть, что отправляется ему вообще, где-то должно быть окно или что-то»).
 *
 * ЕДИНСТВЕННОЕ место записи — каждый вызывающий код зовёт эту функцию, а не
 * пишет в MontajerMessage сам: иначе следующий новый способ что-то сказать
 * монтажёру (а они появляются) забудут завести здесь, и журнал станет молча
 * неполным, то есть будет врать тем, кто ему доверяет (владелец в карточке
 * объекта). Текст пишется РОВНО тот, что ушёл — не пересобирается заново.
 */
export async function recordMontajerMessage(propertyId: string, kind: MontajerMessageKind, text: string): Promise<void> {
  if (!text) return;
  try {
    await prisma.montajerMessage.create({ data: { propertyId, kind, text } });
  } catch (err) {
    void logSystemError(
      "video-handoff",
      `Не удалось записать в журнал сообщений монтажёру (объект ${propertyId}, ${kind}): ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/**
 * КАРТОЧКА ПО ЗАПРОСУ — монтажёр в любой момент получает те же семь фактов по
 * номеру объекта, даже если ролик уже принят и опубликован.
 *
 * Разбор 19.09.2026 (перемешанные описания двух квартир одного продавца): факты
 * уходили монтажёру РОВНО ОДИН РАЗ, подписью к первому файлу. Когда монтажёр
 * дошёл до монтажа и спросил бота «отправь информацию ролика», бот ответил
 * только статусом очереди — «сейчас монтаж ничего не ждёт», потому что ролик к
 * тому моменту уже был принят. Прочитать факты было негде, и они были
 * восстановлены по памяти из того, что осталось выше в переписке, — то есть по
 * ПРЕДЫДУЩЕЙ квартире. Это и есть перемешивание, и это отказ системы, а не
 * человеческий фактор: система показала данные один раз и отказалась повторить.
 */
/** «Стоит в очереди 2-м …» — место из того же orderedQueue, что у выдачи. */
async function queuedPlaceText(propertyId: string): Promise<string> {
  const place = (await orderedQueue()).findIndex((p) => p.id === propertyId) + 1;
  return place > 0 ? `Стоит в очереди ${place}-м, ролик ещё не отправлен.` : "Стоит в очереди, ролик ещё не отправлен.";
}

export async function montajerCardText(shortId: number): Promise<string> {
  const property = await prisma.property.findFirst({
    where: { shortId, deletedAt: null },
    select: { id: true, status: true, videoHandoffStatus: true, videoHandoffFinalPath: true },
  });
  if (!property) return `Объект №${shortId} не найден. Проверьте номер — он есть в шапке каждого сообщения с роликом.`;
  const facts = await propertyFactsForMontajer(property.id);
  /**
   * «Ролик уже принят» — ТОЛЬКО когда он правда принят (№138 ночной проверки
   * 24.09): передача RECEIVED и готовый файл на месте. Снятие с монтажа
   * (closeVideoHandoff) тоже ставит RECEIVED, но без файла, а объект остаётся
   * в EDITING — раньше карточка говорила монтажёру про ролик, которого он не
   * присылал.
   */
  const editedVideoReceived = property.videoHandoffStatus === "RECEIVED" && !!property.videoHandoffFinalPath;
  const state =
    property.videoHandoffStatus === "SENT_TO_EDITOR"
      ? "Сейчас в работе у вас."
      : property.videoHandoffStatus === "QUEUED"
        ? `${await queuedPlaceText(property.id)}${(await queuePaused()) ? " Очередь на паузе — придёт, когда её возобновят." : ""}`
        : property.status === "EDITING"
          ? editedVideoReceived
            ? "Ролик уже принят, объект на монтаже."
            : property.videoHandoffStatus === "RECEIVED"
              ? "Монтаж этого объекта снят руководством — ролик от вас сейчас не ждут."
              : "Объект на монтаже, но вам через бот не передавался."
          : `Статус объекта: ${property.status}.`;
  return `${facts}\n\n${state}`;
}

/**
 * Место монтажёра занимает РОВНО ОДИН объект — и это теперь гарантия, а не
 * везение (19.09.2026, владелец: «неважно сколько объектов, всё должно работать
 * слаженно»).
 *
 * Было: «посмотреть, занято ли» и «занять» — два отдельных запроса, между
 * которыми ничего не стоит, а зовут их из `void queueVideoHandoff(...)` (не
 * дожидаясь, routes/properties/moderation.ts). Два объекта, одобренных подряд,
 * успевали оба увидеть свободное место и оба уйти в SENT_TO_EDITOR. А
 * возвращённый монтажёром ролик привязывается к «самому старому
 * SENT_TO_EDITOR» (telegram/bot.ts) — то есть при двух занятых местах готовый
 * ролик одного объекта молча уезжает в карточку другого.
 *
 * Стало: проверка и захват — в одной транзакции под консультативным замком
 * Postgres. Замок на всю очередь один (номер постоянный), берётся на время
 * транзакции и снимается сам при любом исходе, включая падение. Отдельной
 * таблицы очереди по-прежнему нет, роль очереди играет сама Property.
 */
const HANDOFF_QUEUE_LOCK_ID = 1909_2026;

/**
 * ВЫДАЧА СЛОТА ПУБЛИКАЦИИ — ТОЖЕ ОБЩАЯ ОЧЕРЕДЬ (22.09.2026).
 *
 * Слот считается от последнего уже выданного (`nextPublishSlot`), то есть
 * «прочитал максимум — записал свой». Два ролика, принятых одновременно —
 * а это ровно тот случай, ради которого расстановка и вводилась («монтажёр
 * отправит 10 готовых роликов»), и путей приёма два (Telegram-бот и загрузка
 * из CRM, оба обычные параллельные запросы, — читали один и тот же максимум и
 * получали ОДИН И ТОТ ЖЕ слот. Пачка снова уходила залпом, причём молча:
 * каждая запись по отдельности верна.
 *
 * Замок общий на всю выдачу, а не по объекту (withPropertyLock): объекты тут
 * мешают друг другу именно тем, что делят одну шкалу времени.
 *
 * Экспортирован (28.09.2026) — фото-посты (lib/photoPosts.ts::schedulePhotoPostsTick)
 * берут тот же замок и садятся на ту же шкалу времени, читая занятые слоты через
 * lib/publishSlots.ts::loadOccupiedPublishSlots (объединяет Property.scheduledPublishAt
 * и PropertyPhotoPost.scheduledAt), а не второй независимый счётчик.
 */
export const PUBLISH_SLOT_LOCK_ID = 2209_2026;

/**
 * КТО ДЕРЖИТ МЕСТО МОНТАЖЁРА — ОДНО ОПРЕДЕЛЕНИЕ НА ВЕСЬ КОД (23.09.2026).
 *
 * `SENT_TO_EDITOR` значит «объект ждёт готовый файл», но не всегда «монтажёр над
 * ним работает»: ручная загрузка готового ролика из CRM
 * (publishedVideoFix.ts::openForManualFinalVideo) ставит тот же статус, чтобы
 * приёмник файла его пропустил. До этой правки такой объект занимал место
 * монтажёра наравне с настоящей передачей: брошенная или упавшая загрузка
 * держала очередь, в CRM было написано «у монтажёра», а монтажёр не получал
 * ничего, и досылать было нечего. Теперь место держит только настоящая
 * передача; очередь, привязка файла в боте, досылка и тревоги смотрят сюда.
 *
 * Удалённые объекты местом не считаются: объект, удалённый прямо из очереди,
 * иначе держал бы монтажёра занятым навсегда — он никогда не станет RECEIVED.
 */
export const EDITOR_HOLDER_WHERE = {
  videoHandoffStatus: "SENT_TO_EDITOR",
  deletedAt: null,
  videoHandoffManualSince: null,
} as const;

/** Кто-то уже держит необработанный ролик прямо сейчас? Единственный вопрос,
 *  который решает, отправлять следующий немедленно или ждать в очереди. */
async function editorIsBusy(tx: TxClient): Promise<boolean> {
  const busy = await tx.property.findFirst({ where: EDITOR_HOLDER_WHERE, select: { id: true } });
  return !!busy;
}

/**
 * ОЧЕРЕДЬ НА ПАУЗЕ? (24.09.2026, Settings.videoHandoffQueuePaused). Пауза держит
 * только ВЫДАЧУ места: освободившееся место не уходит следующему, одобренные
 * объекты встают в QUEUED. Держатель, которому место уже выдано, остаётся у
 * монтажёра, и досылка ему идёт как обычно. Читать под замком очереди там, где
 * от ответа зависит, кому достанется место.
 */
async function queuePaused(db: TxClient = prisma): Promise<boolean> {
  const settings = await db.settings.findUnique({ where: { id: "singleton" }, select: { videoHandoffQueuePaused: true } });
  return settings?.videoHandoffQueuePaused === true;
}

/** Всё, что решает «кому достанется место монтажёра», — только под этим замком. */
async function withQueueLock<T>(fn: (tx: TxClient) => Promise<T>): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${HANDOFF_QUEUE_LOCK_ID}::bigint)`;
    return fn(tx);
  });
}

/**
 * ПОРЯДОК ОЧЕРЕДИ — ОДНО ОПРЕДЕЛЕНИЕ НА ВЕСЬ КОД (24.09.2026, владелец: «хочу,
 * чтобы очередь всегда была соблюдена … и кнопку, чтобы передвигать очередь»).
 *
 * До этой правки «следующего» выбирали в нескольких местах каждый своим
 * запросом: выдача места и экран конвейера — по времени постановки, сторож
 * досылки — вообще без порядка (`findFirst` без `orderBy`). Порядок жил в
 * запросах, а не в данных, и передвинуть объект было нечем. Теперь порядок —
 * поле `Property.videoHandoffQueueOrder` (1..N), и читают его ТОЛЬКО через
 * `orderedQueue`/`nextInQueue`: выдача места, позиции на экране, состояние
 * очереди, ответ бота, карточка монтажёру, строка «Дальше в очереди» и сторож.
 * Время постановки — только запасной ключ для строк без номера.
 */
const QUEUED_WHERE = { videoHandoffStatus: "QUEUED", deletedAt: null } as const;

const QUEUE_ORDER_BY: Prisma.PropertyOrderByWithRelationInput[] = [
  { videoHandoffQueueOrder: { sort: "asc", nulls: "last" } },
  { videoHandoffSentAt: { sort: "asc", nulls: "last" } },
  { id: "asc" },
];

/** Потолок чтения очереди: «строго по одному» держит её в единицах, предел — от
 *  неожиданного, а не рабочая величина. */
const QUEUE_READ_LIMIT = 500;

/** `heldAt`/`holdReason` (25.09.2026, «Отложить») — только для отображения:
 *  отложенный остаётся В ЭТОМ списке на своём месте, его пропускает только
 *  `nextInQueue`. Не путать с держателем места — тот в `orderedQueue` не входит
 *  вовсе (см. QUEUED_WHERE). */
export type QueuedHandoffRef = { id: string; shortId: number; heldAt: Date | null; holdReason: string | null };

/** Вся очередь ждущих (без держателя места) в порядке выдачи, ВКЛЮЧАЯ
 *  отложенных — они по-прежнему стоят на своём месте, просто помечены
 *  (см. QueuedHandoffRef). Кому место уйдёт реально — `nextInQueue`. */
export async function orderedQueue(db: TxClient = prisma, opts: { excludeId?: string } = {}): Promise<QueuedHandoffRef[]> {
  const rows = await db.property.findMany({
    where: { ...QUEUED_WHERE, ...(opts.excludeId ? { id: { not: opts.excludeId } } : {}) },
    orderBy: QUEUE_ORDER_BY,
    select: { id: true, shortId: true, videoHandoffHeldAt: true, videoHandoffHoldReason: true },
    take: QUEUE_READ_LIMIT,
  });
  return rows.map((r) => ({ id: r.id, shortId: r.shortId, heldAt: r.videoHandoffHeldAt, holdReason: r.videoHandoffHoldReason }));
}

/** Кому место уйдёт следующим. `excludeId` — объект, который только что его
 *  освободил. Отложенных (`videoHandoffHeldAt` не пусто) ПРОПУСКАЕТ — держатель
 *  места отложить нельзя, а ждущий с паузой ждёт «Вернуть в очередь», не своей
 *  очереди (25.09.2026, «Отложить»). */
export async function nextInQueue(db: TxClient = prisma, excludeId?: string): Promise<QueuedHandoffRef | null> {
  const [first] = await db.property.findMany({
    where: { ...QUEUED_WHERE, videoHandoffHeldAt: null, ...(excludeId ? { id: { not: excludeId } } : {}) },
    orderBy: QUEUE_ORDER_BY,
    select: { id: true, shortId: true, videoHandoffHeldAt: true, videoHandoffHoldReason: true },
    take: 1,
  });
  return first ? { id: first.id, shortId: first.shortId, heldAt: first.videoHandoffHeldAt, holdReason: first.videoHandoffHoldReason } : null;
}

/** Записать порядок очереди заново, 1..N, одним запросом. Только под замком очереди. */
async function renumberQueue(tx: TxClient, orderedIds: string[]): Promise<void> {
  if (orderedIds.length === 0) return;
  await tx.$executeRaw`
    UPDATE "Property" AS p
    SET "videoHandoffQueueOrder" = v.ord::int
    FROM unnest(${orderedIds}::text[]) WITH ORDINALITY AS v(id, ord)
    WHERE p."id" = v.id`;
}

/** Номер для постановки в КОНЕЦ очереди: max+1. Только под замком очереди. */
async function queueTailOrder(tx: TxClient): Promise<number> {
  const agg = await tx.property.aggregate({ where: QUEUED_WHERE, _max: { videoHandoffQueueOrder: true } });
  return (agg._max.videoHandoffQueueOrder ?? 0) + 1;
}

/**
 * Выдать место монтажёра объекту из очереди — только под замком очереди.
 * Отметка доставки прошлого круга гасится вместе с занятием места: иначе смерть
 * процесса до отправки выглядела бы для сторожа досылки как «уже доставлено».
 * Время выдачи — сейчас, а не время постановки в очередь (24.09.2026): иначе
 * сторож досылки видел «выдан сутки назад, не доставлен» и слал дубль раньше,
 * чем dispatchToEditor успевал записать свою отметку.
 */
/**
 * НОВЫЙ КРУГ ПЕРЕДАЧИ — ОТМЕТКИ «ФАЙЛ У МОНТАЖЁРА» ГАСНУТ (25.09.2026). Досылка
 * шлёт только файлы без отметки (PropertyVideo.montajerDeliveredAt), поэтому
 * отметки прошлого круга (перемонтаж, «Снова на монтаж») иначе оставили бы
 * монтажёра без файлов нового круга. Зовётся там, где объект встаёт в очередь или
 * занимает место, — внутри той же транзакции.
 */
async function resetMontajerDeliveryMarks(tx: TxClient, propertyId: string): Promise<void> {
  await tx.propertyVideo.updateMany({
    where: { propertyId, montajerDeliveredAt: { not: null } },
    data: { montajerDeliveredAt: null, montajerDeliveredToId: null },
  });
}

async function seatFromQueue(tx: TxClient, propertyId: string): Promise<void> {
  await resetMontajerDeliveryMarks(tx, propertyId);
  await tx.property.update({
    where: { id: propertyId },
    data: {
      videoHandoffStatus: "SENT_TO_EDITOR",
      videoHandoffSentAt: new Date(),
      videoHandoffDeliveredAt: null,
      videoHandoffDispatchAttempts: 0,
      videoHandoffManualSince: null,
      videoHandoffQueueOrder: null,
    },
  });
}

/**
 * ЛОК ПО ОДНОМУ ОБЪЕКТУ (21.09.2026, аудит «монтажёр ↔ CRM») — тот же приём, что
 * и withQueueLock выше (pg_advisory_xact_lock, снимается сам с транзакцией), но
 * ключ не общий на всю очередь, а свой на propertyId: hashtext(uuid) → int4,
 * приводим к bigint явно (у advisory-функции нет перегрузки под int4). Нужен
 * там, где несколько запросов могут одновременно решать судьбу ОДНОГО объекта
 * (лимит числа видео routes/properties/videos.ts, закрытие хендоффа ниже) —
 * заводить для этого второй общий лок как HANDOFF_QUEUE_LOCK_ID было бы неверно:
 * он держал бы разные объекты друг за друга, хотя они друг другу не мешают.
 */
export async function withPropertyLock<T>(propertyId: string, fn: (tx: TxClient) => Promise<T>): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${propertyId})::bigint)`;
    return fn(tx);
  });
}

/**
 * Вызывается из routes/properties/moderation.ts сразу после того, как оба
 * материала (фото+видео) одобрены и объект вошёл в EDITING — тот же момент,
 * что запускает (или не запускает) автомонтаж. No-op молча, если
 * Settings.videoHandoffEnabled выключен — это не ошибка, это обычный путь,
 * когда монтажёр работает как раньше вручную через CRM.
 */
/** Куда встаёт объект, если место монтажёра занято: одобрение и «Снова на
 *  монтаж» — в конец, «Вернуть монтажёру» (переделка уже сданного) — в начало. */
export type QueuePlacement = "back" | "front";

/**
 * Общее ядро «кому достанется место монтажёра» — только запись статуса, под
 * HANDOFF_QUEUE_LOCK_ID, через переданный tx. Вынесено (24.09.2026) отдельно
 * от queueVideoHandoff ниже, чтобы sendBackToMontajer (publishedVideoFix.ts)
 * мог выполнить ЭТУ ЖЕ запись изнутри СВОЕЙ транзакции (withPropertyLock) —
 * см. queueVideoHandoffInTx.
 *
 * Возвращает id объекта, которому в этом шаге выдано место (сам объект или
 * голова очереди), либо null — место занято или очередь на паузе. Файлы
 * вызывающий шлёт ровно этому id и только после коммита (24.09.2026).
 */
async function applyQueueTransition(
  tx: TxClient,
  propertyId: string,
  remake: RemakeMessageContext | null | undefined,
  placement: QueuePlacement
): Promise<string | null> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${HANDOFF_QUEUE_LOCK_ID}::bigint)`;
  // Очередь на паузе — одобрение ставит объект в очередь, а не монтажёру
  // (24.09.2026): иначе пауза держала бы только освобождение места, а новое
  // одобрение при свободном месте всё равно уезжало бы сразу.
  const busy = await editorIsBusy(tx);
  const paused = await queuePaused(tx);
  const waiting = await orderedQueue(tx, { excludeId: propertyId });
  // Место свободно, но впереди уже кто-то ждёт (очередь только что сняли с
  // паузы, процесс умер между освобождением и выдачей) — новичок не обходит
  // ждущих: встаёт в очередь, а место уходит её голове (24.09.2026, «чтобы
  // очередь всегда была соблюдена»). «В начало» — значит и впереди всех.
  const seatSelf = !busy && !paused && (waiting.length === 0 || placement === "front");
  await resetMontajerDeliveryMarks(tx, propertyId);
  await tx.property.update({
    where: { id: propertyId },
    // videoHandoffSentAt пишем и для QUEUED (не только для реальной отправки) —
    // запасной ключ порядка для строк без номера (QUEUE_ORDER_BY).
    // dispatchToEditor перезапишет это же поле настоящим временем отправки,
    // когда объект реально уйдёт монтажёру.
    data: {
      videoHandoffStatus: seatSelf ? "SENT_TO_EDITOR" : "QUEUED",
      videoHandoffSentAt: new Date(),
      // «В начало» перенумеровывается ниже вместе со всей очередью.
      videoHandoffQueueOrder: seatSelf ? null : placement === "back" ? await queueTailOrder(tx) : 0,
      // Отметка доставки от ПРОШЛОГО круга (перемонтаж, «Вернуть монтажёру»)
      // иначе переживала бы вход в новую передачу: процесс умер до отправки,
      // а сторож досылки видит «доставлено» и молчит, пока очередь стоит.
      videoHandoffDeliveredAt: null,
      videoHandoffDispatchAttempts: 0,
      videoHandoffManualSince: null,
      // Причина/комментарий перемонтажа кладём НА ОБЪЕКТ, а не держим в
      // памяти: если место монтажёра занято, dispatchToEditor выполнится
      // позже (releaseQueueIfClear), уже без доступа к аргументам этого
      // вызова — единственный источник правды к тому моменту это Property.
      videoHandoffRemakeReason: remake?.reason ?? null,
      videoHandoffRemakeComment: remake?.comment ?? null,
    },
  });
  if (seatSelf) return propertyId;
  if (placement === "front") await renumberQueue(tx, [propertyId, ...waiting.map((p) => p.id)]);
  if (busy || paused) return null;
  const head = await nextInQueue(tx);
  if (!head) return null;
  await seatFromQueue(tx, head.id);
  return head.id;
}

export async function queueVideoHandoff(
  propertyId: string,
  remake?: RemakeMessageContext | null,
  placement: QueuePlacement = "back"
): Promise<void> {
  const settings = await prisma.settings.findUnique({
    where: { id: "singleton" },
    select: { videoHandoffEnabled: true, videoMontajerAgentId: true },
  });
  if (!settings?.videoHandoffEnabled) return;
  if (!settings.videoMontajerAgentId) {
    void logSystemError("video-handoff", `Объект ${propertyId} готов к передаче, но монтажёр не назначен в Настройках`);
    return;
  }

  // Проверить и занять — одним неделимым шагом, см. withQueueLock выше. Сама
  // отправка монтажёру идёт уже ВНЕ замка: она ходит в Telegram и может длиться
  // секунды, держать на ней замок всей очереди незачем.
  const seated = await withQueueLock((tx) => applyQueueTransition(tx, propertyId, remake, placement));
  if (seated === propertyId) await dispatchToEditor(propertyId, settings.videoMontajerAgentId);
  // Место ушло голове очереди, а не этому объекту — её файлы уходят в фоне,
  // как при любой выдаче места следующему (releaseQueueIfClear).
  else if (seated) dispatchInBackground(seated, settings.videoMontajerAgentId);
}

/**
 * queueVideoHandoff ДЛЯ ВЫЗОВА ИЗНУТРИ ЧУЖОЙ ТРАНЗАКЦИИ (24.09.2026,
 * sendBackToMontajer::withPropertyLock, publishedVideoFix.ts — закрытие
 * гонки двойного клика, п.2 задания send-back-api-24-09.md).
 *
 * queueVideoHandoff САМ открывает транзакцию (withQueueLock → новое
 * подключение). Позвать его изнутри ещё не закоммиченной ВНЕШНЕЙ транзакции,
 * которая уже писала в ту же строку Property, значило бы самоблокировку:
 * внешняя ждёт эту функцию, а её собственная транзакция ждёт снятия
 * блокировки со строки, которую держит внешняя же транзакция, — повиснет
 * навсегда. Поэтому здесь статус переводится ТЕМ ЖЕ tx, что держит внешний
 * замок (withPropertyLock): к моменту, когда внешняя транзакция коммитится
 * и второй параллельный запрос получает доступ к строке, статус уже
 * QUEUED/SENT_TO_EDITOR, а не промежуточный NONE — гонка закрыта целиком,
 * а не только на шаге проверки и создания заявки.
 *
 * Дозвон монтажёру (dispatchToEditor, Telegram) по-прежнему СНАРУЖИ, уже
 * после коммита внешней транзакции: вызывающий обязан позвать его сам, когда
 * получит `dispatch: true` — держать замок объекта на время сетевого похода
 * незачем (тот же принцип, что у queueVideoHandoff выше).
 *
 * Настройки (videoHandoffEnabled/videoMontajerAgentId) вызывающий обязан
 * проверить САМ до вызова — здесь не перепроверяются и не логируются:
 * sendBackToMontajer уже отказал бы 409 раньше, а честность после этого шага
 * (статус не стал QUEUED/SENT_TO_EDITOR) — забота вызывающего.
 */
export async function queueVideoHandoffInTx(
  tx: TxClient,
  propertyId: string,
  montajerAgentId: string,
  remake?: RemakeMessageContext | null,
  placement: QueuePlacement = "back"
): Promise<{ dispatch: false } | { dispatch: true; propertyId: string; montajerAgentId: string }> {
  const seated = await applyQueueTransition(tx, propertyId, remake, placement);
  return seated ? { dispatch: true, propertyId: seated, montajerAgentId } : { dispatch: false };
}

/**
 * Ссылка, по которой сырой ролик СКАЧИВАЕТСЯ, а не проигрывается.
 *
 * Именно скачивается: маршрут `.../download-file` отдаёт файл с заголовком
 * `Content-Disposition: attachment` (routes/properties/videos.ts). Голый путь
 * `/uploads/video/...` этого заголовка не имеет — Safari на iPhone такой файл
 * просто открывает плеером, и монтажёр остаётся без файла (владелец, 12.09.2026).
 *
 * Срок жизни ссылки — неделя, а не обычные десять минут: она уходит в сообщение,
 * которое монтажёр откроет, когда освободится.
 */
export function rawVideoDownloadLink(propertyId: string, videoId: string): string | null {
  const base = crmPublicBase();
  if (!base) return null;
  const token = signVideoDownloadToken(videoId, "7d");
  return `${base}/api/v1/properties/${propertyId}/videos/${videoId}/download-file?token=${token}`;
}

/**
 * ПОСЛЕДНИЙ РЕЗЕРВ — ССЫЛКА ТОЛЬКО КОГДА ПОПЫТКИ СТОРОЖА ИСЧЕРПАНЫ (24.09.2026,
 * задание D). Раньше ссылка на скачивание шла сразу же, вдогонку неудачной
 * попытке файлом — и от Bot API нередко приходил дубль (см. докстринг в
 * deliverSourceVideos выше). Теперь ссылку шлёт ТОЛЬКО сторож
 * (lib/videoHandoffRedelivery.ts), и только для роликов, которые НИ РАЗУ не
 * ушли монтажёру за все попытки этого круга (отметка montajerDeliveredAt, 25.09.2026;
 * раньше смотрели на `telegramFileId`, но его ставит и копия наблюдателю — файл,
 * дошедший до наблюдателя, но не до монтажёра, оставался бы без ссылки).
 */
export async function sendGiveUpFallbackLinks(propertyId: string, shortId: number, montajerAgentId: string): Promise<void> {
  const [montajer, videos] = await Promise.all([
    prisma.agent.findFirst({ where: { id: montajerAgentId, isActive: true }, select: { telegramChatId: true } }),
    prisma.propertyVideo.findMany({
      where: { propertyId, ...notYetWithMontajerWhere(montajerAgentId) },
      orderBy: SOURCE_VIDEO_ORDER,
      select: { id: true, filename: true },
    }),
  ]);
  if (!montajer?.telegramChatId || videos.length === 0) return;
  for (const video of videos) {
    const link = rawVideoDownloadLink(propertyId, video.id);
    const text = link
      ? `Объект №${shortId}: ролик «${video.filename}» так и не дошёл файлом после всех попыток. Ссылка на скачивание: ${link}`
      : `Объект №${shortId}: ролик «${video.filename}» так и не дошёл файлом после всех попыток, а ссылка недоступна (не настроен публичный адрес CRM) — заберите через карточку объекта в CRM.`;
    try {
      await sendToMontajer(montajer.telegramChatId, text, { copy: true, propertyShortId: shortId });
    } catch (err) {
      void logSystemError(
        "video-handoff",
        `Объект №${shortId}: запасная ссылка на «${video.filename}» тоже не отправилась: ${describeError(err)}`
      );
    }
  }
}

function megabytes(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(0);
}

/**
 * Склонение «ролик/ролика/роликов» — используется и в подписи к ролику
 * (queueStatusLine), и в ответе на вопрос «очередь» (queueStatusForMontajer),
 * чтобы формулировка не разъехалась между двумя местами.
 */
function pluralRoliks(count: number): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return "ролик";
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return "ролика";
  return "роликов";
}

/**
 * Сколько РОЛИКОВ (файлов), а не объектов, ждёт своей очереди на монтаж
 * (владелец 21.09.2026: «сколько роликов осталось на монтаж, а не какие
 * объекты»). Считаем именно файлы — монтажёр меряет работу ими, а у одного
 * объекта роликов может быть несколько (см. dispatchToEditor: до 30 штук на
 * объект, Settings.propertyVideoMaxCount).
 *
 * Два запроса вместо одного: сперва id объектов в очереди, потом count их
 * сырых видео одним `WHERE propertyId IN (...)`. Дороже, чем один голый
 * count по Property, но очередь «строго по одному» держит списки крошечными
 * (обычно 0-3 объекта), так что цена не растёт с базой в целом — а посчитать
 * объекты вместо роликов означало бы соврать монтажёру, если у кого-то из
 * них снято два-три дубля.
 */
async function queuedRolikCount(excludePropertyId?: string): Promise<number> {
  // Отложенные (25.09.2026) НЕ считаются «дальше в очереди» монтажёру — они
  // придержаны сознательно, показывать их как работу, которая вот-вот придёт,
  // было бы неправдой (см. nextInQueue — их и не выдаст).
  const queuedProperties = (await orderedQueue(prisma, { excludeId: excludePropertyId })).filter((p) => !p.heldAt);
  if (queuedProperties.length === 0) return 0;
  return prisma.propertyVideo.count({ where: { propertyId: { in: queuedProperties.map((p) => p.id) } } });
}

/** Строка про очередь для подписи к ролику, который монтажёр вот-вот получит —
 *  просто число оставшихся роликов (владелец 21.09.2026), без перечисления
 *  объектов. Пусто, если очередь пуста. */
async function queueStatusLine(excludePropertyId: string): Promise<string> {
  const [count, paused] = await Promise.all([queuedRolikCount(excludePropertyId), queuePaused()]);
  if (count === 0) return "";
  return `\n\nДальше в очереди: ${count} ${pluralRoliks(count)}${paused ? " (очередь на паузе — следующий пока не придёт)" : ""}.`;
}

/**
 * Живой статус очереди — монтажёр видит его по ЛЮБОМУ своему сообщению боту, не
 * только в момент отправки нового ролика (владелец, 16.09.2026: «чтобы монтажёр
 * всегда видел очередь объектов», найдено после того как объект №96 провисел
 * в очереди 5 дней никем не замеченный, см. videoHandoffStaleAlarm.ts). Вызывается
 * из telegram/bot.ts для чата, привязанного к текущему Settings.videoMontajerAgentId.
 *
 * Очередь — числом роликов, не перечнем номеров объектов (владелец 21.09.2026,
 * тот же день, что и правка queueStatusLine — «привести к тому же виду»).
 */
/** Сколько объектов очереди бот перечисляет по номерам — дальше «и ещё N». */
const MONTAJER_QUEUE_LIST_LIMIT = 10;

/** «Очередь: 1) №12, 2) №15 (отложен) …» — тем же порядком, каким место будет
 *  выдаваться (orderedQueue), чтобы монтажёр видел, что придёт следующим
 *  (24.09.2026). Отложенный (25.09.2026) помечен прямо в списке — он стоит на
 *  месте, но место ему не уйдёт, пока не вернут в очередь. */
function montajerQueueListLine(queue: QueuedHandoffRef[]): string {
  if (queue.length === 0) return "";
  const shown = queue.slice(0, MONTAJER_QUEUE_LIST_LIMIT).map((p, i) => `${i + 1}) №${p.shortId}${p.heldAt ? " (отложен)" : ""}`);
  const rest = queue.length - shown.length;
  return `Очередь: ${shown.join(", ")}${rest > 0 ? ` и ещё ${rest}` : ""}.`;
}

export async function queueStatusForMontajer(): Promise<string> {
  const [current, queuedCount, settingsRow, queue] = await Promise.all([
    prisma.property.findFirst({
      where: EDITOR_HOLDER_WHERE,
      select: { shortId: true, videoHandoffSentAt: true },
    }),
    queuedRolikCount(),
    prisma.settings.findUnique({
      where: { id: "singleton" },
      select: { videoHandoffQueuePaused: true, videoHandoffQueuePauseReason: true },
    }),
    orderedQueue(),
  ]);
  const paused = settingsRow?.videoHandoffQueuePaused ?? false;
  const listLine = montajerQueueListLine(queue);
  // Пауза (24.09.2026) — честно: иначе «монтаж ничего не ждёт» при трёх
  // объектах в очереди читалось бы как «работы нет», а она есть, просто придержана.
  // Причина — рядом с фактом паузы (25.09.2026, А4): «на паузе» без объяснения
  // читалось монтажёром как сбой, а не как чьё-то осознанное решение.
  const pausedLine = paused
    ? `Очередь на паузе — новые объекты пока не придут.${settingsRow?.videoHandoffQueuePauseReason ? ` Причина: ${settingsRow.videoHandoffQueuePauseReason}.` : ""}`
    : "";
  if (!current) {
    if (!paused) return "Сейчас монтаж ничего не ждёт.";
    return queuedCount > 0
      ? `Сейчас монтаж ничего не ждёт. В очереди ${queuedCount} ${pluralRoliks(queuedCount)}, но ${pausedLine[0].toLowerCase()}${pausedLine.slice(1)}${listLine ? `\n${listLine}` : ""}`
      : `Сейчас монтаж ничего не ждёт. ${pausedLine}`;
  }
  const sentAgo = current.videoHandoffSentAt
    ? Math.floor((Date.now() - current.videoHandoffSentAt.getTime()) / (60 * 60 * 1000))
    : null;
  const lines = [`В работе у вас: объект №${current.shortId}${sentAgo !== null ? ` (отправлен ${sentAgo} ч назад)` : ""}.`];
  if (queuedCount > 0) lines.push(`Дальше в очереди: ${queuedCount} ${pluralRoliks(queuedCount)}.`);
  if (pausedLine) lines.push(pausedLine);
  return listLine ? `${lines.join(" ")}\n${listLine}` : lines.join(" ");
}

/**
 * Отправляет монтажёру ВСЕ сырые ролики объекта, по одному сообщению на ролик.
 *
 * До 12.09.2026 уходил ровно первый (`findFirst`), а остальные монтажёр мог найти
 * только сам, открыв карточку, — и ничто ему об их существовании не сообщало.
 * Владелец: «иногда снимают несколько специально, чтобы монтажёр собрал из них
 * один или выбрал нормальный». Поэтому шлём все и нумеруем их «файл 2 из 3».
 *
 * Очередь «строго по одному» из шапки файла этим не нарушается: она про ОБЪЕКТЫ,
 * а не про файлы — у монтажёра по-прежнему в работе один объект.
 *
 * Ролик тяжелее предела отправки уходит ссылкой на скачивание, а не отказом:
 * предел зависит от того, куда смотрит бот (облако Telegram — 50 МБ, свой Bot API
 * сервер — 2 ГБ, см. telegram/api.ts), и меняться он будет без правок здесь.
 */
/**
 * Пауза между сообщениями одному чату — см. докстринг у места вызова ниже.
 * `let`, а не константа, только ради тестов (setMontajerSendPauseMsForTests):
 * пятнадцать файлов с настоящей паузой — это 16 секунд на каждый тест.
 */
const TELEGRAM_SEND_PAUSE_MS = 1_100;
let telegramSendPauseMs = TELEGRAM_SEND_PAUSE_MS;

/** Только для тестов: пауза между файлами одному чату. Без аргумента — боевая. */
export function setMontajerSendPauseMsForTests(ms: number = TELEGRAM_SEND_PAUSE_MS): void {
  telegramSendPauseMs = ms;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Таймаут отправки файлом растёт с размером: 480-МБ .mov через свой Bot API
 *  не укладывается в стандартные 60 с (свой сервер отвечает, лишь дозалив файл
 *  в Telegram). 1 с на мегабайт сверху — с большим запасом даже на медленном канале. */
function sendTimeoutForBytes(bytes: number): number {
  return 60_000 + Math.ceil(bytes / (1024 * 1024)) * 1_000;
}

/**
 * ПОРЯДОК ИСХОДНИКОВ — ОДИН НА ВСЕ ПУТИ (25.09.2026). Отдельного поля порядка у
 * PropertyVideo нет: порядок — это порядок загрузки агентом, а при равном времени
 * (пачка с телефона пишется в одну миллисекунду) — id, иначе «файл 3 из 15»
 * на повторе мог бы оказаться другим файлом, чем в первый раз.
 */
export const SOURCE_VIDEO_ORDER = [{ uploadedAt: "asc" }, { id: "asc" }] satisfies Prisma.PropertyVideoOrderByWithRelationInput[];

/** Файл ещё не у ЭТОГО монтажёра в текущем круге (см. PropertyVideo.montajerDeliveredAt). */
function notYetWithMontajerWhere(montajerAgentId: string): Prisma.PropertyVideoWhereInput {
  return {
    OR: [{ montajerDeliveredAt: null }, { montajerDeliveredToId: null }, { montajerDeliveredToId: { not: montajerAgentId } }],
  };
}

function isWithMontajer(
  video: { montajerDeliveredAt: Date | null; montajerDeliveredToId: string | null },
  montajerAgentId: string
): boolean {
  return !!video.montajerDeliveredAt && video.montajerDeliveredToId === montajerAgentId;
}

/** Строка PropertyVideo целиком — findMany без select (факты, file_id, отметки). */
type SourceVideo = PropertyVideo;

/**
 * ОДИН ОБЪЕКТ — ОДНА ПОСЫЛКА (25.09.2026, владелец: «защиту поставь, чтобы
 * вообще никогда ни описания, ни ролики, ни ещё что-то не путались»).
 *
 * История путаниц: 19.09 подпись одного объекта оказалась у ролика другого;
 * №119 — 16 файлов ушли, а журнал говорил про один. Корень один: тексты и файлы
 * собирались РАЗНЫМИ запросами и передавались отдельными аргументами, так что
 * ничто не мешало однажды отдать «факты №133» вместе с «файлами №136».
 *
 * Теперь всё, что уходит монтажёру по объекту, — одна неизменяемая посылка,
 * которую строит ОДНА функция из ОДНОГО propertyId (buildMontajerDelivery).
 * Поле-метка — незаэкспортированный символ, поэтому собрать посылку в обход этой
 * функции (подсунув чужие тексты или чужие файлы) не даст компилятор, а
 * deliverSourceVideos принимает только её. Перед каждым файлом ещё и проверка
 * на месте: файл принадлежит объекту посылки, иначе отправка прерывается.
 */
const MONTAJER_DELIVERY_BRAND: unique symbol = Symbol("MontajerDelivery");

export interface MontajerDelivery {
  readonly [MONTAJER_DELIVERY_BRAND]: true;
  readonly property: { readonly id: string; readonly shortId: number };
  readonly videos: readonly SourceVideo[];
  /** Первое сообщение (подпись к первому файлу): факты + очередь, либо перемонтаж. */
  readonly headText: string;
  /** Факты карточки — подпись ко всем остальным файлам. */
  readonly factsText: string;
  readonly remake: RemakeMessageContext | null;
}

export async function buildMontajerDelivery(propertyId: string): Promise<MontajerDelivery | null> {
  const [property, videos] = await Promise.all([
    prisma.property.findUnique({
      where: { id: propertyId },
      select: { id: true, shortId: true, videoHandoffRemakeReason: true, videoHandoffRemakeComment: true },
    }),
    prisma.propertyVideo.findMany({ where: { propertyId }, orderBy: SOURCE_VIDEO_ORDER }),
  ]);
  if (!property) return null;
  // Причина/комментарий перемонтажа — с самого объекта (queueVideoHandoff их
  // туда и положил, см. там же почему в памяти их не пронести через очередь).
  const remake: RemakeMessageContext | null = property.videoHandoffRemakeReason
    ? { reason: property.videoHandoffRemakeReason as VideoRemakeReason, comment: property.videoHandoffRemakeComment }
    : null;
  // ОДНА функция для реальной сборки и для превью (buildMontajerMessageText) —
  // см. её docstring. headText — то, что реально идёт первым сообщением.
  const [factsText, headText] = await Promise.all([
    propertyFactsForMontajer(propertyId),
    buildMontajerMessageText(propertyId, remake),
  ]);
  return Object.freeze({
    [MONTAJER_DELIVERY_BRAND]: true as const,
    property: Object.freeze({ id: property.id, shortId: property.shortId }),
    videos: Object.freeze(videos),
    headText,
    factsText,
    remake,
  });
}

/** Подпись и имя файла i — из ОДНОЙ посылки, в одном месте. */
function montajerFileCaption(delivery: MontajerDelivery, index: number, note: string | null): string {
  const video = delivery.videos[index]!;
  const head = montajerFileCaptionHead(delivery.property.shortId, index, delivery.videos.length, describeRawVideo(video));
  /**
   * ФАКТЫ КАРТОЧКИ — К КАЖДОМУ ФАЙЛУ, а не только к первому (19.09.2026).
   * Было: второй и третий ролик уходили строкой «Ролик 2 из 3. Объект №109»,
   * и данные квартиры оставались в переписке единственным сообщением — выше
   * файлов, между которыми монтажёр листает. У объекта с двумя роликами
   * достаточно пролистнуть на один файл назад, чтобы читать факты ЧУЖОЙ
   * квартиры, и именно так 19.09 описания двух квартир одного продавца
   * перемешались. Повторение семи строк дешевле перепутанного ролика.
   */
  const body = index === 0 ? delivery.headText : delivery.factsText;
  const caption = body ? `${head}\n\n${body}` : head;
  return note ? `${note}\n\n${caption}` : caption;
}

/**
 * Ответ Telegram «слишком часто» уже после всех повторов по retry_after
 * (telegram/api.ts): дальше бить тем же чатом — только собирать новые отказы.
 * Остаток этого круга не шлём, его дошлёт сторож по отметкам.
 */
function isTelegramRateLimitError(err: unknown): boolean {
  return /too many requests|retry after/i.test(err instanceof Error ? err.message : String(err));
}

/**
 * ОТПРАВКА ИСХОДНИКОВ МОНТАЖЁРУ. Место монтажёра (SENT_TO_EDITOR) к этому
 * моменту уже занято; факт доставки пишется ОТДЕЛЬНО — `videoHandoffDeliveredAt`,
 * только если КАЖДЫЙ файл объекта реально у монтажёра (отметка
 * PropertyVideo.montajerDeliveredAt — файлом, ссылкой или сообщением «тяжелее
 * лимита» со ссылкой).
 *
 * Зачем (22.09.2026, объект №121): 480-МБ .mov читался в память целиком и ещё раз
 * копировался в Blob — api (лимит 768 МБ) убило OOM через 8 секунд после
 * одобрения. Статус остался SENT_TO_EDITOR, ни строки в журнале, монтажёр ничего
 * не получил, а очередь «строго по одному» держала все следующие объекты в QUEUED
 * до ручной отмены утром. Теперь файл идёт потоком (`fs.openAsBlob`), а если
 * процесс всё же умрёт посреди отправки — `deliveredAt` останется пустым и сторож
 * lib/videoHandoffRedelivery.ts дошлёт с нарастающей паузой.
 *
 * `resend` (25.09.2026): "missing" — только файлы без отметки «у монтажёра»
 * (первый круг — это все, досылка сторожа и слово «файлы» — только недошедшие);
 * "all" — все заново (кнопка «📥 Прислать файлами» в «Исходниках»: монтажёр
 * потерял файлы у себя, по file_id это секунды).
 *
 * Возвращает true, если доставка состоялась целиком.
 */
export async function dispatchToEditor(
  propertyId: string,
  montajerAgentId: string,
  opts: { resend?: "missing" | "all" } = {}
): Promise<boolean> {
  return (await dispatchToEditorOutcome(propertyId, montajerAgentId, opts)) === "delivered";
}

/** `busy` — другая отправка этого объекта идёт прямо сейчас, эта не начиналась. */
export type DispatchToEditorOutcome = "delivered" | "failed" | "busy";

async function dispatchToEditorOutcome(
  propertyId: string,
  montajerAgentId: string,
  opts: { resend?: "missing" | "all" } = {}
): Promise<DispatchToEditorOutcome> {
  const [montajerRow, initialDelivery] = await Promise.all([
    prisma.agent.findUnique({
      where: { id: montajerAgentId },
      select: { id: true, telegramChatId: true, fullName: true, isActive: true },
    }),
    buildMontajerDelivery(propertyId),
  ]);
  let delivery = initialDelivery;
  // Отключённому монтажёру сырые ролики с адресом объекта в личный Telegram
  // не уходят никогда (G4, 02.10.2026): настройка могла указать на него из
  // точки возврата или из гонки с увольнением. Дальше путь тот же, что у
  // монтажёра без Telegram — не доставлено, сторож поднимет тревогу.
  if (montajerRow && !montajerRow.isActive) {
    void logSystemError(
      "video-handoff",
      `Монтажёр ${montajerRow.fullName} отключён — ролик в его Telegram не отправлен, назначьте монтажёра в Настройках`
    );
  }
  const montajer = montajerRow
    ? { id: montajerRow.id, fullName: montajerRow.fullName, telegramChatId: montajerRow.isActive ? montajerRow.telegramChatId : null }
    : null;
  if (!delivery || delivery.videos.length === 0) {
    // Место остаётся занятым (агент может дозалить видео), но доставка не
    // отмечена и попытка посчитана: сторож lib/videoHandoffRedelivery.ts
    // повторит, а исчерпав попытки — поднимет тревогу, а не будет молчать.
    void logSystemError("video-handoff", `Объект №${delivery?.property.shortId ?? propertyId}: нет сырого видео для передачи монтажёру`);
    await prisma.property.updateMany({
      where: { id: propertyId, ...EDITOR_HOLDER_WHERE },
      data: { videoHandoffDeliveredAt: null, videoHandoffDispatchAttempts: { increment: 1 } },
    });
    return "failed";
  }

  // Ответ монтажёра привязывается к первому ролику — он же «основной». Здесь же
  // фиксируем, что РЕАЛЬНО ушло (владелец 20.09.2026: «хочу видеть, что
  // отправляется монтажёру») и гасим временные поля перемонтажа — следующая
  // ОБЫЧНАЯ передача не должна унаследовать чужую причину.
  /**
   * ЗАПИСЬ ТОЛЬКО ЕСЛИ ОБЪЕКТ ВСЁ ЕЩЁ ДЕРЖИТ МЕСТО (23.09.2026). Раньше здесь
   * стоял безусловный `update` со статусом SENT_TO_EDITOR: если объект сняли с
   * монтажа или удалили, пока сторож или очередь готовили отправку, эта строка
   * возвращала его на место монтажёра — снятый объект снова держал очередь, а
   * монтажёр получал ролик, который ему только что отменили.
   */
  // ОТМЕТКА «ИДЁТ ЖИВАЯ ОТПРАВКА» (24.09.2026, гонка сторожа с живой отправкой) —
  // тот же момент, что и остальной claim. Гасим её в finally ниже, каким бы ни
  // был исход (доставлено, прервано, упало) — иначе сторож считал бы отправку
  // вечно идущей до собственного порога в 15 минут.
  const dispatchStartedAt = new Date();
  // Захват АТОМАРНО учитывает отметку живой отправки (аудит 04.10.2026, PUB05): два
  // параллельных вызова («файлы» подряд, слово + кнопка, сторож на границе окна)
  // раньше проверяли занятость по снимку, прочитанному ДО захвата, и оба проходили —
  // монтажёр получал файлы дважды. Отметка старше окна — хозяин умер, захват законный.
  const claimed = await prisma.property.updateMany({
    where: {
      id: propertyId,
      ...EDITOR_HOLDER_WHERE,
      OR: [
        { videoHandoffDispatchStartedAt: null },
        { videoHandoffDispatchStartedAt: { lt: new Date(dispatchStartedAt.getTime() - HANDOFF_DISPATCH_BUSY_WINDOW_MS) } },
      ],
    },
    data: {
      videoHandoffSentAt: new Date(),
      videoHandoffVideoId: delivery.videos[0]!.id,
      videoHandoffLastFactsText: delivery.factsText || null,
      videoHandoffLastMessageText: delivery.headText || null,
      videoHandoffRemakeReason: null,
      videoHandoffRemakeComment: null,
      videoHandoffDeliveredAt: null,
      videoHandoffDispatchAttempts: { increment: 1 },
      videoHandoffDispatchStartedAt: dispatchStartedAt,
    },
  });
  if (claimed.count !== 1) {
    // Отказ из-за чужой живой отправки отличаем от «передачу сняли»: первое не
    // ошибка (файлы уже идут), второе — да.
    const holderBusy = await prisma.property.findFirst({
      where: { id: propertyId, ...EDITOR_HOLDER_WHERE, videoHandoffDispatchStartedAt: { not: null } },
      select: { id: true },
    });
    if (holderBusy) return "busy";
    void logSystemError(
      "video-handoff",
      `Объект №${delivery.property.shortId}: передачу сняли, пока готовилась отправка — монтажёру не шлю`
    );
    return "failed";
  }
  try {
    const resend = opts.resend ?? "missing";
    // Список недошедших в снимке мог устареть, пока шла чужая отправка, закончившаяся
    // до нашего захвата: пересобираем посылку, если отметки «у монтажёра» разошлись.
    if (resend === "missing") {
      const snapshotMissing = delivery.videos.filter((v) => !isWithMontajer(v, montajerAgentId)).length;
      const freshMissing = await prisma.propertyVideo.count({ where: { propertyId, ...notYetWithMontajerWhere(montajerAgentId) } });
      if (freshMissing !== snapshotMissing) delivery = (await buildMontajerDelivery(propertyId)) ?? delivery;
    }
    return (await dispatchToEditorAfterClaim(delivery, montajerAgentId, montajer, resend)) ? "delivered" : "failed";
  } finally {
    // Условие — только СВОЯ отметка: если за это время объект успели отправить
    // заново (маловероятно, но optimistic concurrency дешевле разбора), чужую
    // не гасим.
    await prisma.property.updateMany({
      where: { id: propertyId, videoHandoffDispatchStartedAt: dispatchStartedAt },
      data: { videoHandoffDispatchStartedAt: null },
    });
  }
}

async function dispatchToEditorAfterClaim(
  delivery: MontajerDelivery,
  montajerAgentId: string,
  montajer: { id: string; telegramChatId: string | null; fullName: string } | null,
  resend: "missing" | "all"
): Promise<boolean> {
  const { property, remake, headText } = delivery;
  const journalKind = remake ? "REMAKE" : "HANDOFF";
  if (!montajer?.telegramChatId) {
    // Монтажёр ещё не привязал Telegram (или назначен, но не прошёл /start) —
    // ролик всё равно ждёт его в CRM-панели, отправка в Telegram — только
    // удобство поверх, не единственный путь. Пуш — обычное уведомление CRM.
    void sendPushToAgent(montajerAgentId, {
      title: remake ? "🔁 Ролик на перемонтаж" : "🎬 Новый ролик на монтаж",
      body: `Объект №${property.shortId} — заберите через CRM`,
      url: `/properties/${property.id}`,
    }).catch(() => {});
    // Не доставлено: deliveredAt остаётся пустым, сторож повторит, когда
    // монтажёр привяжет Telegram, а после исчерпания попыток поднимет тревогу.
    void logSystemError(
      "video-handoff",
      `Объект №${property.shortId}: монтажёр ${montajer?.fullName ?? montajerAgentId} не привязал Telegram — ролик не отправлен, ждёт в CRM`
    );
    // Журнал («я хочу видеть, что отправляется ему вообще») — запись даже здесь:
    // молчание в истории хуже честной пометки «не отправлено» (23.09.2026,
    // объект №119 — владелец решил, что ушёл один ролик, потому что запись без
    // списка файлов ничего не говорила о том, что реально произошло).
    void recordMontajerMessage(property.id, journalKind, `${headText}\n\nне отправлено: нет Telegram`);
    return false;
  }

  const result = await deliverSourceVideos(montajer.telegramChatId, "монтажёру", delivery, {
    note: null,
    montajer: { agentId: montajerAgentId, skipAlreadyDelivered: resend === "missing" },
  });

  if (result.aborted) {
    // Сняли, пока шли файлы, ИЛИ сменили монтажёра в Настройках (25.09.2026, А1):
    // не отмечаем доставку и не шлём копии наблюдателям — этот монтажёр объект
    // больше не ждёт. Журнал говорит честно, что успело уйти и почему прервано.
    const abortReasonText =
      result.abortReason === "editor-changed" ? "сменили монтажёра" : result.abortReason === "mismatch" ? "файл чужого объекта" : "объект сняли";
    void recordMontajerMessage(
      property.id,
      journalKind,
      `${montajerDeliveryJournalText(headText, result.perFile)}

отправка прервана: ${abortReasonText}`
    );
    return false;
  }

  // Журнал (владелец: «я хочу видеть, что отправляется ему вообще») — ОДНА
  // запись на весь круг файлов, а не по строке на каждый: список файлов и исход
  // каждого (23.09.2026, объект №119). ПОСЛЕ доставки монтажёру, не до — иначе
  // запись врёт об исходе ДО того, как он известен.
  void recordMontajerMessage(property.id, journalKind, montajerDeliveryJournalText(headText, result.perFile));

  // Доставлено целиком — отмечаем СРАЗУ, до копий наблюдателям (23.09.2026).
  // Раньше отметка стояла после копий: тяжёлые файлы каждому наблюдателю идут
  // минутами, и перезапуск контейнера посреди них (автовыкат, до двадцати раз в
  // день) оставлял доставку неотмеченной — сторож слал монтажёру всё второй раз.
  // Условие на статус: объект могли снять с монтажа, пока шли файлы.
  if (result.delivered) {
    await prisma.property.updateMany({
      where: { id: property.id, videoHandoffStatus: "SENT_TO_EDITOR" },
      data: { videoHandoffDeliveredAt: new Date(), videoHandoffDispatchAttempts: 0 },
    });
  }

  // Контрольное «отправлено N из N» — только если в этот раз что-то реально ушло.
  if (result.sentVideoIds.size > 0) {
    await sendToMontajer(
      montajer.telegramChatId,
      montajerDeliveryControlText(property.shortId, result.withMontajerCount, delivery.videos.length),
      { copy: true, propertyShortId: property.shortId }
    ).catch((err) =>
      logSystemError("video-handoff", `Объект №${property.shortId}: контрольное сообщение монтажёру не ушло: ${describeError(err)}`)
    );
  }

  // Копии наблюдателям — строго ПОСЛЕ монтажёра и каждому в своём try/catch
  // (sendMontageCopies): чужой отказ не задерживает и не роняет основную передачу.
  // Ровно то, что ушло монтажёру в этот раз, — не больше.
  if (result.sentVideoIds.size > 0) {
    const note = montageCopyNote(montajer.fullName);
    await sendMontageCopies(montajerAgentId, `исходники объекта ${property.id}`, (chatId) =>
      deliverSourceVideos(chatId, "наблюдателю монтажа", delivery, { note, onlyVideoIds: result.sentVideoIds }).then(() => undefined)
    );
  }

  return result.delivered;
}

/**
 * ТЕКСТ ЖУРНАЛА «ЧТО РЕАЛЬНО УШЛО МОНТАЖЁРУ» (23.09.2026, объект №119) — список
 * файлов и исход каждого, а не одна общая строка. До 100 строк (25.09.2026:
 * было 30 при потолке Settings.propertyVideoMaxCount тоже 30 — любой объект
 * сверх потолка, загруженный до его снижения, терял хвост списка молча).
 */
const JOURNAL_FILE_LINES_LIMIT = 100;

function montajerDeliveryJournalText(headText: string, perFile: DeliverSourceVideosResult["perFile"]): string {
  const outcomeLabel: Record<DeliverSourceVideosResult["perFile"][number]["outcome"], string> = {
    file: "✓ файлом",
    link: "✓ ссылкой",
    already: "✓ уже был у монтажёра",
    failed: "✗ не дошёл",
  };
  const lines = perFile
    .slice(0, JOURNAL_FILE_LINES_LIMIT)
    .map((entry) => `${entry.index + 1}. ${entry.filename} — ${megabytes(entry.sizeBytes)} МБ — ${outcomeLabel[entry.outcome]}`);
  const rest = perFile.length - lines.length;
  if (rest > 0) lines.push(`… и ещё ${rest}`);
  return [headText, "", `Файлов: ${perFile.length}`, ...lines].join("\n");
}

/** Исход доставки ОДНОГО файла — журналу «что ушло монтажёру» (23.09.2026,
 *  объект №119) нужен список, а не только общий счётчик. */
export interface DeliverSourceVideosResult {
  /** Каждый файл объекта у монтажёра (только для получателя-монтажёра). */
  delivered: boolean;
  /** Сколько файлов объекта у монтажёра после этого круга (включая дошедшие раньше). */
  withMontajerCount: number;
  /** Что реально ушло в этот раз (файлом или ссылкой) — копиям наблюдателям. */
  sentVideoIds: Set<string>;
  perFile: {
    index: number;
    videoId: string;
    filename: string;
    sizeBytes: number;
    outcome: "file" | "link" | "already" | "failed";
  }[];
  /** Объект сняли с монтажа (или удалили), пока шли файлы, ИЛИ сменили
   *  монтажёра посреди отправки (см. abortReason) — остальные не отправлены. */
  aborted: boolean;
  /** Почему прервано — только когда aborted. "removed" — объект сняли/удалили,
   *  "editor-changed" — в Настройках назначили другого монтажёра (25.09.2026, А1),
   *  "mismatch" — в посылке оказался файл чужого объекта (защита, не должно быть). */
  abortReason?: "removed" | "editor-changed" | "mismatch";
}

type HandoffStillWithEditorResult = "ok" | "removed" | "editor-changed";

/**
 * ОБЪЕКТ ВСЁ ЕЩЁ У МОНТАЖЁРА? — перед КАЖДЫМ файлом (24.09.2026). Тяжёлые
 * исходники идут минутами; №134 сняли, пока его файлы шли, и файл дошёл
 * монтажёру уже после «сняли с монтажа». Перечитываем статус перед каждым
 * файлом: сняли — остальные не шлём.
 *
 * `expectedMontajerAgentId` (25.09.2026, А1) — та же проверка для смены
 * монтажёра посреди фоновой отправки: `dispatchToEditor` занимает место под
 * ОДНОГО конкретного монтажёра, но Settings.videoMontajerAgentId мог смениться,
 * пока тяжёлый файл ещё шёл предыдущему — без этой проверки старый монтажёр
 * дополучил бы исходники объекта, который уже не его.
 */
async function handoffStillWithEditor(
  propertyId: string,
  expectedMontajerAgentId?: string
): Promise<HandoffStillWithEditorResult> {
  const row = await prisma.property.findFirst({ where: { id: propertyId, ...EDITOR_HOLDER_WHERE }, select: { id: true } });
  if (!row) return "removed";
  if (expectedMontajerAgentId) {
    const settings = await prisma.settings.findUnique({
      where: { id: "singleton" },
      select: { videoMontajerAgentId: true },
    });
    if (settings?.videoMontajerAgentId !== expectedMontajerAgentId) return "editor-changed";
  }
  return "ok";
}

interface DeliverSourceVideosOptions {
  /** Приписка «Копия. Монтажёр: …» наблюдателю — перед подписью каждого файла. */
  note: string | null;
  /** Получатель — сам монтажёр: проверка смены монтажёра перед каждым файлом и
   *  отметки «файл у монтажёра»; `skipAlreadyDelivered` — не слать отмеченные. */
  montajer?: { agentId: string; skipAlreadyDelivered: boolean };
  /** Наблюдателю — только эти файлы (то, что только что ушло монтажёру). */
  onlyVideoIds?: ReadonlySet<string>;
}

/** Отметка «этот файл у монтажёра» — в памяти посылки (копиям наблюдателей и
 *  подсчёту ниже) и в базе (досылке сторожа и слову «файлы»). */
async function markWithMontajer(video: SourceVideo, montajerAgentId: string, shortId: number): Promise<void> {
  const now = new Date();
  video.montajerDeliveredAt = now;
  video.montajerDeliveredToId = montajerAgentId;
  await prisma.propertyVideo
    .update({ where: { id: video.id }, data: { montajerDeliveredAt: now, montajerDeliveredToId: montajerAgentId } })
    .catch((err) =>
      logSystemError(
        "video-handoff",
        `Объект №${shortId}: файл «${video.filename}» дошёл до монтажёра, но отметка не записалась — сторож может прислать его ещё раз: ${describeError(err)}`
      )
    );
}

/**
 * Доставка сырых роликов в ОДИН чат — монтажёру или наблюдателю. Всё, что уходит,
 * берётся из одной посылки (MontajerDelivery) — см. её докстринг.
 */
async function deliverSourceVideos(
  chatId: string,
  recipientLabel: string,
  delivery: MontajerDelivery,
  opts: DeliverSourceVideosOptions
): Promise<DeliverSourceVideosResult> {
  const { property, videos } = delivery;
  const total = videos.length;
  const perFile: DeliverSourceVideosResult["perFile"] = [];
  const sentVideoIds = new Set<string>();
  const montajerAgentId = opts.montajer?.agentId;
  const result = (extra: Partial<DeliverSourceVideosResult> = {}): DeliverSourceVideosResult => {
    const withMontajerCount = montajerAgentId ? videos.filter((v) => isWithMontajer(v, montajerAgentId)).length : 0;
    return {
      delivered: !!montajerAgentId && withMontajerCount === total,
      withMontajerCount,
      sentVideoIds,
      perFile,
      aborted: false,
      ...extra,
    };
  };
  const failRemaining = (fromIndex: number) => {
    for (let i = fromIndex; i < total; i++) {
      const v = videos[i]!;
      if (opts.onlyVideoIds && !opts.onlyVideoIds.has(v.id)) continue;
      const already = montajerAgentId ? isWithMontajer(v, montajerAgentId) : false;
      perFile.push({ index: i, videoId: v.id, filename: v.filename, sizeBytes: v.sizeBytes, outcome: already ? "already" : "failed" });
    }
  };
  let sentThisRound = 0;

  for (const [index, video] of videos.entries()) {
    if (opts.onlyVideoIds && !opts.onlyVideoIds.has(video.id)) continue;
    // ЗАЩИТА ОТ ПУТАНИЦЫ НА МЕСТЕ (25.09.2026): файл обязан принадлежать объекту
    // посылки. Посылку собирает один запрос по одному propertyId, так что сюда
    // попасть нечему — но если однажды попадёт, лучше не дослать, чем прислать
    // монтажёру чужой ролик под номером этого объекта.
    if (video.propertyId !== property.id) {
      void logSystemError(
        "video-handoff",
        `Объект №${property.shortId}: в посылке монтажёру оказался файл «${video.filename}» другого объекта (${video.propertyId}) — отправка остановлена`
      );
      failRemaining(index);
      return result({ aborted: true, abortReason: "mismatch" });
    }
    if (opts.montajer?.skipAlreadyDelivered && montajerAgentId && isWithMontajer(video, montajerAgentId)) {
      perFile.push({ index, videoId: video.id, filename: video.filename, sizeBytes: video.sizeBytes, outcome: "already" });
      continue;
    }
    const stillOk = await handoffStillWithEditor(property.id, montajerAgentId);
    if (stillOk !== "ok") {
      const reasonText = stillOk === "editor-changed" ? "сменили монтажёра" : "объект сняли с монтажа";
      void logSystemError(
        "video-handoff",
        `Объект №${property.shortId}: отправка ${recipientLabel} прервана на ролике ${index + 1} из ${total} — ${reasonText}`
      );
      failRemaining(index);
      return result({ aborted: true, abortReason: stillOk });
    }
    // ПАУЗА МЕЖДУ РОЛИКАМИ ОДНОГО ЧАТА (21.09.2026, аудит «монтажёр ↔ CRM»).
    // core.telegram.org/bots/faq#my-bot-is-hitting-limits-how-do-i-avoid-this
    // рекомендует не больше одного сообщения в секунду в один и тот же чат —
    // до объекта разрешено до 30 роликов (Settings.propertyVideoMaxCount), и без
    // паузы цикл бил бы их подряд без единого промежутка. Запас сверх секунды —
    // на рассинхрон часов между нашим сервером и Bot API. Если Telegram всё же
    // ответил 429, повтор по его retry_after делает сам telegram/api.ts.
    if (sentThisRound > 0) await sleep(telegramSendPauseMs);
    sentThisRound++;
    const head = montajerFileCaption(delivery, index, opts.note);
    const link = rawVideoDownloadLink(property.id, video.id);
    const push = (outcome: "file" | "link" | "failed") =>
      perFile.push({ index, videoId: video.id, filename: video.filename, sizeBytes: video.sizeBytes, outcome });
    const delivered = async (outcome: "file" | "link") => {
      push(outcome);
      sentVideoIds.add(video.id);
      if (montajerAgentId) await markWithMontajer(video, montajerAgentId, property.shortId);
    };

    const filePath = localVideoFilePath(video.storageKey);
    if (!filePath) {
      void logSystemError("video-handoff", `Объект №${property.shortId}: битый ключ хранилища сырого видео ${video.storageKey}`);
      push("failed");
      continue;
    }
    try {
      const stat = await fs.promises.stat(filePath);
      if (stat.size > TELEGRAM_BOT_SEND_LIMIT_BYTES) {
        // Читать файл в память ради сообщения о его размере незачем — stat уже всё сказал.
        // Отказ этого сообщения — тоже потеря ролика молча, та же логика, что и
        // в catch ниже: явная строка в журнал, а не проглоченная ошибка.
        try {
          await sendMessage(
            chatId,
            link
              ? `${head}\n\nФайл ${megabytes(stat.size)} МБ — тяжелее, чем принимает Telegram. Скачать: ${link}`
              : `${head}\n\nФайл ${megabytes(stat.size)} МБ — тяжелее, чем принимает Telegram. Заберите через карточку объекта в CRM.`
          );
          await delivered("link");
        } catch (msgErr) {
          void logSystemError(
            "video-handoff",
            `${recipientLabel === "монтажёру" ? "Монтажёр" : "Наблюдатель монтажа"} не получил ролик ${index + 1} из ${total} (объект №${property.shortId}) — сообщение о превышении размера не отправилось: ${describeError(msgErr)}`
          );
          push("failed");
          if (isTelegramRateLimitError(msgErr)) {
            failRemaining(index + 1);
            return result();
          }
        }
        continue;
      }
      // ДОСЫЛКА ПО file_id, НЕ ФАЙЛОМ (24.09.2026, задание B/C). Этот конкретный
      // ролик уже когда-то дошёл ДО КОГО-ТО этим ботом — file_id живёт в
      // Telegram независимо от чата. Строка вместо потока с диска — 0 байт, около
      // секунды, та же подпись. Годится и повтору сторожа/«файлы» монтажёру, и
      // копии наблюдателю сразу вслед за настоящей отправкой.
      if (video.telegramFileId) {
        try {
          await sendDocument(chatId, video.telegramFileId, head);
          void prisma.propertyVideo
            .update({ where: { id: video.id }, data: { telegramDeliveredAt: new Date() } })
            .catch(() => {});
          await delivered("file");
          continue;
        } catch (fileIdErr) {
          // file_id мог умереть (бот пересоздан, Telegram подчистил старое) —
          // не считаем это провалом ролика, просто грузим файлом заново ниже.
          void logSystemError(
            "video-handoff",
            `Пересылка ролика ${index + 1}/${total} ${recipientLabel} (объект №${property.shortId}) по file_id не удалась, гружу файлом: ${describeError(fileIdErr)}`
          );
        }
      }
      // ПОТОКОМ С ДИСКА, не readFile: Buffer 480 МБ + его копия в Blob убили api
      // по OOM (объект №121, 22.09.2026). openAsBlob читает файл по мере отправки.
      const file = await fs.openAsBlob(filePath);
      try {
        const sent = await sendDocumentFile(
          chatId,
          file,
          montajerFileName(property.shortId, index, total, video.filename),
          head,
          sendTimeoutForBytes(stat.size)
        );
        // file_id — на будущее: следующая копия (наблюдателю), следующий круг
        // (сторож досылки, ручное «файлы») пойдут этой строкой, а не заново
        // потоком с диска. Мутация того же элемента посылки — копия наблюдателю
        // идёт сразу следом и должна видеть его без ожидания записи в базу.
        if (sent?.document?.file_id) {
          video.telegramFileId = sent.document.file_id;
          void prisma.propertyVideo
            .update({
              where: { id: video.id },
              data: {
                telegramFileId: sent.document.file_id,
                telegramFileUniqueId: sent.document.file_unique_id ?? null,
                telegramDeliveredAt: new Date(),
              },
            })
            .catch((updErr) =>
              logSystemError(
                "video-handoff",
                `Ролик ${index + 1}/${total} (объект №${property.shortId}) ушёл, но file_id не сохранился: ${describeError(updErr)}`
              )
            );
        }
        await delivered("file");
      } catch (sendErr) {
        // БЕЗ ЗАПАСНОЙ ССЫЛКИ ТУТ ЖЕ (24.09.2026, задание D). Раньше при таймауте
        // отправки код сразу слал ссылку «на всякий случай» — а Bot API часто
        // всё-таки успевал дослать файл до истечения нашего таймаута, и монтажёр
        // получал дубль. Теперь ролик просто остаётся недоставленным: сторож
        // lib/videoHandoffRedelivery.ts дошлёт ИМЕННО его (отметки), а ссылку шлёт
        // сам сторож и только когда попытки исчерпаны (sendGiveUpFallbackLinks).
        void logSystemError(
          "video-handoff",
          `Отправка ролика ${index + 1}/${total} ${recipientLabel} (объект №${property.shortId}) файлом не удалась: ${describeError(sendErr)}`
        );
        push("failed");
        if (isTelegramRateLimitError(sendErr)) {
          failRemaining(index + 1);
          return result();
        }
      }
    } catch (err) {
      void logSystemError(
        "video-handoff",
        `Отправка ролика ${index + 1}/${total} ${recipientLabel} (объект №${property.shortId}) не удалась: ${describeError(err)}`
      );
      push("failed");
    }
  }

  return result();
}

/**
 * ПРИСЛАТЬ ИСХОДНИКИ ЗАНОВО — по просьбе монтажёра из того же чата.
 *
 * Тот же dispatchToEditor, что и при первой передаче: те же файлы, та же
 * подпись, ничего в очереди не двигается (объект уже SENT_TO_EDITOR). Нужен
 * для житейского: файл потерялся в переписке, Telegram почистил кэш, монтажёр
 * вернулся к объекту через день. До 19.09.2026 единственным способом было
 * попросить администратора вручную.
 *
 * ТОЛЬКО НЕДОШЕДШЕЕ (25.09.2026): слово «файлы» шлёт файлы без отметки «у
 * монтажёра», а когда у монтажёра уже всё — не шлёт ничего и так и говорит
 * (`alreadyAll`). Все заново — `force` (кнопка «📥 Прислать файлами»).
 */
/** Окно, в котором фоновая отправка держателя считается ещё идущей (25.09.2026,
 *  А2) — то же 15 минут, что и у сторожа зависшей отправки. «Прислать файлы
 *  заново» (кнопка/слово монтажёра) внутри этого окна не запускает вторую
 *  параллельную отправку, а честно отвечает «уже отправляю». */
export const HANDOFF_DISPATCH_BUSY_WINDOW_MS = 15 * 60 * 1000;

export interface ResendSourceVideosResult {
  ok: boolean;
  shortId: number | null;
  busy?: boolean;
  /** Все файлы объекта уже у монтажёра — число файлов; ничего не отправлено. */
  alreadyAll?: number;
}

export async function resendSourceVideos(opts: { force?: boolean } = {}): Promise<ResendSourceVideosResult> {
  const [settings, current] = await Promise.all([
    prisma.settings.findUnique({ where: { id: "singleton" }, select: { videoMontajerAgentId: true } }),
    prisma.property.findFirst({
      where: EDITOR_HOLDER_WHERE,
      orderBy: { videoHandoffSentAt: "asc" },
      select: { id: true, shortId: true, videoHandoffDispatchStartedAt: true },
    }),
  ]);
  if (!settings?.videoMontajerAgentId || !current) return { ok: false, shortId: null };
  if (
    current.videoHandoffDispatchStartedAt &&
    Date.now() - current.videoHandoffDispatchStartedAt.getTime() < HANDOFF_DISPATCH_BUSY_WINDOW_MS
  ) {
    return { ok: false, shortId: current.shortId, busy: true };
  }
  if (!opts.force) {
    const [total, missing] = await Promise.all([
      prisma.propertyVideo.count({ where: { propertyId: current.id } }),
      prisma.propertyVideo.count({ where: { propertyId: current.id, ...notYetWithMontajerWhere(settings.videoMontajerAgentId) } }),
    ]);
    if (total > 0 && missing === 0) return { ok: false, shortId: current.shortId, alreadyAll: total };
  }
  // Проверка занятости выше идёт по снимку; настоящий замок — атомарный захват внутри
  // dispatchToEditor (аудит 04.10.2026, PUB05): проигравший гонку отвечает «уже отправляю».
  const outcome = await dispatchToEditorOutcome(current.id, settings.videoMontajerAgentId, { resend: opts.force ? "all" : "missing" });
  if (outcome === "busy") return { ok: false, shortId: current.shortId, busy: true };
  return { ok: true, shortId: current.shortId };
}

/** Список опубликованных каналов после добавления новых успешных, без дублей —
 *  общая арифметика для publishHandoffResult (весь набор каналов сразу) и
 *  ручной публикации в один канал (routes/properties/videos.ts::POST
 *  /:id/tiktok-publish) — чтобы правило "не дублировать канал в списке" не
 *  разъехалось между двумя копиями. */
export function nextPublishedChannels(existing: string[], succeededChannels: string[]): string[] {
  return Array.from(new Set([...existing, ...succeededChannels]));
}

/** Один успешно опубликованный канал — минимальный набор полей, которые
 *  дописывает applySucceededPublishResults ниже. */
export interface SucceededPublishChannel {
  channel: "INSTAGRAM" | "FACEBOOK" | "TELEGRAM" | "YOUTUBE" | "TIKTOK" | "THREADS";
  postId?: string;
  /** Только Facebook — второй идентификатор того же поста, см. PublishResult.secondaryPostId. */
  secondaryPostId?: string;
  /** Только Threads (23.09.2026) — permalink пишется НЕ в Property.instagramUrl
   *  (та колонка только для Instagram), а в publishedPostIds.THREADS_URL, см.
   *  applySucceededPublishResults ниже. Новой колонки Property не заводим
   *  (договор задания). */
  permalink?: string;
}

/**
 * ДОПИСАТЬ КАРТОЧКУ ПОСЛЕ УСПЕШНОЙ ПУБЛИКАЦИИ — вынесено из publishHandoffResult
 * (21.09.2026, случай №111) ровно затем, чтобы фоновое дозавершение отложенного
 * контейнера Instagram (lib/instagramPendingContainers.ts::runInstagramPendingContainersTick)
 * дописывало карточку ТЕМ ЖЕ путём, что и обычная публикация — а не второй копией
 * этого куска (publishedChannels/publishedPostIds/instagramUrl, проверка блокеров
 * продажи, выход в AVAILABLE). Раньше это жило только внутри publishHandoffResult.
 *
 * `igPermalink` — отдельным параметром, а не полем succeeded[], потому что он же
 * пишется в instagramUrl независимо от channel-специфичных postId/secondaryPostId.
 */
export async function applySucceededPublishResults(
  propertyId: string,
  succeeded: SucceededPublishChannel[],
  igPermalink?: string | null,
  /**
   * `finalize: false` — только записать каналы, НЕ доводя объект до продажи
   * (22.09.2026). Нужно там, где эта функция зовётся по разу на канал
   * (onChannelPublished в publishApprovedPost): выход в «Продаётся» — событие
   * всей публикации, а не каждого её канала, и повторять его пять раз значило
   * бы пять раз уведомить агента и пять раз синхронизировать сайт. Выход
   * делает `finalizePropertyAvailability` ниже, ровно один раз за публикацию.
   */
  options?: { finalize?: boolean }
): Promise<{ instagramUrl: string | null; wentAvailable: boolean; blockers: string[] }> {
  if (succeeded.length === 0) return { instagramUrl: null, wentAvailable: false, blockers: [] };

  const property = await prisma.property.findUnique({
    where: { id: propertyId },
    select: { deletedAt: true, videoHandoffFinalPath: true },
  });
  // ОБЪЕКТ УДАЛИЛИ, ПОКА ПУБЛИКАЦИЯ ШЛА (22.09.2026). Сюда ведут все пути записи
  // результата — живой, фоновое задание и дозавершение отложенного контейнера
  // Instagram; удаление в CRM мягкое (`deletedAt`), поэтому запись на месте и
  // `findUnique` её находит. Без этой строки дозавершение дописывало каналы
  // удалённому объекту и выводило его обратно в «Продаётся» — с уведомлением
  // агенту и синхронизацией сайта. Проверка стоит здесь, в общей точке записи,
  // а не копией в каждом вызывающем.
  if (!property || property.deletedAt) return { instagramUrl: null, wentAvailable: false, blockers: [] };

  // Пометки пишем ДЕЛЬТОЙ к свежей карточке условным обновлением (аудит 04.10.2026,
  // PUB07): прежнее «прочитать, посчитать, записать целиком» теряло id, который
  // параллельная публикация (другой канал, отложенный контейнер, сверка) сохранила
  // между чтением и записью.
  await updatePublishedMarks(propertyId, (current) => {
    const newPostIds = { ...current.postIds, ...rawVideoPublicationMarks(current.postIds, succeeded, property.videoHandoffFinalPath) };
    for (const r of succeeded) {
      if (r.postId) newPostIds[r.channel] = r.postId;
      if (r.channel === "FACEBOOK" && r.secondaryPostId) newPostIds.FACEBOOK_POST = r.secondaryPostId;
      // THREADS — permalink идёт СВОИМ ключом (не instagramUrl, та колонка только
      // для Instagram, и не общий igPermalink-параметр ниже) — договор задания.
      if (r.channel === "THREADS" && r.permalink) newPostIds.THREADS_URL = r.permalink;
    }
    return {
      channels: nextPublishedChannels(current.channels, succeeded.map((r) => r.channel)),
      postIds: newPostIds,
      ...(igPermalink ? { data: { instagramUrl: igPermalink } } : {}),
    };
  });
  requestPultSnapshot(); // пульт: ролик ушёл в соцсеть
  const updated = await prisma.property.findUniqueOrThrow({
    where: { id: propertyId },
    include: { district: true, photos: { orderBy: { order: "asc" } } },
  });

  // КРОССПОСТИНГ НА ПАРТНЁРСКИЕ СТРАНИЦЫ FACEBOOK (28.09.2026) — публикацию не
  // ждём (`void`), единая точка записи FACEBOOK в карточку годится для всех
  // вызывающих (сейчас — только здесь, в videoHandoff.ts), а не только для
  // onChannelPublished. Вызов внутри идемпотентен (см. docstring
  // allowCrosspostForPages) — сработает и на промежуточной, и на финальной
  // записи одной и той же публикации без риска дублей.
  const facebookSucceeded = succeeded.find((r) => r.channel === "FACEBOOK" && r.postId);
  if (facebookSucceeded?.postId) {
    void crosspostAfterFacebookPublish(propertyId, facebookSucceeded.postId);
  }

  if (options?.finalize === false) {
    const blockers = blockersForSale({ instagramUrl: updated.instagramUrl, photoCount: updated.photos.length });
    return { instagramUrl: updated.instagramUrl, wentAvailable: false, blockers };
  }
  const finalized = await finalizePropertyAvailability(propertyId);
  return { instagramUrl: finalized.instagramUrl, wentAvailable: finalized.wentAvailable, blockers: finalized.blockers };
}

/**
 * ВЫХОД ОБЪЕКТА В ПРОДАЖУ — ОДИН РАЗ ЗА ПУБЛИКАЦИЮ (вынесено 22.09.2026 из
 * applySucceededPublishResults, когда каналы стали отмечаться по одному).
 * Сняты ли условия продажи (lib/propertyPipeline.ts::blockersForSale) — и если
 * да, перевод в AVAILABLE и всё, что за ним следует: запись в историю, пуш
 * ответственному, автоподбор ожидающих покупателей, синхронизация с сайтом.
 *
 * Зовётся и когда в этот заход не добавилось ни одного нового канала: после
 * перезапуска посреди публикации каналы уже записаны, новых успехов нет, а
 * объект всё ещё не в продаже — и довести его до неё, кроме этого вызова,
 * некому.
 */
export async function finalizePropertyAvailability(
  propertyId: string
): Promise<{ instagramUrl: string | null; wentAvailable: boolean; blockers: string[] }> {
  const property = await prisma.property.findUnique({
    where: { id: propertyId },
    include: { district: true, photos: { orderBy: { order: "asc" } } },
  });
  if (!property) return { instagramUrl: null, wentAvailable: false, blockers: [] };
  /**
   * ВЫХОДИТ В ПРОДАЖУ ТОЛЬКО ОБЪЕКТ ИЗ КОНВЕЙЕРА (24.09.2026, проверка готового
   * ролика по классам). Раньше перевод в AVAILABLE и всё, что за ним, шли без
   * взгляда на статус: новый ролик уже продающегося объекта (замена из карточки)
   * заново писал «вышел из монтажа» в историю, слал агенту пуш «опубликован»,
   * будил автоподбор покупателей и сбрасывал `stageEnteredAt`; поздний повтор
   * TikTok или дозавершение контейнера Instagram возвращали в продажу
   * проданный, забронированный, снятый и удалённый объект. Уже в продаже —
   * выводить некуда; вне конвейера — нельзя.
   */
  if (property.deletedAt || !(PROPERTY_PIPELINE_STATUSES as readonly string[]).includes(property.status)) {
    return { instagramUrl: property.instagramUrl, wentAvailable: false, blockers: [] };
  }

  const blockers = blockersForSale({ instagramUrl: property.instagramUrl, photoCount: property.photos.length });
  if (blockers.length > 0) return { instagramUrl: property.instagramUrl, wentAvailable: false, blockers };

  // Условный перевод: два одновременных вызова (основное задание, дозавершение
  // Instagram, повтор TikTok) оба видели «монтаж» и оба писали «монтаж завершён».
  // Выигрывает тот, кто первым сменил статус; второй выходит без побочных действий.
  const moved = await prisma.property.updateMany({
    where: { id: propertyId, deletedAt: null, status: { in: [...PROPERTY_PIPELINE_STATUSES] } },
    data: { status: "AVAILABLE", stageEnteredAt: new Date() },
  });
  if (moved.count === 0) return { instagramUrl: property.instagramUrl, wentAvailable: false, blockers: [] };
  const updated = await prisma.property.findUniqueOrThrow({
    where: { id: propertyId },
    include: { district: true, photos: { orderBy: { order: "asc" } } },
  });
  // req=null — тот же довод, что и у обычной публикации: закрывает не HTTP-запрос,
  // а фоновая/дозавершающая публикация, аудит пишется от имени «Система».
  await publishAfterEditingComplete(null, updated);
  return { instagramUrl: updated.instagramUrl, wentAvailable: true, blockers: [] };
}

/** Итог одного канала публикации — для честной квитанции монтажёру, не только для журнала. */
export interface HandoffPublishSummary {
  /** Пробовали ли вообще публиковать (Settings.autoPublishEnabled). */
  attempted: boolean;
  succeededChannels: string[];
  failedChannels: { channel: string; error?: string }[];
  /** НЕ отказ (случай №111, 21.09.2026) — контейнер Meta пережил окно ожидания,
   *  но ещё жив и его доведёт до публикации фоновый проход
   *  lib/instagramPendingContainers.ts::runInstagramPendingContainersTick. Канал
   *  не «сломан» и не «опубликован» — третье честное состояние, отдельное от
   *  succeededChannels/failedChannels. */
  pendingChannels: { channel: string }[];
  /** Канал формально succeeded, но не туда, куда попросили — пример: TikTok
   *  ушёл в черновики («Входящие») вместо ленты (см. PublishResult.note,
   *  lib/socialPublish.ts::publishTikTokVideo). */
  notes: { channel: string; note: string }[];
  instagramUrl: string | null;
  /** Объект реально ушёл в «Продаётся» (все условия lib/propertyPipeline.ts::blockersForSale сняты). */
  wentAvailable: boolean;
  /** Чего не хватает, если в продажу объект не ушёл, — то же самое, что видно в карточке. */
  blockers: string[];
}

/**
 * Итог ПРИЁМА (не публикации) — тем, кто зовёт receiveEditedVideo (сейчас
 * telegram/bot.ts и routes/properties/videos.ts), нужен человекочитаемый
 * результат, а не догадки по молчанию. `ok: false` — файл НЕ принят, объект
 * по-прежнему в SENT_TO_EDITOR и монтажёр может прислать ролик ещё раз, ничего
 * не потеряно.
 *
 * `summary` ВСЕГДА `null` (21.09.2026, случай №114) — публикация больше не
 * происходит внутри этого вызова, она поставлена фоновым заданием
 * (`jobs/videoHandoffPublish.ts`) и займёт минуты уже ПОСЛЕ того, как этот
 * вызов вернул ответ. Поле оставлено (не убрано) ради формы: и бот, и
 * CRM-панель (PropertyVideoFixCard.tsx) уже умеют показать «ролик принят» на
 * пустом summary — оба места не нужно трогать отдельно, они деградируют
 * честно. Настоящий результат публикации уходит ПОЗЖЕ отдельным уведомлением
 * (notifyVideoHandoffPublishResult, из самого задания).
 *
 * `media`/`filename` (23.09.2026, объект №127) — факты принятого файла для
 * квитанции монтажёру (`handoffReceiptText`, telegram/bot.ts): имя, размер,
 * длительность, WxH, наличие звука. `media` — `undefined`, если ffprobe был
 * недоступен и ворота приёма (`checkEditedClip` ниже) пропустили файл без
 * проверки — квитанция в этом случае просто не показывает факты, не врёт ими.
 */
export type ReceiveEditedVideoResult =
  | {
      ok: true;
      summary: HandoffPublishSummary | null;
      media?: MediaInfo;
      filename?: string;
      /** Слот расстановки, на который встала публикация (24.09.2026): ролик
       *  уходит в сети не сразу, а в этот час — и загрузивший из карточки
       *  должен узнать время из ответа, а не гадать, куда делся файл. */
      scheduledPublishAt?: Date;
      /** Файл принят, но в сети сам не уйдёт — и почему (24.09.2026, проверка
       *  по классам): автопубликация выключена, объект вне продажи, либо он
       *  уже вышел во всех пяти сетях. Раньше ответ обещал час выхода, а
       *  задание потом тихо ничего не публиковало. Слот в этом случае не
       *  занимается, задание не ставится. */
      notPublishingReason?: string;
      /** Сети, где ПОСЛЕ приёма остался СТАРЫЙ ролик (25.09.2026, Б4): публикация
       *  пропускает уже вышедшие каналы (skipChannels в publishHandoffResult),
       *  так что замена туда не доходит. Раньше об этом не говорили никому —
       *  человек думал, что заменил ролик везде. Нет поля — старого нигде нет. */
      oldVideoLeftIn?: string[];
      /** Ролик ушёл на проверку модератору (Settings.clipReviewEnabled,
       *  25.09.2026): слота нет, публикация встанет после «Одобрить». */
      clipReviewPending?: boolean;
    }
  | { ok: false; error: string };

/**
 * В КАКИХ СОСТОЯНИЯХ ОБЪЕКТА ГОТОВЫЙ РОЛИК ЕЩЁ УМЕСТНО ПУБЛИКОВАТЬ — одно место
 * для задания публикации (jobs/videoHandoffPublish.ts, 24.09.2026, ночная
 * проверка), приёма файла и кнопки «Опубликовать сейчас». Конвейер подготовки
 * (в норме — EDITING) и AVAILABLE (объект уже в продаже, ролик ему всё ещё
 * нужен); снятый, проданный, забронированный — нет.
 */
export const HANDOFF_PUBLISHABLE_STATUSES: readonly string[] = [...PROPERTY_PIPELINE_STATUSES, "AVAILABLE"];

/** Как назвать непубликуемый статус человеку: «продан», «снят с продажи»… */
function handoffBlockedStatusLabel(status: string): string {
  if (status === "SOLD") return "продан";
  if (status === "WITHDRAWN") return "снят с продажи";
  if (status === "RESERVED") return "забронирован";
  return `в статусе ${status}`;
}

/**
 * ПРЕДИКАТ «РОЛИК ЭТОГО ОБЪЕКТА МОЖНО ПУБЛИКОВАТЬ» ПО СТАТУСУ — для всех путей,
 * которые выпускают готовый ролик в сети мимо задания публикации (25.09.2026,
 * пачка «Перезалив честно», Б1): отложенный повтор TikTok, дозавершение
 * контейнера Instagram, ручные «Опубликовать в TikTok» и «Выложить в истории».
 * До этого каждый из них смотрел только deletedAt/файл, и проданный объект
 * выходил в сеть спустя часы после продажи. `null` — можно; иначе — причина.
 */
export function handoffStatusBlockReason(status: string): string | null {
  if (HANDOFF_PUBLISHABLE_STATUSES.includes(status)) return null;
  return `Объект ${handoffBlockedStatusLabel(status)} — его ролик в сети не публикуем.`;
}

/** То, что карточка и «Расписание» показывают вместо причины слота, когда
 *  задание публикации пропустило ролик из-за статуса объекта (раздел 6 спецификации
 *  docs/handoff-2026-09-25-montage-control-spec.md). */
export function handoffSkippedByStatusReason(status: string): string {
  return `Не вышло: объект ${handoffBlockedStatusLabel(status)}.`;
}

/**
 * ИДЁТ ЛИ ПРЯМО СЕЙЧАС ПУБЛИКАЦИЯ РОЛИКА ОБЪЕКТА — задание публикации принятого
 * ролика или отложенный повтор TikTok в статусе RUNNING. Одна проверка на все
 * действия над роликом (25.09.2026, Б3): приём нового файла, открытие приёма,
 * «Убрать из соцсетей», возврат монтажёру, «Удалено в приложении», ручной
 * TikTok, «Опубликовать сейчас». Задание держит путь к файлу и минутами читает
 * его, а вышедший канал записывает только в конце своего шага — любое действие
 * посреди этого либо теряется молча, либо старый ролик выходит после «удалили».
 */
export async function isHandoffPublishRunning(propertyId: string, db: TxClient = prisma): Promise<boolean> {
  const running = await db.backgroundJob.findFirst({
    where: {
      dedupeKey: { in: [videoHandoffPublishDedupeKey(propertyId), tiktokPublishRetryDedupeKey(propertyId)] },
      status: "RUNNING",
    },
    select: { id: true },
  });
  return running !== null;
}

/** Общий текст отказа при идущей публикации — там, где своего текста нет. */
/** Ролик ждёт решения модератора (lib/clipReview.ts) — публиковать и двигать его время рано. */
export const CLIP_REVIEW_PENDING_ERROR = "Ролик ждёт проверки модератора — сначала «Одобрить» в карточке или в Telegram.";
export const HANDOFF_PUBLISH_RUNNING_ERROR = "Сейчас идёт публикация ролика — повторите через минуту.";

/** Все пять сетей автопубликации (socialPublish.ts::publishApprovedPost). */
const AUTO_PUBLISH_CHANNELS = ["INSTAGRAM", "FACEBOOK", "TELEGRAM", "YOUTUBE", "TIKTOK"] as const;

/**
 * Уйдёт ли принятый ролик в сети сам — и если нет, почему. `null` — уйдёт.
 * Те же три причины, по которым задание публикации отработало бы вхолостую
 * (publishHandoffResult смотрит autoPublishEnabled и пропускает уже вышедшие
 * каналы, задание — статус объекта), только сказанные человеку сразу, при
 * загрузке, а не пустым пушем «опубликован. Ушло: —» часами позже.
 */
async function handoffNotPublishingReason(property: { status: string; publishedChannels: string[] | null }): Promise<string | null> {
  if (handoffStatusBlockReason(property.status)) {
    return "Объект снят с продажи, продан или забронирован — в сети ролик сам не уйдёт. Файл сохранён: он пригодится, когда объект вернётся в продажу.";
  }
  const settings = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { autoPublishEnabled: true } });
  if (!settings?.autoPublishEnabled) {
    return "Автопубликация выключена в Настройках — в сети ролик сам не уйдёт. Файл сохранён.";
  }
  const published = new Set(property.publishedChannels ?? []);
  if (AUTO_PUBLISH_CHANNELS.every((c) => published.has(c))) {
    return "Объект уже вышел во всех пяти сетях со старым роликом — новый туда сам не уйдёт. Чтобы заменить, сначала «Убрать из соцсетей».";
  }
  return null;
}

/**
 * Готовый ролик получен — из Telegram (бот скачал байты) или из CRM-панели
 * (обычная загрузка файла). Сохраняет его в публичный /uploads/handoff (не в
 * закрытое хранилище сырых клипов — publishApprovedPost ждёт публичный путь) и
 * СТАВИТ ПУБЛИКАЦИЮ ФОНОВЫМ ЗАДАНИЕМ (владелец: «монтажёр и есть последняя
 * проверка на этом пути», вторая модерация не нужна — но сама публикация
 * больше не выполняется здесь же, синхронно).
 *
 * ПОЧЕМУ НЕ СРАЗУ (21.09.2026, случай №114): раньше публикация (ffmpeg-кадр +
 * пять сетей, минуты) шла прямо в этом вызове. Рестарт контейнера (выкат,
 * авария) посреди неё убивал работу МОЛЧА — ни одного исключения, значит и
 * `logSystemError` не срабатывал: `videoHandoffStatus` уже стоял RECEIVED
 * (записан строкой раньше), а `publishedChannels` оставался пуст навсегда.
 * Вебхук Telegram отвечал Telegram-у `200 OK` ДО обработки (routes/webhooks.ts),
 * а `isDuplicateDelivery` ставил отметку «обработано» ДО работы, а не после —
 * повторной доставки от Telegram было не дождаться. ЭТА ЧАСТЬ дыры закрыта
 * ОБЩИМ способом отдельно (`lib/webhookDedupe.ts`, разбор того же случая №114:
 * отметка теперь несёт `completedAt`, а зависшая без него старше 10 минут
 * подхватывается повторной доставкой заново) — здесь она только упомянута,
 * чтобы не задваивать докстринг.
 *
 * Задание (`jobs/videoHandoffPublish.ts`, тип "video-handoff-publish",
 * dedupeKey на объект) переживает рестарт: подбор зависшего RUNNING в
 * `jobs/runner.ts` сам доводит прерванную попытку до конца или до честной
 * сдачи через ~15 минут — то есть систематически, для КАЖДОГО такого сбоя, а
 * не только для того, что уже случилось. `videoHandoffUnfinishedPublishWatchdog.ts`
 * — только страховка НА СЛУЧАЙ, если само задание не успело встать в очередь
 * (процесс умер между записью статуса и постановкой, до соседней строки ниже).
 *
 * Ничего не бросает наружу — любая ошибка сохранения файла превращается в
 * `{ ok: false }` с понятным текстом: вызывающий код (бот) обязан честно
 * ответить монтажёру, а не притвориться, что всё прошло. Постановка задания —
 * best-effort по контракту `enqueueBackgroundJob` (см. там же); сбой самой
 * постановки — тот самый узкий случай, который закрывает сторож.
 */
/**
 * Хвост приёма, общий для буфера (Telegram, одиночная загрузка CRM) и уже
 * собранного на диске файла (докачка с середины, 23.09.2026) — статус объекта
 * ПРОВЕРЕН И ЗАФИКСИРОВАН вызывающим кодом ДО файловой операции (см. обе
 * точки входа ниже), здесь только: убрать файл прошлой попытки, записать
 * RECEIVED и поставить публикацию в очередь. Вынесено, чтобы эти шаги не
 * разъехались между буферным и файловым путём приёма.
 */
async function finishReceivingVideo(
  property: NonNullable<Awaited<ReturnType<typeof prisma.property.findUnique>>>,
  publicPath: string,
  originalFilename: string
): Promise<ReceiveEditedVideoResult> {
  const propertyId = property.id;
  const destPath = path.join(videoHandoffDir, path.basename(publicPath));

  // ВОРОТА ПРИ ПРИЁМЕ (23.09.2026, объект №127): монтажёр вернул боту НЕ
  // смонтированный ролик, а побайтно тот же исходник агента — CRM приняла
  // файл без единой проверки, поставила публикацию, и ролик без звука ушёл в
  // четыре сети сразу. До этой строки файл уже лежит на диске (оба входа —
  // receiveEditedVideo и receiveEditedVideoFromFile — сначала пишут его), но
  // статус объекта ЕЩЁ НЕ ТРОНУТ — отказ здесь не меняет ничего в базе, объект
  // остаётся SENT_TO_EDITOR и монтажёр присылает ролик заново.
  const check = await checkEditedClip(destPath, propertyId, property.shortId);
  if (!check.ok) {
    await fs.promises.unlink(destPath).catch(() => {});
    void logSystemError("video-handoff", `Объект №${property.shortId}: ролик от монтажёра отклонён — ${check.error}`);
    return { ok: false, error: check.error };
  }

  // ПРОШЛЫЙ РОЛИК ЕЩЁ ПУБЛИКУЕТСЯ (24.09.2026, проверка по классам). Ручное
  // открытие приёма это уже не пускает (publishedVideoFix.ts::openForManualFinalVideo),
  // но бот и уже открытая сессия докачки проходят мимо него. Задание держит
  // путь к прежнему файлу и читает его минутами, а постановка нового задания
  // при RUNNING пустая (jobs/enqueue.ts) — новый ролик не ушёл бы никуда, а у
  // прежнего отвалились бы оставшиеся сети. Объект остаётся ждать файл.
  // С 25.09.2026 — та же проверка, что у остальных действий над роликом
  // (isHandoffPublishRunning): отложенный повтор TikTok тоже читает прежний файл.
  if (await isHandoffPublishRunning(propertyId)) {
    await fs.promises.unlink(destPath).catch(() => {});
    return { ok: false, error: "Прошлый ролик этого объекта прямо сейчас уходит в сети — подождите пару минут и пришлите новый." };
  }

  // ПРОВЕРКА ГОТОВОГО РОЛИКА МОДЕРАТОРОМ (25.09.2026, владелец: «ролики от
  // монтажёра пусть проходят модерацию в Telegram»). Включена — ролик принят,
  // но слот публикации не считается и задание не ставится, пока модератор не
  // нажмёт «Одобрить» (lib/clipReview.ts::approveClip → schedulePublishAfterAccept).
  const clipReviewSettings = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { clipReviewEnabled: true } });
  const clipReview = clipReviewSettings?.clipReviewEnabled ?? false;

  // Приём пишется одной записью с условием на статус (24.09.2026, проверка по
  // классам): статус читался до переноса файла, ffprobe и md5 — секунды, а на
  // гигабайтном ролике и дольше. Если за это время приём закрыли (сняли с
  // монтажа, вернули в очередь, удалили объект), безусловная запись публиковала
  // бы ролик по закрытой передаче и затирала свежую настоящую передачу в RECEIVED.
  //
  // videoHandoffReceivedAt — момент РЕАЛЬНОГО приёма файла (см. докстринг поля
  // в schema.prisma, случай №114): отдельно от videoHandoffSentAt, чтобы
  // videoHandoffUnfinishedPublishWatchdog.ts мог отличить «публикация идёт
  // прямо сейчас» от «зависло».
  //
  // Слот прошлого ролика гасится здесь же и считается заново для нового —
  // в schedulePublishAfterAccept ниже (под своим замком), либо после одобрения.
  let accepted: { oldVideoLeftIn: string[] } | null;
  try {
    accepted = await prisma.$transaction(async (tx) => {
      const now = new Date();
      const written = await tx.property.updateMany({
        where: { id: propertyId, deletedAt: null, videoHandoffStatus: "SENT_TO_EDITOR" },
        data: {
          videoHandoffStatus: "RECEIVED",
          videoHandoffFinalPath: publicPath,
          videoHandoffReceivedAt: now,
          // Ожидание (ручное или пересылка рядом с держателем места) закрыто приёмом.
          videoHandoffManualSince: null,
          scheduledPublishAt: null,
          scheduledPublishReason: null,
          clipReviewStatus: clipReview ? "PENDING" : "NONE",
          clipReviewRequestedAt: clipReview ? now : null,
          clipReviewDecidedAt: null,
          clipReviewDecidedById: null,
          clipReviewComment: null,
        },
      });
      if (written.count !== 1) return null;
      // Где уже висит прежний ролик — тем же tx, после записи приёма: ровно
      // тот список, который задание публикации пропустит (skipChannels).
      const fresh = await tx.property.findUnique({ where: { id: propertyId }, select: { publishedChannels: true } });
      return { oldVideoLeftIn: fresh?.publishedChannels ?? [] };
    });
  } catch (err) {
    // Контракт «ничего не бросает наружу» (см. докстринг выше): база упала на
    // записи — новый файл не привязан ни к чему, прежний остаётся на месте.
    await fs.promises.unlink(destPath).catch(() => {});
    void logSystemError("video-handoff", `Объект №${property.shortId}: не удалось записать приём ролика: ${describeError(err)}`);
    return { ok: false, error: "Не получилось записать приём ролика — объект по-прежнему ждёт, пришлите ролик ещё раз." };
  }
  if (!accepted) {
    await fs.promises.unlink(destPath).catch(() => {});
    return { ok: false, error: "Эта передача уже закрыта — объект её не ждёт." };
  }
  const oldVideoLeftIn = accepted.oldVideoLeftIn.length > 0 ? accepted.oldVideoLeftIn : undefined;
  requestPultSnapshot(); // пульт: ролик принят, ждёт проверки

  // Пересылка после ошибки (reopenForResend) оставляет на диске файл от
  // прошлой неудачной попытки — новый принят успешно, старый больше не
  // нужен и, раз публикация так и не состоялась по нему, нигде не
  // используется. Без этого на объект с двумя-тремя пересылками копился бы
  // мусор в uploads/handoff (владелец, 14.09.2026: «мусор копиться»).
  // ПОСЛЕ записи в базу, а не до (24.09.2026): сбой записи иначе оставлял
  // объект со ссылкой на уже удалённый файл.
  if (property.videoHandoffFinalPath && property.videoHandoffFinalPath !== publicPath) {
    await fs.promises.unlink(path.join(videoHandoffDir, path.basename(property.videoHandoffFinalPath))).catch(() => {});
    await fs.promises.unlink(legacyHandoffCoverPath(property.videoHandoffFinalPath)).catch(() => {});
  }

  // НЕДОДЕЛАННЫЙ REELS ПРОШЛОГО РОЛИКА (24.09.2026, проверка по пяти сетям).
  // Контейнер Instagram, который Meta ещё обрабатывала, живёт до суток и
  // публикуется тиком (lib/instagramPendingContainers.ts) — со СТАРЫМ роликом,
  // рядом с новым Reels от нового задания. Новый ролик заменяет прежний, и
  // его недоделанный Reels гасится здесь. Прямой записью, а не функцией того
  // модуля: он сам импортирует этот (applySucceededPublishResults).
  const cancelledReels = await prisma.pendingInstagramContainer
    .updateMany({
      where: { propertyId, status: "PENDING", kind: "REEL" },
      data: { status: "CANCELLED", resolvedAt: new Date(), error: "Принят новый готовый ролик — Reels прошлого ролика отменён" },
    })
    .catch((err) => {
      void logSystemError("video-handoff", `Объект №${property.shortId}: не удалось отменить недоделанный Reels прошлого ролика: ${describeError(err)}`);
      return { count: 0 };
    });
  if (cancelledReels.count > 0) {
    void logSystemError("video-handoff", `Объект №${property.shortId}: принят новый ролик — отменён недоделанный Reels прошлого (${cancelledReels.count})`);
  }

  // МЕСТО МОНТАЖЁРА ОСВОБОЖДАЕТСЯ ЗДЕСЬ, СРАЗУ (21.09.2026, тот же повод, что и
  // сама расстановка по времени) — не по завершении публикации, как было до
  // введения расстановки: публикация теперь может ждать своего слота часами, а
  // держать монтажёра без работы всё это время значило бы свести на нет саму
  // причину, по которой очередь вообще существует. Идемпотентно (см. докстринг
  // самой функции) — повторный вызов (пересылка после ошибки) ничего не сломает.
  // Ролик на проверке модератора — то же самое: монтажёр берёт следующий.
  if (property.videoHandoffStatus === "SENT_TO_EDITOR") await releaseQueueIfClear(propertyId);

  const base = { ok: true as const, summary: null, media: check.media ?? undefined, filename: originalFilename, oldVideoLeftIn };
  if (clipReview) {
    // Ждущее задание прошлого ролика ушло бы в свой час мимо проверки.
    await prisma.backgroundJob.deleteMany({ where: { dedupeKey: videoHandoffPublishDedupeKey(propertyId), status: "PENDING" } });
    for (const listener of clipReviewListeners) {
      void listener(propertyId).catch((err) =>
        logSystemError("video-handoff", `Объект №${property.shortId}: рассылка ролика на проверку упала: ${describeError(err)}`)
      );
    }
    return { ...base, clipReviewPending: true };
  }

  const scheduled = await schedulePublishAfterAccept(propertyId);
  return {
    ...base,
    scheduledPublishAt: scheduled.scheduledPublishAt ?? undefined,
    notPublishingReason: scheduled.notPublishingReason,
  };
}

/**
 * Подписчики «ролик принят и ждёт проверки модератора» — lib/clipReview.ts
 * рассылает его в Telegram. Подписка, а не импорт: clipReview сам зовёт
 * schedulePublishAfterAccept отсюда, прямой импорт замкнул бы цикл.
 */
type ClipReviewListener = (propertyId: string) => Promise<void>;
const clipReviewListeners: ClipReviewListener[] = [];
export function onClipReviewRequested(listener: ClipReviewListener): void {
  clipReviewListeners.push(listener);
}

export interface SchedulePublishResult {
  /** Слот, на который встала публикация; null — не встала (см. notPublishingReason). */
  scheduledPublishAt: Date | null;
  notPublishingReason?: string;
}

/**
 * РАССТАНОВКА ПО ВРЕМЕНИ И ПОСТАНОВКА ПУБЛИКАЦИИ ДЛЯ ПРИНЯТОГО РОЛИКА — одно
 * место для приёма без проверки (finishReceivingVideo) и для «Одобрить» после
 * проверки модератором (lib/clipReview.ts::approveClip, 25.09.2026). Раньше
 * жило внутри приёма; вынесено без изменения смысла, чтобы одобрение не
 * держало вторую копию выдачи слотов.
 *
 * РАССТАНОВКА (21.09.2026, владелец: «монтажёр отправит 10 готовых роликов —
 * пусть не идёт всё так быстро»). Слот считает чистая арифметика
 * (lib/publishSchedule.ts) с учётом всех уже выданных слотов — глобально по
 * всем объектам, не только по этому: именно это и разносит пачку из десяти
 * принятых роликов вместо залпа, а с 24.09.2026 ещё и ставит каждый ролик в
 * лучший свободный час, а не просто следом за предыдущим. deletedAt: null —
 * удалённый объект слот не держит, publishedChannels не смотрим: даже уже
 * опубликованный слот остаётся ориентиром "когда была занята последняя минута".
 * Ролик, который сам никуда не уйдёт (notPublishingReason), слот не занимает.
 *
 * Чтение занятых слотов и запись своего — в одной транзакции под общим
 * замком (PUBLISH_SLOT_LOCK_ID): иначе два одновременных приёма получают один
 * и тот же слот. Запись — с условием «передача всё ещё RECEIVED»: объект,
 * который успели вернуть монтажёру или удалить, слот не получает.
 *
 * Правила берутся из Настроек, а приоритетные часы — из тепловой карты
 * (lib/publishScheduleRules.ts, 23.09.2026). Читаем их ДО замка.
 *
 * Ничего не бросает: сбой базы — строка в журнал и честная причина; ролик
 * принят, сторож недоехавших публикаций (videoHandoffUnfinishedPublishWatchdog)
 * поставит задание позже.
 */
export async function schedulePublishAfterAccept(propertyId: string): Promise<SchedulePublishResult> {
  const closedReason = "Передачу закрыли, пока ролик принимался, — в сети он сам не уйдёт.";
  try {
    const property = await prisma.property.findUnique({
      where: { id: propertyId },
      select: { shortId: true, status: true, deletedAt: true, videoHandoffStatus: true, publishedChannels: true },
    });
    if (!property || property.deletedAt || property.videoHandoffStatus !== "RECEIVED") {
      return { scheduledPublishAt: null, notPublishingReason: closedReason };
    }
    const notPublishingReason = await handoffNotPublishingReason(property);
    if (notPublishingReason) {
      // Ролик сам никуда не уйдёт. Ждущее задание прошлого ролика отработало бы
      // вхолостую и прислало пуш «опубликован. Ушло: —» — убираем его. Кнопка
      // «Опубликовать сейчас» при надобности поставит заново.
      await prisma.backgroundJob.deleteMany({ where: { dedupeKey: videoHandoffPublishDedupeKey(propertyId), status: "PENDING" } });
      return { scheduledPublishAt: null, notPublishingReason };
    }
    const scheduleRules = (await loadPublishScheduleRules()).rules;
    const scheduledPublishAt = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${PUBLISH_SLOT_LOCK_ID}::bigint)`;
      // ВСЕ занятые слоты от «сейчас минус промежуток» и дальше, а не только
      // последний (24.09.2026): лучшие часы занимаются первыми, и новый слот может
      // встать РАНЬШЕ уже выданного — промежуток обязан соблюдаться с каждым.
      // Себя исключаем: пересылка после ошибки заново выбирает свой слот.
      // Предел — две недели вперёд при сотне роликов в день с запасом.
      const now = new Date();
      // Занятые слоты — объединяя ролики и фото-посты (28.09.2026,
      // lib/publishSlots.ts): иначе оба вида публикаций считали бы свои часы
      // отдельно и могли бы встать на одну и ту же минуту.
      const occupied = await loadOccupiedPublishSlots(tx, new Date(now.getTime() - scheduleRules.minGapMin * 60_000), propertyId);
      const computed = nextPublishSlot(now, occupied, scheduleRules);
      // Слот пишется внутри той же транзакции, под замком: запись после снятия
      // замка вернула бы гонку за слот. Причина едет рядом со временем.
      const written = await tx.property.updateMany({
        where: { id: propertyId, deletedAt: null, videoHandoffStatus: "RECEIVED" },
        data: { scheduledPublishAt: computed.at, scheduledPublishReason: computed.reason },
      });
      return written.count === 1 ? computed.at : null;
    });
    if (!scheduledPublishAt) return { scheduledPublishAt: null, notPublishingReason: closedReason };

    // Постановка задания — best-effort (см. докстринг enqueueBackgroundJob):
    // dedupeKey на объект, повторный приём (пересылка после ошибки) переставит
    // то же задание заново, а не создаст дубль. runAt — тот самый слот, а не
    // «сейчас»: без него постановка в очередь и есть публикация.
    const enqueued = await enqueueBackgroundJob({
      type: VIDEO_HANDOFF_PUBLISH_JOB_TYPE,
      payload: { propertyId },
      maxAttempts: VIDEO_HANDOFF_PUBLISH_MAX_ATTEMPTS,
      dedupeKey: videoHandoffPublishDedupeKey(propertyId),
      runAt: scheduledPublishAt,
    });
    if (!enqueued.enqueued) {
      // Тот самый узкий случай, который дальше ловит сторож
      // (videoHandoffUnfinishedPublishWatchdog.ts): файл принят, но постановка в
      // очередь не удалась. Честная строка в журнал — не молчим.
      void logSystemError(
        "video-handoff",
        `Объект ${propertyId}: ролик принят, но не удалось поставить публикацию в очередь заданий — досмотрит сторож`
      );
    } else {
      // Задание прошлого ролика ещё ЖДАЛО своего часа (замена до слота): постановка
      // с тем же ключом его не трогает (jobs/enqueue.ts), и оно ушло бы в прежний
      // час с прежним счётчиком попыток, а карточка и «Расписание» показывали бы
      // новый (24.09.2026). Время и лестница повторов — от нового ролика.
      await prisma.backgroundJob.updateMany({
        where: { dedupeKey: videoHandoffPublishDedupeKey(propertyId), status: "PENDING" },
        data: { runAt: scheduledPublishAt, attempts: 0, lastError: null },
      });
    }
    return { scheduledPublishAt };
  } catch (err) {
    void logSystemError("video-handoff", `Объект ${propertyId}: не удалось поставить публикацию ролика: ${describeError(err)} — досмотрит сторож`);
    return { scheduledPublishAt: null, notPublishingReason: "Ролик принят, но время публикации не записалось — CRM поставит его сама в течение 10 минут." };
  }
}

/**
 * ВОРОТА ПЕРЕД ПРИЁМОМ — три честных отказа плюс один «пропустить без
 * проверки» (23.09.2026, объект №127, см. докстринг вызывающего кода):
 *
 * - probe вернул `null` (ffprobe не установлен, сломан, либо файл битый до
 *   такой степени, что ffprobe не распарсил его) — НЕ блокируем, тот же
 *   принцип, что у `extractCoverFrame`: инструмент недоступен ≠ ролик плохой.
 *   Только запись в журнал — её пишет вызывающий код (finishReceivingVideo),
 *   здесь только флаг `media: null`.
 * - нет видеопотока — «файл не читается как видео».
 * - нет аудиопотока — то, что и стоило объекту №127: без звука в соцсети не
 *   публикуем.
 * - короче 3 секунд — не ролик, обрезок.
 * - тот же файл, что один из исходников объекта (сверка по размеру, а
 *   ПОТОМ — только если размер совпал — по md5 потоком, не в память: сырые
 *   файлы бывают по 100-500 МБ, читать их целиком под сравнение затратно и
 *   не нужно, когда размер уже разный).
 */
async function checkEditedClip(
  destPath: string,
  propertyId: string,
  shortId: number
): Promise<{ ok: true; media: MediaInfo | null } | { ok: false; error: string }> {
  const media = await probeMediaInfo(destPath);
  if (!media) {
    void logSystemError("video-handoff", `Объект №${shortId}: проверить ролик не удалось — принят без проверки (ffprobe недоступен либо файл не распознан)`);
    return { ok: true, media: null };
  }
  if (!media.hasVideo) {
    return { ok: false, error: "Файл не читается как видео." };
  }
  if (!media.hasAudio) {
    return { ok: false, error: "В ролике нет звуковой дорожки — в соцсети без звука не публикуем. Наложите музыку/звук и пришлите заново." };
  }
  if (media.durationSec > 0 && media.durationSec < 3) {
    return { ok: false, error: "Ролик короче 3 секунд." };
  }

  /**
   * ИСХОДНИК ЛЮБОГО ОБЪЕКТА, НЕ ТОЛЬКО СВОЕГО (25.09.2026). До этой правки
   * сверка шла по исходникам целевого объекта: исходник №136, присланный
   * «для №133», проходил ворота и уходил в сети под чужим объявлением. Теперь —
   * исходники всех объектов за 30 дней. Сначала дешёвый отбор по размеру в
   * базе, md5 — только у совпавших по размеру (обычно ни одного).
   */
  const stat = await fs.promises.stat(destPath);
  const destMd5Lazy = lazyMd5(destPath);
  if (stat.size <= PRISMA_INT_MAX) {
    const sameSizeSources = await prisma.propertyVideo.findMany({
      where: {
        sizeBytes: stat.size,
        OR: [{ propertyId }, { uploadedAt: { gte: new Date(Date.now() - SAME_FILE_LOOKBACK_MS) } }],
      },
      orderBy: SOURCE_VIDEO_ORDER,
      take: 50,
      select: { propertyId: true, storageKey: true, filename: true, property: { select: { shortId: true } } },
    });
    for (const source of sameSizeSources) {
      const sourcePath = localVideoFilePath(source.storageKey);
      if (!sourcePath) continue;
      const destMd5 = await destMd5Lazy();
      if (!destMd5) break;
      const sourceMd5 = await md5OfFile(sourcePath);
      if (sourceMd5 && sourceMd5 === destMd5) {
        return {
          ok: false,
          error:
            source.propertyId === propertyId
              ? `Это исходник объекта (${source.filename}), а не смонтированный ролик.`
              : `Это исходник ДРУГОГО объекта — №${source.property.shortId} (${source.filename}), а не смонтированный ролик для №${shortId}. Файл не принят.`,
        };
      }
    }
  }

  /**
   * ТОТ ЖЕ ГОТОВЫЙ РОЛИК, ЧТО УЖЕ СДАН ПО ДРУГОМУ ОБЪЕКТУ (25.09.2026, А4) — на
   * приёме, чтобы монтажёр узнал сразу, а не маркетинг после несостоявшейся
   * публикации. Та же проверка стоит и перед самой публикацией.
   */
  const twin = await findSameFinalVideoElsewhere(propertyId, destPath, destMd5Lazy);
  if (twin) {
    return {
      ok: false,
      error: `Этот же ролик уже сдан по объекту №${twin.shortId} — у двух квартир один ролик быть не может. Пришлите ролик именно для №${shortId}.`,
    };
  }

  return { ok: true, media };
}

/** Сколько дней назад искать тот же файл среди исходников и готовых роликов. */
const SAME_FILE_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;
/** Меньше этого готовые ролики между собой не сравниваем (см. findSameFinalVideoElsewhere). */
export const SAME_FINAL_MIN_BYTES = 256 * 1024;
/** PropertyVideo.sizeBytes — Int: файл больше 2 ГБ среди исходников не найти. */
const PRISMA_INT_MAX = 2_147_483_647;

/** md5 файла — считается один раз и только если понадобился. */
function lazyMd5(filePath: string): () => Promise<string | null> {
  let pending: Promise<string | null> | null = null;
  return () => (pending ??= md5OfFile(filePath));
}

/**
 * ГОТОВЫЙ РОЛИК ОБЪЕКТА СОВПАДАЕТ С ГОТОВЫМ РОЛИКОМ ДРУГОГО (25.09.2026, А4:
 * «один и тот же ролик у двух квартир»). Смотрим принятые за 30 дней финалы
 * других объектов: сперва размер файла на диске, md5 — только у совпавших.
 * null — совпадений нет (или сравнить не с чем).
 */
export async function findSameFinalVideoElsewhere(
  propertyId: string,
  diskPath: string,
  md5Of: () => Promise<string | null> = lazyMd5(diskPath)
): Promise<{ propertyId: string; shortId: number } | null> {
  let size: number;
  try {
    size = (await fs.promises.stat(diskPath)).size;
  } catch {
    return null;
  }
  // Смонтированный ролик от трёх секунд — это сотни килобайт и больше. Файл
  // мельче — заглушка (тестовые данные, обрывок), и совпадение двух заглушек
  // ничего не говорит о перепутанных квартирах.
  if (size < SAME_FINAL_MIN_BYTES) return null;
  const others = await prisma.property.findMany({
    where: {
      id: { not: propertyId },
      videoHandoffFinalPath: { not: null },
      videoHandoffReceivedAt: { gte: new Date(Date.now() - SAME_FILE_LOOKBACK_MS) },
    },
    orderBy: { videoHandoffReceivedAt: "desc" },
    take: 500,
    select: { id: true, shortId: true, videoHandoffFinalPath: true },
  });
  for (const other of others) {
    const otherPath = other.videoHandoffFinalPath ? videoHandoffFinalDiskPath(other.videoHandoffFinalPath) : null;
    if (!otherPath) continue;
    const otherSize = await fs.promises.stat(otherPath).then((s) => s.size).catch(() => null);
    if (otherSize !== size) continue;
    const mine = await md5Of();
    if (!mine) return null;
    if ((await md5OfFile(otherPath)) === mine) return { propertyId: other.id, shortId: other.shortId };
  }
  return null;
}

/**
 * СВЕРКА ПЕРЕД ПУБЛИКАЦИЕЙ (25.09.2026, А4) — зовёт задание публикации
 * (jobs/videoHandoffPublish.ts) перед publishHandoffResult. Совпал с готовым
 * роликом другого объекта — не публикуем: запись в журнал ошибок, пуш
 * маркетингу и руководству, причина на объект (карточка и «Расписание»
 * показывают scheduledPublishReason). true — публиковать нельзя.
 */
export async function blockDuplicateFinalBeforePublish(propertyId: string, shortId: number, diskPath: string): Promise<boolean> {
  const twin = await findSameFinalVideoElsewhere(propertyId, diskPath);
  if (!twin) return false;
  const text = `ролик объекта №${shortId} совпадает с роликом №${twin.shortId}`;
  void logSystemError("video-handoff", `Публикация остановлена: ${text} — один и тот же файл у двух объектов. Проверьте, чей это ролик, и загрузите правильный.`);
  await prisma.property
    .update({ where: { id: propertyId }, data: { scheduledPublishReason: `Не опубликован: ${text}` } })
    .catch((err) => logSystemError("video-handoff", `Объект №${shortId}: причина остановки публикации не записалась: ${describeError(err)}`));
  const recipients = (
    await prisma.agent.findMany({ where: { role: { in: ["MARKETING", "DIRECTOR", "ADMIN"] }, isActive: true }, select: { id: true } })
  ).map((a) => a.id);
  if (recipients.length > 0) {
    await sendPushToAgents(recipients, {
      kind: "task",
      title: `⛔ Объект №${shortId}: публикация остановлена`,
      body: `Готовый ${text}. Проверьте, чей это ролик, и загрузите правильный.`,
      url: `/properties/${shortId}`,
      tag: `video-handoff-duplicate-final-${propertyId}`,
      level: "CRITICAL",
    }).catch((err) => console.error("[video-handoff] пуш о совпавшем ролике:", describeError(err)));
  }
  return true;
}

/** md5 ПОТОКОМ, не readFile целиком: сырые видео и присланные монтажёром
 *  файлы бывают по 100-500 МБ — тот же повод, что у openAsBlob в
 *  deliverSourceVideos (объект №121, OOM от буфера в памяти). null — файл
 *  прочитать не удалось (исходник унесли/переименовали мимо базы), сравнение
 *  просто пропускает этот кандидат, а не роняет приём готового ролика. */
async function md5OfFile(filePath: string): Promise<string | null> {
  try {
    return await new Promise<string>((resolve, reject) => {
      const hash = crypto.createHash("md5");
      const stream = fs.createReadStream(filePath);
      stream.on("error", reject);
      stream.on("data", (chunk) => hash.update(chunk));
      stream.on("end", () => resolve(hash.digest("hex")));
    });
  } catch {
    return null;
  }
}

/** Найти объект и проверить, что он реально ждёт файл — общая первая половина
 *  обеих точек входа (буфер/файл) ниже. */
async function loadPropertyAwaitingHandoff(
  propertyId: string
): Promise<{ ok: true; property: NonNullable<Awaited<ReturnType<typeof prisma.property.findUnique>>> } | { ok: false; error: string }> {
  const property = await prisma.property.findUnique({ where: { id: propertyId } });
  if (!property || property.deletedAt) return { ok: false, error: "Объект не найден или удалён." };
  if (property.videoHandoffStatus !== "SENT_TO_EDITOR") {
    // Пришло что-то не в ответ на актуальную передачу (повтор, файл не к месту) —
    // не публикуем вслепую, только предупреждаем в журнал.
    void logSystemError("video-handoff", `Объект ${propertyId}: получен файл, но передача уже не активна (status=${property.videoHandoffStatus})`);
    return { ok: false, error: "Эта передача уже закрыта — объект её не ждёт." };
  }
  return { ok: true, property };
}

export async function receiveEditedVideo(
  propertyId: string,
  buffer: Buffer,
  originalFilename: string
): Promise<ReceiveEditedVideoResult> {
  const loaded = await loadPropertyAwaitingHandoff(propertyId);
  if (!loaded.ok) return loaded;

  const ext = path.extname(originalFilename) || ".mp4";
  const destName = `${propertyId}-${Date.now()}${ext}`;
  const destPath = path.join(videoHandoffDir, destName);
  try {
    await fs.promises.writeFile(destPath, buffer);
  } catch (err) {
    // Статус НЕ трогали — объект остаётся SENT_TO_EDITOR, повтор безопасен.
    void logSystemError(
      "video-handoff",
      `Объект ${propertyId}: не удалось сохранить ролик от монтажёра на диск: ${err instanceof Error ? err.message : String(err)}`
    );
    return { ok: false, error: "Не получилось сохранить файл на сервере — объект по-прежнему ждёт, пришлите ролик ещё раз." };
  }
  return finishReceivingVideo(loaded.property, `/uploads/handoff/${destName}`, originalFilename);
}

/**
 * ТОТ ЖЕ ПРИЁМ, НО ИЗ УЖЕ СОБРАННОГО НА ДИСКЕ ФАЙЛА (23.09.2026, докачка
 * готового ролика с середины — routes/properties/videos.ts, COMPLETE сессии
 * purpose=HANDOFF). Файл уже целиком на диске (собран completeLocalUploadSession
 * из частей), поэтому здесь не буфер в памяти — `rename` (или copy+unlink при
 * EXDEV между томами, тот же приём, что upload.ts::moveUploadedFile), не чтение
 * гигабайтного файла в оперативную память процесса (лимит контейнера — 768 МБ).
 */
export async function receiveEditedVideoFromFile(propertyId: string, srcPath: string, originalFilename: string): Promise<ReceiveEditedVideoResult> {
  const loaded = await loadPropertyAwaitingHandoff(propertyId);
  if (!loaded.ok) {
    await fs.promises.rm(srcPath, { force: true }).catch(() => {});
    return loaded;
  }

  const ext = path.extname(originalFilename) || ".mp4";
  const destName = `${propertyId}-${Date.now()}${ext}`;
  const destPath = path.join(videoHandoffDir, destName);
  try {
    try {
      await fs.promises.rename(srcPath, destPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
      await fs.promises.copyFile(srcPath, destPath);
      await fs.promises.rm(srcPath, { force: true });
    }
  } catch (err) {
    // Статус НЕ трогали — объект остаётся SENT_TO_EDITOR, повтор безопасен.
    // Части сессии на диске уборщик подберёт как обычную брошенную сессию.
    void logSystemError(
      "video-handoff",
      `Объект ${propertyId}: не удалось перенести собранный ролик от монтажёра в хранилище: ${err instanceof Error ? err.message : String(err)}`
    );
    return { ok: false, error: "Не получилось сохранить файл на сервере — объект по-прежнему ждёт, пришлите ролик ещё раз." };
  }
  return finishReceivingVideo(loaded.property, `/uploads/handoff/${destName}`, originalFilename);
}

/**
 * ЗАДАНИЕ ПРОШЛОГО РОЛИКА, ПРОПУЩЕННОЕ ВО ВРЕМЯ РУЧНОГО ОЖИДАНИЯ (24.09.2026,
 * проверка по классам). Пока объект открыт под замену ролика
 * (openForManualFinalVideo: SENT_TO_EDITOR + videoHandoffManualSince), задание
 * уже принятого ролика, дошедшее до своего часа, видит «не RECEIVED» и молча
 * завершается — это правильно, пока новый файл в пути. Но если замена не
 * удалась или брошена, прежний ролик так и остаётся неопубликованным: сторож
 * недоехавших публикаций пропускает объект, у которого есть строка задания.
 * Здесь такое задание ставится снова — на прежний слот, если он ещё впереди,
 * иначе сейчас. Признак пропуска — задание завершилось ПОСЛЕ открытия ожидания.
 */
export async function rearmPublishSkippedDuringManualWait(propertyId: string, manualSince: Date): Promise<boolean> {
  const [property, job] = await Promise.all([
    prisma.property.findUnique({
      where: { id: propertyId },
      select: { deletedAt: true, videoHandoffStatus: true, videoHandoffFinalPath: true, scheduledPublishAt: true, clipReviewStatus: true },
    }),
    prisma.backgroundJob.findUnique({
      where: { dedupeKey: videoHandoffPublishDedupeKey(propertyId) },
      select: { status: true, updatedAt: true },
    }),
  ]);
  if (!property || property.deletedAt || property.videoHandoffStatus !== "RECEIVED" || !property.videoHandoffFinalPath) return false;
  // Ролик ждёт проверки модератора (25.09.2026) — публикацию поставит только «Одобрить».
  if (property.clipReviewStatus === "PENDING") return false;
  if (!job || job.status !== "DONE" || job.updatedAt < manualSince) return false;
  const now = new Date();
  const runAt = property.scheduledPublishAt && property.scheduledPublishAt > now ? property.scheduledPublishAt : now;
  const enqueued = await enqueueBackgroundJob({
    type: VIDEO_HANDOFF_PUBLISH_JOB_TYPE,
    payload: { propertyId },
    maxAttempts: VIDEO_HANDOFF_PUBLISH_MAX_ATTEMPTS,
    dedupeKey: videoHandoffPublishDedupeKey(propertyId),
    runAt,
  });
  if (enqueued.enqueued && runAt === now) {
    await prisma.property.update({ where: { id: propertyId }, data: { scheduledPublishAt: now } });
  }
  return enqueued.enqueued;
}

/**
 * ОБЪЕКТ С ПРИНЯТЫМ РОЛИКОМ ВОССТАНОВЛЕН ИЗ КОРЗИНЫ (24.09.2026, находка №130
 * ночной проверки). Пока объект лежал в Корзине, задание публикации, если оно
 * дошло до своего часа, увидело `deletedAt` и молча завершилось без единой
 * ошибки (jobs/videoHandoffPublish.ts: «объект удалили, пока задание ждало
 * своей очереди») — то есть закрылось DONE, а не осталось PENDING. Сторож
 * недоехавших публикаций (videoHandoffUnfinishedPublishWatchdog.ts) видит эту
 * строку BackgroundJob и пропускает объект: строка ЕСТЬ, значит «уже
 * разобрано». Без этого вызова принятый ДО удаления ролик не публикуется
 * никогда — только руками через «Опубликовать сейчас» (publishHandoffNow),
 * который эту же реоткрутку по dedupeKey уже умеет (#869/#873).
 *
 * Уместно только для RECEIVED с готовым файлом и пустым publishedChannels —
 * ролик, уже частично вышедший в какие-то сети, повтор решает по каналам
 * карточка объекта, здесь дублировать незачем (тот же принцип, что и в
 * publishHandoffNow). Объект, восстановленный из QUEUED/SENT_TO_EDITOR,
 * сюда не попадает: `releaseVideoHandoffForTrashed` уже перевела его в
 * «синтетический» RECEIVED БЕЗ файла (тот же приём, что при снятии с монтажа,
 * requeueVideoHandoff), и `videoHandoffFinalPath` у него пуст — условие ниже
 * отсекает его само.
 *
 * enqueueBackgroundJob по тому же ключу безопасен независимо от текущего
 * статуса задания: PENDING/RUNNING — не трогает (уже идёт), DONE/GIVEN_UP —
 * переоткрывает, записи нет — создаёт. Второго PENDING-задания не возникает.
 */
export async function rearmPublishAfterRestore(propertyId: string): Promise<boolean> {
  const property = await prisma.property.findUnique({
    where: { id: propertyId },
    select: {
      deletedAt: true,
      videoHandoffStatus: true,
      videoHandoffFinalPath: true,
      publishedChannels: true,
      scheduledPublishAt: true,
    },
  });
  if (!property || property.deletedAt) return false;
  if (property.videoHandoffStatus !== "RECEIVED" || !property.videoHandoffFinalPath) return false;
  if ((property.publishedChannels ?? []).length > 0) return false;
  const now = new Date();
  const runAt = property.scheduledPublishAt && property.scheduledPublishAt > now ? property.scheduledPublishAt : now;
  const enqueued = await enqueueBackgroundJob({
    type: VIDEO_HANDOFF_PUBLISH_JOB_TYPE,
    payload: { propertyId },
    maxAttempts: VIDEO_HANDOFF_PUBLISH_MAX_ATTEMPTS,
    dedupeKey: videoHandoffPublishDedupeKey(propertyId),
    runAt,
  });
  if (enqueued.enqueued && runAt === now) {
    await prisma.property.update({ where: { id: propertyId }, data: { scheduledPublishAt: now } });
  }
  return enqueued.enqueued;
}

/**
 * ЗАМЕНА РОЛИКА НЕ УДАЛАСЬ — ВЕРНУТЬ ПРЕЖНИЙ (24.09.2026, проверка по классам).
 * Загрузка из карточки открывает ожидание ещё до приёма (одиночная — перед
 * приёмом, докачка — на старте сессии). Отказ приёма (нет звука, исходник,
 * обрезок) или отменённая сессия оставляли объект «у монтажёра» на сутки, до
 * сторожа брошенных ожиданий, — а запланированная публикация прежнего ролика
 * за это время тихо отменялась. Трогаем только ожидание поверх уже принятого
 * ролика (есть videoHandoffFinalPath): настоящую передачу монтажёру
 * (manualSince пуст) и первую загрузку (прежнего ролика нет) — нет.
 */
export async function closeManualFinalVideoWait(propertyId: string): Promise<boolean> {
  const property = await prisma.property.findUnique({
    where: { id: propertyId },
    select: { videoHandoffStatus: true, videoHandoffManualSince: true, videoHandoffFinalPath: true },
  });
  if (!property || property.videoHandoffStatus !== "SENT_TO_EDITOR" || !property.videoHandoffManualSince || !property.videoHandoffFinalPath) {
    return false;
  }
  const manualSince = property.videoHandoffManualSince;
  const closed = await prisma.property.updateMany({
    where: { id: propertyId, videoHandoffStatus: "SENT_TO_EDITOR", videoHandoffManualSince: manualSince },
    data: { videoHandoffStatus: "RECEIVED", videoHandoffManualSince: null },
  });
  if (closed.count !== 1) return false;
  await rearmPublishSkippedDuringManualWait(propertyId, manualSince);
  return true;
}

export type DiscardFinalVideoResult =
  | { ok: true; publishedChannels: string[] }
  | { ok: false; status: 404 | 409; error: string };

/**
 * УДАЛИТЬ С КАРТОЧКИ ОШИБОЧНО ПРИНЯТЫЙ ГОТОВЫЙ РОЛИК (09.10.2026, владелец:
 * ролик для №153 приняли на №154 и выпустили в пять сетей, а №153 его не
 * принимал — «уже сдан по №154»). Совпадение ищется по файлу на диске
 * (findSameFinalVideoElsewhere), и «Вернуть монтажёру» путь к файлу не
 * стирает, то есть без этой кнопки правильный объект не примет свой ролик,
 * пока ошибочный держит тот же файл.
 *
 * Что делает: снимает PENDING-задания публикации (основное и повтор TikTok),
 * обнуляет готовый ролик, время приёма, расписание и проверку модератора,
 * переводит объект в ручное ожидание ролика (как openForManualFinalVideo:
 * SENT_TO_EDITOR + videoHandoffManualSince — место монтажёра не занимает,
 * файл примут и бот, и загрузка руками), потом удаляет файл с диска — ПОСЛЕ
 * записи в базу, тем же порядком, что и замена ролика при приёме.
 *
 * Чего НЕ делает: не снимает посты в сетях — publishedChannels остаётся, и
 * вызывающий говорит человеку «в сетях остался ролик — Убрать из соцсетей».
 * Пока ролик прямо сейчас уходит в сети, отказывает: задание читает файл
 * с диска минутами.
 */
export async function discardReceivedFinalVideo(propertyId: string): Promise<DiscardFinalVideoResult> {
  const property = await prisma.property.findUnique({
    where: { id: propertyId },
    select: { deletedAt: true, videoHandoffFinalPath: true, publishedChannels: true },
  });
  if (!property || property.deletedAt) return { ok: false, status: 404, error: "Объект не найден или удалён" };
  if (!property.videoHandoffFinalPath) {
    return { ok: false, status: 409, error: "На карточке нет принятого готового ролика — удалять нечего." };
  }
  if (await isHandoffPublishRunning(propertyId)) {
    return { ok: false, status: 409, error: "Ролик прямо сейчас уходит в сети — подождите пару минут и повторите." };
  }
  const finalPath = property.videoHandoffFinalPath;
  const now = new Date();
  await prisma.$transaction(async (tx) => {
    await tx.backgroundJob.deleteMany({
      where: { dedupeKey: { in: [videoHandoffPublishDedupeKey(propertyId), tiktokPublishRetryDedupeKey(propertyId)] }, status: "PENDING" },
    });
    await tx.property.update({
      where: { id: propertyId },
      data: {
        videoHandoffFinalPath: null,
        videoHandoffReceivedAt: null,
        scheduledPublishAt: null,
        scheduledPublishReason: null,
        clipReviewStatus: "NONE",
        clipReviewRequestedAt: null,
        clipReviewDecidedAt: null,
        clipReviewComment: null,
        videoHandoffStatus: "SENT_TO_EDITOR",
        videoHandoffSentAt: now,
        videoHandoffManualSince: now,
      },
    });
  });
  await fs.promises.unlink(path.join(videoHandoffDir, path.basename(finalPath))).catch(() => {});
  await fs.promises.unlink(legacyHandoffCoverPath(finalPath)).catch(() => {});
  return { ok: true, publishedChannels: property.publishedChannels };
}

/**
 * «ОПУБЛИКОВАТЬ СЕЙЧАС» — не обходит очередь заданий, а просто переставляет
 * `runAt` уже стоящего PENDING-задания на текущий момент (21.09.2026,
 * расстановка публикаций по времени): следующий проход крона фоновых заданий
 * (`cron.ts`, тик каждую минуту) подберёт его как обычно, тем же путём, что и
 * при наступлении слота. НЕ публикует синхронно здесь же — так строка
 * `videoHandoffStatus !== "RECEIVED"` в самом задании (jobs/videoHandoffPublish.ts)
 * остаётся единственным местом, которое решает «уже опубликовано или ещё нет»:
 * второй путь публикации задваивал бы её при неудачном стечении времени
 * (кнопка нажата ровно в момент, когда крон уже забрал задание).
 *
 * RUNNING (уже публикуется) отвечает `{ ok: false }`, а не тихо ничего не
 * делает: вызывающий (кнопка) должен показать честную причину, а не сделать
 * вид, что нажатие сработало. Задание, которого нет или которое уже
 * отработало (DONE/GIVEN_UP), при ещё не вышедшем ролике ставится заново тем
 * же ключом — с 24.09.2026, см. ветку ниже.
 */
export async function publishHandoffNow(propertyId: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const property = await prisma.property.findUnique({
    where: { id: propertyId },
    select: { videoHandoffStatus: true, videoHandoffFinalPath: true, deletedAt: true, publishedChannels: true, status: true, clipReviewStatus: true },
  });
  if (!property || property.deletedAt) return { ok: false, error: "Объект не найден или удалён." };
  if (property.videoHandoffStatus !== "RECEIVED" || !property.videoHandoffFinalPath) {
    return { ok: false, error: "Ролик ещё не принят от монтажёра — публиковать нечего." };
  }
  // Проверка готового ролика (25.09.2026): кнопка не должна обходить модератора.
  if (property.clipReviewStatus === "PENDING") return { ok: false, error: CLIP_REVIEW_PENDING_ERROR };
  // Задание пропустит объект вне продажи (jobs/videoHandoffPublish.ts) — «ок» на
  // кнопку, после которой ничего не выйдет, был бы неправдой (24.09.2026).
  if (!HANDOFF_PUBLISHABLE_STATUSES.includes(property.status)) {
    return { ok: false, error: "Объект снят с продажи, продан или забронирован — в сети его ролик не публикуем." };
  }
  // Автопубликация выключена — задание отработает и никуда не опубликует
  // (publishHandoffResult смотрит тот же флаг). Сказать это честно, а не
  // ответить «поставлено» на кнопку, после которой ничего не выйдет.
  const settings = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { autoPublishEnabled: true } });
  if (!settings?.autoPublishEnabled) {
    return {
      ok: false,
      error: "Автопубликация выключена в Настройках — ролик сам никуда не уйдёт. Включите её или опубликуйте из карточки объекта.",
    };
  }
  const job = await prisma.backgroundJob.findUnique({
    where: { dedupeKey: videoHandoffPublishDedupeKey(propertyId) },
    select: { status: true },
  });
  if (await isHandoffPublishRunning(propertyId)) {
    return { ok: false, error: "Публикация уже идёт — через минуту-две ролик выйдет." };
  }
  const now = new Date();
  if (job?.status === "PENDING") {
    await prisma.backgroundJob.update({
      where: { dedupeKey: videoHandoffPublishDedupeKey(propertyId) },
      data: { runAt: now },
    });
  } else {
    // ЗАДАНИЯ НЕТ ИЛИ ОНО УЖЕ ОТРАБОТАЛО (24.09.2026, очередь в «Расписании»):
    // строка «час прошёл, ролик не ушёл» — это ровно такой случай (задание
    // сдалось на сети, либо не встало в очередь вовсе). До этого кнопка
    // отвечала «обратитесь к разработчику»/«ждать нечего», и застрявший ролик
    // было нечем сдвинуть. Второй публикации это не даёт: повтор идёт тем же
    // заданием по тому же ключу, а уже вышедшие каналы оно пропускает
    // (skipChannels в publishHandoffResult). Вышедший хоть где-то ролик сюда
    // не попадает — его повтор решается в карточке объекта, по каналам.
    if ((property.publishedChannels ?? []).length > 0) {
      return { ok: false, error: "Ролик уже вышел — повтор по отдельным площадкам делается в карточке объекта." };
    }
    const enqueued = await enqueueBackgroundJob({
      type: VIDEO_HANDOFF_PUBLISH_JOB_TYPE,
      payload: { propertyId },
      maxAttempts: VIDEO_HANDOFF_PUBLISH_MAX_ATTEMPTS,
      dedupeKey: videoHandoffPublishDedupeKey(propertyId),
      runAt: now,
    });
    if (!enqueued.enqueued) {
      return { ok: false, error: "Не получилось поставить публикацию — попробуйте ещё раз через минуту." };
    }
  }
  // `scheduledPublishAt` двигаем следом, а не оставляем прежний слот: из него
  // считается отступ для СЛЕДУЮЩЕГО ролика (nextPublishSlot), и оставленное
  // «19:00» развело бы очередь от времени, в которое уже ничего не выйдет.
  // Заодно карточка перестаёт обещать пользователю час, который он только что
  // отменил своей же кнопкой.
  await prisma.property.update({
    where: { id: propertyId },
    data: {
      scheduledPublishAt: now,
      scheduledPublishReason: "Кнопка «Опубликовать сейчас» — расписание для этого ролика отменено вручную.",
    },
  });
  return { ok: true };
}

/**
 * «ПЕРЕНЕСТИ» — своё время выхода для ролика из очереди (24.09.2026, владелец:
 * «разные виды нужных кнопок» в очереди публикаций). Тот же приём, что у
 * «Опубликовать сейчас»: двигается `runAt` уже стоящего задания и
 * `scheduledPublishAt` объекта, сама функция ничего не публикует.
 *
 * Только ждущее задание (PENDING): идущую публикацию переносить поздно, а
 * застрявшую сначала надо запустить — для неё кнопка «Опубликовать сейчас».
 * Время — не раньше чем через минуту и не дальше PUBLISH_AT_MAX_DAYS: «на
 * вчера» означало бы «сейчас», и это другая кнопка.
 */
export async function rescheduleHandoffPublish(
  propertyId: string,
  at: Date
): Promise<{ ok: true; at: Date } | { ok: false; error: string }> {
  const now = Date.now();
  if (at.getTime() < now + 60_000) {
    return { ok: false, error: "Это время уже прошло. Чтобы выпустить ролик сразу, нажмите «Опубликовать сейчас»." };
  }
  if (at.getTime() > now + PUBLISH_AT_MAX_DAYS * 86_400_000) {
    return { ok: false, error: `Перенести можно не дальше чем на ${PUBLISH_AT_MAX_DAYS} дней вперёд.` };
  }
  const property = await prisma.property.findUnique({
    where: { id: propertyId },
    select: { videoHandoffStatus: true, deletedAt: true, clipReviewStatus: true },
  });
  if (!property || property.deletedAt) return { ok: false, error: "Объект не найден или удалён." };
  if (property.videoHandoffStatus !== "RECEIVED") {
    return { ok: false, error: "Ролик ещё не принят от монтажёра — переносить нечего." };
  }
  if (property.clipReviewStatus === "PENDING") return { ok: false, error: CLIP_REVIEW_PENDING_ERROR };
  // Условие на статус — в самом UPDATE, а не отдельным чтением перед ним:
  // крон может забрать задание между чтением и записью, и тогда перенос
  // молча «удался» бы для публикации, которая уже идёт.
  const moved = await prisma.backgroundJob.updateMany({
    where: { dedupeKey: videoHandoffPublishDedupeKey(propertyId), status: "PENDING" },
    data: { runAt: at },
  });
  if (moved.count === 0) {
    return { ok: false, error: "Ролик сейчас не ждёт в очереди — публикация уже идёт или застряла. Для застрявшей — «Опубликовать сейчас»." };
  }
  await prisma.property.update({
    where: { id: propertyId },
    data: { scheduledPublishAt: at, scheduledPublishReason: "Время выхода назначено вручную." },
  });
  return { ok: true, at };
}

/** Окно, в которое монтажёр ещё может переслать исправленный файл, если понял,
 *  что отправил не тот ролик (владелец, 14.09.2026). Вывезено: бот сверяет по
 *  нему и пересылку с номером объекта в имени файла (24.09.2026). */
export const RESEND_WINDOW_MS = 3 * 60 * 60 * 1000;

/**
 * Есть ли что переслать заново? Смотрит на последний ПРИНЯТЫЙ (не текущий в
 * очереди) объект в пределах окна. Если он уже реально ушёл в канал —
 * автоматическая замена невозможна: Instagram Graph API не даёт заменить видео
 * уже опубликованного Reels (`DELETE` → 400 Unsupported delete request,
 * проверено 04.09.2026, см. docs/video-pipeline-handoff-only-04-09-2026.md) —
 * тогда честно говорим, что нужен админ, вместо того чтобы тихо создать дубль.
 */
export async function findResendCandidate(): Promise<{ propertyId: string; shortId: number; alreadyPublished: boolean } | null> {
  const property = await prisma.property.findFirst({
    where: {
      videoHandoffStatus: "RECEIVED",
      deletedAt: null,
      videoHandoffSentAt: { gte: new Date(Date.now() - RESEND_WINDOW_MS) },
    },
    orderBy: { videoHandoffSentAt: "desc" },
    select: { id: true, shortId: true, publishedChannels: true },
  });
  if (!property) return null;
  const alreadyPublished = ((property.publishedChannels ?? []) as string[]).length > 0;
  return { propertyId: property.id, shortId: property.shortId, alreadyPublished };
}

/** Открывает объект для повторного приёма файла — отдельной кнопки «переслать»
 *  нет, монтажёр просто присылает новый ролик, это и есть подтверждение.
 *
 *  Под замком очереди и только если место свободно (23.09.2026): бот проверяет
 *  «никто не ждёт» раньше, чем скачает файл, и за эти секунды место мог занять
 *  следующий объект — без проверки монтажёр держал бы два объекта сразу.
 *  Доставку отмечаем сразу: слать монтажёру нечего, файл несёт он сам. Если приём
 *  не удался, бот зовёт undoReopenForResend — иначе объект держал бы место,
 *  а монтажёр о нём уже забыл. Возвращает false, если место занято. */
/**
 * Возвращает момент реопена (пишется в videoHandoffDeliveredAt как метка) или
 * `null`, если место занято и не удалось открыть. Этот момент передаётся в
 * undoReopenForResend ниже — задание F, 24.09.2026: раньше откат смотрел ТОЛЬКО
 * на статус SENT_TO_EDITOR, а его тем же значением мог выставить и совсем
 * другой круг (объект успели снова отправить монтажёру обычным путём между
 * reopenForResend и её откатом) — откат тогда стирал бы чужую, ни при чём не
 * повинную передачу. Метка — то же optimistic-concurrency, что уже применяет
 * сторож досылки чуть выше (сравнение по старому значению перед записью).
 */
export async function reopenForResend(propertyId: string, opts: { besideHolder?: boolean } = {}): Promise<Date | null> {
  return withQueueLock(async (tx) => {
    /**
     * ПЕРЕСЫЛКА С НОМЕРОМ ОБЪЕКТА, ПОКА МЕСТО ЗАНЯТО ДРУГИМ (24.09.2026, проверка
     * готового ролика по классам). Монтажёр сдал №X, место тут же ушло №Y, и
     * он шлёт исправленный файл, подписанный «X». Раньше такой файл ложился
     * на Y — держателя места. Теперь бот узнаёт номер и открывает X рядом с Y,
     * не занимая место: отметка videoHandoffManualSince выводит X из
     * EDITOR_HOLDER_WHERE, и ни очередь, ни следующий файл без номера его не
     * подхватят. Приём файла или undoReopenForResend закрывают ожидание.
     */
    if (!opts.besideHolder && (await editorIsBusy(tx))) return null;
    const now = new Date();
    const reopened = await tx.property.updateMany({
      where: { id: propertyId, videoHandoffStatus: "RECEIVED", deletedAt: null },
      data: { videoHandoffStatus: "SENT_TO_EDITOR", videoHandoffDeliveredAt: now, videoHandoffManualSince: opts.besideHolder ? now : null },
    });
    return reopened.count === 1 ? now : null;
  });
}

/** Пересылка не принята (файл не сохранился) — объект возвращается в RECEIVED и
 *  не держит место монтажёра. Условие на статус: если приём всё же успел
 *  пройти, трогать нечего. `expectedReopenedAt` (задание F, 24.09.2026) — метка,
 *  которую вернул reopenForResend: без нёё откат мог задеть СОВСЕМ ДРУГУЮ
 *  передачу, успевшую занять то же место тем же статусом SENT_TO_EDITOR между
 *  реопеном и откатом. Опционален — вызывающий код без метки (миграция) ведёт
 *  себя как раньше. Следом отдаём место следующему в очереди. */
export async function undoReopenForResend(propertyId: string, expectedReopenedAt?: Date): Promise<void> {
  const undone = await prisma.property.updateMany({
    where: {
      id: propertyId,
      videoHandoffStatus: "SENT_TO_EDITOR",
      ...(expectedReopenedAt ? { videoHandoffDeliveredAt: expectedReopenedAt } : {}),
    },
    data: { videoHandoffStatus: "RECEIVED", videoHandoffManualSince: null },
  });
  if (undone.count === 1) await releaseQueueIfClear(propertyId);
}

/**
 * Путь НА ДИСКЕ до готового ролика по его публичному пути
 * (`Property.videoHandoffFinalPath`, вида `/uploads/handoff/<файл>`) — то же
 * хранилище, что и `destPath` в `receiveEditedVideo`. `null`, если путь не из
 * этого хранилища (единственный ожидаемый случай — путь не пройдёт публикацию
 * дальше этой проверки).
 *
 * ОБЩАЯ ТОЧКА (21.09.2026, случай №114) — раньше подстановка `path.join(...)`
 * стояла inline только здесь; `jobs/videoHandoffPublish.ts` теперь тоже должен
 * знать, где лежит файл (проверить, что он реально на диске, прежде чем гонять
 * публикацию впустую) — копия этой строки разъехалась бы при следующей смене
 * схемы хранения.
 */
export function videoHandoffFinalDiskPath(publicPath: string): string | null {
  if (!publicPath.startsWith("/uploads/handoff/")) return null;
  return path.join(videoHandoffDir, path.basename(publicPath));
}

/**
 * Публикует переданный вручную ролик БЕЗ отдельного клика одобрения —
 * монтажёр в этом пути уже прошёл свою проверку, вторая была бы лишней
 * (владелец, 01.09.2026; вторая модерация удалена вместе с автомонтажом
 * 04.09.2026). Возвращает честный итог — см. HandoffPublishSummary.
 *
 * ЭКСПОРТИРОВАНА (21.09.2026, случай №114) — тем же путём, каналами и
 * идемпотентностью (skipChannels от текущего publishedChannels) пользуется
 * `videoHandoffUnfinishedPublishWatchdog.ts`, догоняя объекты, у которых файл
 * принят, но публикация оборвалась (рестарт контейнера, сеть). Копии этой
 * логики НЕ заводить — ровно та ловушка из CLAUDE.md («копия логики вместо
 * самой логики»).
 */
export async function publishHandoffResult(propertyId: string, localVideoPath: string): Promise<HandoffPublishSummary> {
  const empty: HandoffPublishSummary = {
    attempted: false,
    succeededChannels: [],
    failedChannels: [],
    pendingChannels: [],
    notes: [],
    instagramUrl: null,
    wentAvailable: false,
    blockers: [],
  };
  const property = await prisma.property.findUnique({
    where: { id: propertyId },
    include: {
      district: true,
      photos: { orderBy: { order: "asc" } },
      intakeAgent: { select: { fullName: true, phone: true } },
      assignedAgent: { select: { fullName: true, phone: true } },
      createdBy: { select: { fullName: true, phone: true } },
    },
  });
  if (!property) return empty;

  const settings = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { autoPublishEnabled: true } });
  // Цена в сомони рядом с долларами (владелец, 17.09.2026) — этот запасной путь
  // почти никогда не срабатывает (reelsCaption уже есть у объекта к этому
  // моменту), но раз уж срабатывает, пусть не расходится форматом с обычным.
  const money = await loadMoneyContext();
  const captionBase = property.reelsCaption ?? generateReelsCaptionFromTemplates(
    reelsCaptionValuesFromProperty({
      type: property.type,
      rooms: property.rooms,
      areaSqm: property.areaSqm,
      floor: property.floor,
      totalFloors: property.totalFloors,
      price: property.price,
      currency: property.currency,
      condition: property.condition,
      stage: property.stage ?? null,
      marketType: property.marketType ?? null,
      districtName: property.district?.name ?? "",
      phone: null,
      address: property.address,
      landAreaSotka: property.landAreaSotka,
      amenities: property.amenities,
      money,
    }),
    null
  );
  /**
   * ПОДВАЛ ДОПИСЫВАЕТСЯ И ЗДЕСЬ, на самой публикации (23.09.2026). Подпись
   * почти всегда уже лежит в карточке, но объект мог впервые получить номер:
   * `withPostFooter` заменяет старый подвал, а не копит второй, поэтому
   * вызывать её лишний раз безопасно и дешевле, чем разбираться, где именно
   * подпись устарела.
   */
  // Концовка с агентом по объекту (владелец 25.09.2026) — идемпотентна, как и подвал.
  const captionAgent = property.intakeAgent ?? property.assignedAgent ?? property.createdBy ?? null;
  const caption = withPostFooter(applyContactFooter(captionBase, captionAgent), property.shortId);

  let updated = await prisma.property.update({
    where: { id: property.id },
    data: { reelsCaption: caption, postApprovedAt: new Date() },
    include: { district: true, photos: { orderBy: { order: "asc" } } },
  });

  let succeededChannels: string[] = [];
  let failedChannels: { channel: string; error?: string }[] = [];
  let pendingChannels: { channel: string }[] = [];
  let notes: { channel: string; note: string }[] = [];
  let wentAvailableFromSucceeded = false;

  // ОБЛОЖКА — ТОЛЬКО ОТ CHATGPT (владелец, 25.09.2026: «выключи наши обложки,
  // сделай всё через ChatGPT API»). Наш SVG-шаблон (coverPoster.ts) отключён
  // совсем, запасным путём тоже не служит. `makePropertyCover` рисует вертикаль
  // 1080×1920 (Reels, Telegram) и вырезает из неё квадрат (лента, сайт), кладёт
  // оба в `/uploads/covers/` и на объект. Любой сбой (сеть, лимит дня, цифры
  // не сошлись) → null: публикация идёт БЕЗ обложки, площадка берёт кадр сама,
  // как до 23.09; причина — в журнале ошибок и в Property.socialCoverError.
  // Подложка — только главное фото карточки; кадр из ролика не берётся
  // (владелец, 25.09): нет фото — обложки нет, публикация идёт без неё.
  // Что принимает каждая сеть — `coverSupportNotes()` в socialPublish.ts.
  // РИСУЕТСЯ И ПРИ ВЫКЛЮЧЕННОЙ АВТОПУБЛИКАЦИИ — намеренно (проверено 28.09.2026):
  // квадрат ведёт объявление на сайте (siteSync.ts::siteImageUrls), идёт в фид
  // каталога Meta (metaCatalogFeed.ts), в пост агента (agentSharePost.ts) и в
  // фото-посты (photoPosts.ts). Перенести его под `autoPublishEnabled` значило бы
  // молча оставить сайт без обложки у всех, кто публикует в сети руками.
  let coverPublicPath: string | null = null;
  let squareCoverPath: string | null = null;
  const videoDiskPath = videoHandoffFinalDiskPath(localVideoPath);
  if (videoDiskPath) {
    const cover = await makePropertyCover(property.id);
    coverPublicPath = cover?.storyUrl ?? null;
    squareCoverPath = cover?.squareUrl ?? null;
  }

  if (settings?.autoPublishEnabled) {
    const alreadyPublished = (property.publishedChannels ?? []) as (
      | "INSTAGRAM"
      | "FACEBOOK"
      | "TELEGRAM"
      | "YOUTUBE"
      | "TIKTOK"
      | "THREADS"
    )[];
    const publishResults = await publishApprovedPost({
      propertyId: property.id,
      localVideoPath,
      localCoverPath: coverPublicPath,
      localSquareCoverPath: squareCoverPath,
      caption,
      skipChannels: alreadyPublished,
      // Канал отмечается опубликованным СРАЗУ, не в общем разборе ниже — иначе
      // рестарт посреди пятиканальной публикации терял память об уже вышедших
      // постах и повтор задания вешал дубли (см. onChannelPublished там же).
      // Общий разбор ниже остаётся: он досчитывает итог для квитанции монтажёру
      // и подчищает то, чего колбэк мог не записать.
      onChannelPublished: async (result) => {
        await applySucceededPublishResults(
          property.id,
          [{ channel: result.channel, postId: result.postId, secondaryPostId: result.secondaryPostId, permalink: result.permalink }],
          result.channel === "INSTAGRAM" ? result.permalink ?? null : null,
          // Выход в продажу — событие всей публикации, а не каждого канала:
          // его делает finalizePropertyAvailability ниже, один раз за заход.
          { finalize: false }
        );
        // ВЫХОД В ПРОДАЖУ — СРАЗУ ПОСЛЕ INSTAGRAM, А НЕ ПОСЛЕ ПОСЛЕДНЕЙ СЕТИ (05.10.2026,
        // владелец: «статус висит на монтаже, хотя должно идти само»). Условие выхода —
        // ссылка на Reels и фото (blockersForSale); TikTok с перекодированием держит
        // задание ещё 10-15 минут, и всё это время объект числился «на монтаже».
        // finalizePropertyAvailability условная и идемпотентная: вызов в конце ничего
        // не повторит.
        if (result.channel === "INSTAGRAM") {
          try {
            await finalizePropertyAvailability(property.id);
          } catch (err) {
            void logSystemError("video-handoff", `Объект ${property.id}: ранний выход в продажу после Instagram не удался: ${describeError(err)}`);
          }
        }
      },
    });
    const succeeded = publishResults.filter((r) => r.ok);
    // ОЖИДАЕТ, А НЕ ОТКАЗ (случай №111, 21.09.2026): контейнер Instagram может
    // пережить наше окно ожидания и всё равно опубликоваться позже — фоновый
    // проход lib/instagramPendingContainers.ts::runInstagramPendingContainersTick
    // доведёт его сам. Такой результат — не succeeded (пост ещё не висит) и не
    // failed (не отказ, канал не сломан) — исключаем из обоих списков, иначе
    // «Ролик принят, но опубликовать не удалось» соврало бы монтажёру, а строка
    // соцсетей в карточке показала бы красным то, что просто ждёт своей очереди.
    const pending = publishResults.filter((r) => !r.ok && r.pending);
    // «СЕЙЧАС НЕЛЬЗЯ, ПОЗЖЕ МОЖНО» (23.09.2026) — второй вид не-отказа, рядом с
    // предыдущим и по той же причине. TikTok отвечает «слишком много
    // неподтверждённых черновиков» / «слишком много публикаций подряд», и это
    // проходит само (см. PublishResult.retriable). Разница с pending выше: там
    // пост уже У площадки и дозреет без нас, здесь площадка не приняла ничего и
    // повторить обязаны мы — отложенным заданием ниже. Раньше это ложилось в
    // failedChannels наравне с «токен недействителен», то есть навсегда: ролик
    // выходил в четыре сети из пяти и в TikTok не выходил больше никогда.
    const retriable = publishResults.filter((r) => !r.ok && !r.pending && r.retriable);
    succeededChannels = succeeded.map((r) => r.channel);
    failedChannels = publishResults
      .filter((r) => !r.ok && !r.pending && !r.retriable)
      .map((r) => ({ channel: r.channel, error: r.error }));
    notes = succeeded.filter((r) => r.note).map((r) => ({ channel: r.channel, note: r.note! }));
    const igResult = succeeded.find((r) => r.channel === "INSTAGRAM");
    if (pending.length > 0 || retriable.length > 0) {
      pendingChannels = [...pending, ...retriable].map((r) => ({ channel: r.channel }));
    }
    for (const result of retriable) {
      if (result.channel !== "TIKTOK") {
        // Признак пока ставит только TikTok. Появится второй канал — ему нужно
        // своё задание повтора, а не тихое попадание в «ожидает» без того, кто
        // это ожидание доведёт до конца.
        void logSystemError(
          "video-handoff",
          `Объект ${property.id}: канал ${result.channel} попросил повторить позже, но задания повтора для него нет — публикация потеряна`
        );
        continue;
      }
      await enqueueBackgroundJob({
        type: TIKTOK_PUBLISH_RETRY_JOB_TYPE,
        payload: { propertyId: property.id },
        dedupeKey: tiktokPublishRetryDedupeKey(property.id),
        maxAttempts: TIKTOK_PUBLISH_RETRY_MAX_ATTEMPTS,
        // Первая попытка — через час: раньше смысла нет, лимиты TikTok живут
        // сутками (см. лесенку в jobs/tiktokPublishRetryPolicy.ts).
        runAt: new Date(Date.now() + TIKTOK_PUBLISH_RETRY_FIRST_DELAY_MS),
      });
    }
    if (succeeded.length > 0) {
      // publishedPostIds — каналы, где пост поддаётся правке (Facebook/Telegram/
      // YouTube, lib/publishedListingSync.ts при смене цены) И/ИЛИ удалению.
      // INSTAGRAM добавлен 20.09.2026: Graph API по-прежнему не даёт редактировать
      // caption опубликованного ig-media (это не изменилось), НО удаление живой
      // проверкой подтверждено рабочим (socialPublish.ts::deleteInstagramMedia) —
      // держать id нужно уже не ради правки, а ради снятия (removeFromSocial,
      // lib/publishedVideoFix.ts). FACEBOOK_POST — второй идентификатор того же
      // поста Facebook (secondaryPostId, см. docstring publishFacebookVideo) —
      // запасной адрес для удаления, если video id перестал существовать
      // (случай №112).
      //
      // Дописывает карточку applySucceededPublishResults (вынесено 21.09.2026,
      // случай №111) — тот же путь, которым фоновое дозавершение отложенного
      // контейнера Instagram доводит карточку после публикации, случившейся уже
      // без монтажёра в чате.
      await applySucceededPublishResults(
        property.id,
        succeeded.map((r) => ({ channel: r.channel, postId: r.postId, secondaryPostId: r.secondaryPostId, permalink: r.permalink })),
        igResult?.permalink ?? null,
        { finalize: false }
      );
      updated = await prisma.property.findUniqueOrThrow({
        where: { id: property.id },
        include: { district: true, photos: { orderBy: { order: "asc" } } },
      });
      wentAvailableFromSucceeded = updated.status === "AVAILABLE";

      // ИСТОРИИ INSTAGRAM (21.09.2026) — сразу вслед за успешным Reels, если
      // рубильник включён (Settings.instagramStoriesEnabled, проверяется внутри).
      // НЕ трогает publishedChannels/updated — история не «пост, который висит»,
      // см. докстринг lib/instagramStories.ts и PropertyStoryPost в schema.prisma.
      // Отказ не должен ронять уже случившуюся публикацию Reels — поэтому свой try.
      if (igResult?.ok) {
        try {
          await publishPropertyInstagramStories(property.id, localVideoPath);
        } catch (err) {
          void logSystemError("meta", `Истории Instagram (объект ${property.id}) упали неожиданно: ${describeError(err)}`);
        }
      }
    }

    // ОБОРВАННАЯ СЕРИЯ ИСТОРИЙ (22.09.2026, класс «страховка ставится ПОСЛЕ окна,
    // которое должна страховать»). Серия из нескольких частей идёт минутами, и
    // рестарт посреди обрывал её насовсем: повторная попытка задания видела
    // Instagram уже опубликованным, пропускала канал — и вместе с ним истории,
    // хотя вышли, скажем, две части из четырёх. Здесь — та самая повторная
    // попытка: `resumeOnly` доделывает начатую серию и НЕ начинает новую (см.
    // SERIES_RESUME_WINDOW_MS в lib/instagramStories.ts). Вне `succeeded.length
    // > 0` намеренно: на повторе Instagram пропущен, успехов может не быть ни
    // одного, а доделать серию всё равно надо.
    if (!igResult?.ok) {
      try {
        await publishPropertyInstagramStories(property.id, localVideoPath, { resumeOnly: true });
      } catch (err) {
        void logSystemError("meta", `Истории Instagram (объект ${property.id}) упали неожиданно: ${describeError(err)}`);
      }
    }

    // ВЫХОД В ПРОДАЖУ — ОДИН РАЗ ЗА ПУБЛИКАЦИЮ И ВНЕ `succeeded.length > 0`
    // (22.09.2026). Вне — потому что после перезапуска посреди публикации
    // каналы уже записаны (onChannelPublished выше), новых успехов в этот
    // заход нет, а объект всё ещё не в продаже: довести его туда, кроме этого
    // вызова, стало некому. Один раз — потому что за ним идут запись в
    // историю, пуш ответственному, автоподбор и синхронизация с сайтом.
    const finalized = await finalizePropertyAvailability(property.id);
    if (finalized.wentAvailable) {
      wentAvailableFromSucceeded = true;
      updated = await prisma.property.findUniqueOrThrow({
        where: { id: property.id },
        include: { district: true, photos: { orderBy: { order: "asc" } } },
      });
    }
  }

  const blockers = blockersForSale({ instagramUrl: updated.instagramUrl, photoCount: updated.photos.length });

  return {
    attempted: !!settings?.autoPublishEnabled,
    succeededChannels,
    failedChannels,
    pendingChannels,
    notes,
    instagramUrl: updated.instagramUrl,
    wentAvailable: wentAvailableFromSucceeded,
    blockers,
  };
}

/**
 * «Успех/частично/провал» — одной строкой в заголовок уведомления о результате
 * публикации (см. notifyVideoHandoffPublishResult ниже). Чистая функция —
 * проще проверить тестом, чем сам текст внутри уведомления.
 *
 * pendingChannels (случай №111) НЕ считается провалом сам по себе — контейнер
 * Instagram жив и его довершит `instagramPendingContainers.ts` фоном; полный
 * провал — это когда succeededChannels И pendingChannels оба пусты, а
 * failedChannels — нет.
 */
function handoffPublishOutcomeIsFailure(summary: HandoffPublishSummary): boolean {
  return (
    summary.attempted &&
    summary.succeededChannels.length === 0 &&
    summary.pendingChannels.length === 0 &&
    summary.failedChannels.length > 0
  );
}

/**
 * УВЕДОМЛЕНИЕ О РЕЗУЛЬТАТЕ ПУБЛИКАЦИИ (21.09.2026, случай №114, п.3 задания).
 *
 * Владелец: «ожидай, опубликовано когда будет — потом мне пусть покажет».
 * Раньше монтажёр слышал в Telegram короткое «Ролик принят ✅» (владелец
 * 20.09.2026: подробности монтажёру ни к чему), а РЕЗУЛЬТАТ не долетал ни до
 * кого — ни до агента, ни до директора. Теперь результат уходит именно им:
 * тому, кто ведёт объект (назначенный агент, иначе тот, кто завёл — тот же
 * порядок, что и в lib/propertyPipeline.ts::notifyOverdueMaterials), и
 * директорам/админам — оба явно попросили быть в курсе именно этого события,
 * поэтому два получателя здесь не спам «на всех подряд» (правило 20.09), а
 * решение владельца по этому конкретному поводу.
 *
 * Зовётся ОДНИМ местом — `jobs/videoHandoffPublish.ts::run` по завершении
 * (успех, частичный успех или честный провал канала) и `onGiveUp` (задание
 * сдалось после всех попыток) — не копия текста в двух местах.
 */
export async function notifyVideoHandoffPublishResult(
  propertyId: string,
  summary: HandoffPublishSummary | null
): Promise<void> {
  const property = await prisma.property.findUnique({
    where: { id: propertyId },
    select: { shortId: true, assignedAgentId: true, intakeAgentId: true, createdById: true },
  });
  if (!property) return; // объект удалили, пока публикация ждала своей очереди — сообщать некому

  const responsibleId = property.assignedAgentId ?? property.intakeAgentId ?? property.createdById;
  // Получатели — модераторы, не любой DIRECTOR/ADMIN по роли (25.09.2026,
  // задание G, владелец: «пуш должен идти модератору, то есть админу») —
  // см. докстринг montageNotificationRecipients.
  const recipients = await montageNotificationRecipients(responsibleId);
  if (recipients.length === 0) return;

  const url = `/properties/${property.shortId}`;
  const tag = `video-handoff-published-${propertyId}`;

  let title: string;
  let body: string;
  let level: "OTHER" | "CRITICAL" = "OTHER";
  if (!summary) {
    title = `⚠️ Объект №${property.shortId}: публикацию не удалось проверить`;
    body = "Ролик принят и лежит на объекте, но что ушло в соцсети — неизвестно, нужен администратор.";
    level = "CRITICAL";
  } else if (!summary.attempted) {
    title = `🎬 Объект №${property.shortId}: ролик готов`;
    body = "Автопубликация выключена в Настройках — ссылку на видео-обзор нужно вставить вручную.";
  } else if (handoffPublishOutcomeIsFailure(summary)) {
    title = `❌ Объект №${property.shortId}: публикация не прошла`;
    const errs = summary.failedChannels.map((f) => (f.error ? `${f.channel} (${f.error})` : f.channel)).join(", ");
    body = `Ни один канал не ушёл: ${errs}. Нужен администратор.`;
    level = "CRITICAL";
  } else {
    const okList = summary.succeededChannels.join(", ") || "—";
    const failedList = summary.failedChannels.map((f) => f.channel).join(", ");
    const pendingList = summary.pendingChannels.map((p) => p.channel).join(", ");
    title = summary.wentAvailable
      ? `✅ Объект №${property.shortId} опубликован и вышел в продажу`
      : `🎬 Объект №${property.shortId}: опубликован частично`;
    const parts = [`Ушло: ${okList}.`];
    if (pendingList) parts.push(`Ещё обрабатывается (${pendingList}) — довершится само.`);
    if (failedList) parts.push(`Не ушло: ${failedList}.`);
    if (!summary.wentAvailable && summary.blockers.length > 0) {
      parts.push(`В продажу не вышел — ${summary.blockers.join(", ")}.`);
      level = failedList ? "CRITICAL" : level;
    }
    body = parts.join(" ");
  }

  try {
    await sendPushToAgents(recipients, { kind: "task", title, body, url, tag, level });
  } catch (err) {
    // Уведомление — не повод ронять задание публикации: она уже случилась
    // (или честно провалилась), сам факт УЖЕ в journal (logSystemError выше
    // по цепочке отказавших каналов) — теряем только удобство узнать быстро.
    console.error("[video-handoff] уведомление о результате публикации:", err instanceof Error ? err.message : err);
  }

  // ГОТОВЫЙ ПОСТ АГЕНТУ ДЛЯ «ПОДЕЛИТЬСЯ» (28.09.2026) — поверх пуша выше, не
  // вместо него (владелец: пуш остаётся как есть). Только когда реально
  // что-то вышло — пустой succeededChannels у частичного/неудачного случая
  // прислал бы агенту «пост опубликован» без единой рабочей ссылки.
  if (summary && summary.succeededChannels.length > 0) {
    void sendAgentSharePost(propertyId, { succeededChannels: summary.succeededChannels }).catch((err) => {
      console.error("[video-handoff] пост агенту для «Поделиться»:", err instanceof Error ? err.message : err);
    });
  }
}

/**
 * Публикация обошла бота монтажёра — кнопка «Готово» или автопубликация по
 * вручную вписанной ссылке на Reels (routes/properties/crud.ts, решение
 * владельца 05.08.2026 сохранить этот путь наравне с ботом). Если на объекте
 * при этом висел незакрытый хендофф (QUEUED/SENT_TO_EDITOR), закрываем его —
 * иначе editorIsBusy() держит место монтажёра занятым ИМЕННО ЭТИМ объектом
 * НАВСЕГДА (он никогда не станет RECEIVED сам), и вся очередь «строго по
 * одному» встаёт за ним замертво для всех следующих объектов, молча — здесь
 * нечему бросить ошибку в журнал, публикация ведь прошла успешно.
 *
 * Найдено 19.09.2026: №104 и №106 ушли в продажу этим путём и застряли в
 * SENT_TO_EDITOR/QUEUED, из-за чего №107 позади них сутки не получал видео.
 *
 * videoHandoffSentAt чистим вместе со статусом: RECEIVED с пустой датой не
 * попадает в findResendCandidate (там `gte` по этому полю) — ролик через
 * бота на этот объект никогда не присылали, предлагать монтажёру «переслать
 * ещё раз» именно сюда нечего.
 */
export async function skipVideoHandoffOnManualPublish(propertyId: string): Promise<void> {
  // Тот же путь, что у ручного снятия (24.09.2026): держателю места монтажёр
  // получает «сняли с монтажа» ДО того, как место уйдёт следующему, — раньше
  // здесь молча выдавался следующий, а монтажёр продолжал делать опубликованный.
  // Объект не в очереди (NONE/RECEIVED) — no-op, как и было.
  await closeVideoHandoff(propertyId, { holdQueue: false });
}

/**
 * Общий финал закрытия хендоффа — тем же приёмом закрывают и автоматический
 * обход бота (`skipVideoHandoffOnManualPublish`), и ручную отмену из очереди
 * (`cancelVideoHandoffQueueEntry`). `RECEIVED` + пустой `videoHandoffSentAt` —
 * см. комментарий у `skipVideoHandoffOnManualPublish` про `findResendCandidate`.
 *
 * АТОМАРНО (24.09.2026): статус читается и меняется под HANDOFF_QUEUE_LOCK_ID,
 * а запись — `updateMany` с условием на прочитанные `videoHandoffStatus` и
 * `videoHandoffManualSince`. Приём готового ролика и отправка монтажёру замок
 * очереди не берут, поэтому без условия снятие могло затереть только что
 * принятый ролик или объект, который только что открыли под ручную загрузку.
 * `count === 0` — состояние изменилось, вызывающий отвечает 409, а не делает
 * вид, что снял.
 *
 * ПОРЯДОК (24.09.2026, №133/134/135): сначала монтажёру «сняли с монтажа», ПОТОМ
 * освобождение места. Раньше уведомление уходило после отправки файлов
 * следующего объекта — монтажёр получал новые файлы раньше, чем узнавал, что
 * старые больше не нужны.
 *
 * `holdQueue` — место освобождается, но следующий НЕ выдаётся: очередь встаёт
 * на паузу (Settings.videoHandoffQueuePaused) в той же транзакции под тем же
 * замком, что и снятие, — между ними никто не успеет выдать место.
 *
 * `releaseQueueIfClear` вызывается ПОСЛЕ коммита транзакции, а не внутри неё —
 * он сам берёт тот же лок своей транзакцией (`withQueueLock`), и вложенная
 * транзакция на другом соединении ждала бы этот самый advisory-лок вечно.
 */
export type CloseVideoHandoffOutcome = "closed" | "not-found" | "not-in-queue" | "state-changed";

export interface CloseVideoHandoffOpts {
  holdQueue: boolean;
  /** Причина в тексте монтажёру: «Объект №N <reason> — доделывать не нужно…».
   *  По умолчанию «сняли с монтажа» (ручное снятие из конвейера). */
  reason?: string;
  /** Вид записи в MontajerMessage — по умолчанию CANCELLED (ручное снятие/смена
   *  статуса), для удаления в корзину зовущий передаёт PROPERTY_DELETED. */
  kind?: MontajerMessageKind;
  /** holdQueue: кто и почему придержал очередь — пишутся в Settings вместе с
   *  паузой (25.09.2026, А4), тем же замком, что и снятие. */
  pauseReason?: string;
  pausedById?: string;
}

/**
 * Общий финал закрытия хендоффа: ручное снятие из очереди
 * (`cancelVideoHandoffQueueEntry`), продажа/снятие/резерв объекта во время
 * монтажа (`routes/properties/crud.ts`) и удаление в корзину
 * (`releaseVideoHandoffForTrashed`) — все три ведут сюда, а не держат свою
 * копию условия статуса и своя запись в журнал (25.09.2026, А3).
 */
export async function closeVideoHandoff(propertyId: string, opts: CloseVideoHandoffOpts): Promise<CloseVideoHandoffOutcome> {
  const reason = opts.reason ?? "сняли с монтажа";
  const kind: MontajerMessageKind = opts.kind ?? "CANCELLED";
  const closed = await withQueueLock(async (tx) => {
    const property = await tx.property.findUnique({
      where: { id: propertyId },
      select: { videoHandoffStatus: true, videoHandoffManualSince: true, shortId: true },
    });
    if (!property) return { outcome: "not-found" as const };
    const status = property.videoHandoffStatus;
    if (status !== "QUEUED" && status !== "SENT_TO_EDITOR") return { outcome: "not-in-queue" as const };
    const updated = await tx.property.updateMany({
      where: { id: propertyId, videoHandoffStatus: status, videoHandoffManualSince: property.videoHandoffManualSince },
      data: { videoHandoffStatus: "RECEIVED", videoHandoffSentAt: null, videoHandoffManualSince: null, videoHandoffQueueOrder: null },
    });
    if (updated.count === 0) return { outcome: "state-changed" as const };
    if (opts.holdQueue) {
      await tx.settings.updateMany({
        where: { id: "singleton" },
        data: {
          videoHandoffQueuePaused: true,
          videoHandoffQueuePausedAt: new Date(),
          videoHandoffQueuePausedById: opts.pausedById ?? null,
          videoHandoffQueuePauseReason: opts.pauseReason?.trim() || null,
        },
      });
    }
    return {
      outcome: "closed" as const,
      shortId: property.shortId,
      heldSeat: status === "SENT_TO_EDITOR",
      // Ручное ожидание (videoHandoffManualSince) монтажёр не получал — писать
      // ему «сняли» не о чем, но в журнал — да, ниже (для восстановления из
      // корзины нужен факт, что объект был в очереди, даже без Telegram-сообщения).
      wasWithEditor: status === "SENT_TO_EDITOR" && !property.videoHandoffManualSince,
      wasQueuedOnly: status === "QUEUED",
    };
  });
  if (closed.outcome !== "closed") return closed.outcome;

  if (closed.wasWithEditor) {
    await notifyMontajerHandoffCancelled(propertyId, closed.shortId, reason, kind);
  } else if (closed.wasQueuedOnly) {
    // Монтажёр этот объект никогда не видел — Telegram не шлём, но журнал
    // (25.09.2026, А3) остаётся источником правды для восстановления из
    // корзины: «был в очереди на момент удаления» иначе нигде не видно.
    void recordMontajerMessage(
      propertyId,
      kind,
      `Объект №${closed.shortId} ${reason} — снят из очереди монтажа, ролик монтажёру не отправлялся.`
    );
  }
  if (closed.heldSeat) await releaseQueueIfClear(propertyId);
  return "closed";
}

/**
 * Готовый ролик загрузили из CRM, пока объект держал монтажёр (05.10.2026, владелец:
 * «если ролик на монтаже, он должен сняться с монтажа, и следующий уйти монтажёру»).
 * Место и очередь сдвигает сам приём (finishReceivingVideo → releaseQueueIfClear);
 * здесь — только честное сообщение монтажёру, чтобы он не доделывал ненужное.
 */
export async function notifyMontajerFinalUploadedManually(propertyId: string, shortId: number): Promise<void> {
  await notifyMontajerHandoffCancelled(propertyId, shortId, "готов — ролик загрузили из CRM", "CANCELLED");
}

/** «Объект №N <reason>» — монтажёру, который уже держит файлы. Отказ
 *  Telegram — в журнал, а не в тишину: иначе монтажёр доделывает ненужный ролик. */
async function notifyMontajerHandoffCancelled(
  propertyId: string,
  shortId: number,
  reason: string,
  kind: MontajerMessageKind
): Promise<void> {
  const settings = await prisma.settings.findUnique({
    where: { id: "singleton" },
    select: { videoMontajerAgentId: true },
  });
  const montajer = settings?.videoMontajerAgentId
    ? await prisma.agent.findFirst({ where: { id: settings.videoMontajerAgentId, isActive: true }, select: { telegramChatId: true } })
    : null;
  const text = `Объект №${shortId} ${reason} — доделывать не нужно, ролик можно не присылать.`;
  if (!montajer?.telegramChatId) {
    void recordMontajerMessage(propertyId, kind, text);
    return;
  }
  try {
    await sendToMontajer(montajer.telegramChatId, text, { copy: true, propertyShortId: shortId });
  } catch (err) {
    void logSystemError("video-handoff", `Объект №${shortId}: монтажёру не ушло «${reason}»: ${describeError(err)}`);
  }
  void recordMontajerMessage(propertyId, kind, text);
  // Пуш модераторам CRM (25.09.2026, задание G) — снятие с монтажа само по
  // себе решение не тихое: тот, кто может модерировать монтаж, должен знать,
  // что место освободилось не приёмом ролика.
  void montageNotificationRecipients()
    .then((ids) => (ids.length > 0 ? sendPushToAgents(ids, { kind: "task", title: `Объект №${shortId} снят с монтажа`, body: text, url: `/properties/${shortId}`, tag: `video-handoff-cancelled-${propertyId}` }) : undefined))
    .catch((err) => void logSystemError("video-handoff", `Объект №${shortId}: пуш о снятии с монтажа не ушёл: ${describeError(err)}`));
}

/**
 * Объект удалили в Корзину — место монтажёра он больше не держит (19.09.2026,
 * разведка «осиротевшие спутники» по случаю с двумя квартирами одного продавца).
 *
 * До этой правки удаление объекта не трогало `videoHandoffStatus` вовсе. Объект,
 * удалённый прямо из очереди, оставался `SENT_TO_EDITOR` навсегда — сам он
 * `RECEIVED` уже не станет, а `editorIsBusy()` продолжал видеть занятое место, и
 * все следующие объекты вставали в `QUEUED` замертво. Наружу это выглядит как
 * «монтажёру перестали приходить ролики», без единой ошибки в журнале.
 *
 * Зовётся из lib/trashProperty.ts на всю партию сразу — удаление галочками идёт
 * туда же, что и одиночное (одиночное там частный случай партии).
 */
/**
 * ПЕРЕВЕДЕНО НА closeVideoHandoff ПОД ЗАМКОМ (25.09.2026, А3) — раньше здесь
 * стоял голый `updateMany` без advisory-лока очереди: могло совпасть по
 * времени с releaseQueueIfClear или другим закрытием того же объекта.
 * `kind: "PROPERTY_DELETED"` — восстановление из Корзины (`POST
 * /properties/:id/restore`, crud.ts) смотрит именно на эту запись журнала,
 * чтобы понять, был ли объект в очереди на момент удаления, и вернуть его
 * обратно кнопкой уже не нужно — `queueVideoHandoff` вызывается там же.
 */
export async function releaseVideoHandoffForTrashed(propertyIds: string[]): Promise<void> {
  if (propertyIds.length === 0) return;
  for (const id of propertyIds) {
    await closeVideoHandoff(id, { holdQueue: false, reason: "удалён", kind: "PROPERTY_DELETED" });
  }
}

export type RequeueVideoHandoffResult = { ok: true; queued: boolean } | { ok: false; error: string };

/**
 * СНОВА НА МОНТАЖ ПОСЛЕ СНЯТИЯ (23.09.2026, владелец про №121: «я снял с монтажа
 * объект, и теперь у него написано одобрено, и всё — ролика нет ни у монтажёра,
 * ни в списке, и нет кнопки отправить ещё на монтаж»).
 *
 * Снятие (`cancelVideoHandoffQueueEntry`) оставляет объект на этапе EDITING со
 * «синтетическим» RECEIVED без готового файла. Готового ролика нет, значит блок
 * «Вернуть монтажёру» (он про уже вышедший ролик) не показывается, а в очередь
 * объект сам больше не попадёт никогда: он её уже прошёл. Тупик, из которого
 * выводил только разработчик. Эта функция — обратный ход снятию: та же
 * постановка, что при одобрении (`queueVideoHandoff`), без причины перемонтажа,
 * потому что ролика ещё не было.
 *
 * Только для объекта на монтаже, без готового ролика и вне очереди: у объекта с
 * готовым роликом есть «Вернуть монтажёру» с причиной.
 */
export async function requeueVideoHandoff(propertyId: string): Promise<RequeueVideoHandoffResult> {
  const property = await prisma.property.findUnique({
    where: { id: propertyId },
    select: {
      deletedAt: true,
      status: true,
      videoHandoffStatus: true,
      videoHandoffManualSince: true,
      videoHandoffFinalPath: true,
      _count: { select: { videos: true } },
    },
  });
  if (!property || property.deletedAt) return { ok: false, error: "Объект не найден или удалён." };
  if (property.status !== "EDITING") return { ok: false, error: "Объект не на этапе монтажа." };
  if (property.videoHandoffStatus === "QUEUED" || (property.videoHandoffStatus === "SENT_TO_EDITOR" && !property.videoHandoffManualSince)) {
    return { ok: false, error: "Объект уже у монтажёра или стоит в очереди." };
  }
  if (property.videoHandoffFinalPath) {
    return { ok: false, error: "Готовый ролик уже есть — для переделки нажмите «Вернуть монтажёру»." };
  }
  if (property._count.videos === 0) {
    return { ok: false, error: "У объекта нет сырого видео — загрузите его, и тогда отправляйте на монтаж." };
  }
  const settings = await prisma.settings.findUnique({
    where: { id: "singleton" },
    select: { videoHandoffEnabled: true, videoMontajerAgentId: true },
  });
  if (!settings?.videoHandoffEnabled) return { ok: false, error: "Передача роликов монтажёру выключена в Настройках." };
  if (!settings.videoMontajerAgentId) return { ok: false, error: "Монтажёр не назначен в Настройках." };

  await queueVideoHandoff(propertyId);
  const after = await prisma.property.findUnique({ where: { id: propertyId }, select: { videoHandoffStatus: true } });
  return { ok: true, queued: after?.videoHandoffStatus === "QUEUED" };
}

export type CancelVideoHandoffResult =
  | { ok: true }
  | { ok: false; code: "NOT_FOUND" | "NOT_IN_QUEUE" | "STATE_CHANGED"; error: string };

/**
 * Ручная отмена из очереди монтажа (владелец 19.09.2026, после разлепа
 * №104/106/107 — «чтобы админ и монтажёр и директор видели очередь и могли
 * отменять»). В отличие от `skipVideoHandoffOnManualPublish` (объект и так
 * публикуется, хендофф — просто мусор, который надо смести), здесь объект
 * ОСТАЁТСЯ на прежнем этапе (обычно EDITING) — снимается только передача
 * боту: агент перезалил не то видео, объект передумали монтировать сейчас,
 * монтажёра нужно освободить для другого объекта руками.
 *
 * Если снимаемый объект держал место монтажёра (`SENT_TO_EDITOR`), он уже
 * получил файл в Telegram — молчания достаточно не будет, монтажёр может
 * потратить время на ролик, который сняли из-под него; шлём короткое
 * уведомление тем же ботом. `QUEUED`-объект монтажёр никогда не видел —
 * сообщать не о чем.
 *
 * `holdQueue` (24.09.2026): снять и НЕ отдавать место следующему — очередь
 * встаёт на паузу до «Возобновить». Без него — как было: следующий уходит
 * монтажёру сразу (файлы идут в фоне, ответ их не ждёт).
 */
export async function cancelVideoHandoffQueueEntry(
  propertyId: string,
  opts: { holdQueue?: boolean; pauseReason?: string; pausedById?: string } = {}
): Promise<CancelVideoHandoffResult> {
  const outcome = await closeVideoHandoff(propertyId, {
    holdQueue: opts.holdQueue === true,
    pauseReason: opts.pauseReason,
    pausedById: opts.pausedById,
  });
  switch (outcome) {
    case "closed":
      return { ok: true };
    case "not-found":
      return { ok: false, code: "NOT_FOUND", error: "Объект не найден" };
    case "not-in-queue":
      return { ok: false, code: "NOT_IN_QUEUE", error: "Объект сейчас не в очереди монтажа" };
    case "state-changed":
      return { ok: false, code: "STATE_CHANGED", error: "Состояние объекта только что изменилось — обновите список и попробуйте ещё раз" };
  }
}

export type MoveVideoHandoffResult =
  | { ok: true; shortId: number; from: number; to: number }
  | { ok: false; code: "NOT_FOUND" | "NOT_IN_QUEUE" | "HOLDER_CANNOT_MOVE"; error: string };

/**
 * ПЕРЕСТАНОВКА В ОЧЕРЕДИ МОНТАЖА (24.09.2026, владелец: «кнопку, чтобы
 * передвигать очередь — какой-то объект быстрее на монтаж»).
 *
 * Двигаются только ждущие (QUEUED). Держатель места уже у монтажёра — его
 * «передвинуть» значило бы отобрать файлы, это «Снять с монтажа», а не ход.
 * Позиции 1-based среди ждущих: 1 — тот, кому место уйдёт следующим. Под
 * замком очереди: ход и выдача места друг друга не перебивают. После хода
 * очередь перенумеровывается 1..N целиком — без дыр и дублей.
 */
export async function moveVideoHandoffInQueue(propertyId: string, move: VideoHandoffMoveBody): Promise<MoveVideoHandoffResult> {
  return withQueueLock(async (tx) => {
    const property = await tx.property.findUnique({
      where: { id: propertyId },
      select: { shortId: true, deletedAt: true, videoHandoffStatus: true, videoHandoffManualSince: true },
    });
    if (!property || property.deletedAt) return { ok: false, code: "NOT_FOUND", error: "Объект не найден" };
    if (property.videoHandoffStatus === "SENT_TO_EDITOR" && !property.videoHandoffManualSince) {
      return {
        ok: false,
        code: "HOLDER_CANNOT_MOVE",
        error: "Объект уже у монтажёра — его место не двигается. Чтобы освободить место, снимите его с монтажа.",
      };
    }
    if (property.videoHandoffStatus !== "QUEUED") {
      return { ok: false, code: "NOT_IN_QUEUE", error: "Объект сейчас не стоит в очереди монтажа" };
    }
    const ids = (await orderedQueue(tx)).map((p) => p.id);
    const from = ids.indexOf(propertyId);
    if (from < 0) return { ok: false, code: "NOT_IN_QUEUE", error: "Объект сейчас не стоит в очереди монтажа" };
    const last = ids.length - 1;
    const target =
      move.to === "front" ? 0
      : move.to === "up" ? from - 1
      : move.to === "down" ? from + 1
      : (move.position ?? from + 1) - 1;
    const to = Math.min(Math.max(target, 0), last);
    ids.splice(from, 1);
    ids.splice(to, 0, propertyId);
    await renumberQueue(tx, ids);
    return { ok: true, shortId: property.shortId, from: from + 1, to: to + 1 };
  });
}

export type HoldVideoHandoffResult =
  | { ok: true; shortId: number }
  | { ok: false; code: "NOT_FOUND" | "NOT_IN_QUEUE" | "HOLDER_CANNOT_HOLD"; error: string };

/**
 * ОТЛОЖИТЬ ОДИН ОБЪЕКТ В ОЧЕРЕДИ (25.09.2026, владелец: «чтобы была возможность
 * придерживать какой-то монтаж на паузе», спецификация «полный контроль
 * монтажа», блок В3). Только для ждущих (`QUEUED`) — держателя места
 * (`SENT_TO_EDITOR`) отложить нельзя, у него уже есть «Снять с монтажа»
 * (`cancelVideoHandoffQueueEntry`), которое и освобождает место, и место в
 * очереди не двигается — объект просто помечен, `nextInQueue` его пропускает
 * (см. докстринг там же). Под замком очереди — тем же, что и остальные ходы:
 * иначе выдача места и придержка, совпав по времени, могли бы разойтись.
 */
export async function holdVideoHandoff(propertyId: string, opts: { reason?: string; byId: string }): Promise<HoldVideoHandoffResult> {
  return withQueueLock(async (tx) => {
    const property = await tx.property.findUnique({
      where: { id: propertyId },
      select: { shortId: true, deletedAt: true, videoHandoffStatus: true },
    });
    if (!property || property.deletedAt) return { ok: false, code: "NOT_FOUND", error: "Объект не найден" };
    if (property.videoHandoffStatus === "SENT_TO_EDITOR") {
      return {
        ok: false,
        code: "HOLDER_CANNOT_HOLD",
        error: "Объект уже у монтажёра — его нельзя отложить. Чтобы освободить место, снимите его с монтажа.",
      };
    }
    if (property.videoHandoffStatus !== "QUEUED") {
      return { ok: false, code: "NOT_IN_QUEUE", error: "Объект сейчас не стоит в очереди монтажа" };
    }
    await tx.property.update({
      where: { id: propertyId },
      data: { videoHandoffHeldAt: new Date(), videoHandoffHeldById: opts.byId, videoHandoffHoldReason: opts.reason?.trim() || null },
    });
    return { ok: true, shortId: property.shortId };
  });
}

export type ReleaseVideoHandoffHoldResult =
  | { ok: true; shortId: number }
  | { ok: false; code: "NOT_FOUND" | "NOT_HELD"; error: string };

/**
 * ВЕРНУТЬ В ОЧЕРЕДЬ объект, отложенный `holdVideoHandoff` (25.09.2026). Сам по
 * себе не выдаёт место — снятие пометки лишь снова делает объект видимым для
 * `nextInQueue`; если место монтажёра свободно и очередь не на паузе, `releaseQueueIfClear`
 * ПОСЛЕ снятия лока отдаёт место (этому же объекту, если он теперь первый
 * невот-ложенный, или тому, кто раньше его в очереди) — та же схема, что у
 * `setVideoHandoffQueuePaused(false)`.
 */
export async function releaseVideoHandoffHold(propertyId: string): Promise<ReleaseVideoHandoffHoldResult> {
  const outcome = await withQueueLock(async (tx) => {
    const property = await tx.property.findUnique({
      where: { id: propertyId },
      select: { shortId: true, deletedAt: true, videoHandoffStatus: true, videoHandoffHeldAt: true },
    });
    if (!property || property.deletedAt) return { ok: false as const, code: "NOT_FOUND" as const, error: "Объект не найден" };
    if (property.videoHandoffStatus !== "QUEUED" || !property.videoHandoffHeldAt) {
      return { ok: false as const, code: "NOT_HELD" as const, error: "Объект сейчас не отложен" };
    }
    await tx.property.update({
      where: { id: propertyId },
      data: { videoHandoffHeldAt: null, videoHandoffHeldById: null, videoHandoffHoldReason: null },
    });
    return { ok: true as const, shortId: property.shortId };
  });
  if (outcome.ok) await releaseQueueIfClear("");
  return outcome;
}

/**
 * ПАУЗА ОЧЕРЕДИ МОНТАЖЁРА (24.09.2026). Под замком очереди — releaseQueueIfClear,
 * идущий параллельно, видит либо старое значение, либо новое. Возобновление
 * сразу отдаёт свободное место следующему (файлы идут в фоне).
 */
/**
 * `opts.byId`/`opts.reason` (25.09.2026, А4) — кто и почему поставил очередь
 * на паузу, рядом с фактом паузы. Снятие паузы гасит все три поля вместе с
 * флагом: они относятся к ТЕКУЩЕЙ паузе, а не к истории пауз.
 */
export async function setVideoHandoffQueuePaused(
  paused: boolean,
  opts: { byId?: string | null; reason?: string | null } = {}
): Promise<void> {
  await withQueueLock((tx) =>
    tx.settings.updateMany({
      where: { id: "singleton" },
      data: paused
        ? {
            videoHandoffQueuePaused: true,
            videoHandoffQueuePausedAt: new Date(),
            videoHandoffQueuePausedById: opts.byId ?? null,
            videoHandoffQueuePauseReason: opts.reason?.trim() || null,
          }
        : {
            videoHandoffQueuePaused: false,
            videoHandoffQueuePausedAt: null,
            videoHandoffQueuePausedById: null,
            videoHandoffQueuePauseReason: null,
          },
    })
  );
  if (!paused) await releaseQueueIfClear("");
}

/** Состояние очереди для экрана конвейера: пауза (с причиной и автором),
 *  держатель места и тот, кому место уйдёт следующим (тем же порядком, что у
 *  releaseQueueIfClear). */
export async function videoHandoffQueueState(): Promise<VideoHandoffQueueState> {
  const [settingsRow, holder, queue] = await Promise.all([
    prisma.settings.findUnique({
      where: { id: "singleton" },
      select: {
        videoHandoffQueuePaused: true,
        videoHandoffQueuePausedAt: true,
        videoHandoffQueuePausedById: true,
        videoHandoffQueuePauseReason: true,
      },
    }),
    prisma.property.findFirst({ where: EDITOR_HOLDER_WHERE, select: { id: true, shortId: true } }),
    orderedQueue(),
  ]);
  const pausedBy = settingsRow?.videoHandoffQueuePausedById
    ? await prisma.agent.findUnique({
        where: { id: settingsRow.videoHandoffQueuePausedById },
        select: { id: true, fullName: true },
      })
    : null;
  // heldAt — Date на сервере, ISO-строкой наружу (как и остальные даты в ответе).
  // Отложенный (25.09.2026) остаётся В СПИСКЕ на своём месте (queuedCount его
  // считает — позиции экрана строятся по тому же orderedQueue), но `next`
  // (кому реально уйдёт место монтажёра) — первый НЕ отложенный, той же
  // логикой, что и nextInQueue.
  const serializedQueue = queue.map((p) => ({
    id: p.id,
    shortId: p.shortId,
    heldAt: p.heldAt?.toISOString() ?? null,
    holdReason: p.holdReason,
  }));
  return {
    paused: settingsRow?.videoHandoffQueuePaused ?? false,
    pausedAt: settingsRow?.videoHandoffQueuePausedAt?.toISOString() ?? null,
    pausedBy,
    pauseReason: settingsRow?.videoHandoffQueuePauseReason ?? null,
    holder,
    next: serializedQueue.find((p) => !p.heldAt) ?? null,
    queuedCount: queue.length,
    queue: serializedQueue,
  };
}

/** Позиция каждого объекта в очереди хендоффа прямо сейчас — 1 у того, кто
 *  держит место монтажёра (`SENT_TO_EDITOR`), 2+ у ждущих своей очереди
 *  (`QUEUED`, тем же порядком, что и `queueStatusForMontajer`/`dispatchToEditor`).
 *  Экраны конвейера (routes/marketing.ts) подмешивают её в свои строки —
 *  список тут всегда маленький (очередь «строго по одному»), считать заново
 *  на каждый запрос дешевле, чем городить отдельный кэш. */
export async function videoHandoffQueuePositions(): Promise<Map<string, number>> {
  const [current, queued] = await Promise.all([
    prisma.property.findFirst({ where: EDITOR_HOLDER_WHERE, select: { id: true } }),
    orderedQueue(),
  ]);
  const positions = new Map<string, number>();
  if (current) positions.set(current.id, 1);
  queued.forEach((p, i) => positions.set(p.id, i + 2));
  return positions;
}

/** Скаляры Property, которых достаточно, чтобы собрать блок «Монтаж» карточки
 *  объекта — ровно те поля, что уже загружает GET /properties/:id, лишнего
 *  запроса на саму запись Property здесь нет (25.09.2026, задание C). */
export interface VideoHandoffCardPropertyFields {
  id: string;
  videoHandoffStatus: string;
  videoHandoffHeldAt: Date | null;
  videoHandoffHoldReason: string | null;
  videoHandoffSentAt: Date | null;
  videoHandoffDeliveredAt: Date | null;
  videoHandoffDispatchAttempts: number;
  videoHandoffDispatchStartedAt: Date | null;
  videoHandoffReceivedAt: Date | null;
  scheduledPublishAt: Date | null;
  scheduledPublishReason: string | null;
  videoHandoffFinalPath: string | null;
  clipReviewStatus: string;
  clipReviewRequestedAt: Date | null;
  clipReviewDecidedAt: Date | null;
  clipReviewDecidedById: string | null;
  clipReviewComment: string | null;
}

/**
 * БЛОК «МОНТАЖ» ДЛЯ КАРТОЧКИ ОДНОГО ОБЪЕКТА (25.09.2026, владелец: «чтобы в
 * карточке объекта всё было»). Три запроса — позиции очереди (уже дешёвые,
 * см. докстринг у videoHandoffQueuePositions), монтажёр из Настроек и список
 * сырых роликов с фактами доставки. Один объект за раз — не список, N+1
 * здесь неприменим (счёт запросов на карточку, не на строку списка).
 */
export async function videoHandoffCardForProperty(property: VideoHandoffCardPropertyFields): Promise<PropertyVideoHandoffCard | null> {
  if (property.videoHandoffStatus === "NONE") return null;
  const [positions, settings, videos] = await Promise.all([
    videoHandoffQueuePositions(),
    prisma.settings.findUnique({ where: { id: "singleton" }, select: { videoMontajerAgentId: true } }),
    prisma.propertyVideo.findMany({
      where: { propertyId: property.id },
      orderBy: { uploadedAt: "asc" },
      select: {
        id: true, filename: true, sizeBytes: true, durationSec: true, hasAudio: true, telegramFileId: true,
        montajerDeliveredAt: true, montajerDeliveredToId: true,
      },
    }),
  ]);
  const publishJob = await prisma.backgroundJob.findFirst({
    where: { dedupeKey: videoHandoffPublishDedupeKey(property.id), status: { in: ["PENDING", "RUNNING"] } },
    select: { status: true, runAt: true, attempts: true, updatedAt: true },
  });
  const [montajer, clipDecidedBy] = await Promise.all([
    settings?.videoMontajerAgentId
      ? prisma.agent.findUnique({ where: { id: settings.videoMontajerAgentId }, select: { id: true, fullName: true } })
      : null,
    property.clipReviewDecidedById
      ? prisma.agent.findUnique({ where: { id: property.clipReviewDecidedById }, select: { fullName: true } })
      : null,
  ]);
  return {
    status: property.videoHandoffStatus as PropertyVideoHandoffCard["status"],
    queuePosition: positions.get(property.id) ?? null,
    heldAt: property.videoHandoffHeldAt?.toISOString() ?? null,
    holdReason: property.videoHandoffHoldReason,
    sentAt: property.videoHandoffSentAt?.toISOString() ?? null,
    deliveredAt: property.videoHandoffDeliveredAt?.toISOString() ?? null,
    dispatchAttempts: property.videoHandoffDispatchAttempts,
    dispatchStartedAt: property.videoHandoffDispatchStartedAt?.toISOString() ?? null,
    receivedAt: property.videoHandoffReceivedAt?.toISOString() ?? null,
    scheduledPublishAt: property.scheduledPublishAt?.toISOString() ?? null,
    scheduledPublishReason: property.scheduledPublishReason,
    montajer,
    // Проверка готового ролика модератором (25.09.2026, lib/clipReview.ts).
    // finalVideoUrl — публичный путь /uploads/handoff/…: ответ карточки
    // подписывает его signMediaUrlsInResponses, как и остальные /uploads.
    finalVideoUrl: property.videoHandoffFinalPath,
    publish: publishJob
      ? {
          state: publishJob.status === "RUNNING" ? "running" : publishJob.attempts > 0 ? "retrying" : "waiting",
          runAt: publishJob.runAt.toISOString(),
          startedAt: publishJob.status === "RUNNING" ? publishJob.updatedAt.toISOString() : null,
          attempt: publishJob.attempts,
        }
      : { state: "idle", runAt: null, startedAt: null, attempt: 0 },
    clipReview: {
      status: property.clipReviewStatus as PropertyVideoHandoffCard["clipReview"]["status"],
      requestedAt: property.clipReviewRequestedAt?.toISOString() ?? null,
      decidedAt: property.clipReviewDecidedAt?.toISOString() ?? null,
      decidedBy: clipDecidedBy?.fullName ?? null,
      comment: property.clipReviewComment,
    },
    videos: videos.map((v) => ({
      id: v.id,
      name: v.filename,
      sizeBytes: v.sizeBytes,
      durationSec: v.durationSec,
      hasAudio: v.hasAudio,
      // Большие файлы уходят монтажёру ссылкой и file_id не получают, но отметка
      // «у монтажёра» ставится — по одному file_id карточка рисовала красный крест зря.
      delivered: !!v.telegramFileId || (montajer != null && isWithMontajer(v, montajer.id)),
    })),
  };
}

/**
 * Следующий в очереди (если есть) получает ролик — вызывается ПОСЛЕ того, как
 * предыдущая передача закрылась (публикацией или явным отказом руками).
 *
 * ЭКСПОРТИРОВАНА (21.09.2026, случай №114) — публикация переехала в очередь
 * фоновых заданий (`jobs/videoHandoffPublish.ts`). Освобождение места
 * монтажёра, наоборот, переехало ОБРАТНО на момент приёма файла
 * (`receiveEditedVideo`, тот же день, расстановка публикаций по времени) — раз
 * публикация теперь может ждать своего слота часами, ждать ещё и её исход
 * ради следующего ролика было бы неверно. `jobs/videoHandoffPublish.ts`
 * по-прежнему зовёт эту функцию и на честной сдаче, и на файле, пропавшем с
 * диска — это подстраховка на случай, если приём почему-то её не позвал
 * (старое задание из очереди, поставленное до этой правки), а не основной путь.
 */
export async function releaseQueueIfClear(justFinishedPropertyId: string): Promise<void> {
  const settings = await prisma.settings.findUnique({
    where: { id: "singleton" },
    select: { videoMontajerAgentId: true },
  });
  if (!settings?.videoMontajerAgentId) return;
  // Выбор следующего и занятие места — под тем же замком, что и постановка в
  // очередь: иначе освобождение места и одобрение нового объекта, совпав по
  // времени, выдали бы монтажёру сразу двоих.
  const next = await withQueueLock(async (tx) => {
    if (await editorIsBusy(tx)) return null; // место уже занял кто-то другой
    // Очередь на паузе (24.09.2026) — место остаётся свободным, следующий ждёт
    // «Возобновить». Касается всех, кто освобождает место: приём ролика, снятие,
    // корзина, пересылка, публикация и сторож досылки.
    if (await queuePaused(tx)) return null;
    const candidate = await nextInQueue(tx, justFinishedPropertyId || undefined);
    if (!candidate) return null;
    await seatFromQueue(tx, candidate.id);
    return candidate;
  });
  if (!next) return;
  dispatchInBackground(next.id, settings.videoMontajerAgentId);
}

/**
 * ОТПРАВКА СЛЕДУЮЩЕГО — В ФОНЕ (24.09.2026). Раньше releaseQueueIfClear ждал
 * отправку файлов (175–213 МБ — десятки секунд), и вместе с ним ждали: кнопка
 * «Снять с монтажа» (браузер рвёт запрос на 30 с — «Связь пропала»), квитанция
 * «принято» монтажёру в боте (Telegram-поллер стоял минутами) и загрузка
 * готового ролика из CRM. Место занято под замком ДО этого вызова, так что
 * очередь «строго по одному» не страдает.
 *
 * Если фоновая отправка упадёт или процесс умрёт посреди неё, у держателя
 * останется `videoHandoffDeliveredAt = null` — сторож досылки
 * (lib/videoHandoffRedelivery.ts) дошлёт с нарастающей паузой от
 * `videoHandoffSentAt`, записанного при выдаче места.
 */
const backgroundDispatches = new Set<Promise<unknown>>();

/**
 * ЭКСПОРТИРОВАНА (25.09.2026, А1) — смена монтажёра в Настройках
 * (routes/settings.ts) тоже отправляет держателя места фоном: PATCH не должен
 * висеть минуты, пока идёт передача тяжёлых исходников новому монтажёру.
 */
export function dispatchInBackground(
  propertyId: string,
  montajerAgentId: string,
  opts: { resend?: "missing" | "all" } = {}
): void {
  const job: Promise<unknown> = dispatchToEditor(propertyId, montajerAgentId, opts)
    .catch((err) => {
      void logSystemError("video-handoff", `Отправка объекта ${propertyId} монтажёру в фоне упала: ${describeError(err)} — дошлёт сторож досылки`);
    })
    .finally(() => backgroundDispatches.delete(job));
  backgroundDispatches.add(job);
}

/** Дождаться всех фоновых отправок — для тестов и аккуратной остановки процесса. */
export async function settleBackgroundHandoffDispatches(): Promise<void> {
  while (backgroundDispatches.size > 0) await Promise.allSettled([...backgroundDispatches]);
}
