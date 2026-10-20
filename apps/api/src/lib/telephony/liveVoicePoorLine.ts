/**
 * РАЗРЫВ ПЕТЛИ «ПЛОХО СЛЫШНО / ПОВТОРИТЕ» (10.10.2026, реальные звонки: звонящий говорит
 * по-таджикски при плохой слышимости, во втором звонке его друг — по-русски с акцентом;
 * робот в обоих звонках по кругу говорил «плохо слышно / не расслышал / повторите /
 * прервалось», и клиент уходил).
 *
 * Правило (промт — просьба, а не гарантия, поэтому ещё и кодом):
 *  1. Переспрашивать — не больше одного раза подряд и не больше двух за звонок, каждый раз
 *     другой короткой фразой (это в промте, LIVE_VOICE_SPEECH_RULES).
 *  2. Два переспроса подряд — третьего «повторите» НЕ будет. Как только звонящий заговорит
 *     снова, модель получает служебную реплику:
 *       - язык звонящего так и не ясен (и таджикский разрешён) — вопрос на двух языках
 *         «Тоҷикӣ ё русӣ…?» (замер 10.10: петля шла оттого, что таджикскую речь принимали
 *         за помеху; вопрос о языке её снимает);
 *       - язык ясен, или вопрос уже был, или переспросов за звонок стало три — «путь без
 *         понимания речи» (poorLineBreakNote): номер уже известен — на двух языках «Мо ба
 *         ҳамин рақам занг мезанем / Мы перезвоним на этот номер», вопрос только «удобно
 *         сейчас?», а если есть перевод — сначала предложить соединить с человеком.
 *  3. Мост пишет в расшифровку строку POOR_LINE_TRANSCRIPT_PREFIX — по ней итог звонка
 *     ставит задачу «перезвонить» тем же путём, что любое обещание звонка
 *     (liveVoiceConsultant.ts::rememberPromise → askAgentToCallBack / consultantCallbackTarget),
 *     с пометкой «плохая слышимость, язык …».
 *  4. Трубку робот первым без прощания не кладёт — прощание на языке человека.
 *
 * «Неудача понимания» — реплика САМОГО робота с просьбой повторить: модель слышит звук
 * сама, и мусорная расшифровка звонящего ещё не значит, что она его не поняла. Сама
 * расшифровка звонящего счётчик НЕ увеличивает никогда (10.10.2026, тестовый звонок
 * владельца: русская речь записана немецким и португальским). А переспрос робота после
 * реплики, которую распознавание записало чистой кириллицей, не считается неудачей
 * линии: речь была разборчивой, и уводить человека на перезвон незачем.
 */

import { classifyCallerUtterance, type CallLanguage } from "./liveVoiceCallerLanguage.js";

/** Сколько переспросов подряд — неудача понимания, после которой третьего не будет. */
export const POOR_LINE_REPROMPTS_IN_A_ROW = 2;
/** Переспросов за звонок, после которых следующий — тоже повод уйти на перезвон. */
export const POOR_LINE_REPROMPTS_PER_CALL = 2;
/** Реплика длиннее стольких слов — уже не переспрос, а ответ по делу. */
const REPROMPT_MAX_WORDS = 14;

/**
 * Признаки переспроса — русские и таджикские. Без \b и \w: по кириллице они молчат
 * (CLAUDE.md, «Ловушки»), поэтому границы — вручную через \p{L}.
 */
const REPROMPT_RE =
  /(?<!\p{L})(плохо\s+слышно|не\s+слышно|не\s+расслышал[аи]?|не\s+расслышу|не\s+разобрал[аи]?|не\s+понял[аи]?|повторите|повторить|ещё\s+раз|еще\s+раз|прервал[оа]сь|связь\s+(?:плохая|прерывается|пропадает)|вас\s+не\s+слышно|нашунидам|намешунавам|нафаҳмидам|нафахмидам|як\s+бори\s+дигар|боз\s+як\s+бор|такрор\s+кунед|алоқа\s+бад|алока\s+бад)(?!\p{L})/iu;

/** Реплика робота — просьба повторить (короткая и с признаком переспроса). */
export function isRepromptReply(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  const words = trimmed.split(/[^\p{L}]+/u).filter(Boolean).length;
  return words <= REPROMPT_MAX_WORDS && REPROMPT_RE.test(trimmed);
}

/** Состояние одного звонка. Без побочных эффектов: решение возвращает наружу. */
export class PoorLineTracker {
  private turnText = "";
  /** Реплика звонящего перед текущим ходом модели (кусками). */
  private callerTurnText = "";
  private inARow = 0;
  private total = 0;
  private asked = false;
  private broken = false;

  /** Кусок расшифровки ответа модели. */
  onModelText(chunk: string): void {
    if (this.turnText.length < 2_000) this.turnText += chunk;
  }

