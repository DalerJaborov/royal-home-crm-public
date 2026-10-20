/**
 * Озвучка произвольного русского текста в браузере — для брифинга знака ИИ
 * («Рассказать», удержание знака на пульте).
 *
 * ПОЧЕМУ Web Speech API, А НЕ СЕРВЕРНЫЙ TTS, КОТОРЫЙ В ПРОЕКТЕ УЖЕ ЕСТЬ.
 * Серверный синтез (`apps/api/src/ai/tts.ts`, Gemini) используется для
 * УТРЕННЕГО ПРИВЕТСТВИЯ и остаётся там без изменений: приветствие — это одна
 * фраза на роль и время суток, она кешируется файлом
 * (`ensureGreetingAudio`) и синтезируется от силы трижды в сутки на всю
 * компанию. Брифинг устроен иначе:
 *
 *   1. Его текст меняется при каждом обновлении снимка — там числа. Дисковый
 *      кеш, ключуемый текстом, не попадёт почти никогда, то есть каждое
 *      нажатие = оплаченный вызов Gemini. При нынешнем бюджете ИИ (~$8/мес)
 *      это заметная статья ради озвучки того, что человек и так видит.
 *   2. У TTS-модели есть лимит и эскалирующая пауза по квоте
 *      (`ttsQuotaPausedUntil`): исчерпав её брифингами, мы отключим и
 *      приветствие, которое владелец просил оставить как есть.
 *   3. Маршрута «озвучь произвольный текст» в API нет вовсе, а заводить его —
 *      это ещё и открытая дверь: любой авторизованный клиент сможет гонять
 *      платный синтез произвольными строками.
 *
 * Web Speech синтезирует локально: мгновенно, бесплатно, работает офлайн и не
 * зависит от квоты. Ранее в проекте от Web Speech отказались — но от
 * РАСПОЗНАВАНИЯ (`hooks/useSpeechRecognition.ts`, причина: «не понимает
 * таджикский»). Здесь задача обратная и другая: синтез РУССКОГО текста,
 * русские голоса есть во всех целевых браузерах.
 *
 * Побочная выгода, ради которой это и подходит лучше файла: `onboundary` даёт
 * настоящие границы слов, и знак раскрывается на каждом слоге по факту речи, а
 * не по выдуманному таймеру.
 *
 * ЧЕГО ЗДЕСЬ НАМЕРЕННО НЕТ. Голоса не выдумываются: если русского голоса в
 * системе нет, `speakRu` возвращает `null`, и вызывающий код обязан показать
 * это человеку, а не делать вид, что говорит. Границы слов тоже: Safari шлёт
 * `onboundary` нерегулярно, и подменять их равномерным тиком мы не будем —
 * знак тогда просто дышит ровно, как и положено профилю «говорит».
 */

/** Управление начатой репликой. */
export interface SpeakHandle {
  /** Прервать речь. Идемпотентно. */
  cancel(): void;
}

export interface SpeakOptions {
  /** Речь действительно началась (у браузера это отдельное событие). */
  onStart?: () => void;
  /** Граница слова — знак раскрывается на слог. Может не прийти ни разу. */
  onBoundary?: () => void;
  /** Речь закончилась, прервана или отказала. Зовётся ровно один раз. */
  onEnd?: () => void;
}

function synth(): SpeechSynthesis | null {
  try {
    return typeof window !== "undefined" && "speechSynthesis" in window ? window.speechSynthesis : null;
  } catch {
    return null;
  }
}

/**
 * Русский голос из установленных в системе.
 *
 * `getVoices()` в Chrome возвращает пустой список до события `voiceschanged`
 * — поэтому ответ `null` означает «пока не знаю», а не «голосов нет», и
 * `isVoiceReady` ниже это различает. Предпочитаем локальный голос сетевому:
 * сетевой добавляет задержку и требует интернета, а брифинг должен начинаться
 * сразу по нажатию.
 */
function pickRussianVoice(s: SpeechSynthesis): SpeechSynthesisVoice | null {
  const voices = s.getVoices();
  if (!voices.length) return null;
  const ru = voices.filter((v) => v.lang?.toLowerCase().startsWith("ru"));
  if (!ru.length) return null;
  return ru.find((v) => v.localService) ?? ru[0];
}

/** Браузер умеет синтез речи в принципе. */
export function isVoiceSupported(): boolean {
  return synth() !== null;
}

/**
 * Подписка на появление голосов. Нужна кнопке «Рассказать»: до `voiceschanged`
 * список пуст, и без подписки кнопка навсегда осталась бы выключенной у тех,
 * у кого голоса подгружаются асинхронно.
 */
export function onVoicesReady(fn: () => void): () => void {
  const s = synth();
  if (!s) return () => {};
  s.addEventListener("voiceschanged", fn);
  return () => s.removeEventListener("voiceschanged", fn);
}

/** Русский голос уже доступен прямо сейчас. */
export function hasRussianVoice(): boolean {
  const s = synth();
  return s ? pickRussianVoice(s) !== null : false;
}

/**
 * Произнести русский текст. Возвращает `null`, если синтез недоступен или
 * русского голоса нет — вызывающий обязан сказать об этом человеку.
 */
export function speakRu(text: string, { onStart, onBoundary, onEnd }: SpeakOptions = {}): SpeakHandle | null {
  const s = synth();
  if (!s) return null;
  const voice = pickRussianVoice(s);
  if (!voice) return null;

  // Чужая недоговорённая реплика обрывается: две речи одновременно — каша, а
  // очередь означала бы, что нажатие «Рассказать» срабатывает через минуту.
  s.cancel();

  const u = new SpeechSynthesisUtterance(text);
  u.voice = voice;
  u.lang = voice.lang || "ru-RU";
  // Чуть медленнее обычного: это доклад с числами, а не реплика.
  u.rate = 0.95;
  u.pitch = 1;
  u.volume = 1;

  let finished = false;
  /**
   * Известная многолетняя поломка Chrome: синтез самопроизвольно умолкает
   * примерно через 15 с, и `onend` при этом не приходит — реплика просто
   * обрывается на полуслове. Лечится периодическим `pause()`/`resume()`.
   * Брифинг как раз длиннее 15 с, поэтому без этого он обрывался бы почти
   * всегда. На движках без этой поломки пара вызовов безвредна.
   */
  const keepAlive = setInterval(() => {
    if (finished) return;
    try {
      s.pause();
      s.resume();
    } catch {
      // движок может не поддерживать паузу — не повод падать
    }
  }, 10_000);

  const finish = () => {
    if (finished) return;
    finished = true;
    clearInterval(keepAlive);
    onEnd?.();
  };

  u.onstart = () => onStart?.();
  u.onboundary = () => onBoundary?.();
  u.onend = finish;
  // `onerror` приходит и при штатном `cancel()` (тип "canceled"/"interrupted") —
  // различать незачем: и то и другое означает «речь кончилась».
  u.onerror = finish;

  try {
    s.speak(u);
  } catch {
    finish();
    return null;
  }

  return {
    cancel() {
      if (finished) return;
      try {
        s.cancel();
      } catch {
        // движок отказал — всё равно закрываем сессию речи
      }
      finish();
    },
  };
}
