import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { dushanbeStartOfToday } from "./dushanbeTime.js";
import { prisma } from "../db.js";
import { logSystemError } from "./systemError.js";
import { describeError } from "./describeError.js";

/**
 * Хранилище файлов, которые НЕЛЬЗЯ отдавать по прямой ссылке.
 *
 * Папка `uploads` раздаётся статикой без всякой проверки (app.ts: express.static),
 * и это правильно для фотографий объектов — их и так видит весь сайт. Но фото и
 * голосовые, которые клиент прислал в личную переписку, так отдавать нельзя: по
 * требованию владельца их открывают только админ и директор. Поэтому отдельная
 * папка ВНЕ uploads и выдача только через маршрут с проверкой права.
 */
/**
 * Каталог считается ПРИ КАЖДОМ обращении, а не один раз при загрузке модуля
 * (22.09.2026). Раньше значение бралось на импорте, и прогон тестов (сотни
 * файлов в одном процессе) ломался тихо: тот, кто загрузил модуль первым,
 * фиксировал каталог для всех остальных — тест уборки чистил чужую папку и
 * «удалял 0 файлов». В проде переменная задаётся один раз и не меняется, так
 * что накладных расходов это не добавляет, зато класс поломок исчезает.
 */
function privateDirName(): string {
  return path.resolve(process.env.PRIVATE_UPLOADS_DIR ?? "./uploads-private");
}

function privateDirPath(): string {
  const dir = privateDirName();
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Расширение по типу содержимого — чтобы файл открывался в браузере и плеере. */
const EXT_BY_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "audio/ogg": "ogg",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/wav": "wav",
  "audio/webm": "webm",
  // Видео и документы от клиентов (messengers/attachments.ts: VIDEO_TYPES,
  // DOCUMENT_TYPES). С 16.08.2026 их передавали сюда, но строк не было —
  // savePrivateFile возвращал null, и присланный рум-тур/PDF молча выбрасывался
  // целиком (найдено 21.09.2026). Байты тех файлов не сохранились нигде.
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  // Тот же «webm», что у голосовых выше. Обратный поиск privateMimeType берёт
  // ПЕРВОЕ совпадение, то есть audio/webm: голосовые (их большинство) отдаются как
  // раньше, а видео в WebM браузер всё равно опознаёт по содержимому контейнера.
  "video/webm": "webm",
  "video/3gpp": "3gp",
  "video/mpeg": "mpeg",
  "application/pdf": "pdf",
  "text/plain": "txt",
};

/**
 * Имя файла, который сгенерировали МЫ САМИ: uuid + расширение из справочника выше.
 * Используется дважды и оба раза как рубеж безопасности — на выдаче (чтобы имя из
 * URL не увело чтение за пределы папки) и на уборке (чтобы удалять только своё).
 */
const OWN_NAME_RE = /^[0-9a-f-]{36}\.[a-z0-9]{2,4}$/i;

/**
 * Запись — асинхронная (аудит 23.09.2026, №89). Вложения бывают до 16 МБ (видео
 * рум-тура), и `writeFileSync` держал весь процесс API на время записи: ни
 * запросов, ни живых обновлений, ни событий телефонии. На медленном диске —
 * заметные рывки у всех сразу.
 */
export async function savePrivateFile(data: Buffer, mimeType: string): Promise<string | null> {
  return writeOwnFile(privateDirName(), data, mimeType);
}

/**
 * ГОЛОСОВЫЕ ЗАМЕТКИ СОТРУДНИКОВ — В СВОЙ ПОДКАТАЛОГ (G2, 02.10.2026).
 *
 * Заметки (причина отказа, заморозки, заявки на удаление, итог разговора)
 * лежали в общей папке с вложениями переписки, и ночная уборка стирала их через
 * 180 дней наравне с одноразовыми фото из чатов — ссылка в карточке тихо
 * становилась «файл не найден». Уборка обходит только верхний уровень папки
 * (см. cleanupPrivateFiles: «без recursive»), поэтому подкаталог она не трогает
 * вовсе, а том и бэкап у него те же, что у остального закрытого хранилища.
 * Ссылка `/me/voice-notes/<имя>` не меняется — меняется только место на диске.
 */
