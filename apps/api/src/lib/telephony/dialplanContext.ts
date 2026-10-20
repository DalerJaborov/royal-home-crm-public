import { amiActionRetrying, type AmiCredentials, type AmiPacket } from "./amiClient.js";

/**
 * ЕСТЬ ЛИ НА СТАНЦИИ НУЖНЫЙ НАМ КОНТЕКСТ ДИАЛПЛАНА.
 *
 * Отдельным модулем, а не внутри inboundRouting.ts: контекстов стало два — путь
 * входящего звонка к ответственному (`royalhome-agent-route`) и путь исходящего с
 * подсказкой (`royalhome-agent-out`), — и спрашивают о них разные модули. Оставь
 * функцию в inboundRouting, и whisperSync.ts, который её зовёт, замкнул бы круг
 * импортов: маршрутизация тянет подсказки, подсказки тянут маршрутизацию.
 *
 * ЧИТАЕМ ФАЙЛ ДИАЛПЛАНА, А НЕ СПРАШИВАЕМ ПРО КОНТЕКСТ. Напрашивающийся `ShowDialPlan`
 * пользователю AMI недоступен: ему нужен отдельный класс прав, а владелец расширять
 * права станции отказался — «одна дыра в CRM не должна означать угнанную телефонию
 * агентства» (проверено на живой станции 16.08.2026: `ShowDialPlan` отвечает
 * `Permission denied` всегда). `GetConfig` теми же правами работает и отвечает на тот
 * же вопрос честнее: контексты живут в `extensions_custom.conf`, и наличие там секции —
 * ровно то, что администратор добавляет руками.
 */

/**
 * Файл, в котором контексты описаны руками. Именно `_custom`: его FreePBX не
 * перезаписывает при «Apply Config».
 */
export const ROUTE_DIALPLAN_FILE = "extensions_custom.conf";

/**
 * Станции на ответ даётся меньше обычного: на том конце ЖИВОЙ человек слушает музыку
 * ожидания, и три секунды раздумий CRM — это три секунды, украденные у дозвона.
 */
const AMI_TIMEOUT_MS = 3_000;

/**
 * Сколько верим ответу «контекст на станции есть». Диалплан меняется руками раз в
 * несколько месяцев (см. заголовок модуля) — 30 минут кэша не заметны на фоне этой
 * частоты, а нагрузку на станцию с «спросить на каждый звонок» превращают в «спросить
 * раз в получас». Поднято с прежних 5 минут 20.09.2026, когда стало ясно, что реальный
 * риск был не в частоте проверки, а в том, что отказ AMI прятался под тем же кэшем,
 * что и честный ответ (см. `stationHasContext` ниже) — раз это разделено, держать
 * ПОДТВЕРЖДЁННОЕ «есть» дольше уже ничем не рискует.
 */
const OK_TTL_MS = 30 * 60_000;
/** …и сколько «контекста нет» (тоже подтверждено живым ответом станции): короче,
 *  чтобы правка диалплана заработала быстро. */
const MISSING_TTL_MS = 60_000;

/** Ответ станции по каждому интересующему контексту — только ПОДТВЕРЖДЁННЫЕ ответы
 *  (см. stationHasContext): отказ AMI сюда не попадает никогда. */
let cache = new Map<string, { at: number; present: boolean }>();

/** Только для тестов: забыть, что мы спрашивали станцию. */
export function resetDialplanContextCache(): void {
  cache = new Map();
}

/**
 * Есть ли в ответе `GetConfig` секция с таким именем.
 *
 * Ответ приходит одним пакетом, где ключи пронумерованы: `Category-000000` — имя
 * секции, `Line-000000-000004` — её строка. Имена ключей `parseAmiPacket` уже привёл
 * к нижнему регистру, поэтому ищем `category-NNNNNN`.
 */
export function packetHasCategory(packet: AmiPacket, context: string): boolean {
  const wanted = context.trim().toLowerCase();
  return Object.entries(packet).some(
    ([key, value]) => /^category-\d+$/.test(key) && value.trim().toLowerCase() === wanted
  );
}

