/**
 * ПРЕДЕЛЫ КАНАЛОВ ДЛЯ ИСХОДЯЩИХ ФОТО И ВИДЕО (25.11.2026, владелец: «любые видео
 * отправлять и получать, как в самом WhatsApp или Telegram»).
 *
 * Это пределы САМИХ платформ, а не наши: снять их нельзя, можно только уложиться.
 * Поэтому сервер готовит файл под канал (apps/api/src/lib/outgoingMediaPrepare.ts):
 * сжимает видео и фото под потолок, а в Telegram шлёт оригинал. Одно место на сервер
 * (доставка и сжатие) и на экран (подсказки до выбора файла).
 *
 * Первоисточники (сверено 25.11.2026):
 *  - WhatsApp Cloud API, reference/media: фото JPEG/PNG ≤ 5 МБ; видео MP4/3GPP ≤ 16 МБ,
 *    только H.264 + AAC; документы ≤ 100 МБ.
 *  - Instagram Messaging API: фото ≤ 8 МБ (png, jpeg), видео ≤ 25 МБ.
 *  - Messenger Send API: вложение ≤ 25 МБ; для фото берём 8 МБ, как у Instagram —
 *    ОЦЕНКА с запасом: фото после нашей обработки весит 1–3 МБ, предел не упирается.
 *  - Telegram Bot API: фото по ссылке ≤ 5 МБ (sendPhoto). Свой сервер Bot API с
 *    `--local` поднимает потолок файлов до 2000 МБ — видео в Telegram идёт оригиналом,
 *    его предел задаёт сервер (apps/api/src/telegram/api.ts).
 */
const MB = 1024 * 1024;

export type MetaOutgoingChannel = "WHATSAPP" | "INSTAGRAM" | "FACEBOOK";

export const META_OUTGOING_MEDIA_LIMITS: Record<MetaOutgoingChannel, { image: number; video: number }> = {
  WHATSAPP: { image: 5 * MB, video: 16 * MB },
  INSTAGRAM: { image: 8 * MB, video: 25 * MB },
  FACEBOOK: { image: 8 * MB, video: 25 * MB },
};

/** Фото в Telegram по ссылке: потолок облачного Bot API (sendPhoto). Telegram и сам
 *  пережимает фото до 2560 px, так что уложиться в 5 МБ — без видимой потери. */
export const TELEGRAM_OUTGOING_IMAGE_LIMIT = 5 * MB;

/**
 * Запас к потолку при сжатии видео: битрейт x264 «в среднем», а не точно, и контейнер
 * добавляет пару процентов. 8% — с запасом на оба; файл, всё же вылезший за предел,
 * сжимается второй раз с поправкой.
 */
export const OUTGOING_VIDEO_SIZE_MARGIN = 0.08;

/**
 * НИЖНИЙ ПРЕДЕЛ КАЧЕСТВА: 360p и 300 кбит/с на картинку. Ниже стены и мебель на
 * обходе квартиры рассыпаются в квадраты — клиенту честнее отправить ссылку на
 * просмотр в нормальном качестве, чем «кашу». Отсюда предельная длина видео,
 * помещающегося в канал целиком (звук 64 кбит/с): WhatsApp ≈ 5,5 минуты,
 * Instagram и Messenger ≈ 8,5 минуты. Длиннее — ссылка.
 */
export const OUTGOING_VIDEO_MIN_KBPS = 300;
export const OUTGOING_VIDEO_MIN_HEIGHT = 360;

/** Человеческое «примерно сколько минут видео помещается в канал» — для подсказки. */
export function maxVideoMinutesForChannel(channel: MetaOutgoingChannel): number {
  const bits = META_OUTGOING_MEDIA_LIMITS[channel].video * (1 - OUTGOING_VIDEO_SIZE_MARGIN) * 8;
  const seconds = bits / ((OUTGOING_VIDEO_MIN_KBPS + 64) * 1000);
  return Math.floor((seconds / 60) * 2) / 2;
}

/**
 * Предел ИСХОДНИКА, который сотрудник может выбрать для отправки клиенту: 1 ГБ.
 * Дальше упирается не код, а мобильный интернет агента (файл едет частями по 8 МБ с
 * докачкой) и смысл: видео длиннее ~8 минут всё равно уйдёт ссылкой.
 */
export const OUTGOING_MEDIA_SOURCE_MAX_BYTES = 1024 * MB;