const VOICE_NOTES_SUBDIR = "voice-notes";

function voiceNotesDirName(): string {
  return path.join(privateDirName(), VOICE_NOTES_SUBDIR);
}

export async function saveVoiceNoteFile(data: Buffer, mimeType: string): Promise<string | null> {
  return writeOwnFile(voiceNotesDirName(), data, mimeType);
}

/**
 * Путь к голосовой заметке: сперва подкаталог заметок, затем — для записанных
 * до 02.10.2026 — верхний уровень общей папки. `legacy: true` значит, что файл
 * лежит рядом с вложениями переписки и вызывающий обязан убедиться, что это не
 * вложение (routes/me.ts).
 */
export function voiceNoteFilePath(name: string): { path: string; legacy: boolean } | null {
  if (!OWN_NAME_RE.test(name)) return null;
  const dir = voiceNotesDirName();
  const full = path.join(dir, name);
  if (path.dirname(path.resolve(full)) === path.resolve(dir) && fs.existsSync(full)) {
    return { path: full, legacy: false };
  }
  const old = privateFilePath(name);
  return old ? { path: old, legacy: true } : null;
}

/**
 * Переносит в подкаталог заметок те файлы верхнего уровня, на которые ссылается
 * хоть одна колонка голосовых заметок, — заметки, записанные до 02.10.2026.
 * Зовётся ночью ПЕРЕД уборкой (cron.ts); бросает — уборка в эту ночь не идёт.
 * Имя, найденное в переписке, не переносится: вложение клиента не должно стать
 * «заметкой», которую маршрут заметок отдаёт любому сотруднику.
 */
export async function adoptReferencedVoiceNotes(): Promise<{ moved: number }> {
  // Все колонки, куда формы кладут ссылку на заметку. Новая колонка с заметкой —
  // строка сюда, иначе её файлы, записанные до 02.10.2026, уборка не пощадит.
  const prefix = "/me/voice-notes/";
  const like = { startsWith: prefix };
  const lists = await Promise.all([
    prisma.interaction.findMany({ where: { voiceNoteUrl: like }, select: { voiceNoteUrl: true } }).then((r) => r.map((x) => x.voiceNoteUrl)),
    prisma.agent.findMany({ where: { frozenReasonVoiceUrl: like }, select: { frozenReasonVoiceUrl: true } }).then((r) => r.map((x) => x.frozenReasonVoiceUrl)),
    prisma.problemReport.findMany({ where: { notesVoiceUrl: like }, select: { notesVoiceUrl: true } }).then((r) => r.map((x) => x.notesVoiceUrl)),
    prisma.clientDeleteRequest.findMany({ where: { commentVoiceUrl: like }, select: { commentVoiceUrl: true } }).then((r) => r.map((x) => x.commentVoiceUrl)),
    prisma.propertyDeleteRequest.findMany({ where: { commentVoiceUrl: like }, select: { commentVoiceUrl: true } }).then((r) => r.map((x) => x.commentVoiceUrl)),
    prisma.jobApplication.findMany({ where: { rejectionReasonVoiceUrl: like }, select: { rejectionReasonVoiceUrl: true } }).then((r) => r.map((x) => x.rejectionReasonVoiceUrl)),
    prisma.property.findMany({ where: { reviewRejectionVoiceUrl: like }, select: { reviewRejectionVoiceUrl: true } }).then((r) => r.map((x) => x.reviewRejectionVoiceUrl)),
  ]);
  const names = new Set<string>();
  for (const url of lists.flat()) {
    const name = url?.slice(prefix.length) ?? "";
    if (OWN_NAME_RE.test(name)) names.add(name);
  }
  let moved = 0;
  const top = privateDirName();
  const dest = voiceNotesDirName();
  for (const name of names) {
    const from = path.join(top, name);
    if (!fs.existsSync(from)) continue;
    if (await isConversationAttachment(name)) continue;
    await fs.promises.mkdir(dest, { recursive: true });
    await fs.promises.rename(from, path.join(dest, name));
    moved++;
  }
  return { moved };
}

