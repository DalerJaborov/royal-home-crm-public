import { randomBytes, randomUUID } from "node:crypto";
import { prisma } from "../../db.js";
import {
  CALL_WHISPER_INCOMING_PARTS,
  CALL_WHISPER_LANGUAGE,
  CALL_WHISPER_OUTGOING_PARTS,
  CALL_WHISPER_VOICE,
} from "../settingsConstants.js";
import { logSystemError } from "../systemError.js";
import { describeError } from "../describeError.js";
import { loadAmiCredentials } from "./amiClient.js";
import { stationHasContext } from "./dialplanContext.js";
import { removeWhisperFiles, whisperFilesExist, WHISPER_TTS_MODEL, WhisperQuotaPausedError } from "./whisperAudio.js";
import { ttsQuotaPausedUntil } from "../../ai/tts.js";
import { assembleWhisper, whisperPiecesOnCooldown } from "./whisperClips.js";
import {
  buildWhisperParts,
  buildWhisperText,
  resolveWhisperLanguage,
  whisperDigest,
  type WhisperDirection,
  type WhisperLanguage,
  type WhisperSource,
} from "./whisperText.js";

/**
 * КТО ПОЛУЧАЕТ ОЗВУЧЕННУЮ ПОДСКАЗКУ, КОГДА ОНА ПЕРЕОЗВУЧИВАЕТСЯ И КОГДА ИСЧЕЗАЕТ.
 *
 * Работа фоновая и НЕ на пути звонка: в момент разговора файл обязан уже лежать на
 * станции. Крон проходит пачкой, сравнивает отпечаток каждой карточки с озвученным и
 * трогает только расхождения — иначе агентство переозвучивало бы всю базу каждый прогон,
 * а это деньги за синтез и лишний трафик на АТС.
 *
 * КОМУ ФАЙЛ НЕ НУЖЕН (и потому не создаётся):
 *  - у клиента нет ответственного — его звонок идёт оператору, а не агенту;
 *  - сделка закрыта, клиент потерян или в архиве — такие звонки агенту не переводятся;
 *  - карточка в Корзине;
 *  - у ответственного в карточке стоит «не играть мне» (Agent.whisperLanguage = "off").
 * Во всех этих случаях уже озвученный файл УДАЛЯЕТСЯ — и с диска CRM, и (следующим
 * заходом станции) с диска АТС. Имя клиента не должно лежать на станции дольше, чем
 * агентство с этим клиентом работает.
 */

/** Статусы, при которых звонок агенту не переводится (тот же список, что в decideRoute). */
const CLOSED_STATUSES = ["DEAL_CLOSED", "LOST", "ARCHIVED"] as const;

/**
 * Сколько подсказок озвучиваем за один проход крона. Ограничение не про нагрузку на нас,
 * а про внешний сервис: синтез речи — платный вызов с лимитом в минуту, и упереться в
 * него первым же прогоном на большой базе значит получить пачку отказов вместо файлов.
 */
const BATCH_LIMIT = 20;

/** Имя файла на диске АТС. СЛУЧАЙНОЕ: по имени файла не должно читаться, чей это клиент. */
function newFileName(): string {
  return `rh${randomBytes(8).toString("hex")}`;
}

/**
 * Сколько карточек читаем за проход и ГДЕ ОСТАНОВИЛИСЬ В ПРОШЛЫЙ РАЗ.
 *
 * Раньше проход брал «500 самых свежих по последнему контакту». На сегодняшних
 * полусотне клиентов разницы нет, но порядок этой выборки устойчив: карточка
 * номер 501 не «озвучилась бы позже» — она не озвучилась бы НИКОГДА, потому что
 * каждый следующий проход брал бы те же 500. Агент просто не слышал бы подсказку и
 * не знал почему — тихая поломка, которая ждала бы роста базы.
 *
 * Теперь база прокручивается по кругу курсором: проход берёт следующие PAGE карточек
 * от последней виденной, дошёл до конца — начинает сначала. Сколько бы карточек ни
 * стало, каждая рано или поздно оказывается в окне.
 */
