/**
 * ПЕРЕБИВАНИЕ ТОЛЬКО НАСТОЯЩЕЙ РЕЧЬЮ (12.11.2026, звонки владельца 11.11 на ElevenLabs).
 *
 * ЧТО БЫЛО. Три звонка 11.11: робот обрывал себя на полуслове 4–7 раз за звонок
 * («Ничего, ...», «Да, Royal...», «Алло, в...»). Замер моста (журнал api rh-new):
 * эхо линии −33…−40 дБ (echoRatioDb) — это НЕ эхо своего голоса; порог подавления эха
 * при шумовом поле 8 — всего 64–86, и любой звук поверх речи робота (вздох, «э-э», шорох,
 * голоса рядом) уходил в ElevenLabs как есть. Серверный VAD агента на такой звук
 * прерывает реплику (interruption) — порога длительности перебивания в настройках
 * агента нет (справочник agents/create, поле turn: только interruption_ignore_terms —
 * точные слова, а не звуки).
 *
 * ПРАВИЛО. Пока голос робота звучит в линии, кадр речи звонящего (EchoGateDecision.speech —
 * не эхо и громче порога VAD; не bargeIn: тот строже, и тихие слоги рвали бы серию, ревью 12.11)
 * придерживается. Набралось holdFrames громких кадров подряд — это речь: придержанные
 * кадры уходят поставщику целиком (распознавание не теряет начало фразы) и дальше звук
 * идёт как есть. Серия оборвалась раньше — это был короткий звук: придержанное уходит
 * приглушённым в 4 раза (поток звука не рвётся и не сдвигается). Робот замолчал — всё
 * придержанное уходит как есть: человек начал говорить на конце реплики.
 *
 * Цена: настоящее перебивание доходит до поставщика на holdFrames × 20 мс позже.
 * Выключатель — LIVE_VOICE_BARGE_IN_HOLD_MS=0. Только для ElevenLabs: у Gemini свой
 * VAD с prefixPaddingMs (LIVE_VOICE_ACTIVITY_DETECTION), его не трогаем.
 *
 * ГОРЯЧИЙ ПУТЬ: кадр 20 мс; только массивы ссылок, без копий звука, кроме тишины.
 */

const FRAME_MS = 20;
/** По умолчанию — 240 мс: короче «алло» (~400 мс), длиннее вздоха и щелчка. ОЦЕНКА, проверить на звонке. */
export const BARGE_IN_HOLD_DEFAULT_MS = 240;
/** Больше этого не держим — человек ждал бы перебивания слишком долго. */
const BARGE_IN_HOLD_MAX_MS = 600;

/** Сколько кадров придерживать (0 — правило выключено). */
export function bargeInHoldFrames(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.LIVE_VOICE_BARGE_IN_HOLD_MS;
  const ms = raw === undefined || raw.trim() === "" ? BARGE_IN_HOLD_DEFAULT_MS : Number(raw);
  if (!Number.isFinite(ms) || ms <= 0) return 0;
  return Math.round(Math.min(ms, BARGE_IN_HOLD_MAX_MS) / FRAME_MS);
}

/** Столько тихих кадров подряд (100 мс) обрывают серию: смычки «п/т/к» и паузы между слогами короче. */
const QUIET_BREAK_FRAMES = 5;
/**
 * Короткий звук уходит приглушённым в 4 раза (−12 дБ), а не нулями (ревью 12.11.2026): «да»
 * поверх хвоста вопроса робота короче порога, и нулями распознавание его не услышало бы
 * вовсе. Приглушённый звук распознавание ещё может разобрать, а перебить робота ему труднее.
 * ОЦЕНКА — проверить звонком.
 */
const SHORT_SOUND_GAIN = 0.25;

function attenuate(frame: Int16Array): Int16Array {
  const out = new Int16Array(frame.length);
  for (let i = 0; i < frame.length; i++) out[i] = Math.round(frame[i] * SHORT_SOUND_GAIN);
  return out;
}

export class BargeInHold {
  /** Кадры с первого громкого кадра серии, ещё не отданные (громкие и тихие между ними). */
  private pending: Int16Array[] = [];
  private loudInRun = 0;
  private quietRun = 0;
  /** Серия признана речью — до конца реплики робота звук идёт как есть. */
  private open = false;
  /** Сколько коротких звуков поверх робота не дошло до поставщика (замер). */
  suppressed = 0;

  constructor(private readonly holdFrames: number) {}

  /**
   * Кадр звонящего → кадры для поставщика (0, 1 или несколько), порядок и длина потока
   * сохраняются. botOnLine — голос робота сейчас звучит в линии; loud — EchoGateDecision.bargeIn.
   */
  push(frame: Int16Array, botOnLine: boolean, loud: boolean): Int16Array[] {
    if (this.holdFrames <= 0) return [frame];
    if (!botOnLine) {
      this.open = false;
      return this.take(frame, false);
    }
    if (this.open) return [frame];
    if (this.pending.length === 0 && !loud) return [frame];
    this.pending.push(frame);
    if (loud) {
      this.loudInRun += 1;
      this.quietRun = 0;
      if (this.loudInRun >= this.holdFrames) {
        this.open = true;
        return this.take(null, false);
      }
      return [];
    }
    this.quietRun += 1;
    // Серия оборвалась, или тянется вдвое дольше порога, а громких мало — это не речь.
    if (this.quietRun >= QUIET_BREAK_FRAMES || this.pending.length >= 2 * this.holdFrames) {
      this.suppressed += 1;
      return this.take(null, true);
    }
    return [];
  }

  /** Отдать придержанное (как есть или приглушённым) и, если есть, текущий кадр. */
  private take(frame: Int16Array | null, silence: boolean): Int16Array[] {
    const out = silence ? this.pending.map(attenuate) : this.pending;
    this.pending = [];
    this.loudInRun = 0;
    this.quietRun = 0;
    if (frame) out.push(frame);
    return out;
  }
}
