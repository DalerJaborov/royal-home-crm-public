import { joinTranscriptFragments } from "@royal-home/shared";

/**
 * ПРОСЛУШКА ЖИВОГО ГОЛОСА В РЕАЛЬНОМ ВРЕМЕНИ (09.10.2026).
 *
 * Реестр активных разговоров робота и шина «разговор → слушатели» в памяти
 * процесса. Мост (liveVoiceBridge.ts) только ПУБЛИКУЕТ сюда кадры звука и
 * реплики; слушатели (routes/liveVoiceListen.ts — поток событий в браузер)
 * подписываются. Мост ничего не знает о слушателях, а слушалка — о мосте.
 *
 * ГЛАВНОЕ ТРЕБОВАНИЕ — слушалка не имеет права уронить или задержать звонок:
 *  - публикация звука идёт с каждого RTP-пакета (50 кадров в секунду на сторону),
 *    поэтому без подписчиков это одно сравнение числа и выход — ни поиска по
 *    карте, ни копий, ни аллокаций (activeSubscribers === 0);
 *  - никаких await и промисов: всё синхронно, обработчик слушателя вызывается
 *    прямо в потоке моста, поэтому он обязан быть дешёвым (маршрут только кладёт
 *    кадр в свой буфер, а кодирование и запись в сеть делает по таймеру);
 *  - каждый вызов обработчика и каждая публичная функция — в try/catch: упавший
 *    слушатель отписывается, звонок этого не замечает;
 *  - предел слушателей на разговор (MAX_LISTENERS_PER_SESSION): лишних не берём.
 *
 * Состояние живёт в одном процессе. Прод — один контейнер api (см. комментарий в
 * routes/events.ts); разговор тоже живёт ровно в этом процессе, так что и
 * реестр, и слушатели — в одном месте.
 */

/** Кто говорит: клиент (звук с линии) или робот (звук, ушедший в линию). */
export type ListenSide = "client" | "bot";

export type ListenEvent =
  | { kind: "transcript"; role: ListenSide; text: string; ts: number }
  /** pcm — линейный PCM16, 8 кГц, моно. Слушатель НЕ должен менять массив: тот же
   *  массив лежит в записи разговора моста. */
  | { kind: "audio"; side: ListenSide; pcm: Int16Array }
  | { kind: "end"; reason: string };

export type ListenHandler = (event: ListenEvent) => void;

/** Реплика для показа тому, кто подключился посреди разговора. */
export interface BacklogLine {
  role: ListenSide;
  text: string;
}

export interface ActiveSessionInfo {
  id: string;
  channelId: string;
  investigationOnly: boolean;
  startedAt: number;
  callerNumber: string | null;
  direction: string;
  listeners: number;
}

interface Entry {
  info: Omit<ActiveSessionInfo, "listeners">;
  backlog: () => BacklogLine[];
  handlers: Set<ListenHandler>;
}

/** Сколько человек одновременно слушают один разговор. */
export const MAX_LISTENERS_PER_SESSION = 5;
/** Потолок жизни записи реестра: сессия моста живёт не дольше 15 минут
 *  (LIVE_VOICE_MAX_SESSION_MS), час — запас на случай, если конец не дошёл. */
const ENTRY_MAX_AGE_MS = 60 * 60_000;

const entries = new Map<string, Entry>();
/** Всего подписчиков по всем разговорам — быстрый выход горячего пути. */
let activeSubscribers = 0;

function dropEntry(key: string, entry: Entry): void {
  activeSubscribers -= entry.handlers.size;
  if (activeSubscribers < 0) activeSubscribers = 0;
  entry.handlers.clear();
  entries.delete(key);
}

function deliver(entry: Entry, event: ListenEvent): void {
  for (const handler of entry.handlers) {
    try {
      handler(event);
    } catch {
      // Упавший слушатель уходит сам; остальные и звонок не страдают. Удаление
      // из Set во время обхода в JavaScript безопасно.
      entry.handlers.delete(handler);
      activeSubscribers = Math.max(0, activeSubscribers - 1);
    }
  }
}

/** Разговор начался (после того, как сессия попала в реестр моста). */
export function sessionStarted(params: {
  key: string;
  channelId: string;
  investigationOnly?: boolean;
  callerNumber: string | null;
  direction: string;
  startedAt?: number;
  /** Накопленные реплики — читается только когда кто-то подключился. */
  backlog?: () => BacklogLine[];
}): void {
  try {
    const old = entries.get(params.key);
    if (old) dropEntry(params.key, old);
    entries.set(params.key, {
      info: {
        id: params.key,
        channelId: params.channelId,
        investigationOnly: params.investigationOnly === true,
        startedAt: params.startedAt ?? Date.now(),
        callerNumber: params.callerNumber,
        direction: params.direction,
      },
      backlog: params.backlog ?? (() => []),
      handlers: new Set(),
    });
  } catch {
    // слушалка не должна влиять на звонок
  }
}

