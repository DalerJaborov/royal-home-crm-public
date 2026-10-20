import crypto from "node:crypto";
import { Prisma, type Settings } from "../generated/prisma/client.js";
import { prisma } from "../db.js";

/**
 * ТОЧКИ ВОЗВРАТА НАСТРОЕК — снятие, сравнение, восстановление, срок хранения.
 *
 * Владелец просил кнопку «сбросить все настройки» на случай, когда что-то
 * настроено неверно и работать перестало. Сброса тут нет и не будет: «по
 * умолчанию» для строки Settings означает ПУСТО — без маркеров Instagram, ключей
 * Gemini, паролей АТС, адреса WebRTC и промта бота. Такая кнопка чинила бы одну
 * поломку ценой полной остановки каналов связи и телефонии.
 *
 * Вместо неё — история состояний. Ключевое требование сформулировал сам владелец:
 * «если сделать снимок, а потом кто-то испортит настройки и снова нажмёт кнопку —
 * вернёмся к испорченным?». С единственным слотом — да, испорченное затирает
 * исправное. Поэтому точек много, каждая со временем и автором, и испорченное
 * состояние ложится РЯДОМ, ничего не разрушая.
 */

/** Поля Settings, где лежат зашифрованные секреты (см. routes/settings.ts). */
export const SECRET_SETTINGS_FIELDS = [
  "anthropicApiKey",
  // Ключ OpenAI для обложек через ChatGPT (25.09.2026) — секрет, как и остальные ключи ИИ.
  "openaiApiKey",
  "geminiApiKey",
  "geminiApiKey2",
  "openaiApiKey",
  // Список дополнительных ключей: каждый элемент зашифрован так же, как ключ выше.
  // Без этой строки точка возврата отдавала бы наружу шифротексты целиком — второй
  // способ прочитать секрет, ровно тот, который здесь и закрывается.
  "geminiApiKeysExtra",
  "metaAppSecret",
  "metaVerifyToken",
  "metaWaToken",
  "metaIgToken",
  "metaIgAppSecret",
  "metaPageToken",
  "asteriskAriPassword",
  "asteriskAmiPassword",
  // Ниже — секреты, которых в списке не было (найдено 23.09.2026, когда сюда
  // добавлялся ключ СМС). routes/settings.ts прячет их из ответа, а точка
  // возврата показывала первые 80 знаков значения в «чем отличается»:
  // шифротекст, а googleBudgetToken — вообще открытым текстом. Страж —
  // tests/settings-snapshot-secrets.test.ts: любое поле Settings с «Token»,
  // «Secret», «Password» или «ApiKey» в имени обязано стоять здесь.
  "metaIgManageToken",
  "metaAdsToken",
  "googleBudgetToken",
  "youtubeClientSecret",
  // Ключ OpenAI для обложек (#953, 25.09.2026) пришёл без этой строки — страж
  // settings-snapshot-secrets краснел у всех правок сразу.
  "openaiApiKey",
  "youtubeRefreshToken",
  "tiktokClientSecret",
  "tiktokRefreshToken",
  "threadsAppSecret",
  "threadsAccessToken",
  "searchConsoleRefreshToken",
  "yandexWebmasterClientSecret",
  "yandexWebmasterRefreshToken",
  "callWhisperStationToken",
  "smsApiToken",
  "openaiApiKey",
  // Ключ фида каталога (G12, 02.10.2026): GET /settings отдаёт его только маской,
  // а «чем отличается» в точке возврата показывал целиком — страж ловил «ApiKey».
  "metaCatalogFeedKey",
  // Ключ ElevenLabs для живого голоса (02.10.2026).
  "elevenLabsApiKey",
] as const;

const SECRET_FIELD_SET: ReadonlySet<string> = new Set(SECRET_SETTINGS_FIELDS);

