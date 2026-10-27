/**
 * Озвучка ответов ИИ-ассистента. Поставщик — Gemini (тот же провайдер, что уже
 * разбирает голосовые и ведёт диалог), отдельная TTS-модель линейки 2.5.
 *
 * ПОЧЕМУ ОТДЕЛЬНАЯ МОДЕЛЬ, А НЕ GEMINI_MODEL. Разговорные модели (`gemini-3.6-flash`
 * и т.п., см. geminiTransport.ts) не отдают аудио, только текст. Синтез речи держит
 * отдельная линейка моделей (`*-tts`), поэтому имя модели — своя переменная
 * окружения, а не переиспользование GEMINI_MODEL: смена основной диалоговой модели
 * не должна тихо ломать озвучку и наоборот.
 *
 * ИМЯ МОДЕЛИ ПЕРЕД СМЕНОЙ СВЕРИТЬ на ai.google.dev/gemini-api/docs/models —
 * придуманное имя даёт 404 на каждый вызов (см. предупреждение у GEMINI_MODEL).
 *
 * ФОРМАТ ОТВЕТА. Gemini TTS отдаёт «сырой» PCM (16 бит, моно, 24 кГц) в base64, без
 * WAV-заголовка — браузер такой файл не проиграет через <audio src>. Заголовок
 * дописывает фронтенд (apps/web/src/lib/pcmToWav.ts): гонять 24-байтный заголовок
 * через сеть незачем, дешевле собрать его на месте воспроизведения.
 *
 * ОТКАЗ — НЕ ОШИБКА ДЛЯ ПОЛЬЗОВАТЕЛЯ. Ответ ассистента уже показан текстом; если
 * озвучка недоступна (ключ не задан, лимит, сеть), фронтенд просто не проигрывает
 * звук — как страховка от сети, а не сбой всего диалога.
 */

import { resolveGeminiKeys } from "./geminiClient.js";
import {
  geminiUrl,
  geminiProxyHeaders,
  isRetryableGeminiStatus,
  GEMINI_RETRY_DELAYS_MS,
  GEMINI_TTS_MODELS,
  shouldLogGeminiModelFallback,
  sleep,
} from "./geminiTransport.js";
import { logSystemError } from "../lib/systemError.js";
import { describeError } from "../lib/describeError.js";

/** Первая (основная) модель цепочки — для обратной совместимости с местами, которым
 *  нужно одно имя (ключ кеша приветствия, проверка паузы по квоте ДО вызова). Сама
 *  цепочка с резервными именами — GEMINI_TTS_MODELS в geminiTransport.ts. */
export const GEMINI_TTS_MODEL = GEMINI_TTS_MODELS[0];

/** Голос из каталога прилагаемых голосов Gemini TTS — нейтральный, для делового тона. */
const VOICE_NAME = process.env.GEMINI_TTS_VOICE || "Kore";

/** Ограничение длины входа: длинный ответ ассистента озвучивать дорого и долго,
 *  а слушать длиннее пары абзацев в интерфейсе CRM никто не станет. */
const MAX_INPUT_CHARS = 2000;

export interface TtsResult {
  audioBase64: string;
  sampleRateHz: number;
}

/**
 * Оборачивает сырой PCM (моно, 16 бит) в WAV-заголовок — НА СЕРВЕРЕ, а не в
 * браузере, как делает pcmToWav.ts (13.09.2026, голосовые ответы бота в
 * переписке: файл нужен готовым для transcodeToOggOpus/deliverVoiceToConversation
 * ещё до того, как что-либо доходит до браузера — фронтенда в этом пути нет
 * вовсе, WhatsApp/Instagram получают уже готовый файл).
 */