async function writeOwnFile(dir: string, data: Buffer, mimeType: string): Promise<string | null> {
  // MediaRecorder в браузере отдаёт "audio/webm;codecs=opus", а не голое
  // "audio/webm" — точное совпадение по всей строке ничего не находило, и
  // голосовая заметка молча не сохранялась бы (02.09.2026).
  const ext = EXT_BY_MIME[mimeType.split(";")[0].trim()];
  if (!ext) return null;
  const name = `${randomUUID()}.${ext}`;
  try {
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.writeFile(path.join(dir, name), data);
    return name;
  } catch (err) {
    /**
     * ОТКАЗ ДИСКА ОБЯЗАН БЫТЬ ВИДЕН, ХОТЯ ФАЙЛ И ПРАВДА РОНЯЕМ.
     *
     * Пустой `catch` здесь означал, что «не тот формат» и «кончилось место»
     * выглядят для вызывающего ОДИНАКОВО — как `null`. Ронять файл при отказе
     * диска решено сознательно (см. storeFetchedAttachments: реплика клиента
     * важнее вложения), и это поведение не меняется. Но молчать об этом нельзя:
     * на полном диске молча пропадали бы ВСЕ фото и голосовые всех клиентов
     * подряд, а наружу это выходило бы как «неподдерживаемый формат аудио» —
     * сообщение, уводящее в сторону от настоящей причины.
     *
     * Неподдерживаемый MIME (возврат выше) в журнал не пишется намеренно: это
     * не сбой, а нормальный ответ на то, что прислал человек.
     */
    void logSystemError(
      "api",
      `Вложение не сохранилось в закрытое хранилище (${mimeType}): ${describeError(err)}`
    );
    return null;
  }
}

/**
 * Полный путь к файлу по имени из переписки.
 *
 * Имя приходит из URL, поэтому проверяем его строго: только то, что мы сами
 * сгенерировали (uuid и расширение). Без этого «..%2F..%2Fetc%2Fpasswd» увёл бы
 * чтение за пределы папки — классический обход пути.
 */
export function privateFilePath(name: string): string | null {
  if (!OWN_NAME_RE.test(name)) return null;
  const privateDir = privateDirPath();
  const full = path.join(privateDir, name);
  // Второй рубеж на случай, если регулярное выражение однажды ослабят.
  if (path.dirname(path.resolve(full)) !== privateDir) return null;
  return fs.existsSync(full) ? full : null;
}

export function privateMimeType(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  const found = Object.entries(EXT_BY_MIME).find(([, e]) => e === ext);
  return found ? found[0] : "application/octet-stream";
}

/**
 * Какому клиенту принадлежит вложение — по имени файла (К7, аудит безопасности
 * 11.09.2026).
 *
 * Ссылка на файл живёт ВНУТРИ реплики (jsonb `messages`) одной из трёх таблиц
 * диалога — своей таблицы «вложения» в базе нет (см. комментарий в
 * routes/attachments.ts, почему раньше это было осознанным ограничением). Имя
 * файла — наш собственный uuid, случайное совпадение с чужим сообщением
 * исключено, поэтому текстовый поиск `"file":"<uuid>.<ext>"` внутри jsonb
 * однозначно называет диалог, а через него — клиента.
 *
 * Три таблицы, а не одна: BotConversation (Instagram/Facebook/WhatsApp через
 * бот-платформу), TelegramConversation (личка с ботом), TelegramDirectConversation
 * (Telegram Direct Messages канала) — вложение может прийти по любому каналу.
 *
 * null — файл не нашёлся ни в одном диалоге (диалог удалён, вложение из другого
 * механизма) ЛИБО диалог ни к какому клиенту не привязан. И то и другое трактуется
 * вызывающим как «владельца установить нельзя» — то есть закрыто всем, кроме
 * `clients.viewAll`, а не наоборот.
 */