/** Разговор закончился: слушателям уходит «конец», запись реестра убирается. */
export function sessionEnded(key: string, reason: string): void {
  try {
    const entry = entries.get(key);
    if (!entry) return;
    deliver(entry, { kind: "end", reason });
    dropEntry(key, entry);
  } catch {
    // см. выше
  }
}

/** Звук одной стороны (PCM16, 8 кГц). Без слушателей — мгновенный выход. */
export function publishAudio(key: string, side: ListenSide, pcm: Int16Array): void {
  if (activeSubscribers === 0) return;
  try {
    const entry = entries.get(key);
    if (!entry || entry.handlers.size === 0) return;
    deliver(entry, { kind: "audio", side, pcm });
  } catch {
    // см. выше
  }
}

/** Реплика (кусок расшифровки). Без слушателей — мгновенный выход. */
export function publishTranscript(key: string, role: ListenSide, text: string): void {
  if (activeSubscribers === 0) return;
  try {
    const entry = entries.get(key);
    if (!entry || entry.handlers.size === 0) return;
    deliver(entry, { kind: "transcript", role, text, ts: Date.now() });
  } catch {
    // см. выше
  }
}

function sweepStale(now: number): void {
  for (const [key, entry] of entries) {
    if (now - entry.info.startedAt > ENTRY_MAX_AGE_MS) dropEntry(key, entry);
  }
}

/** Идущие сейчас разговоры, самые свежие первыми. */
export function listActive(): ActiveSessionInfo[] {
  try {
    sweepStale(Date.now());
    return [...entries.values()]
      .map((e) => ({ ...e.info, listeners: e.handlers.size }))
      .sort((a, b) => b.startedAt - a.startedAt);
  } catch {
    return [];
  }
}

export function getActive(key: string): ActiveSessionInfo | null {
  const entry = entries.get(key);
  return entry ? { ...entry.info, listeners: entry.handlers.size } : null;
}

/**
 * Подписаться на разговор. null — разговора нет (уже закончился) или слушателей
 * уже MAX_LISTENERS_PER_SESSION. Возвращает функцию отписки (повторный вызов безвреден).
 */
export function subscribe(key: string, handler: ListenHandler): (() => void) | null {
  try {
    const entry = entries.get(key);
    if (!entry) return null;
    if (entry.handlers.size >= MAX_LISTENERS_PER_SESSION) return null;
    entry.handlers.add(handler);
    activeSubscribers += 1;
    return () => {
      // Запись могла быть уже снята (конец разговора) — тогда счётчик не трогаем.
      if (entry.handlers.delete(handler)) activeSubscribers = Math.max(0, activeSubscribers - 1);
    };
  } catch {
    return null;
  }
}

/** Накопленные реплики разговора — для показа подключившемуся посреди разговора. */
export function getBacklog(key: string): BacklogLine[] {
  try {
    return entries.get(key)?.backlog() ?? [];
  } catch {
    return [];
  }
}

/**
 * Строки расшифровки моста ("Клиент: …", "Бот: …", служебные "[…]") → реплики.
 * Служебные пометки моста пропускаются: это не речь. Подряд идущие куски одного
 * говорящего склеиваются (модель присылает расшифровку обрывками).
 */
export function backlogFromTranscript(lines: readonly string[]): BacklogLine[] {
  const out: BacklogLine[] = [];
  for (const line of lines) {
    let role: ListenSide;
    let text: string;
    if (line.startsWith("Клиент: ")) {
      role = "client";
      text = line.slice("Клиент: ".length);
    } else if (line.startsWith("Бот: ")) {
      role = "bot";
      text = line.slice("Бот: ".length);
    } else {
      continue;
    }
    const last = out[out.length - 1];
    if (last && last.role === role) last.text = joinTranscriptFragments(last.text, text);
    else out.push({ role, text });
  }
  return out;
}

/** Только для тестов. */
export function resetLiveVoiceMonitorForTests(): void {
  entries.clear();
  activeSubscribers = 0;
}

/** Только для тестов: число подписчиков на горячем пути. */
export function totalSubscribersForTests(): number {
  return activeSubscribers;
}