export function pcmToWavBuffer(pcm: Buffer, sampleRateHz: number): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // моно
  header.writeUInt32LE(sampleRateHz, 24);
  header.writeUInt32LE(sampleRateHz * 2, 28); // байт/сек = частота × 2 (16 бит, 1 канал)
  header.writeUInt16LE(2, 32); // байт на кадр
  header.writeUInt16LE(16, 34); // бит на сэмпл
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/**
 * ПАУЗА, КОГДА СУТОЧНАЯ КВОТА ВЫЖЖЕНА.
 *
 * ЧТО БЫЛО НЕ ТАК (найдено на живом проде 21.08.2026). Квота синтеза речи кончилась
 * вечером, а крон подсказок агенту ходит каждые пять минут и берёт одни и те же
 * двадцать карточек. Двенадцать часов подряд: ~240 запросов в час, все с 429, и
 * двадцать одинаковых записей в журнал ошибок на каждый заход — 445 неразобранных
 * к утру. Толку ноль: квота суточная, до полуночи по Тихому океану ни один из этих
 * запросов не мог пройти.
 *
 * ЧТО ДЕЛАЕМ. Поймали 429 — замолкаем на час и не трогаем сеть вовсе. Пауза
 * считается ОТДЕЛЬНО ПО МОДЕЛИ: телефонная подсказка и ответ ассистента озвучиваются
 * разными моделями (см. TtsOptions), и выжженная квота таджикской модели не должна
 * лишать голоса русского ассистента.
 *
 * ПОЧЕМУ ПАУЗА ПРИВЯЗАНА К НАБОРУ КЛЮЧЕЙ. Владелец 21.08.2026: «добавил ключи в
 * настройках — пусть сразу же всё работает». Квота считается на ПРОЕКТ Google, а не
 * на ключ, поэтому новый ключ из другого проекта — это новая квота, и ждать конца
 * паузы бессмысленно. Набор ключей входит в отпечаток паузы: изменился состав —
 * отпечаток другой, пауза к нему не относится, следующий же вызов идёт в сеть.
 * Ждать и перезапускать API не нужно.
 */
/**
 * Пауза растёт с каждым разом: 5 минут → 10 → 20 → 40 → час и не больше.
 *
 * ПОЧЕМУ НЕ ОДНО ЧИСЛО. За 429 стоят две разные беды. Короткая — предел запросов в
 * минуту: прошло несколько минут, и всё снова работает; час молчания здесь был бы
 * наказанием на пустом месте. Длинная — суточная квота проекта: до полуночи по
 * Тихому океану не поможет ничто, и час между попытками в самый раз. Отличить их по
 * ответу Google нельзя — он одинаковый. Поэтому не гадаем: первая пауза короткая, а
 * если после неё снова 429, значит беда длинная, и следующая вдвое длиннее.
 */
const QUOTA_PAUSE_STEPS_MS = [5, 10, 20, 40, 60].map((m) => m * 60 * 1000);

/** Отпечаток набора ключей: только хвосты, чтобы сам ключ нигде не осел. */
function keysSignature(keys: string[]): string {
  return keys.map((k) => k.slice(-4)).join("|");
}

const quotaPause = new Map<string, { signature: string; until: number; strikes: number }>();

/** Только для тестов: забыть паузы по всем моделям. Модуль живёт весь процесс
 *  воркера vitest — без сброса тест, запущенный после другого прогона этого же
 *  файла в том же воркере, наследует чужую паузу (см. resetDialplanContextCache
 *  в lib/telephony/dialplanContext.ts — тот же приём). */
export function resetTtsQuotaPause(): void {
  quotaPause.clear();
}

/**
 * Стоит ли озвучка на паузе для этой модели ПРИ ТЕКУЩИХ ключах. Отдаёт момент
 * окончания паузы либо null. Зовут снаружи — например, синхронизатор подсказок
 * (lib/telephony/whisperSync.ts), чтобы не заводить два десятка одинаковых записей
 * в журнал ошибок на каждый заход крона.
 */
export async function ttsQuotaPausedUntil(model = GEMINI_TTS_MODEL): Promise<number | null> {
  const paused = quotaPause.get(model);
  if (!paused) return null;
  if (Date.now() >= paused.until) {
    quotaPause.delete(model);
    return null;
  }
  // Ключи сменились — прежняя пауза больше ни о чём не говорит.
  if (paused.signature !== keysSignature(await resolveGeminiKeys())) {
    quotaPause.delete(model);
    return null;
  }
  return paused.until;
}

/** Время окончания паузы человеческим часом — для записи в журнал. */
function untilLabel(until: number): string {
  return new Date(until).toLocaleTimeString("ru-RU", { timeZone: "Asia/Dushanbe", hour: "2-digit", minute: "2-digit" });
}

export async function isTtsEnabled(): Promise<boolean> {
  return (await resolveGeminiKeys()).length > 0;
}