const PAGE = 200;
let scanCursor: string | null = null;
/**
 * НОВЫЙ ПРОЦЕСС НАЧИНАЕТ ОБХОД СО СЛУЧАЙНОГО МЕСТА (E12 глубокой проверки
 * 02.10.2026). Курсор живёт в памяти worker, а worker перезапускается на каждом
 * выкате — два десятка раз в день. С курсором от начала базы каждый выкат
 * возвращал обход к первым id, и карточки в конце порядка до окна почти не
 * доходили. Случайная точка старта (id — uuid) делает охват равномерным при
 * любой частоте выкатов, без отдельной таблицы под курсор.
 */
let scanFromRandomStart = true;

/** Только для тестов: начать обход базы заново, с самого начала. */
export function resetWhisperScan(): void {
  scanCursor = null;
  scanFromRandomStart = false;
}

export interface WhisperSyncResult {
  rendered: number;
  removed: number;
  failed: number;
}

/** Настройки подсказки в одном месте — читаются один раз на проход. */
interface WhisperSettings {
  enabled: boolean;
  incoming: boolean;
  outgoing: boolean;
  incomingParts: string[];
  outgoingParts: string[];
  language: string;
  voice: string;
  aiHint: boolean;
}

export async function loadWhisperSettings(): Promise<WhisperSettings> {
  const settings = await prisma.settings.findUnique({
    where: { id: "singleton" },
    select: {
      callWhisperEnabled: true,
      callWhisperIncoming: true,
      callWhisperOutgoing: true,
      callWhisperAiHint: true,
    },
  });
  return {
    enabled: settings?.callWhisperEnabled ?? false,
    incoming: settings?.callWhisperIncoming ?? true,
    outgoing: settings?.callWhisperOutgoing ?? false,
    // Состав озвучки, язык и голос — константы с 01.11.2026 (lib/settingsConstants.ts).
    incomingParts: [...CALL_WHISPER_INCOMING_PARTS],
    outgoingParts: [...CALL_WHISPER_OUTGOING_PARTS],
    language: CALL_WHISPER_LANGUAGE,
    voice: CALL_WHISPER_VOICE,
    aiHint: settings?.callWhisperAiHint ?? false,
  };
}

/** Клиент в том виде, в каком его читает синхронизация. */
type ClientRow = {
  id: string;
  fullName: string;
  kind: "BUYER" | "SELLER" | "OTHER";
  desiredType: "APARTMENT" | "HOUSE" | "COMMERCIAL" | "LAND" | null;
  desiredDistrict: { name: string } | null;
  budgetMin: unknown;
  budgetMax: unknown;
  currency: "USD" | "TJS";
  lastContactAt: Date;
  assignedAgent: { id: string; whisperLanguage: string | null } | null;
};

const CLIENT_PAGE_WHERE = {
  deletedAt: null,
  assignedAgentId: { not: null },
  status: { notIn: [...CLOSED_STATUSES] },
};

/** Очередная страница карточек, начиная от курсора. null — с начала базы. */
function loadClientPage(cursor: string | null): Promise<ClientRow[]> {
  return prisma.client.findMany({
    where: CLIENT_PAGE_WHERE,
    select: {
      id: true,
      fullName: true,
      kind: true,
      desiredType: true,
      desiredDistrict: { select: { name: true } },
      budgetMin: true,
      budgetMax: true,
      currency: true,
      lastContactAt: true,
      assignedAgent: { select: { id: true, whisperLanguage: true } },
    },
    orderBy: { id: "asc" },
    take: PAGE,
    // Строго после курсора. Не Prisma-`cursor`: тот требует, чтобы строка-курсор
    // существовала, а точка старта нового процесса — случайный uuid.
    ...(cursor ? { where: { ...CLIENT_PAGE_WHERE, id: { gt: cursor } } } : {}),
  });
}

