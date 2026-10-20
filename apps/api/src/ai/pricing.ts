/**
 * Цены на модели ИИ — доллары за миллион токенов.
 *
 * Четыре вида токенов стоят по-разному, и это главная причина, по которой одна
 * сумма «сколько токенов израсходовано» ничего не говорит о деньгах: чтение
 * кэша дешевле обычного входа в десять раз, а выход дороже входа в пять.
 * Запись в кэш берётся по пятиминутному сроку жизни (1.25 от входа) — часовой
 * (2.0) мы не используем.
 *
 * Сверено со справочником поставщика 26.07.2026. При смене цен правится только
 * эта таблица; пересчитать старые записи можно по полю AiLog.model.
 */
export interface ModelPrice {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
  /** Звук на входе/выходе, если у модели он стоит иначе текста (Live API). Не
   *  задано — звук считается по input/output. */
  audioInput?: number;
  audioOutput?: number;
}

const PER_MILLION: Record<string, ModelPrice> = {
  "claude-sonnet-5": { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  "claude-haiku-4-5": { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 },
  // Gemini (сверено с ai.google.dev/pricing 20.08.2026). До этого дня стоимость
  // вызовов Gemini оставалась null и в месячную строку «расходы на ИИ» не
  // попадала вовсе — то есть строка врала в меньшую сторону ровно на Gemini.
  // Кэш Google тарифицирует иначе (за хранение), мы его не используем — ставки
  // записи/чтения условно нулевые, а не выдуманные.
  /**
   * ОСНОВНАЯ РАБОЧАЯ МОДЕЛЬ — И ЕЁ ЦЕНЫ ЗДЕСЬ НЕ БЫЛО ВОВСЕ (22.08.2026).
   *
   * gemini-3.7-flash обслуживает ~99% вызовов (2671 из 2748 за неделю, 12.5 млн
   * входных токенов), а строки в этой таблице у неё не было — значит costUsd
   * писался null, и раздел «расходы на ИИ» показывал $0.14 в день при настоящих
   * тратах у Google в десятки раз больше. Отчёт врал не немного, а в ноль.
   *
   * Ставки взяты по семейству Flash того же поколения (как у 3.6-flash). Это
   * оценка, а не выписка из прайса Google: точную цифру видно только в биллинге,
   * и расхождение теперь заметно сразу — наш итог сверяется с ai.google.dev.
   */
  "gemini-3.7-flash": { input: 0.3, output: 2.5, cacheWrite: 0, cacheRead: 0.075 },
  "gemini-3.6-flash": { input: 0.3, output: 2.5, cacheWrite: 0, cacheRead: 0.075 },
  // Закрыта Google 22.08.2026 (HTTP 404 «no longer available to new users») и убрана
  // из расшифровки. Строка остаётся: по ней пересчитываются старые записи AiLog.
  "gemini-2.5-pro": { input: 1.25, output: 10, cacheWrite: 0, cacheRead: 0.31 },
  "gemini-3.1-pro-preview": { input: 2, output: 12, cacheWrite: 0, cacheRead: 0.5 },
  // Дешёвая ступень (geminiLiteModel, включена 30.08.2026): card-fill и
  // score-client идут через неё. Цена — по сводкам поставщиков на 30.08.2026
  // ($0.125 вход / $0.75 выход); как и у 3.7-flash выше, это оценка до сверки
  // с биллингом Google. Чтение кэша — 1/4 от входа, как у остальных Gemini.
  "gemini-3.1-flash-lite": { input: 0.125, output: 0.75, cacheWrite: 0, cacheRead: 0.031 },
  // Резервные модели той же линейки — без своей строки их вызовы писались бы
  // с costUsd=null и выпадали из строки «расходы на ИИ» (грабля 22.08.2026).
  "gemini-3.5-flash": { input: 0.3, output: 2.5, cacheWrite: 0, cacheRead: 0.075 },
  "gemini-3-flash-preview": { input: 0.3, output: 2.5, cacheWrite: 0, cacheRead: 0.075 },
  /**
   * ЖИВОЙ ГОЛОС (03.10.2026). До этого дня строки не было вовсе, и каждый звонок
   * робота писался в AiLog с costUsd=null — в «расходах на ИИ» звонки были
   * бесплатными. У Live API звук и текст тарифицируются по-разному, поэтому две пары
   * ставок.
   *
   * ⚠️ ЗАГЛУШКА, НЕ СВЕРЕНО С ai.google.dev/pricing: страницу с этих машин не
   * открыть (геоблок), а цен именно этих двух моделей в доступных сводках нет.
   * Ставки взяты по ближайшей известной модели того же класса (Live «native
   * audio» Flash: текст $0.50 / $2.00, звук $3.00 / $12.00 за миллион). Сверить с
   * биллингом Google и поправить здесь — пересчёт старых записей по AiLog.model.
   */
  "gemini-3.8-live": { input: 0.5, output: 2, cacheWrite: 0, cacheRead: 0.125, audioInput: 3, audioOutput: 12 },
  "gemini-3.1-flash-live-preview": {
    input: 0.5,
    output: 2,
    cacheWrite: 0,
    cacheRead: 0.125,
    audioInput: 3,
    audioOutput: 12,
  },
  // OpenAI (25.09.2026): чтение цифр с обложки ChatGPT (lib/video/coverOpenAi.ts).
  // Сама картинка gpt-image-1 считается поштучно — ai/openaiClient.ts.
  "gpt-4.1-mini": { input: 0.4, output: 1.6, cacheWrite: 0, cacheRead: 0.1 },
};

export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheWriteTokens?: number;
  cacheReadTokens?: number;
  /** Часть inputTokens/outputTokens, которая звук (см. ModelPrice.audioInput). */
  audioInputTokens?: number;
  audioOutputTokens?: number;
}

/**
 * Стоимость вызова в долларах. null — цены для модели нет: например, Gemini
 * тарифицируется у другого поставщика. Врать нулём нельзя: ноль в отчёте
 * читается как «бесплатно», а не как «неизвестно».
 */
export function estimateCostUsd(model: string | undefined, usage: TokenUsage): number | null {
  const price = model ? PER_MILLION[model] : undefined;
  if (!price) return null;

  // Звук — часть входа/выхода, не сверх него: отделяем и считаем по своей ставке.
  const input = usage.inputTokens ?? 0;
  const output = usage.outputTokens ?? 0;
  const audioIn = Math.min(input, Math.max(0, usage.audioInputTokens ?? 0));
  const audioOut = Math.min(output, Math.max(0, usage.audioOutputTokens ?? 0));
  const cost =
    ((input - audioIn) * price.input +
      audioIn * (price.audioInput ?? price.input) +
      (output - audioOut) * price.output +
      audioOut * (price.audioOutput ?? price.output) +
      (usage.cacheWriteTokens ?? 0) * price.cacheWrite +
      (usage.cacheReadTokens ?? 0) * price.cacheRead) /
    1_000_000;

  // Шесть знаков — столько же, сколько хранит колонка costUsd.
  return Math.round(cost * 1_000_000) / 1_000_000;
}