  /** Модель закончила ход: переспрос или ответ по делу. */
  onModelTurnComplete(): void {
    const text = this.turnText;
    const callerSaid = this.callerTurnText;
    this.turnText = "";
    this.callerTurnText = "";
    if (!text.trim()) return;
    // Звонящего распознали чистой кириллицей — линия в порядке: переспрос не в счёт.
    const callerClear = classifyCallerUtterance(callerSaid) !== "unclear";
    if (isRepromptReply(text)) {
      if (callerClear) return;
      this.inARow += 1;
      this.total += 1;
    } else {
      this.inARow = 0;
    }
  }

  /** Клиент перебил — недоговорённая реплика не считается. */
  onInterrupted(): void {
    this.turnText = "";
  }

  /**
   * Звонящий снова заговорил. "ask" — спросить язык (один раз), "callback" — уйти на путь без
   * понимания речи (один раз за звонок); null — ничего. languageKnown — язык звонящего уже
   * ясен (или замок «только русский»): тогда вопрос о языке пропускается.
   */
  onCallerText(chunk: string, languageKnown: boolean): "ask" | "callback" | null {
    if (this.callerTurnText.length < 2_000) this.callerTurnText += chunk;
    if (!chunk.trim() || this.broken) return null;
    const tooMany = this.total > POOR_LINE_REPROMPTS_PER_CALL;
    const looping = this.inARow >= POOR_LINE_REPROMPTS_IN_A_ROW;
    if (!tooMany && !looping) return null;
    if (!tooMany && !this.asked && !languageKnown) {
      this.asked = true;
      // Вопрос о языке — реплика не-переспрос: счёт подряд начнётся заново после него.
      this.inARow = 0;
      return "ask";
    }
    this.broken = true;
    return "callback";
  }
}

/** Начало строки расшифровки, по которой итог звонка ставит задачу «перезвонить». */
export const POOR_LINE_TRANSCRIPT_PREFIX = "[плохая слышимость]";

function languageName(language: CallLanguage | null): string {
  return language === "tg" ? "таджикский" : language === "ru" ? "русский" : "не определён";
}

/** Строка расшифровки: «[плохая слышимость] … (язык: …)». */
export function poorLineTranscriptLine(language: CallLanguage | null): string {
  return `${POOR_LINE_TRANSCRIPT_PREFIX} робот дважды не разобрал речь — предложил перезвон на номер звонящего (язык: ${languageName(language)})`;
}

/** Пометка для задачи «перезвонить» — из строки расшифровки; null — строки нет. */
export function poorLineCallbackNote(transcript: readonly string[]): string | null {
  const line = transcript.find((l) => l.startsWith(POOR_LINE_TRANSCRIPT_PREFIX));
  if (!line) return null;
  const language = /язык: ([^)]+)\)/u.exec(line)?.[1] ?? "не определён";
  return `плохая слышимость, язык: ${language}`;
}

/** Фразы перезвона — таджикская первой (решение владельца 10.10.2026). */
export const POOR_LINE_CALLBACK_TG = "Мо ба ҳамин рақам занг мезанем";
export const POOR_LINE_CALLBACK_RU = "Мы перезвоним на этот номер";

/**
 * Служебная реплика «путь без понимания речи» (текст в скобках не для озвучивания).
 * tajikAllowed — замок «только русский» снят: тогда на двух языках, таджикский первым;
 * с замком — только по-русски (таджикского текста в таком звонке нет).
 * numberKnown — номер пришёл со звонком; скрыт — перезванивать некуда, просим набрать нас.
 */
export function poorLineBreakNote(opts: { tajikAllowed: boolean; numberKnown: boolean }): string {
  const callback = opts.numberKnown
    ? opts.tajikAllowed
      ? `«${POOR_LINE_CALLBACK_TG}. ${POOR_LINE_CALLBACK_RU}» — и спроси только одно: «Ҳозир барои шумо қулай аст? Вам сейчас удобно?»`
      : `«${POOR_LINE_CALLBACK_RU}» — и спроси только одно: «Вам сейчас удобно?»`
    : opts.tajikAllowed
      ? "что связь плохая и чтобы человек перезвонил нам ещё раз — по-таджикски и по-русски, коротко («Алоқа бад аст, лутфан боз занг занед. Связь плохая — перезвоните нам, пожалуйста»)"
      : "что связь плохая и чтобы человек перезвонил нам ещё раз («Связь плохая — перезвоните нам, пожалуйста»)";
  return (
    "(Служебное: ты уже дважды не разобрал человека. Повторить больше НЕ проси и «плохо слышно» не говори. " +
    "Если у тебя есть transfer_to_agent — сначала одной фразой предложи соединить с живым человеком прямо сейчас; на «да» соединяй. " +
    `Иначе одной короткой фразой скажи ${callback} ` +
    "Звонок агента уже записан — функцию для этого звать не нужно. Трубку первым не клади: дождись ответа и попрощайся на языке человека" +
    (opts.tajikAllowed ? " (не ясен — сначала по-таджикски, потом по-русски)" : "") +
    ". Эту пометку вслух не читай.)"
  );
}