/** Decimal из Prisma — не число: `Number()` на нём честнее, чем неявное приведение. */
function toNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function toSource(client: ClientRow, promisedAt: Date | null, aiHint: string | null): WhisperSource {
  return {
    fullName: client.fullName,
    kind: client.kind,
    propertyType: client.desiredType,
    districtName: client.desiredDistrict?.name ?? null,
    budgetMin: toNumber(client.budgetMin),
    budgetMax: toNumber(client.budgetMax),
    currency: client.currency,
    lastContactAt: client.lastContactAt,
    promisedAt,
    aiHint,
  };
}

/**
 * Незакрытые договорённости пачкой, а не по клиенту.
 *
 * Запрос ОДИН на всю пачку намеренно: `await` внутри цикла по списку из базы — это
 * N+1, из-за которого проход крона по сотне карточек превращается в сотню запросов.
 */
async function loadPromises(clientIds: string[]): Promise<Map<string, Date>> {
  if (clientIds.length === 0) return new Map();
  const rows = await prisma.interaction.findMany({
    where: { clientId: { in: clientIds }, completedAt: null, nextActionDate: { not: null } },
    select: { clientId: true, nextActionDate: true },
    orderBy: { nextActionDate: "asc" },
  });
  const map = new Map<string, Date>();
  for (const row of rows) {
    // Первая по дате и есть ближайшая: сортировка уже сделана базой, а Map хранит
    // первое встреченное значение.
    if (row.nextActionDate && !map.has(row.clientId)) map.set(row.clientId, row.nextActionDate);
  }
  return map;
}

/** Направления, которые сейчас включены владельцем. */
function activeDirections(settings: WhisperSettings): WhisperDirection[] {
  const directions: WhisperDirection[] = [];
  if (settings.incoming) directions.push("in");
  if (settings.outgoing) directions.push("out");
  return directions;
}

function partsFor(settings: WhisperSettings, direction: WhisperDirection): string[] {
  return direction === "in" ? settings.incomingParts : settings.outgoingParts;
}

/**
 * Один проход: убрать лишнее, озвучить недостающее.
 *
 * Возвращает счётчики — они показываются в Настройках («готово N подсказок») и в
 * журнале крона, чтобы «почему у нового клиента нет подсказки» имело ответ.
 */
