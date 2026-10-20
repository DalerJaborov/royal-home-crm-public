import { Router } from "express";
import fs from "node:fs";
import path from "node:path";
import rateLimit from "express-rate-limit";
import { prisma } from "../db.js";
import { decryptSecretSafe } from "../crypto.js";
import { secretsMatch } from "../lib/secretCompare.js";
import { whisperFilePath } from "../lib/telephony/whisperAudio.js";
import { logSystemError } from "../lib/systemError.js";

/**
 * ОТДАЧА ОЗВУЧЕННЫХ ПОДСКАЗОК СТАНЦИИ.
 *
 * Станция ходит сюда сама и забирает файлы к себе — тем же приёмом, что уже работает
 * для музыки ожидания (cron royalhome-audio-sync.sh). У CRM нет и не должно быть записи
 * на диск АТС: одна дыра в CRM не должна означать угнанную телефонию агентства.
 *
 * НО ЗДЕСЬ, В ОТЛИЧИЕ ОТ МУЗЫКИ, ЛЕЖАТ ИМЕНА КЛИЕНТОВ. Мелодия раздаётся публично
 * (`express.static("/uploads")`) и это безобидно; подсказка «Фаррух, харидор, манзил дар
 * Сомонӣ» — персональные данные агентства, и публичный адрес для неё недопустим.
 * Поэтому оба маршрута закрыты секретом (Settings.callWhisperStationToken), сверяемым
 * в постоянное время, а сами файлы лежат ВНЕ каталога статики (lib/telephony/whisperAudio.ts).
 *
 * ФОРМАТ МАНИФЕСТА — ПРОСТОЙ ТЕКСТ, а не JSON: его читает скрипт на самой АТС, где из
 * инструментов есть `curl`, `awk` и `sh`, а `jq` может не оказаться вовсе. Строка на файл:
 *   <имя файла> <отпечаток>
 * Отпечаток нужен станции, чтобы не скачивать заново то, что уже лежит.
 */

export const telephonyWhisperRouter = Router();

/**
 * Защита от перебора секрета. Станция ходит раз в минуту и в лимит не упирается; всё,
 * что бьётся чаще, — это подбор, и отвечать ему быстро незачем.
 */
const stationLimiter = rateLimit({
  windowMs: 60_000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
});

/** Заголовок, которым станция представляется. */
const TOKEN_HEADER = "x-whisper-token";

/**
 * Проверка секрета. Ответ на неверный токен — 404, а не 403: наличие самого маршрута
 * подтверждать посторонним незачем.
 */
async function stationAuthorized(headerValue: unknown): Promise<boolean> {
  const provided = typeof headerValue === "string" ? headerValue.trim() : "";
  if (!provided) return false;
  const settings = await prisma.settings.findUnique({
    where: { id: "singleton" },
    select: { callWhisperStationToken: true },
  });
  const expected = decryptSecretSafe(settings?.callWhisperStationToken ?? null);
  // Секрет не задан — маршрут закрыт для всех: пустой токен не должен открывать доступ.
  if (!expected) return false;
  return secretsMatch(provided, expected);
}

telephonyWhisperRouter.use(stationLimiter);

/**
 * Список того, что должно лежать на станции. Отсутствующее в этом списке станция у себя
 * удаляет — так уходят подсказки о клиентах, с которыми агентство больше не работает.
 */
