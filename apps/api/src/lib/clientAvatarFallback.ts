import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import sharp from "sharp";
import {
  AVATAR_GEOMETRY,
  CLIENT_AVATAR_TONES,
  GENDER_RING_COLOR,
  PERSON_ICON_PATHS,
  clientAvatarTone,
  guessGenderFromName,
} from "@royal-home/shared";
import { describeError } from "./describeError.js";
import { uploadsDir } from "../upload.js";

/**
 * НАРИСОВАННЫЙ АВАТАР КЛИЕНТА ДЛЯ ШТОРКИ УВЕДОМЛЕНИЙ.
 *
 * Настоящее фото есть далеко не у всех: WhatsApp Cloud API его не отдаёт вовсе, у
 * нового клиента оно ещё не скачано, у заведённого руками его не будет никогда
 * (см. lib/clientAvatar.ts). До 19.08.2026 в этих случаях уведомление показывало общую
 * иконку приложения — то есть все клиенты в шторке выглядели одинаково, и весь смысл
 * аватара («понять, кто написал, не открывая карточку») пропадал ровно там, где он
 * нужнее всего.
 *
 * Рисуем тот же кружок, что и CRM: фигурка человека (lucide `User`) на тоне по хэшу
 * имени и тонкое кольцо угаданного пола (значок «покупатель/продавец» убран 21.09.2026,
 * см. clientAvatar.ts). Вид целиком описан в packages/shared/src/clientAvatar.ts и
 * импортируется отсюда — палитра и контуры физически не могут разойтись с
 * components/ClientAvatar.tsx, потому что источник один.
 *
 * ПОЧЕМУ PNG, А НЕ SVG. Просится отдать `data:image/svg+xml`, но Chromium декодирует
 * картинку уведомления своим обычным декодером изображений, а SVG в нём намеренно
 * отключён — уведомление просто осталось бы без значка. Именно на эти грабли уже
 * наступил `/icon.svg` в apps/web/src/sw.ts. Поэтому SVG отрисовывается в PNG через
 * sharp (он и так в зависимостях, тем же путём готовятся фото объектов и аватары
 * сотрудников).
 *
 * ПОЧЕМУ ФАЙЛ НА ДИСКЕ, А НЕ `data:image/png;base64,...` В ТЕЛЕ ПУША (до 25.08.2026).
 * Web Push (и Apple, и FCM) режет тело сообщения на ~4096 байт, а сам нарисованный
 * PNG уже 4-13 КБ в base64 — payload превышал лимит раньше, чем в него попадали
 * заголовок и текст, и push falил кодом 413/400 (найдено по утреннему отчёту об
 * ошибках 25.08.2026: `web.push.apple.com` 413, `fcm.googleapis.com` 400 "binary
 * data ... must be less than 4096 bytes"). Файл пишется один раз на пару
 * имя+вид в `uploads/avatars-fallback/` (та же публичная статика без авторизации,
 * что и у настоящих фото — см. lib/crmPublicUrl.ts) и отдаётся коротким путём,
 * ровно как уже работает `photoUrl` из lib/clientAvatar.ts.
 */

/** Сторона картинки. 192 — размер, который Android берёт под крупный значок уведомления;
 *  меньше даёт мыло на плотных экранах, больше бессмысленно раздувает payload. */
const PNG_SIZE = 192;

/** Единицы SVG: кружок диаметром 100, поле шире на PAD под кольцо и выступающий значок. */
const D = 100;
const R = D / 2;
const PAD = 10;

/**
 * Готовые картинки живут в памяти процесса.
 *
 * Push по одному клиенту уходит десятками за день, а картинка зависит только от имени —
 * гонять sharp на каждое сообщение незачем. Ключ — само имя: сменилось оно — ключ другой,
 * старая запись просто перестаёт использоваться.
 */
const cache = new Map<string, string>();
const CACHE_LIMIT = 500;

/** Публичная статика — тот же каталог, что и настоящие фото клиентов
 *  (lib/clientAvatar.ts), раздаётся без авторизации через express.static("/uploads"). */