export async function syncWhispers(now: Date = new Date()): Promise<WhisperSyncResult> {
  const settings = await loadWhisperSettings();
  const result: WhisperSyncResult = { rendered: 0, removed: 0, failed: 0 };
  if (!settings.enabled) return result;

  const directions = activeDirections(settings);
  if (directions.length === 0) return result;

  // Кого озвучиваем в этот проход. Окно движется по базе курсором (см. PAGE выше):
  // порядок по id устойчив и не зависит от того, что происходит с карточками между
  // проходами, — а значит ни одна не может «застрять» вне окна навсегда.
  const startCursor = scanCursor ?? (scanFromRandomStart ? randomUUID() : null);
  scanFromRandomStart = false;
  let clients = await loadClientPage(startCursor);

  // Круг замкнулся (или случайная точка старта пришлась за последний id) —
  // начинаем базу заново с начала.
  if (clients.length === 0 && startCursor) {
    scanCursor = null;
    clients = await loadClientPage(null);
  }
  scanCursor = clients.length === PAGE ? (clients[clients.length - 1]?.id ?? null) : null;

  const promises = await loadPromises(clients.map((c) => c.id));
  const existing = await prisma.callWhisper.findMany({
    where: { clientId: { in: clients.map((c) => c.id) } },
  });
  const byKey = new Map(existing.map((row) => [`${row.clientId}:${row.direction}:${row.language}`, row]));

  /** Ключи, которые ДОЛЖНЫ существовать после прохода: всё остальное — мусор. */
  const wanted = new Set<string>();

  /**
   * КВОТА СИНТЕЗА КОНЧИЛАСЬ — ОЗВУЧИВАТЬ НЕ ПЫТАЕМСЯ (21.08.2026, найдено на проде).
   *
   * Крон ходит каждые пять минут по одним и тем же карточкам. Когда суточная квота
   * выжжена, каждая падала и заводила запись в журнале: двадцать одинаковых записей
   * каждые пять минут, 445 неразобранных к утру — и все про одну и ту же беду.
   *
   * Глушится ТОЛЬКО синтез: уборка устаревших подсказок ниже голоса не требует и
   * идёт как обычно, иначе на паузе копился бы мусор на станции.
   *
   * Пауза снимается сама, как только владелец добавит ключ из другого проекта Google
   * (см. ttsQuotaPausedUntil в ai/tts.ts) — ждать её конца не нужно.
   *
   * ПЕРЕМЕННАЯ, А НЕ КОНСТАНТА: квота может кончиться в середине пачки, и тогда флаг
   * поднимается прямо в цикле (ловим WhisperQuotaPausedError ниже). Одной проверки
   * перед циклом мало — именно так 22.08.2026 набирались сотни записей «не озвучилась»
   * на нормальных таджикских именах.
   */
  let voiceMuted = (await ttsQuotaPausedUntil(WHISPER_TTS_MODEL)) !== null;

  for (const client of clients) {
    const language = resolveWhisperLanguage(client.assignedAgent?.whisperLanguage, settings.language);
    // «off» у сотрудника или неизвестный язык — этому человеку не играем вовсе.
    if (!language) continue;

    for (const direction of directions) {
      const key = `${client.id}:${direction}:${language}`;
      wanted.add(key);
      if (voiceMuted) continue;
      if (result.rendered + result.failed >= BATCH_LIMIT) continue;

      const parts = partsFor(settings, direction);
      const source = toSource(client, promises.get(client.id) ?? null, null);
      const options = { language, direction, parts, now, voice: settings.voice };
      const text = buildWhisperText(source, options);
      // Озвучивать нечего — например, у карточки нет ни имени, ни вида. Молча
      // пропускаем: агент просто не услышит подсказки, звонок от этого не страдает.
      if (!text) continue;

      const digest = whisperDigest(source, options);
      const current = byKey.get(key);
      const pieces = buildWhisperParts(source, options);
      /**
       * ПОДСКАЗКА, СОБРАННАЯ БЕЗ ОДНОГО КУСКА, помечена в отпечатке как неполная
       * (22.08.2026). Она уже играет агенту и это лучше тишины, но пересобрать её
       * стоит — вдруг молчавший кусок озвучится. Не каждые пять минут: пока кусок
       * ждёт своей повторной попытки (см. whisperClips.ts), пересборка дала бы ровно
       * ту же неполную фразу и только отъедала бы место в пачке у остальных карточек.
       */
      const partialDigest = `${digest}:partial`;
      const cooling = whisperPiecesOnCooldown(pieces, language, settings.voice);
      // Синтез только что отказался читать всё, из чего состоит фраза, — пересобирать
      // нечего и писать в журнал нечего: об отказе уже написано один раз.
      if (cooling === pieces.length && pieces.length > 0) continue;
      const upToDate = current?.digest === digest || (current?.digest === partialDigest && cooling > 0);
      // Файл на диске проверяется отдельно от строки в базе: строка без файла означает,
      // что станции нечего забирать, и такую подсказку нужно озвучить заново.
      if (current && upToDate && (await whisperFilesExist(current.fileName))) continue;

      const fileName = current?.fileName ?? newFileName();
      try {
        /**
         * СОБИРАЕМ ИЗ КУСОЧКОВ, а не озвучиваем фразу целиком: синтез ограничен
         * суточной квотой (100 запросов на проект и модель), а словарь фразы конечен —
         * см. whisperClips.ts. Переозвучка после правки карточки почти всегда не
         * стоит ни одного запроса: все куски уже озвучены.
         */
        const { durationMs, skipped } = await assembleWhisper(pieces, {
          language,
          voice: settings.voice,
          fileName,
        });
        const storedDigest = skipped > 0 ? partialDigest : digest;
        await prisma.callWhisper.upsert({
          where: { clientId_direction_language: { clientId: client.id, direction, language } },
          create: { clientId: client.id, direction, language, digest: storedDigest, fileName, text, durationMs },
          update: { digest: storedDigest, fileName, text, durationMs },
        });
        result.rendered++;
      } catch (err) {
        /**
         * КВОТА КОНЧИЛАСЬ ПРЯМО В ЭТОМ ПРОХОДЕ — молчим до конца прохода и НЕ ПИШЕМ
         * ни строки. Проверка перед циклом ловит только квоту, кончившуюся раньше;
         * когда она кончалась в середине пачки, оставшиеся девятнадцать карточек
         * заводили девятнадцать записей «не озвучилась» на нормальных именах — ровно
         * это и составило сотни записей в журнале прода за 22.08.2026. Про саму квоту
         * ОДНУ запись уже сделал ai/tts.ts, второй раз повторять её незачем.
         */
        if (err instanceof WhisperQuotaPausedError) {
          voiceMuted = true;
          continue;
        }
        result.failed++;
        // Отказ синтеза — не повод останавливать проход: остальные карточки озвучатся,
        // а эта попробует ещё раз следующим заходом.
        await logSystemError(
          "telephony",
          `Подсказка агенту о клиенте не озвучилась: ${describeError(err)}`
        );
      }
    }
  }

  result.removed = await removeStaleWhispers(wanted, clients.map((c) => c.id));
  return result;
}