/**
 * ПОЛЯ, КОТОРЫЕ ПИШЕТ НЕ ЧЕЛОВЕК, А СИСТЕМА — точка возврата их не трогает
 * (G7, 02.10.2026). Возврат к прошлой неделе ради испорченного промта бота
 * заодно возвращал прошлонедельный курс доллара, ставил очередь монтажа на
 * паузу или снимал с неё и подменял ротированные маркеры TikTok/Threads/
 * Instagram/рекламы старыми — канал мог отвалиться. Это состояние мира, а не
 * выбор директора: в списке отличий его нет, при возврате оно остаётся как есть.
 */
export const SYSTEM_SETTINGS_FIELDS = [
  // An emergency shell kill switch must survive restoration of unrelated settings.
  // Rollout changes have a separate role gate and administrative endpoint.
  "uiShellRollout",
  // Курс обновляется сам (lib/exchangeRate.ts).
  "usdToTjsRate",
  "usdToTjsRateUpdatedAt",
  "usdToTjsRateSource",
  // Пауза очереди монтажа — оперативное состояние (lib/videoHandoff.ts).
  "videoHandoffQueuePaused",
  "videoHandoffQueuePausedAt",
  "videoHandoffQueuePausedById",
  "videoHandoffQueuePauseReason",
  // Маркеры, которые система продлевает и ротирует сама: старый — уже не рабочий.
  "tiktokRefreshToken",
  "threadsAccessToken",
  "threadsTokenExpiresAt",
  "metaIgToken",
  "metaIgTokenRefreshedAt",
  "metaAdsToken",
  "metaAdsTokenRefreshedAt",
  // Отметки «уже запускали» и найденное системой.
  "dailyStoriesLastRunAt",
  "digestLastRunAt",
  "metaAdsSyncedAt",
  "callWhisperFetchedAt",
  "metaWaBusinessAccountId",
] as const;

const SYSTEM_FIELD_SET: ReadonlySet<string> = new Set(SYSTEM_SETTINGS_FIELDS);

export function isSystemSettingsField(field: string): boolean {
  return SYSTEM_FIELD_SET.has(field);
}

/** Поля Settings со ссылкой на сотрудника (то же, что снимает lib/agentSettingsCleanup.ts). */
const STAFF_SINGLE_FIELDS = [
  "callbackOperatorAgentId",
  "videoMontajerAgentId",
  "videoModeratorAgentId",
  "liveVoiceTransferAgentId",
] as const;

/**
 * Сотрудники в точке возврата могли с тех пор уйти. PATCH /settings не даёт
 * поставить уволенного, замороженного или монтажёра без Telegram; возврат обязан
 * держать ту же планку, иначе через него уволенный тихо снова становится
 * монтажёром или дежурным (G7, 02.10.2026). Такие поля не возвращаются, из
 * списка дежурных выпадает только недоступный. Правит план на месте.
 */
export async function dropUnavailableStaffFromPlan(plan: RestorePlan): Promise<string[]> {
  const ids = new Set<string>();
  for (const f of STAFF_SINGLE_FIELDS) {
    const v = plan.data[f];
    if (typeof v === "string") ids.add(v);
  }
  const duty = plan.data.incomingDutyAgentIds;
  if (Array.isArray(duty)) for (const id of duty) if (typeof id === "string") ids.add(id);
  if (ids.size === 0) return [];

  const agents = await prisma.agent.findMany({
    where: { id: { in: [...ids] } },
    select: { id: true, isActive: true, frozenAt: true, telegramChatId: true },
  });
  const byId = new Map(agents.map((a) => [a.id, a]));
  const usable = (id: string) => {
    const a = byId.get(id);
    return !!a && a.isActive && !a.frozenAt;
  };

  const skipped: string[] = [];
  const drop = (field: string) => {
    delete plan.data[field];
    plan.changedFields = plan.changedFields.filter((f) => f !== field);
    skipped.push(field);
  };
  for (const f of STAFF_SINGLE_FIELDS) {
    const v = plan.data[f];
    if (typeof v !== "string") continue;
    if (!usable(v)) drop(f);
    else if (f === "videoMontajerAgentId" && !byId.get(v)?.telegramChatId) drop(f);
  }
  if (Array.isArray(duty)) {
    const kept = duty.filter((id): id is string => typeof id === "string" && usable(id));
    if (kept.length !== duty.length) {
      plan.data.incomingDutyAgentIds = kept;
      skipped.push("incomingDutyAgentIds");
    }
  }
  return skipped;
}