export async function findAttachmentOwnerClientId(name: string): Promise<string | null> {
  if (!OWN_NAME_RE.test(name)) return null;
  // Пробел после двоеточия — НЕ опечатка: `jsonb::text` в Postgres печатает поля
  // как `"file": "..."`, с пробелом, а не как `JSON.stringify` в JS-коде, который
  // это значение когда-то записал (`"file":"..."`, без пробела). Без пробела
  // запрос никогда ничего не находил — поймано на собственном тесте.
  const needle = `%"file": "${name}"%`;

  const bot = await prisma.$queryRaw<{ clientId: string | null }[]>`
    SELECT "clientId" FROM "BotConversation"
    WHERE "clientId" IS NOT NULL AND messages::text LIKE ${needle}
    LIMIT 1`;
  if (bot[0]?.clientId) return bot[0].clientId;

  const tg = await prisma.$queryRaw<{ clientId: string | null }[]>`
    SELECT "clientId" FROM "TelegramConversation"
    WHERE "clientId" IS NOT NULL AND messages::text LIKE ${needle}
    LIMIT 1`;
  if (tg[0]?.clientId) return tg[0].clientId;

  const tgd = await prisma.$queryRaw<{ clientId: string | null }[]>`
    SELECT "clientId" FROM "TelegramDirectConversation"
    WHERE "clientId" IS NOT NULL AND messages::text LIKE ${needle}
    LIMIT 1`;
  if (tgd[0]?.clientId) return tgd[0].clientId;

  return null;
}

/**
 * Лежит ли файл вложением в каком-нибудь диалоге — с клиентом или без.
 *
 * Голосовые заметки сотрудников и вложения клиентов делят одно закрытое
 * хранилище и один вид имени. Маршрут голосовых заметок (routes/me.ts) пускает
 * любого сотрудника, поэтому вложения из переписки он отдавать не должен: у них
 * свой маршрут с правом и сверкой владельца (routes/attachments.ts).
 */
export async function isConversationAttachment(name: string): Promise<boolean> {
  if (!OWN_NAME_RE.test(name)) return false;
  const needle = `%"file": "${name}"%`;
  const rows = await prisma.$queryRaw<{ found: number }[]>`
    SELECT 1 AS found FROM "BotConversation" WHERE messages::text LIKE ${needle}
    UNION ALL
    SELECT 1 FROM "TelegramConversation" WHERE messages::text LIKE ${needle}
    UNION ALL
    SELECT 1 FROM "TelegramDirectConversation" WHERE messages::text LIKE ${needle}
    LIMIT 1`;
  return rows.length > 0;
}

/**
 * СРОК ХРАНЕНИЯ вложений переписки — 180 суток.
 *
 * Почему вообще удаляем: до сих пор отсюда не удалялся ни один файл. Папка росла
 * только вверх, и на боевом сервере это кончается переполнением диска — причём
 * молча и в тот момент, когда его меньше всего ждут.
 *
 * Почему именно 180:
 * — Переписка в CRM обрезается до 40 последних реплик (MAX_STORED_MESSAGES в
 *   messengers/conversation.ts). Ссылка на файл живёт ВНУТРИ реплики, поэтому в
 *   живом диалоге старые вложения становятся недостижимы задолго до этого срока —
 *   реплика с ними просто вытесняется из хвоста.
 * — Технические журналы (AiLog, ErrorLog) живут 90 суток. Присланное клиентом —
 *   не служебный шум, ему разумно дать вдвое больше.
 * — Полгода перекрывают цикл сделки с недвижимостью: фото и голосовое старше этого
 *   срока относятся к разговору, который давно закрылся тем или иным образом.
 *
 * Удаление НЕОБРАТИМО, поэтому правила жёсткие и все до одного проверяются тестами:
 * только эта папка, только её верхний уровень, только обычные файлы, только с нашими
 * же именами, только по возрасту и не больше потолка за один проход.
 */
const RETENTION_DAYS = 180;

/**
 * Потолок удалений за один проход. Уборка идёт каждую ночь, поэтому накопленный
 * хвост всё равно разберётся за несколько ночей, зато ошибка в условиях не сможет
 * снести хранилище целиком за один раз: наутро будет видно и что удалилось, и что нет.
 */
const MAX_DELETIONS_PER_RUN = 500;

export interface PrivateFilesCleanupResult {
  deleted: number;
  /** Осмотрено и оставлено: свежие, чужие имена, каталоги, ссылки. */
  kept: number;
  /** Файл подходил под удаление, но не удалился (права, занят) — виден в журнале. */
  failed: number;
  /** Потолок за проход исчерпан, остаток уйдёт следующей ночью. */
  capped: boolean;
}

