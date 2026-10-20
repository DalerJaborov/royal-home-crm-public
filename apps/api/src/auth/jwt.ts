import jwt, { type SignOptions } from "jsonwebtoken";
import type { Role } from "@royal-home/shared";

/**
 * Тип срока жизни токена, как его понимает сама библиотека: число секунд или
 * строка вида «15m»/«30d». Наши сроки приходят из окружения обычной строкой и в
 * это сужение не проходят — приведение нужно, но именно к нему, а не к any.
 *
 * `as any` в объекте опций отключал проверку ВСЕГО вызова, а не одного поля:
 * опечатка в соседнем `algorithm` или `notBefore` прошла бы мимо компилятора
 * молча (аудит 10.08.2026).
 */
type ExpiresIn = SignOptions["expiresIn"];

export interface AccessTokenPayload {
  sub: string;
  role: Role;
}

const ACCESS_SECRET = process.env.JWT_ACCESS_SECRET!;
const REFRESH_SECRET = process.env.JWT_REFRESH_SECRET!;
const ACCESS_TTL = process.env.JWT_ACCESS_TTL ?? "15m";
const REFRESH_TTL = process.env.JWT_REFRESH_TTL ?? "90d";

export function signAccessToken(payload: AccessTokenPayload): string {
  return jwt.sign(payload, ACCESS_SECRET, { expiresIn: ACCESS_TTL as ExpiresIn });
}

export function signRefreshToken(payload: { sub: string; sid: string }): string {
  return jwt.sign(payload, REFRESH_SECRET, { expiresIn: REFRESH_TTL as ExpiresIn });
}

/**
 * Тем же секретом подписаны и служебные короткие токены: промежуточный токен
 * входа до второго фактора (lib/pending-2fa.ts), ссылки на видео и файлы
 * (ниже). У всех у них есть поле `purpose`, у настоящего токена доступа — нет.
 *
 * Прежде проверялась только подпись, и промежуточный токен входа (в нём есть
 * `sub`) открывал любой маршрут API: второй фактор у директорских учёток не
 * защищал ничего, достаточно было пароля (найдено 23.09.2026).
 */
export function verifyAccessToken(token: string): AccessTokenPayload {
  const payload = jwt.verify(token, ACCESS_SECRET);
  if (
    typeof payload !== "object" ||
    payload === null ||
    "purpose" in payload ||
    typeof payload.sub !== "string" ||
    typeof (payload as { role?: unknown }).role !== "string"
  ) {
    throw new jwt.JsonWebTokenError("не токен доступа");
  }
  return payload as unknown as AccessTokenPayload;
}

export function verifyRefreshToken(token: string): { sub: string; sid: string } {
  return jwt.verify(token, REFRESH_SECRET) as { sub: string; sid: string };
}

/**
 * Ссылка «Скачать» на сырое видео объекта (31.08.2026) — раньше presigned-URL
 * R2 (самодостаточная ссылка со встроенной подписью, TTL 600с), которую браузер
 * открывает window.open() БЕЗ участия кода приложения (значит, без заголовка
 * Authorization — токен доступа лежит только в памяти JS, см. lib/api.ts).
 * Теперь то же самое своим коротким токеном: та же схема, тот же секрет
 * (ACCESS_SECRET уже используется для входа), но с собственным полем `purpose`,
 * чтобы обычный 15-минутный токен доступа нельзя было спутать с этим — не
 * уязвимость (у обладателя токена доступа и так есть полный доступ), а просто
 * чтобы код проверки был однозначным, а не "любой валидный токен подойдёт".
 */
export interface VideoDownloadTokenPayload {
  purpose: "video-download";
  videoId: string;
}

/**
 * Ссылка на скачивание сырого ролика.
 *
 * Десять минут по умолчанию — это срок для ссылки, по которой жмут прямо сейчас,
 * из открытой карточки. Ссылке, УШЕДШЕЙ В СООБЩЕНИЕ (монтажёру в Telegram), этого
 * мало: он открывает чат, когда освободился, а не когда бот написал, и получал бы
 * «ссылка недействительна» на ровном месте. Поэтому срок задаётся вызывающим, а
 * значение по умолчанию остаётся прежним — ничего не меняется там, где его не
 * передают.
 */
export function signVideoDownloadToken(videoId: string, expiresIn: string = "10m"): string {
  return jwt.sign({ purpose: "video-download", videoId } satisfies VideoDownloadTokenPayload, ACCESS_SECRET, {
    expiresIn: expiresIn as jwt.SignOptions["expiresIn"],
  });
}

export function verifyVideoDownloadToken(token: string, videoId: string): boolean {
  try {
    const payload = jwt.verify(token, ACCESS_SECRET) as VideoDownloadTokenPayload;
    return payload.purpose === "video-download" && payload.videoId === videoId;
  } catch {
    return false;
  }
}

/**
 * ДОСТУП К ЗАКРЫТЫМ ПОДКАТАЛОГАМ `/uploads` (К11, аудит безопасности 11.09.2026).
 *
 * `video/`, `automontage/`, `handoff/` раньше раздавались той же голой статикой,
 * что и фото объектов (app.ts: `express.static("/uploads", uploadsDir)`) — то
 * есть любой, кто узнал или подобрал путь, получал файл без единой проверки.
 * Для фото это осознанно и правильно (они и так публичны на сайте), но для этих
 * трёх — черновики монтажа и сырые исходники — нет.
 *
 * Полный `requireAuth` тут не подходит буквально: браузер не прикладывает
 * заголовок Authorization к `<video src>`/`<img src>`, поэтому «просто закрыть
 * роут правом» сломало бы ЛЮБОЙ показ этих файлов, включая внутренний, — не
 * только внешний. Поэтому путь подписывается сам, коротким токеном с истечением,
 * ТАМ, ГДЕ рождается ссылка (см. lib/crmPublicUrl.ts::publicUploadUrl и
 * middleware в app.ts, переписывающий такие пути в исходящем JSON) — а не там,
 * где её открывают.
 *
 * TTL сутки — с запасом на то, что вкладка с видео может быть открыта долго, но
 * не бессрочно: каждая перезагрузка страницы получает свежую подпись заново, а
 * значит долгий токен ничего не покупает, кроме лишнего риска, если утечёт.
 */
const MEDIA_TOKEN_TTL_SEC = 24 * 60 * 60;

export interface MediaAccessTokenPayload {
  purpose: "media-access";
  /** Путь ровно как он лежит в базе/строится модулем: "/uploads/video/xxx.mp4". */
  path: string;
}

export function signMediaToken(relPath: string, ttlSec: number = MEDIA_TOKEN_TTL_SEC): string {
  return jwt.sign({ purpose: "media-access", path: relPath } satisfies MediaAccessTokenPayload, ACCESS_SECRET, {
    expiresIn: ttlSec,
  });
}

export function verifyMediaToken(token: string, relPath: string): boolean {
  try {
    const payload = jwt.verify(token, ACCESS_SECRET) as MediaAccessTokenPayload;
    return payload.purpose === "media-access" && payload.path === relPath;
  } catch {
    return false;
  }
}

/** Парсит строки вида "30d"/"15m"/"12h"/"45s" в миллисекунды — для maxAge cookie. */
export function refreshTtlMs(): number {
  const match = /^(\d+)([smhd])$/.exec(REFRESH_TTL);
  if (!match) return 30 * 24 * 60 * 60 * 1000;
  const n = Number(match[1]);
  const unitMs = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2] as "s" | "m" | "h" | "d"];
  return n * unitMs;
}