export function isSecretSettingsField(field: string): boolean {
  return SECRET_FIELD_SET.has(field);
}

/**
 * СРОК ХРАНЕНИЯ: не больше 200 точек и не старше 180 суток.
 *
 * Два ограничителя, потому что по одному каждый из них дырявый. Только по сроку —
 * и день, в который настройки крутили полсотни раз, оставляет полсотни строк; только
 * по количеству — и таблица живёт вечно, храня состояние годичной давности, к
 * которому никто не вернётся (за год схема настроек успевает измениться так, что
 * возврат к ней уже не имеет смысла).
 *
 * Числа. 180 суток — заведомо больше любого «а как было до рекламной кампании»;
 * 200 точек при паре правок в неделю покрывает те же полгода, а при буре правок в
 * один вечер не даёт этой буре вытеснить всю осмысленную историю (полсотни правок
 * подряд — это одна сессия настройки, и до неё остаётся ещё 150 точек). Одна точка
 * весит порядка 10 КБ JSON, то есть потолок таблицы — около 2 МБ.
 */
export const SNAPSHOT_KEEP_COUNT = 200;
export const SNAPSHOT_KEEP_DAYS = 180;

/** Отпечаток действующего ключа шифрования; null — ключ не настроен. */
export function encryptionKeyFingerprint(): string | null {
  const raw = process.env.SETTINGS_ENCRYPTION_KEY;
  if (!raw || raw.length !== 64) return null;
  return crypto.createHash("sha256").update(raw).digest("hex").slice(0, 16);
}

/** Типы полей Settings берём из самой схемы, а не списком в коде: новое поле
 *  Json/DateTime иначе пришлось бы дописывать сюда руками, и забытая правка
 *  всплыла бы только на попытке восстановления. */
let fieldTypes: Map<string, { type: string; isList: boolean }> | null = null;

/**
 * ОТКУДА БЕРЁТСЯ ОПИСАНИЕ СХЕМЫ ПОСЛЕ PRISMA 7.
 *
 * До семёрки это был `Prisma.dmmf.datamodel` — публичный экспорт генератора.
 * Генератор `prisma-client` его больше не отдаёт, публичной замены Prisma пока
 * не выпустила (prisma/prisma#19392), а варианты «разобрать schema.prisma через
 * @prisma/internals» и «свой генератор» тянут в сервер лишний пакет и лишний шаг
 * сборки ради одной карты полей.
 *
 * Поэтому берём `_runtimeDataModel` — то же описание схемы, зашитое генератором
 * в сам клиент; поле внутреннее, но это по-прежнему ОДИН источник правды —
 * схема, а не список полей руками. Именно это свойство здесь и было важно:
 * новое поле Json/DateTime не должно требовать правки этого файла.
 *
 * Если однажды поле переименуют, молчания не будет: карта окажется пустой, и
 * `settingsFieldTypes` бросит исключение прямо на первом обращении, а не отдаст
 * тихо испорченное восстановление.
 */
type RuntimeField = { name: string; type: string; isList?: boolean };
type WithRuntimeDataModel = {
  _runtimeDataModel?: { models?: Record<string, { fields?: RuntimeField[] }> };
};

function settingsFieldTypes(): Map<string, { type: string; isList: boolean }> {
  if (fieldTypes) return fieldTypes;
  const map = new Map<string, { type: string; isList: boolean }>();
  const model = (prisma as unknown as WithRuntimeDataModel)._runtimeDataModel?.models?.Settings;
  for (const field of model?.fields ?? []) {
    map.set(field.name, { type: field.type, isList: field.isList === true });
  }
  if (map.size === 0) {
    throw new Error(
      "не удалось прочитать описание модели Settings из клиента Prisma: " +
        "точки возврата настроек не смогут восстановить даты, Decimal и Json"
    );
  }
  fieldTypes = map;
  return map;
}

