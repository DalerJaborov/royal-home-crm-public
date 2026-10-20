/**
 * Звуки уведомлений приложения — генерируются WebAudio, без файлов и сэмплов.
 * Ленивый AudioContext: создаётся при первом реальном вызове, а не при импорте
 * модуля (до первого клика AudioContext всё равно будет suspended браузером).
 *
 * Дизайн звука (08.09.2026, по просьбе владельца — «как у iPhone, не раздражают»):
 * мягкие, короткие, синтезированные тона в духе системных звуков iOS/macOS —
 * не копия чужих сэмплов, свой синтез. Один общий мастер-гейн (0.6).
 *
 * Тумблер «Звуки уведомлений» (09.09.2026, переименован из «Звуки ИИ»
 * 15.09.2026 после удаления знака ИИ — тумблер и его назначение те же, только
 * название не привязано к удалённой функции): единая точка проверки — ЗДЕСЬ,
 * в `soundsAllowed()`. Модуль читает `useUiPrefs.getState().aiSoundsEnabled`
 * напрямую — да, модуль больше не агностик к стору, но одна точка правды
 * стоит этого узкого связывания; разрозненные проверки в компонентах убраны.
 *
 * Что здесь озвучено — общие события приложения, не знак ИИ (тот удалён
 * 15.09.2026 вместе со своими звуками «приветствие/тап/готово/внимание»):
 * новый лид, новое сообщение, входящий звонок, тихий тик ленты пульта,
 * успех/отказ действия.
 *
 * Автоплей-политика: любые ошибки (контекст заблокирован, вкладка без фокуса,
 * браузер отказал в создании контекста) проглатываются молча — звук
 * необязателен, UI не должен падать или шуметь в консоль из-за него.
 */

import { useUiPrefs } from "../store/uiPrefs";
import { dushanbeHour } from "./date";

let ctx: AudioContext | null = null;
let masterGain: GainNode | null = null;

/** Единая точка: звук разрешён, только если тумблер включён. */
function soundsAllowed(): boolean {
  try {
    return useUiPrefs.getState().aiSoundsEnabled;
  } catch {
    // Стор не инициализирован (нереалистично в браузере, но на всякий случай) — тихо, без звука.
    return false;
  }
}

/**
 * ТИХИЕ ЧАСЫ ДЛЯ ЗВУКОВ (владелец 12.09.2026, то же окно, что у пушей:
 * 21:00 → 08:00 по Душанбе — см. apps/api/src/lib/pushQuietHours.ts).
 *
 * ЧТО МОЛЧИТ, А ЧТО НЕТ. Тишина накрывает только звуки СОБЫТИЙ — тех, что
 * приходят сами: новый лид, сообщение клиента, входящий звонок, новое дело
 * на пульте. Отклики на СОБСТВЕННОЕ действие человека («сохранено», «не
 * удалось») ночью не глушатся: он сам только что нажал кнопку и ждёт ответа —
 * молчание здесь читается как «не сработало».
 *
 * Час берётся по Душанбе, а не по часам устройства: владелец открывает CRM и в
 * поездке, и правило «ночью тихо» относится к рабочему дню агентства, а не к
 * местному времени телефона.
 */
const QUIET_FROM_HOUR = 21;
const QUIET_TO_HOUR = 8;

export function isQuietHourDushanbe(now = new Date()): boolean {
  const h = dushanbeHour(now);
  return h >= QUIET_FROM_HOUR || h < QUIET_TO_HOUR;
}

/** Звук СОБЫТИЯ (пришло само): тумблер плюс тихие часы. */
function eventSoundsAllowed(): boolean {
  return soundsAllowed() && !isQuietHourDushanbe();
}

function getContext(): AudioContext | null {
  if (ctx) return ctx;
  try {
    const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    ctx = new Ctor();
    return ctx;
  } catch {
    return null;
  }
}

/** Мастер-шина: один GainNode(0.6) → destination, переиспользуется всеми звуками. */
function getMaster(c: AudioContext): GainNode {
  if (masterGain) return masterGain;
  const g = c.createGain();
  g.gain.value = 0.6;
  g.connect(c.destination);
  masterGain = g;
  return g;
}

/** Вызывать из первого обработчика клика/тапа пользователя за сессию — на
 *  части браузеров (Safari/iOS, Chrome с автоплей-политикой) AudioContext
 *  создаётся в suspended состоянии, пока не появится жест пользователя. */