/**
 * Голос и модель задаются вызывающим, потому что у озвучки два разных потребителя с
 * разными требованиями: ответ ассистента в браузере (русский, любая TTS-модель) и
 * подсказка агенту в трубку (таджикский, см. lib/telephony/whisperAudio.ts).
 *
 * РАЗНИЦА НЕ КОСМЕТИЧЕСКАЯ: проверено на живых запросах 20.08.2026 — модель
 * `gemini-2.5-flash-preview-tts` на таджикский текст возвращает `finishReason: OTHER`
 * и НИ ОДНОГО байта звука, то есть молчание без ошибки. Русский та же модель читает
 * нормально. Поэтому телефонная подсказка просит модель явно, а не наследует общую.
 */
export interface TtsOptions {
  /** Имя голоса из каталога Gemini TTS; по умолчанию — VOICE_NAME. */
  voice?: string;
  /** Имя ОДНОЙ TTS-модели — переопределяет всю цепочку резервов (обратная
   *  совместимость). Для резервной цепочки использовать `models`. */
  model?: string;
  /** Цепочка моделей, слева направо: стабильная (если есть) → preview. По
   *  умолчанию — GEMINI_TTS_MODELS. См. previewWhisperSpeech (whisperAudio.ts),
   *  передающий GEMINI_WHISPER_TTS_MODELS. */
  models?: string[];
}

/**
 * ГОЛОСОВОЙ ОТВЕТ БОТА В ПЕРЕПИСКЕ — СТИЛЬ ЖИВОГО ЧЕЛОВЕКА, А НЕ ДИКТОРА
 * (13.09.2026, владелец: «проверь, чтобы звучал максимально человечно»).
 *
 * Без инструкции модель читает написанный для WhatsApp/Telegram текст ровно
 * той же безликой манерой, что и подсказку агенту в трубку (см. STYLE_PROMPT
 * в lib/telephony/whisperAudio.ts — та специально «как диктор», это другая
 * задача). Здесь наоборот: имитация того, как реальный сотрудник наговорил
 * голосовое клиенту — с живой интонацией, естественным темпом и паузами на
 * знаках препинания, не суфлёрским зачитыванием.
 *
 * Инструкция ПЕРЕД текстом, тот же приём, что и STYLE_PROMPT/greetingVoice.ts
 * (документированная у Google форма управления тоном Gemini TTS: обычная
 * фраза на естественном языке перед содержанием, не спецразметка).
 */
const CHAT_VOICE_STYLE_PROMPT =
  "Скажи это голосом живого человека, тепло и по-простому, обычным разговорным темпом, " +
  "как будто быстро надиктовал голосовое сообщение знакомому клиенту, а не читаешь текст " +
  "вслух — с естественными паузами на знаках препинания, без дикторской чёткости: ";

/** Exact remaining input capacity after the existing style prefix. This lets
 * strict callers skip audio rather than letting synthesizeSpeech silently
 * truncate the sealed text. Legacy callers retain their existing truncation. */
export const CHAT_VOICE_REPLY_MAX_TEXT_CHARS = MAX_INPUT_CHARS - CHAT_VOICE_STYLE_PROMPT.length;

export function chatVoiceReplyFitsTtsInputLimit(text: string): boolean {
  return text.trim().length > 0 && CHAT_VOICE_STYLE_PROMPT.length + text.length <= MAX_INPUT_CHARS;
}

/**
 * Озвучка ГОЛОСОВОГО ОТВЕТА БОТА В ПЕРЕПИСКЕ (Meta/Telegram-личка/Telegram
 * Direct) — единственная точка входа для этой задачи, чтобы стиль не разошёлся
 * по трём местам вызова (webhooks/telegram bot/telegramDirectMessages) так
 * же, как это уже случалось с текстом владельца (см. память
 * feedback_single_source_of_truth_for_owner_text).
 */
export function synthesizeChatVoiceReply(text: string, options: TtsOptions = {}): Promise<TtsResult | null> {
  return synthesizeSpeech(CHAT_VOICE_STYLE_PROMPT + text, options);
}