export type SnapshotPayload = Record<string, unknown>;

/**
 * Строка Settings в виде, пригодном для JSON: Decimal становится строкой, дата —
 * ISO. Обратное преобразование делает `restoreValue` — по типу поля из схемы.
 */
export function toSnapshotPayload(settings: Settings): SnapshotPayload {
  return JSON.parse(JSON.stringify(settings)) as SnapshotPayload;
}

/** Одинаковы ли два значения настройки. Сравнение по сериализованному виду:
 *  Decimal и дата приходят из базы объектами, а из снимка — строками. */
function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

export interface SettingsFieldChange {
  field: string;
  /** Значение из снимка (у секретов — только признак, само значение не отдаётся). */
  from: unknown;
  /** Действующее значение. */
  to: unknown;
}

/** Максимальная длина значения в описании отличий: промт бота — 30 000 знаков,
 *  и в списке точек возврата ему делать нечего. */
const PREVIEW_LIMIT = 80;

/** Что можно показать в интерфейсе. Секрет наружу не уходит никогда — только
 *  «задан/пусто»: точка возврата не должна стать вторым способом прочитать ключ. */
function previewValue(field: string, value: unknown): unknown {
  // У списка секретов (дополнительные ключи Gemini) показываем количество: пустой
  // массив — это «ни одного», а не «задан», и обычная проверка на истинность
  // ошиблась бы на нём в обе стороны.
  if (isSecretSettingsField(field)) {
    if (Array.isArray(value)) return value.length ? `•••• ×${value.length}` : null;
    return value ? "••••" : null;
  }
  if (typeof value === "string" && value.length > PREVIEW_LIMIT) return `${value.slice(0, PREVIEW_LIMIT)}…`;
  return value;
}

/**
 * Чем снимок отличается от заданного состояния. Именно это делает список точек
 * пригодным для выбора: «время + автор» не даёт узнать точку, в которой всё ещё
 * работало, а «здесь бот был включён, а сейчас выключен» — даёт.
 */
export function diffSnapshot(payload: SnapshotPayload, current: Settings): SettingsFieldChange[] {
  const now = toSnapshotPayload(current);
  const changes: SettingsFieldChange[] = [];
  for (const field of settingsFieldTypes().keys()) {
    if (field === "id") continue;
    if (isSystemSettingsField(field)) continue;
    // Поле, которого в снимке нет вовсе (снимок снят до появления настройки),
    // отличием не считается: восстанавливать там нечего.
    if (!(field in payload)) continue;
    if (sameValue(payload[field], now[field])) continue;
    changes.push({
      field,
      from: previewValue(field, payload[field]),
      to: previewValue(field, now[field]),
    });
  }
  return changes;
}

/** Значение из снимка в виде, который примет Prisma. */
function restoreValue(field: string, value: unknown): unknown {
  const meta = settingsFieldTypes().get(field);
  if (!meta) return value;
  if (meta.type === "DateTime" && !meta.isList) {
    return value === null || value === undefined ? null : new Date(value as string);
  }
  if (meta.type === "Json" && !meta.isList) {
    // У Json-полей обычный null запрещён: Prisma требует различать «нет значения
    // в колонке» и «в колонке лежит JSON null». Здесь всегда первое.
    return value === null || value === undefined ? Prisma.DbNull : value;
  }
  return value;
}

export interface CaptureResult {
  id: string;
  changedFields: string[];
}

/**
 * Снимает точку возврата ПЕРЕД изменением настроек.
 *
 * @param nextData — то, что вот-вот запишется. Нужно, чтобы не плодить точки на
 * сохранениях, ничего не менявших: форма показывает действующие значения, и
 * «открыл вкладку, нажал Сохранить» иначе вытесняло бы настоящие точки из истории.
 *
 * Возвращает null, если снимать нечего: строки настроек ещё нет (первое
 * сохранение) или ни одно значение не отличается от текущего.
 */