export function unlockAudio(): void {
  if (!soundsAllowed()) return;
  try {
    const c = getContext();
    if (c && c.state === "suspended") {
      void c.resume().catch(() => {});
    }
  } catch {
    // тихо — звук не критичен
  }
}

/** Один тон: sine (+ немного triangle для тепла), с ADSR-подобной огибающей и
 *  опциональным vibrato. Возвращает ничего — подключает сама к переданной шине. */
function playTone(
  c: AudioContext,
  dest: AudioNode,
  {
    freq,
    start,
    attack,
    duration,
    peak,
    type = "sine",
    detuneTriangleMix = 0,
    vibratoHz,
    vibratoCents,
    lowpassStart,
    lowpassEnd,
  }: {
    freq: number;
    start: number;
    attack: number;
    duration: number;
    peak: number;
    type?: OscillatorType;
    /** 0..1 — доля треугольной волны, подмешанной к синусу для тепла тембра. */
    detuneTriangleMix?: number;
    vibratoHz?: number;
    vibratoCents?: number;
    lowpassStart?: number;
    lowpassEnd?: number;
  }
) {
  const osc = c.createOscillator();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, start);

  const gain = c.createGain();
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(Math.max(peak, 0.0002), start + attack);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);

  let node: AudioNode = osc;
  if (lowpassStart != null && lowpassEnd != null) {
    const filter = c.createBiquadFilter();
    filter.type = "lowpass";
    filter.Q.value = 0.7;
    filter.frequency.setValueAtTime(lowpassStart, start);
    filter.frequency.linearRampToValueAtTime(lowpassEnd, start + attack + duration * 0.6);
    osc.connect(filter);
    node = filter;
  }
  node.connect(gain);
  gain.connect(dest);

  osc.start(start);
  osc.stop(start + duration + 0.05);

  if (vibratoHz && vibratoCents) {
    const lfo = c.createOscillator();
    lfo.type = "sine";
    lfo.frequency.value = vibratoHz;
    const lfoGain = c.createGain();
    lfoGain.gain.value = vibratoCents; // в центах — подключаем к detune
    lfo.connect(lfoGain);
    lfoGain.connect(osc.detune);
    lfo.start(start);
    lfo.stop(start + duration + 0.05);
  }

  if (detuneTriangleMix > 0) {
    const osc2 = c.createOscillator();
    osc2.type = "triangle";
    osc2.frequency.setValueAtTime(freq, start);
    const gain2 = c.createGain();
    gain2.gain.setValueAtTime(0.0001, start);
    gain2.gain.exponentialRampToValueAtTime(Math.max(peak * detuneTriangleMix, 0.0002), start + attack);
    gain2.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    osc2.connect(gain2);
    gain2.connect(dest);
    osc2.start(start);
    osc2.stop(start + duration + 0.05);
  }
}

/**
 * «Тихий сигнал о новом деле» пульта директора — spec-pult-v8-07-09.md §7:
 * два синуса 660 и 880 Гц (квинта, мягче "тика" колёсика iOS), второй с
 * задержкой 20 мс, атака 8 мс, пик 0.12/0.08, экспоненциальное затухание до
 * 0.0001 за ~120 мс. Гейты (document.hidden, prefers-reduced-motion, троттлинг
 * 1 раз/3 мин и 8/час) — НЕ здесь, это ответственность `lib/pultSound.ts`:
 * этот модуль ничего не знает про React/тикер/настройки, только звук.
 */
export function playSoftTick(): void {
  if (!eventSoundsAllowed()) return;
  try {
    const c = getContext();
    if (!c) return;
    const master = getMaster(c);
    const now = c.currentTime;
    playTone(c, master, { freq: 660, start: now, attack: 0.008, duration: 0.128, peak: 0.12 });
    playTone(c, master, { freq: 880, start: now + 0.02, attack: 0.008, duration: 0.128, peak: 0.08 });
  } catch {
    // тихо — звук необязателен
  }
}