telephonyWhisperRouter.get("/manifest", async (req, res) => {
  if (!(await stationAuthorized(req.headers[TOKEN_HEADER]))) return res.status(404).end();

  /**
   * ОБРЕЗАННЫЙ МАНИФЕСТ ОПАСНЕЕ ДЛИННОГО. Станция удаляет у себя всё, чего в списке
   * нет: не поместись часть строк — она стёрла бы живые подсказки и на следующем
   * заходе скачала их обратно. Карусель трафика, а файл пропадает ровно в тот момент,
   * когда по нему идёт звонок.
   *
   * Поэтому список собирается ЦЕЛИКОМ, страницами по курсору, а на случай базы, размер
   * которой мы сегодня не представляем, есть аварийный потолок — и если он сработал,
   * ответ честно помечается неполным (`X-Whisper-Complete: 0`), а скрипт на станции по
   * этому признаку НИЧЕГО НЕ УДАЛЯЕТ (docs/telephony-whisper.md).
   */
  const HARD_CAP = 50_000;
  const PAGE = 1000;
  const rows: { fileName: string; digest: string }[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await prisma.callWhisper.findMany({
      select: { id: true, fileName: true, digest: true },
      orderBy: { id: "asc" },
      take: PAGE,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    rows.push(...page.map((row) => ({ fileName: row.fileName, digest: row.digest })));
    if (page.length < PAGE || rows.length >= HARD_CAP) break;
    cursor = page[page.length - 1]!.id;
  }
  // Подсказки по приметам объекта (24.09.2026, lib/telephony/propertyWhisper.ts) —
  // тем же списком: станция не отличает их от подсказок о клиенте.
  let propertyCursor: string | undefined;
  while (rows.length < HARD_CAP) {
    const page: { id: string; fileName: string; digest: string }[] = await prisma.propertyWhisper.findMany({
      select: { id: true, fileName: true, digest: true },
      orderBy: { id: "asc" },
      take: PAGE,
      ...(propertyCursor ? { cursor: { id: propertyCursor }, skip: 1 } : {}),
    });
    rows.push(...page.map((row) => ({ fileName: row.fileName, digest: row.digest })));
    if (page.length < PAGE) break;
    propertyCursor = page[page.length - 1]!.id;
  }
  const complete = rows.length < HARD_CAP;
  if (!complete) {
    // Ветка «упёрлись в предел» — редкая и уже дорогая (страницы выбраны):
    // ждём запись, чтобы след в журнале не зависел от того, кто успел первым.
    await logSystemError(
      "telephony",
      `Список подсказок для станции упёрся в предел ${HARD_CAP} — станция получила неполный список ` +
        `и не будет удалять свои файлы (docs/telephony-whisper.md)`
    );
  }

  // Отметка «станция приходила» — по ней в Настройках видно, жив ли обмен. Пишем без
  // ожидания: задержать ответ станции ради строки статистики было бы неправильным
  // размениванием (она в это время держит соединение перед звонком).
  void prisma.settings
    .update({ where: { id: "singleton" }, data: { callWhisperFetchedAt: new Date() } })
    .catch(() => {
      // Настроек нет (первый запуск) либо база недоступна — обмен файлами от этого не
      // страдает, а без отметки времени интерфейс просто покажет «ещё не приходила».
    });

  res.setHeader("X-Whisper-Complete", complete ? "1" : "0");
  res.type("text/plain").send(rows.map((row) => `${row.fileName} ${row.digest}`).join("\n"));
});

/**
 * Сам файл. Имя берётся из манифеста, но проверяется по базе: путь собирается только из
 * того, что мы сами когда-то записали, — произвольное имя из запроса до файловой системы
 * не доходит.
 */
telephonyWhisperRouter.get("/file/:name", async (req, res) => {
  if (!(await stationAuthorized(req.headers[TOKEN_HEADER]))) return res.status(404).end();

  const row =
    (await prisma.callWhisper.findUnique({ where: { fileName: req.params.name }, select: { fileName: true } })) ??
    (await prisma.propertyWhisper.findUnique({ where: { fileName: req.params.name }, select: { fileName: true } }));
  // Имени нет в базе — обычная гонка с уборкой (removeStaleWhispers в
  // whisperSync.ts стирает СТРОКУ раньше файла), станция просто скачала
  // манифест до того, как подсказку убрали. Ничего не сломалось, писать
  // в журнал нечего — то же самое случится и на следующей минуте, когда
  // манифест уже не назовёт этот файл.
  if (!row) return res.status(404).end();

  const filePath = whisperFilePath(row.fileName, "wav");
  if (!fs.existsSync(filePath)) {
    /**
     * СТРОКА ЕСТЬ, ФАЙЛА НЕТ — это уже расхождение, а не обычная гонка выше:
     * манифест обещал станции файл, которого на диске не оказалось (docs/TASKS.md,
     * «файлы озвучки телефонии отдают 404»). logSystemError дедуплицирует
     * одинаковый текст сам (10 минут, см. lib/systemError.ts) — при частом опросе
     * станции (раз в минуту) это одна запись в журнале, а не одна на каждый заход.
     * Самоисправится: whisperFilesExist в whisperSync.ts на следующем проходе
     * синхронизации увидит отсутствие файла и переозвучит подсказку заново.
     */
    // `await`, а не `void`: это редкая ветка отказа (404 и так уже решён), ждать
    // её никому не больно, а без ожидания дедупликация logSystemError гоняется
    // наперегонки сама с собой — два подряд захода станции успевали записаться
    // обе, и тест «одна запись, а не на каждый заход» мигал.
    await logSystemError(
      "telephony",
      `Подсказка станции: файл ${row.fileName}.wav есть в базе CallWhisper, но не на диске — переозвучится следующим проходом синхронизации`
    );
    return res.status(404).end();
  }

  res.type("audio/wav");
  // root + basename, а не абсолютный путь целиком: в Express 5 у send больше нет
  // прежнего послабления «точка важна только в имени файла» — теперь ЛЮБОЙ сегмент
  // пути, начинающийся с точки, даёт 404 (dotfiles: "ignore"). Корень при этой
  // форме вызова не проверяется вовсе, проверяется только имя файла — ровно та
  // защита, которая здесь и нужна.
  res.sendFile(path.basename(filePath), { root: path.dirname(filePath) });
});