export async function captureSettingsSnapshot(params: {
  agentId: string | null;
  agentName: string;
  reason: "update" | "restore";
  nextData: Record<string, unknown>;
}): Promise<CaptureResult | null> {
  const current = await prisma.settings.findUnique({ where: { id: "singleton" } });
  if (!current) return null;

  const payload = toSnapshotPayload(current);
  const changedFields = Object.keys(params.nextData).filter((field) => {
    if (field === "id") return false;
    if (!(field in payload)) return false;
    // Секрет всегда шифруется заново (случайный вектор), поэтому сравнение
    // шифротекстов бессмысленно — считаем такое поле изменённым по факту записи.
    if (isSecretSettingsField(field)) return true;
    return !sameValue(JSON.parse(JSON.stringify(params.nextData[field] ?? null)), payload[field]);
  });
  if (changedFields.length === 0) return null;

  const snapshot = await prisma.settingsSnapshot.create({
    data: {
      payload: payload as Prisma.InputJsonValue,
      agentId: params.agentId,
      agentName: params.agentName,
      reason: params.reason,
      changedFields,
      keyFingerprint: encryptionKeyFingerprint(),
    },
    select: { id: true },
  });
  await pruneSettingsSnapshots();
  return { id: snapshot.id, changedFields };
}

export interface PruneResult {
  byAge: number;
  byCount: number;
}

/** Обрезка истории по обоим правилам сразу (см. SNAPSHOT_KEEP_*). */
export async function pruneSettingsSnapshots(): Promise<PruneResult> {
  const cutoff = new Date(Date.now() - SNAPSHOT_KEEP_DAYS * 24 * 60 * 60 * 1000);
  const byAge = await prisma.settingsSnapshot.deleteMany({ where: { createdAt: { lt: cutoff } } });

  // Граница «двухсотой сверху» одним запросом, а не выборкой всех идентификаторов:
  // удаляем то, что старше её по времени создания.
  const boundary = await prisma.settingsSnapshot.findMany({
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    skip: SNAPSHOT_KEEP_COUNT - 1,
    take: 1,
    select: { createdAt: true },
  });
  let byCount = 0;
  if (boundary.length > 0) {
    const deleted = await prisma.settingsSnapshot.deleteMany({
      where: { createdAt: { lt: boundary[0].createdAt } },
    });
    byCount = deleted.count;
  }
  return { byAge: byAge.count, byCount };
}

export interface RestorePlan {
  /** Что будет записано в Settings. */
  data: Record<string, unknown>;
  /** Имена полей, которые изменятся. */
  changedFields: string[];
  /** Секреты, которые НЕ восстанавливаются: они зашифрованы другим ключом. */
  skippedSecrets: string[];
}

/** Совпадает ли ключ шифрования снимка с действующим. Оба null — совпадает:
 *  это одинаковое состояние среды («шифрования не было»). */
export function secretsRestorable(snapshotFingerprint: string | null): boolean {
  return snapshotFingerprint === encryptionKeyFingerprint();
}

/**
 * Что именно вернёт восстановление. Отдельной функцией, чтобы одно и то же
 * решение принималось и при показе предупреждения, и при самой записи.
 */
export function planRestore(
  payload: SnapshotPayload,
  current: Settings,
  snapshotFingerprint: string | null
): RestorePlan {
  const keepSecrets = !secretsRestorable(snapshotFingerprint);
  const now = toSnapshotPayload(current);
  const data: Record<string, unknown> = {};
  const changedFields: string[] = [];
  const skippedSecrets: string[] = [];

  for (const field of settingsFieldTypes().keys()) {
    if (field === "id") continue;
    if (isSystemSettingsField(field)) continue;
    if (!(field in payload)) continue;
    if (sameValue(payload[field], now[field])) continue;
    if (isSecretSettingsField(field)) {
      if (keepSecrets) {
        // Ключ шифрования сменился — вернуть старое значение значит записать в
        // Настройки нечитаемый мусор, внешне неотличимый от рабочего маркера.
        skippedSecrets.push(field);
        continue;
      }
    }
    data[field] = restoreValue(field, payload[field]);
    changedFields.push(field);
  }
  return { data, changedFields, skippedSecrets };
}