const fallbackAvatarDir = path.join(uploadsDir, "avatars-fallback");
fs.mkdirSync(fallbackAvatarDir, { recursive: true });

/** Разметка кружка — те же примитивы и в том же порядке, что в ClientAvatar.tsx.
 *
 *  Текста здесь нет вовсе (владелец 19.08.2026 отклонил вариант с инициалами), и это
 *  снимает две проблемы сервера разом: не нужно экранировать имя клиента, пришедшее из
 *  мессенджера, и не нужен шрифт в контейнере API, чтобы буквы вообще отрисовались. */
export function buildFallbackAvatarSvg(fullName: string | null | undefined): string {
  const tone = clientAvatarTone(fullName);
  const gender = guessGenderFromName(fullName);

  const person = D * AVATAR_GEOMETRY.person;
  const ringW = D * AVATAR_GEOMETRY.ring;
  const ringR = R + D * AVATAR_GEOMETRY.ringGap + ringW / 2;

  const ring = gender
    ? `<circle cx="${R}" cy="${R}" r="${ringR}" fill="none" stroke="${GENDER_RING_COLOR[gender]}" stroke-width="${ringW}"/>`
    : "";

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${PNG_SIZE}" height="${PNG_SIZE}" viewBox="${-PAD} ${-PAD} ${D + PAD * 2} ${D + PAD * 2}">` +
    `<circle cx="${R}" cy="${R}" r="${R}" fill="${tone.bg}"/>` +
    `<g transform="translate(${R - person / 2} ${R - person / 2}) scale(${person / 24})" fill="none" stroke="${tone.fg}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">` +
    PERSON_ICON_PATHS.map((d) => `<path d="${d}"/>`).join("") +
    `</g>` +
    ring +
    `</svg>`
  );
}

/** Имя файла на диске — по хэшу имени+вида, а не по самому имени: URL публичный
 *  (без авторизации), и имя клиента в него попадать не должно. */
function fallbackAvatarFilename(key: string): string {
  return `${crypto.createHash("sha256").update(key).digest("hex").slice(0, 24)}.png`;
}

/**
 * `/uploads/avatars-fallback/....png` с нарисованным аватаром — то, что кладётся в
 * `PushPayload.avatarUrl`, когда настоящего фото нет.
 *
 * Никогда не бросает: отсутствие картинки в уведомлении — мелочь, а несостоявшееся
 * уведомление о сообщении клиента — нет. Отказ означает `null`, и service worker
 * покажет обычную иконку приложения, как и раньше.
 */
export async function buildFallbackAvatarUrl(fullName: string | null | undefined): Promise<string | null> {
  const key = fullName ?? "";
  const cached = cache.get(key);
  if (cached) return cached;

  const filename = fallbackAvatarFilename(key);
  const filePath = path.join(fallbackAvatarDir, filename);
  const url = `/uploads/avatars-fallback/${filename}`;

  try {
    const exists = await fs.promises.access(filePath).then(
      () => true,
      () => false
    );
    if (!exists) {
      const svg = buildFallbackAvatarSvg(fullName);
      const png = await sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toBuffer();
      await fs.promises.writeFile(filePath, png);
    }
    // Простое ограничение размера: карта не должна расти вечно на живой базе, а какая
    // именно запись вытеснится — неважно, файл на диске уже готов, следующий запрос
    // просто заново найдёт его по тому же имени.
    if (cache.size >= CACHE_LIMIT) cache.clear();
    cache.set(key, url);
    return url;
  } catch (err) {
    console.error("[avatar] запасной аватар:", describeError(err));
    return null;
  }
}

/** Только для тестов: кэш живёт в памяти процесса и переживает смену данных клиента. */
export function resetFallbackAvatarCache(): void {
  cache.clear();
}

/** Количество тонов палитры — чтобы тест мог убедиться, что выбор устойчив, не зная её. */
export const FALLBACK_AVATAR_TONE_COUNT = CLIENT_AVATAR_TONES.length;