/**
 * Удаляет из закрытого хранилища файлы старше RETENTION_DAYS.
 *
 * Каталог НЕ ПАРАМЕТР — намеренно: убирать можно только там, куда сами и пишем,
 * и передать сюда другой путь нельзя даже по ошибке (за пределами тестов, где
 * PRIVATE_UPLOADS_DIR задаётся до загрузки модуля, как и в проде).
 *
 * `maxDeletions` умеет только ПОНИЗИТЬ потолок — поднять его вызовом невозможно.
 *
 * Функция синхронная, как и остальной модуль: она работает раз в сутки глубокой
 * ночью, и ради неё городить асинхронный обход не за чем.
 */
export function cleanupPrivateFiles(options?: { maxDeletions?: number }): PrivateFilesCleanupResult {
  const result: PrivateFilesCleanupResult = { deleted: 0, kept: 0, failed: 0, capped: false };
  const cap = Math.max(0, Math.min(options?.maxDeletions ?? MAX_DELETIONS_PER_RUN, MAX_DELETIONS_PER_RUN));

  // Граница — начало суток ПО ДУШАНБЕ минус срок хранения, а не «ровно 180×24 часа
  // назад». Контейнер живёт в UTC, и скользящий момент делал бы границу зависящей
  // от того, в котором часу запустилась задача. Так граница объяснима словами:
  // «удаляем всё, что старше начала того дня». Заодно это чуть консервативнее —
  // файл живёт на несколько часов дольше, а не меньше.
  const cutoffMs = dushanbeStartOfToday().getTime() - RETENTION_DAYS * 24 * 60 * 60 * 1000;

  let entries: fs.Dirent[];
  try {
    // Без recursive: вложенных каталогов мы не создаём, и заходить внутрь чего-то,
    // что там появилось не от нас, уборка не должна тем более.
    entries = fs.readdirSync(privateDirPath(), { withFileTypes: true });
  } catch (err) {
    console.error("[uploads-private] каталог не прочитан:", err instanceof Error ? err.message : err);
    return result;
  }

  for (const entry of entries) {
    if (result.deleted >= cap) {
      result.capped = true;
      break;
    }

    // 1. Только обычные файлы. Каталоги и символические ссылки не трогаем вовсе:
    //    ссылка увела бы удаление наружу, а каталог — не наш объект.
    if (!entry.isFile()) {
      result.kept++;
      continue;
    }

    // 2. Только имена, которые сгенерировали мы сами. Всё остальное, что могло
    //    оказаться в папке (чужой файл, ручная копия, бэкап), не наше дело.
    if (!OWN_NAME_RE.test(entry.name)) {
      result.kept++;
      continue;
    }

    // 3. Итоговый путь обязан лежать НЕПОСРЕДСТВЕННО в нашей папке. Проверка
    //    дублирует предыдущую и стоит здесь именно поэтому: если правило имени
    //    однажды ослабят, этот рубеж останется.
    const full = path.join(privateDirPath(), entry.name);
    if (path.dirname(path.resolve(full)) !== privateDirPath()) {
      result.kept++;
      continue;
    }

    let stat: fs.Stats;
    try {
      // lstat, а не stat: он не идёт по ссылке. Возраст берём у самого объекта.
      stat = fs.lstatSync(full);
    } catch {
      // Файл исчез между чтением каталога и проверкой — обычное дело, не ошибка.
      result.kept++;
      continue;
    }
    if (!stat.isFile()) {
      result.kept++;
      continue;
    }

    // 4. Возраст. mtime — момент записи: файл пишется один раз и больше не меняется.
    if (stat.mtimeMs >= cutoffMs) {
      result.kept++;
      continue;
    }

    try {
      fs.unlinkSync(full);
      result.deleted++;
    } catch (err) {
      // Один неудалённый файл не повод бросать проход: остальные всё равно надо убрать.
      result.failed++;
      console.error(`[uploads-private] файл ${entry.name} не удалён:`, err instanceof Error ? err.message : err);
    }
  }

  return result;
}
