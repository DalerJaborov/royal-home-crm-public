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
/**
 * «МБ» у Meta — ДЕСЯТИЧНЫЕ (ревью 25.11.2026): документация пишет «16MB», а считает ли
 * платформа 16·10⁶ или 16·2²⁰ байт, не сказано. Берём меньшее — 16 000 000: файл на
 * 0,7 МБ легче не виден глазу, а отказ Meta на 16,5 «двоичных» мегабайтах — виден.
 */
const DMB = 1_000_000;

/**
 * Подпись веса или предела файла для сотрудника в ДЕСЯТИЧНЫХ мегабайтах — теми же, что
 * заданы пределы каналов выше (16 000 000 байт = «16 МБ»). Двоичный `formatUploadLimit`
 * показал бы «15,3 МБ» при заявленных 16 (ревью 26.11.2026). Дробь отбрасывается вниз до
 * десятой: предел никогда не называется больше настоящего.
 */
export function formatChannelLimit(bytes: number): string {
  const trim = (n: number) => String(Math.floor(n * 10 + 1e-9) / 10).replace(".", ",");
  if (bytes >= 1_000_000_000) return `${trim(bytes / 1_000_000_000)} ГБ`;
  return `${trim(bytes / DMB)} МБ`;
}

export type MetaOutgoingChannel = "WHATSAPP" | "INSTAGRAM" | "FACEBOOK";

export const META_OUTGOING_MEDIA_LIMITS: Record<MetaOutgoingChannel, { image: number; video: number }> = {
  WHATSAPP: { image: 5 * DMB, video: 16 * DMB },
  INSTAGRAM: { image: 8 * DMB, video: 25 * DMB },
  FACEBOOK: { image: 8 * DMB, video: 25 * DMB },
};

/** Фото в Telegram по ссылке: потолок облачного Bot API (sendPhoto). Telegram и сам
 *  пережимает фото до 2560 px, так что уложиться в 5 МБ — без видимой потери. */
export const TELEGRAM_OUTGOING_IMAGE_LIMIT = 5 * DMB;

/**
 * Фото тяжелее этого — не снимок с телефона (48 Мп iPhone в HEIC/JPEG весит 5–15 МБ),
 * а скан или выгрузка из редактора. Его сжатие требует держать файл и пиксели в памяти
 * worker целиком — отказ сразу при приёме, с понятным текстом (ревью 25.11.2026).
 */
export const OUTGOING_IMAGE_SOURCE_MAX_BYTES = 50 * MB;

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