export async function synthesizeSpeech(text: string, options: TtsOptions = {}): Promise<TtsResult | null> {
  const trimmed = text.trim().slice(0, MAX_INPUT_CHARS);
  if (!trimmed) return null;

  const apiKeys = await resolveGeminiKeys();
  if (apiKeys.length === 0) return null;

  const candidates = options.models && options.models.length > 0 ? options.models : options.model ? [options.model] : GEMINI_TTS_MODELS;
  const voiceName = options.voice || VOICE_NAME;

  // Квота проверяется по ПЕРВОЙ (основной) модели цепочки — тот же ключ паузы,
  // которым вызывающие (whisperClips.ts, whisperSync.ts) проверяют её ДО вызова.
  const primaryModel = candidates[0];
  // Пауза ставится и на остальные модели цепочки (см. ниже), и проверяется по каждой:
  // раньше смотрели только основную, а пауза записывалась под именем той модели,
  // которая ответила 429 (CHANNEL-NEW-26). Модели на паузе пропускаем, живые зовём.
  const livePauses = await Promise.all(candidates.map((m) => ttsQuotaPausedUntil(m)));
  const live = candidates.filter((_, i) => !livePauses[i]);
  const pausedUntil = live.length === 0 ? Math.max(...livePauses.map((x) => x ?? 0)) : null;
  if (pausedUntil) {
    /**
     * ДО 14.09.2026 ЭТОТ ВЫХОД БЫЛ ПОЛНОСТЬЮ МОЛЧАЛИВЫМ (нарочно — см. докстринг
     * ttsQuotaPausedUntil: whisperSync.ts проверяет паузу САМ до вызова именно
     * чтобы не заводить 20 одинаковых записей в журнал на каждый заход крона).
     * Но у голосовых ответов бота в переписке (finishQualifyTurn/finishTelegram*)
     * такой проверки ДО вызова нет — они просто зовут synthesizeSpeech и молча
     * получают null. Итог: клиент прислал голосовое, бот ответил текстом, а
     * голос тихо не ушёл, и ни строки в журнале — притом что причина совсем не
     * в этом конкретном ответе. Один короткий лог ЗДЕСЬ закрывает слепую зону
     * для всех подобных вызывающих разом, не трогая уже отлаженный путь whisper.
     */
    console.error(`[tts] пропущено — пауза по квоте ${primaryModel} до ${untilLabel(pausedUntil)}`);
    return null;
  }

  const body = JSON.stringify({
    contents: [{ parts: [{ text: trimmed }] }],
    generationConfig: {
      responseModalities: ["AUDIO"],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName } } },
    },
  });

  let lastDetail = "нет доступных ключей";
  /** Хотя бы один ключ ответил «квота исчерпана» — значит дело не в сети и не в тексте. */
  let quotaExhausted = false;
  let quotaModel = primaryModel;
  /** Модели, до которых дошли в этом вызове: закрытые (404) до исчерпавшей квоту тоже мертвы. */
  const triedModels: string[] = [];

  for (let modelIndex = 0; modelIndex < live.length; modelIndex++) {
    const model = live[modelIndex];
    triedModels.push(model);
    const url = geminiUrl(`/v1beta/models/${model}:generateContent`);
    /**
     * Модель ответила 200, но звука не дала — вердикт О ТЕКСТЕ, а не о ключе.
     *
     * Найдено 22.08.2026: телефонная подсказка озвучивается кусками, и на куске вроде
     * «@nozil760» модель молчит одинаково с любым ключом. Перебор ключей после такого
     * ответа — это лишний запрос из СУТОЧНОЙ квоты каждого проекта на заведомо тот же
     * результат. Ключ ни при чём — выходим сразу.
     */
    let textRefused = false;
    /**
     * МОДЕЛЬ ЗАКРЫТА GOOGLE (404) — «на завтра» ключи не помогут, значит и
     * перебирать их не нужно: пробуем следующую модель В ЦЕПОЧКЕ (пачка 7,
     * 11.09.2026, устраняет молчаливые preview-404 в ai/tts.ts, lib/greetingVoice.ts,
     * lib/telephony/whisperAudio.ts).
     */
    let model404 = false;
    for (const apiKey of apiKeys) {
      if (textRefused || model404) break;
      const attempts = GEMINI_RETRY_DELAYS_MS.length + 1;
      for (let attempt = 0; attempt < attempts; attempt++) {
        if (attempt > 0) await sleep(GEMINI_RETRY_DELAYS_MS[attempt - 1]);
        try {
          const res = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey, ...geminiProxyHeaders() },
            body,
            signal: AbortSignal.timeout(30_000),
          });
          if (!res.ok) {
            lastDetail = `Gemini TTS HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`;
            /**
             * 429 НЕ ПОВТОРЯЕМ ЭТИМ ЖЕ КЛЮЧОМ. Общий перебор считает 429 временной
             * помехой и ждёт 1+2+4 секунды — для предела «запросов в минуту» это
             * разумно, а для исчерпанной СУТОЧНОЙ квоты это четыре заведомо
             * пустых запроса и семь секунд простоя на каждую карточку. Ключ
             * кончился — берём следующий, он из другого проекта Google и со своей
             * квотой; а если кончились все, ниже включается пауза.
             */
            if (res.status === 429) {
              quotaExhausted = true;
              quotaModel = model;
              break;
            }
            if (res.status === 404) {
              model404 = true;
              break;
            }
            if (!isRetryableGeminiStatus(res.status)) break;
            continue;
          }
          const data = (await res.json()) as {
            candidates?: { content?: { parts?: { inlineData?: { data?: string; mimeType?: string } }[] } }[];
          };
          const part = data.candidates?.[0]?.content?.parts?.[0]?.inlineData;
          if (!part?.data) {
            lastDetail = "Gemini TTS не вернул аудио";
            textRefused = true;
            break;
          }
          // mimeType вида "audio/L16;codec=pcm;rate=24000" — частота нужна фронтенду
          // для WAV-заголовка; 24000 — задокументированное значение по умолчанию,
          // используется как страховка, если поле вдруг отсутствует.
          const rateMatch = /rate=(\d+)/.exec(part.mimeType ?? "");
          return { audioBase64: part.data, sampleRateHz: rateMatch ? Number(rateMatch[1]) : 24000 };
        } catch (err) {
          lastDetail = describeError(err);
        }
      }
    }

    if (model404) {
      const next = live[modelIndex + 1];
      if (shouldLogGeminiModelFallback(`tts:${model}`)) {
        void logSystemError(
          "ai",
          `TTS-модель ${model} отвечает 404 (Google её закрыл или переименовал)` +
            (next ? ` — переключаюсь на резервную ${next}.` : " — резервной модели в цепочке нет, озвучка недоступна. Проверьте GEMINI_TTS_MODELS/GEMINI_WHISPER_TTS_MODELS в .env на ai.google.dev/gemini-api/docs/models.")
        );
      }
      if (next) continue; // пробуем следующую модель цепочки
      break; // цепочка исчерпана — падаем в общий отказ ниже
    }
    break; // квота/отказ по тексту/сетевая ошибка — это не про имя модели, не перебираем цепочку
  }
  /**
   * Все ключи вернули «квота исчерпана» — замолкаем на час и пишем ОДНУ запись
   * вместо потока одинаковых. Текст объясняет, что делать: новая квота — это новый
   * проект Google, а не новый ключ в том же проекте (см. resolveGeminiKeys).
   */
  if (quotaExhausted) {
    const signature = keysSignature(apiKeys);
    const previous = quotaPause.get(quotaModel);
    // Подряд — только если беда та же и ключи те же; иначе счёт начинается заново.
    const strikes = previous && previous.signature === signature ? Math.min(previous.strikes + 1, QUOTA_PAUSE_STEPS_MS.length - 1) : 0;
    const until = Date.now() + QUOTA_PAUSE_STEPS_MS[strikes];
    quotaPause.set(quotaModel, { signature, until, strikes });
    // Модели цепочки, закрытые (404) по пути к этой, на паузу идут вместе с ней: иначе
    // следующий вызов снова бил бы в них и в исчерпанную резервную (CHANNEL-NEW-26),
    // а внешние проверки паузы (whisperClips, propertyWhisper) видели бы чистую основную.
    for (const dead of triedModels) {
      if (dead !== quotaModel) quotaPause.set(dead, { signature, until, strikes });
    }
    console.error(`[tts] суточная квота ${quotaModel} исчерпана — пауза до ${untilLabel(until)}`);
    void logSystemError(
      "ai",
      `Озвучка выключена до ${untilLabel(until)}: суточная квота Gemini на модель ${quotaModel} исчерпана на всех ` +
        `${apiKeys.length} ключах. Квота считается на ПРОЕКТ Google, поэтому поможет ключ из ДРУГОГО проекта: ` +
        `Настройки → ИИ → дополнительные ключи. Озвучка возобновится сразу после добавления, ждать конца паузы не нужно.`
    );
    return null;
  }

  console.error("[tts]", lastDetail);
  void logSystemError("ai", `Озвучка ответа не удалась: ${lastDetail}`);
  return null;
}
