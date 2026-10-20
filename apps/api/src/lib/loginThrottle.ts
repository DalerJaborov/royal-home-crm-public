/**
 * ЗАДЕРЖКА ОТВЕТА НА ПОДБОР ПАРОЛЯ (К «Заголовки», аудит безопасности 11.09.2026,
 * пункт 6 пачки 4).
 *
 * НЕ БЛОКИРОВКА — задержка. Решение владельца в самом аудите: блокировка по
 * телефону/IP — это готовый инструмент, чтобы вывести из строя чужой аккаунт
 * (подставить чей-то номер под лавину неудачных попыток и держать его
 * заблокированным); задержка делает перебор дорогим по времени, но не превращает
 * чужой номер в оружие против его владельца.
 *
 * СЧЁТЧИК В ПАМЯТИ ПРОЦЕССА, А НЕ В БАЗЕ — сознательно. Это защита от быстрого
 * автоматического перебора (десятки попыток в минуту), а не журнал: она обязана
 * сбрасываться на каждый деплой (обычное дело в этом проекте несколько раз в
 * день) и не должна платить лишним запросом к базе на каждую попытку входа —
 * самую частую операцию в CRM. Постоянный журнал неудачных входов — отдельная
 * задача, если она вообще понадобится; здесь только сдерживающая задержка.
 *
 * Ключ — ТЕЛЕФОН, не IP: у мобильных операторов Душанбе IP операторский и общий
 * на многих людей (см. lib/loginLog.ts, тот же довод про deviceKey вместо IP) —
 * считать по IP значило бы одному оператору класть 2с всем его абонентам.
 */

const FAILURE_WINDOW_MS = 15 * 60 * 1000;
const FAILURE_THRESHOLD = 10;
const THROTTLE_DELAY_MS = 2000;

/** Метки времени последних неудачных попыток, по телефону — только в пределах окна. */
const failuresByPhone = new Map<string, number[]>();

/** Убирает устаревшие метки и возвращает актуальный (уже очищенный) список. */
function recentFailures(phone: string, now: number): number[] {
  const kept = (failuresByPhone.get(phone) ?? []).filter((t) => now - t < FAILURE_WINDOW_MS);
  if (kept.length > 0) failuresByPhone.set(phone, kept);
  else failuresByPhone.delete(phone);
  return kept;
}

/**
 * ПОДБОР БЕЗ ПОВТОРА НИКОГДА НЕ ЧИСТИТСЯ САМ (найдено 22.09.2026, тот же класс,
 * что у lib/clientMessageAlert.ts::forgetOldMessagePushes). `recentFailures` чистит
 * устаревшие МЕТКИ внутри записи телефона, но саму запись трогает только следующий
 * вызов ПО ЭТОМУ ЖЕ телефону — а телефон, по которому подбор пароля начали и
 * бросили (или который вообще подставили чужим номером один раз), больше никогда
 * не вызывает ни recordLoginFailure, ни throttleLoginIfNeeded для себя. Запись
 * висит в памяти процесса вечно, пока его не перезапустят деплоем. Тот же приём:
 * порог по размеру (не чистим на каждый вызов ради одной лишней записи) и по
 * возрасту (окно давно истекло — метки внутри уже пусты).
 */
function forgetStaleLoginFailures(now: number): void {
  if (failuresByPhone.size < 500) return;
  for (const [phone, timestamps] of failuresByPhone) {
    if (timestamps.every((t) => now - t >= FAILURE_WINDOW_MS)) failuresByPhone.delete(phone);
  }
  // ЖЁСТКИЙ ПОТОЛОК (круг 3, №73). Возраст чистит только брошенное: поток
  // входов с новым номером на каждый запрос держит все записи свежими, и
  // карта росла без предела, пока не кончалась память процесса. Выше потолка
  // уходят самые старые записи (Map помнит порядок вставки) — задержка для
  // них сбросится, но это цена за то, что сервер живёт.
  for (const phone of failuresByPhone.keys()) {
    if (failuresByPhone.size <= MAX_TRACKED_PHONES) break;
    failuresByPhone.delete(phone);
  }
}

/** Сколько номеров помним разом — с запасом на весь штат и его опечатки. */
export const MAX_TRACKED_PHONES = 5000;

/** Для теста: сколько номеров сейчас в памяти. */
export function trackedLoginFailureCount(): number {
  return failuresByPhone.size;
}

/** Неудачная попытка входа — телефон не найден, аккаунт неактивен либо пароль неверный. */
export function recordLoginFailure(phone: string): void {
  const now = Date.now();
  const kept = recentFailures(phone, now);
  kept.push(now);
  failuresByPhone.set(phone, kept);
  forgetStaleLoginFailures(now);
}

/** Успешный вход — прошлые неудачи по этому телефону больше не в счёт. */
export function clearLoginFailures(phone: string): void {
  failuresByPhone.delete(phone);
}

/**
 * Если по этому телефону за последние 15 минут было 10+ неудач — ждём перед тем,
 * как отвечать (успехом или отказом, безразлично). Вызывать ДО остальной логики
 * входа: задержка должна лечь на КАЖДЫЙ следующий ответ этому номеру, а не только
 * на отказ, иначе по разнице задержек можно угадать, подошёл пароль или нет.
 */
export async function throttleLoginIfNeeded(phone: string): Promise<void> {
  const now = Date.now();
  if (recentFailures(phone, now).length < FAILURE_THRESHOLD) return;
  await new Promise((resolve) => setTimeout(resolve, THROTTLE_DELAY_MS));
}

/** Только для тестов — обнуляет счётчик между прогонами. */
export function __resetLoginThrottleForTests(): void {
  failuresByPhone.clear();
}
