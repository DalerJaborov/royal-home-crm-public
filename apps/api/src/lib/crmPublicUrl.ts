import { signMediaToken } from "../auth/jwt.js";

/**
 * Публичный адрес самой CRM — тот, по которому её файлы из `/uploads` видны СНАРУЖИ.
 *
 * Внутри CRM ссылка на фотографию объекта относительная («/uploads/xxx.jpg») — браузеру
 * этого хватает, а внешнему получателю нет. Сайт royalhome.tj уже получает фотографии
 * абсолютными адресами (lib/siteSync.ts), и Meta требует того же: отправляя клиенту фото,
 * мы даём ссылку, а картинку по ней Meta забирает сама, со своих серверов.
 *
 * Папка `uploads` раздаётся статикой без всякой проверки (app.ts) — именно поэтому такая
 * ссылка вообще работает: фотографии объектов и так открыты на сайте. Личная переписка
 * лежит в другом месте и наружу так не отдаётся (lib/privateFiles.ts).
 *
 * Вынесено в отдельный модуль, чтобы адрес собирался ОДНИМ способом: до этого он жил
 * приватной константой в siteSync.ts, и второй потребитель неизбежно завёл бы свою копию
 * с чуть другой обработкой хвостового слэша.
 *
 * Окружение читается лениво, а не константой при загрузке модуля: иначе значение
 * замирает на момент первого импорта, и подменить его в тесте невозможно.
 */

/** Адрес CRM без хвостового слэша либо undefined, если он не настроен. */
export function crmPublicBase(): string | undefined {
  const raw = process.env.CRM_PUBLIC_URL?.trim();
  return raw ? raw.replace(/\/+$/, "") : undefined;
}

/**
 * Адрес самого приложения CRM (не файлов из `/uploads` — см. crmPublicBase выше,
 * это разные вещи: тот адрес отдаёт статику, этот — куда возвращать браузер после
 * стороннего OAuth-согласия). Вынесено сюда 17.09.2026 ради TikTok OAuth
 * callback (redirect_uri); прежний хозяин — вход по ключу устройства
 * (lib/passkeys.ts) — удалён 28.09.2026 решением владельца.
 *
 * CORS_ORIGIN — тот же самый адрес CRM, он уже задан на сервере (CRM_ORIGIN в
 * docker-compose.prod.yml). Список через запятую (несколько разрешённых
 * источников) — берём первый.
 */
export function publicAppUrl(): string {
  const raw = process.env.PUBLIC_APP_URL ?? process.env.CORS_ORIGIN ?? "http://localhost:5173";
  return raw.split(",")[0].trim();
}

/**
 * Абсолютный адрес нашего файла из `/uploads`; null — адрес CRM не настроен либо путь
 * не наш.
 *
 * Путь приходит из базы, но проверяется всё равно: превращать в «нашу публичную ссылку»
 * произвольную строку нельзя — так наружу уходит ссылка куда угодно, а мы за неё ручаемся.
 */
/**
 * Подкаталоги, закрытые от прямой статики (К11, аудит безопасности 11.09.2026,
 * см. app.ts — гейт перед express.static, и auth/jwt.ts::signMediaToken).
 * Фото объектов и остальное под `/uploads` — по-прежнему открыты как были: они
 * и так публичны на сайте, подписывать их нечем и незачем.
 */
const SIGNED_UPLOAD_PREFIXES = ["/uploads/video/", "/uploads/automontage/", "/uploads/handoff/"];

export function publicUploadUrl(uploadPath: string): string | null {
  const base = crmPublicBase();
  if (!base) return null;
  if (!uploadPath.startsWith("/uploads/") || uploadPath.includes("..")) return null;
  if (SIGNED_UPLOAD_PREFIXES.some((prefix) => uploadPath.startsWith(prefix))) {
    return `${base}${uploadPath}?t=${signMediaToken(uploadPath)}`;
  }
  return `${base}${uploadPath}`;
}