/**
 * Убрать подсказки, которых быть не должно: клиент закрыт, удалён, остался без агента,
 * сотрудник сменил язык или отказался от подсказок.
 *
 * ЧИСТИМ ТОЛЬКО ТЕХ, КОГО ВИДЕЛИ В ЭТОМ ПРОХОДЕ, плюс всех, чьих карточек больше нет.
 * Иначе предел выборки в 500 карточек означал бы «всё, что не попало в пачку, удалить» —
 * и подсказки стирались бы по кругу у половины базы.
 */
async function removeStaleWhispers(wanted: Set<string>, seenClientIds: string[]): Promise<number> {
  const rows = await prisma.callWhisper.findMany({
    where: { clientId: { in: seenClientIds } },
    select: { id: true, clientId: true, direction: true, language: true, fileName: true },
  });
  const stale = rows.filter((row) => !wanted.has(`${row.clientId}:${row.direction}:${row.language}`));

  // Карточки, которых не стало вовсе (удалены из базы, а не в Корзину): их строки
  // уходят каскадом при удалении клиента, но файлы на диске остаются — подбираем их.
  const orphans = await prisma.callWhisper.findMany({
    where: { client: { OR: [{ deletedAt: { not: null } }, { assignedAgentId: null }] } },
    select: { id: true, fileName: true },
  });

  const doomed = [...stale, ...orphans.filter((o) => !stale.some((s) => s.id === o.id))];
  if (doomed.length === 0) return 0;

  /**
   * СТРОКА В БАЗЕ ИСЧЕЗАЕТ ПЕРВОЙ, ФАЙЛ — ВТОРЫМ (docs/TASKS.md: «файлы озвучки
   * телефонии отдают 404», ~100 обращений станции за 20 часов).
   *
   * Раньше порядок был обратный: файл стирался с диска, и только потом —
   * строка в базе. Между этими двумя шагами GET /manifest (отдельный запрос
   * станции, независимый от этого прохода) читает базу «как есть» и ещё
   * видел удалённый файл в списке — станция шла за ним по GET /file/:name и
   * получала 404 на подсказку, которая по манифесту должна была существовать.
   * DELETE /:id/photos в routes/properties/photos.ts и trashProperty в
   * crud.ts используют тот же порядок «сперва база, потом диск» — здесь его
   * не было, хотя опасность та же.
   */
  await prisma.callWhisper.deleteMany({ where: { id: { in: doomed.map((row) => row.id) } } });
  await Promise.all(doomed.map((row) => removeWhisperFiles(row.fileName)));
  return doomed.length;
}