/**
 * ЗВУКИ СОБЫТИЙ (владелец 12.09.2026: «все звуки, которых нет, добавь и
 * доработай, и там, где можно добавить»).
 *
 * До этого дня звучало только новое дело в ленте пульта. Событий, ради
 * которых человек держит CRM открытой, не звучало ни одного: новый лид,
 * сообщение клиента, входящий звонок, сохранение, отказ.
 *
 * ФАЙЛОВ ЗВУКОВ В ПРОЕКТЕ НЕТ ВООБЩЕ (apps/web/public — только иконки, заставки
 * и шрифты), и выдумывать их нельзя. Поэтому все звуки синтезируются одним и
 * тем же WebAudio и одним и тем же playTone: одна мастер-шина, один реверб,
 * одна громкость. Побочная польза — ноль байт в бандле и ни одного запроса
 * к сети.
 *
 * ГРОМКОСТЬ держится в той же вилке, что у существующих (пик 0.05…0.12
 * линейно, то есть примерно от -26 до -18 dBFS): звук обязан быть заметен
 * боковым слухом и не обязан перекрикивать разговор с клиентом.
 */

/** Новый лид: две ноты вверх (C5 → G5), мягко. Пик ≈ -22 dBFS. */
export function playNewLead(): void {
  if (!eventSoundsAllowed()) return;
  try {
    const c = getContext();
    if (!c) return;
    const master = getMaster(c);
    const now = c.currentTime;
    const peak = 0.08;
    playTone(c, master, { freq: 523.25, start: now, attack: 0.01, duration: 0.16, peak });
    playTone(c, master, { freq: 783.99, start: now + 0.14, attack: 0.01, duration: 0.24, peak, vibratoHz: 5, vibratoCents: 5 });
  } catch {
    // тихо
  }
}

/** Сообщение клиента: одна короткая нота A5, тише лида — их бывает много. */
export function playNewMessage(): void {
  if (!eventSoundsAllowed()) return;
  try {
    const c = getContext();
    if (!c) return;
    const master = getMaster(c);
    const now = c.currentTime;
    playTone(c, master, { freq: 880, start: now, attack: 0.006, duration: 0.11, peak: 0.06 });
    playTone(c, master, { freq: 1174.66, start: now + 0.055, attack: 0.006, duration: 0.09, peak: 0.035 });
  } catch {
    // тихо
  }
}

/**
 * Входящий звонок: три коротких импульса — единственный звук, который обязан
 * дозваться, а не сообщить. Тихие часы на него НЕ действуют, ровно как и на
 * одноимённый пуш (lib/pushQuietHours.ts, `realtime`): телефон звонит сейчас.
 */
export function playIncomingCall(): void {
  if (!soundsAllowed()) return;
  try {
    const c = getContext();
    if (!c) return;
    const master = getMaster(c);
    const now = c.currentTime;
    for (let i = 0; i < 3; i += 1) {
      const t = now + i * 0.22;
      playTone(c, master, { freq: 987.77, start: t, attack: 0.006, duration: 0.12, peak: 0.1 });
      playTone(c, master, { freq: 659.25, start: t + 0.06, attack: 0.006, duration: 0.12, peak: 0.07 });
    }
  } catch {
    // тихо
  }
}

/**
 * Успех действия — «сохранено», «передано», «одобрено». Отклик на СОБСТВЕННОЕ
 * действие, поэтому тихие часы не глушат: человек только что нажал кнопку.
 * Тембр тот же, что у playDone, но короче — таких событий за день десятки.
 */
export function playSuccess(): void {
  if (!soundsAllowed()) return;
  try {
    const c = getContext();
    if (!c) return;
    const master = getMaster(c);
    const now = c.currentTime;
    playTone(c, master, { freq: 659.25, start: now, attack: 0.008, duration: 0.1, peak: 0.05 });
    playTone(c, master, { freq: 987.77, start: now + 0.07, attack: 0.008, duration: 0.16, peak: 0.05 });
  } catch {
    // тихо
  }
}

/** Отказ: две ноты ВНИЗ (A4 → E4), заметно, но без сирены. Тоже отклик на своё действие. */
export function playError(): void {
  if (!soundsAllowed()) return;
  try {
    const c = getContext();
    if (!c) return;
    const master = getMaster(c);
    const now = c.currentTime;
    const peak = 0.07;
    playTone(c, master, { freq: 440, start: now, attack: 0.008, duration: 0.14, peak });
    playTone(c, master, { freq: 329.63, start: now + 0.13, attack: 0.008, duration: 0.22, peak });
  } catch {
    // тихо
  }
}