/**
 * Ответ на «есть ли контекст» — РОВНО ТРИ состояния, а не два (20.09.2026, находка
 * владельца: `no_dialplan` на четырёх звонках из десяти при том, что контекст на
 * станции есть, проверено руками). `present: true/false` — станция ОТВЕТИЛА, это факт,
 * его можно кэшировать. `unknown: true` — станция НЕ ответила (таймаут, обрыв,
 * отказ соединения) — это не ответ, а тишина, и приравнивать её к «контекста нет»
 * значило бы выдавать заминку связи за решение админа. Тип объединения (а не
 * `boolean`) обязывает вызывающий код explicitно разобрать случай «неизвестно», а
 * не тихо получить `false` через `!result`.
 */
export type DialplanStatus = { present: boolean } | { unknown: true };

export async function stationHasContext(creds: AmiCredentials, context: string): Promise<DialplanStatus> {
  const now = Date.now();
  const cached = cache.get(context);
  if (cached && now - cached.at < (cached.present ? OK_TTL_MS : MISSING_TTL_MS)) return { present: cached.present };

  const result = await amiActionRetrying(creds, "GetConfig", { Filename: ROUTE_DIALPLAN_FILE }, { timeoutMs: AMI_TIMEOUT_MS });
  if (!result.ok) {
    // СТАНЦИЯ НЕ ОТВЕТИЛА — это не «файла нет» и не «прав нет» (замер владельца
    // 20.09.2026: живой GetConfig — 161 мс, то есть отказ почти всегда таймаут или
    // обрыв туннеля, а не медленная станция). До этой правки любой отказ AMI писался
    // в кэш как `present: false` на MISSING_TTL_MS (60 с) — и одна заминка AMI
    // глушила перевод КАЖДОГО следующего звонка на минуту, хотя контекст всё это
    // время был на месте. Кэш НЕ ТРОГАЕМ вовсе: следующий звонок (или следующая
    // попытка в зале ожидания, см. inboundRouting.ts) получает свежий шанс спросить
    // станцию заново, а не наследует чужой таймаут.
    return { unknown: true };
  }
  const present = result.packets.some((packet) => packetHasCategory(packet, context));
  cache.set(context, { at: now, present });
  return { present };
}

/**
 * СТРОКИ СЕКЦИИ ИЗ ОТВЕТА `GetConfig` (28.09.2026, консультант на входящих).
 *
 * Мало знать, что секция есть: 25.09 на станции нашёлся `royalhome-inbound`
 * старой версии — секция на месте, а ветки консультанта (`Stasis(royalhome-live-voice`)
 * в ней нет, и выбор «консультант вместо автоответчика» в Настройках молча не
 * действовал (docs/telephony-audit-25-09.md, §1). Возвращает `null`, если секции нет
 * вовсе, иначе — её строки как есть (`exten=s,1,NoOp(...)`).
 */
export function packetCategoryLines(packet: AmiPacket, context: string): string[] | null {
  const wanted = context.trim().toLowerCase();
  const category = Object.entries(packet).find(
    ([key, value]) => /^category-\d+$/.test(key) && value.trim().toLowerCase() === wanted
  );
  if (!category) return null;
  const prefix = `line-${category[0].slice("category-".length)}-`;
  return Object.entries(packet)
    .filter(([key]) => key.startsWith(prefix))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, value]) => value);
}

export type ContextContentStatus = { present: false } | { present: true; contains: boolean } | { unknown: true };

/**
 * Есть ли в секции файла диалплана строка с таким фрагментом. Без кэша: зовёт
 * только сводная проверка раз в 15 минут, на пути живого звонка этого вопроса нет.
 * Как и `stationHasContext`, это ФАЙЛ на диске станции, а не загруженная память:
 * после правки файла нужен ещё `dialplan reload`.
 */
export async function stationContextContains(
  creds: AmiCredentials,
  context: string,
  fragment: string
): Promise<ContextContentStatus> {
  const result = await amiActionRetrying(creds, "GetConfig", { Filename: ROUTE_DIALPLAN_FILE }, { timeoutMs: AMI_TIMEOUT_MS });
  if (!result.ok) return { unknown: true };
  const needle = fragment.toLowerCase();
  for (const packet of result.packets) {
    const lines = packetCategoryLines(packet, context);
    if (lines) return { present: true, contains: lines.some((line) => line.toLowerCase().includes(needle)) };
  }
  return { present: false };
}