/**
 * Контекст диалплана для ИСХОДЯЩЕГО звонка с подсказкой: сначала играет справку агенту,
 * потом набирает клиента (номер приходит переменной RH_OUT_TARGET). Заводится на станции
 * руками один раз — docs/telephony-whisper.md.
 */
export const WHISPER_OUT_CONTEXT = "royalhome-agent-out";
/** Единственное расширение этого контекста; куда звонить, станция узнаёт из переменной. */
export const WHISPER_OUT_EXTEN = "call";

/**
 * Готовить ли исходящий звонок с подсказкой — и если да, с какой.
 *
 * Три условия, и все обязательны: возможность включена для исходящих, файл для этого
 * клиента и языка уже озвучен, контекст на станции существует. Хоть одно не выполнено —
 * возвращаем null, и звонок уходит ровно тем путём, каким уходил до 20.08.2026.
 *
 * ПОЧЕМУ ПРОВЕРЯЕМ КОНТЕКСТ. Originate в несуществующий контекст — это не «звонок без
 * подсказки», а несостоявшийся звонок: канал агента поднимется и тут же умрёт. Исходящий
 * звонок важнее любой подсказки, поэтому сомнение всегда решается в пользу старого пути.
 */
export async function outgoingWhisper(input: {
  clientId: string;
  agentWhisperLanguage: string | null | undefined;
}): Promise<{ fileName: string; context: string; exten: string } | null> {
  const fileName = await whisperFileForCall({
    clientId: input.clientId,
    agentWhisperLanguage: input.agentWhisperLanguage,
    direction: "out",
  });
  if (!fileName) return null;

  const creds = await loadAmiCredentials();
  // Управление станцией (AMI) не настроено — спросить про контекст нечем, и рисковать
  // исходящим звонком ради подсказки не станем.
  if (!creds) return null;
  // Подсказка необязательна: и честное «контекста нет», и «станция не ответила»
  // (см. dialplanContext.ts, 20.09.2026) здесь одинаково безопасны — молчим в ухо
  // агенту, звонок при этом идёт как обычно. Разбирать unknown отдельно тут незачем.
  const whisperContext = await stationHasContext(creds, WHISPER_OUT_CONTEXT);
  if (!("present" in whisperContext) || !whisperContext.present) return null;

  return { fileName, context: WHISPER_OUT_CONTEXT, exten: WHISPER_OUT_EXTEN };
}

/**
 * Какую подсказку играть в конкретном звонке. Возвращает имя файла на станции либо null.
 *
 * Вызывается НА ПУТИ ЗВОНКА, поэтому здесь ровно один запрос к базе и никакой генерации:
 * не готово — значит агент просто не услышит подсказку, а звонок пойдёт как обычно.
 */
export async function whisperFileForCall(input: {
  clientId: string;
  agentWhisperLanguage: string | null | undefined;
  direction: WhisperDirection;
}): Promise<string | null> {
  const settings = await loadWhisperSettings();
  if (!settings.enabled) return null;
  if (input.direction === "in" && !settings.incoming) return null;
  if (input.direction === "out" && !settings.outgoing) return null;

  const language: WhisperLanguage | null = resolveWhisperLanguage(input.agentWhisperLanguage, settings.language);
  if (!language) return null;

  const row = await prisma.callWhisper.findUnique({
    where: {
      clientId_direction_language: { clientId: input.clientId, direction: input.direction, language },
    },
    select: { fileName: true },
  });
  return row?.fileName ?? null;
}
