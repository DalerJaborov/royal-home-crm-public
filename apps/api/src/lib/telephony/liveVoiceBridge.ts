import dgram from "node:dgram";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import WebSocket from "ws";
import { prisma } from "../../db.js";
import {
  addChannelToBridge,
  answerChannel,
  createBridge,
  createExternalMediaChannel,
  deleteBridge,
  DIALPLAN_CONTEXT,
  continueInDialplan,
  hangupCall,
  isDialableTajikNumber,
  listActiveChannels,
  listBridges,
  loadAriCredentials,
  type AriCredentials,
  normalizeDialNumber,
  originateToStasisApp,
  playChannelSound,
  readChannelVariable,
} from "./ariClient.js";
import { startPingWatchdog } from "./ariPingWatchdog.js";
import type { AriChannel, AriEvent } from "./ariTypes.js";
import {
  liveVoiceSpeechLanguageCode,
  type LiveVoiceActivityDetection,
  type LiveVoiceFunctionDeclaration,
  type LiveVoiceToolCall,
  type LiveVoiceTranscriptEvent,
} from "../../ai/liveVoiceClient.js";
import { liveVoiceInputTranscriptionConfig, liveVoiceTranscriptionHintLanguage } from "../../ai/liveVoiceTranscriptionHints.js";
import {
  foreignLanguageFarewellTrigger,
  languageCorrectionText,
  LiveVoiceReplyGuard,
  OFF_CATALOG_DEDUP_KEY,
  offCatalogLogMessage,
  offCatalogTranscriptLine,
  toolResultTranscriptLine,
  type ReplyGuardFinding,
} from "./liveVoiceGuards.js";
import {
  classifyCallerUtterance,
  callerLanguageAskAfterRepromptsNote,
  callerLanguageAskNote,
  callerLanguageSwitchNote,
  createCallerLanguageTracker,
  type CallerLanguageAction,
  type CallerLanguageTracker,
} from "./liveVoiceCallerLanguage.js";
import { PoorLineTracker, poorLineBreakNote, poorLineTranscriptLine } from "./liveVoicePoorLine.js";
import { loadMoneyContext } from "../money.js";
import {
  buildLiveVoiceSystemPrompt,
  LIVE_VOICE_SYSTEM_PROMPT,
  LIVE_VOICE_PROMPT_VERSION,
  type LiveVoicePromptSettings,
} from "../../ai/liveVoicePersona.js";
import { describeError } from "../describeError.js";
import { logSystemError } from "../systemError.js";
import { LIVE_VOICE_STATION_AUDIO_RETRY_MS, NO_STATION_AUDIO_REASON } from "./liveVoiceAudioPath.js";
import {
  expectedRtpPeer,
  externalMediaHost,
  externalMediaPort,
  liveVoiceRtpProblem,
  parseStationRtpTarget,
  rtpSourceMatchesTarget,
} from "./liveVoiceRtpConfig.js";
import { toSmsPhone } from "../sms/phone.js";
import { recordCallbackRequest } from "../callbackRequests.js";
import { invokeLiveVoiceTranscriptionObserver, type LiveVoiceTranscriptionObservation } from "../../ai/liveVoiceTranscription.js";
import { isR2Configured, r2Upload } from "../r2Client.js";
import { LIVE_VOICE_RECORDING_PREFIX } from "./callRecordings.js";
import { sanitizeSpokenName } from "../spokenName.js";
import { createNotifications } from "../notifications.js";
import { sendPushToAgents } from "../../push.js";
import { emptyUsage, logAiCall, type SpentTokens } from "../../ai/shared.js";
import { GEMINI_LIVE_MODEL } from "../../ai/geminiTransport.js";
import { findAgentsWithPermission } from "../recipients.js";
import * as liveVoiceMonitor from "./liveVoiceMonitor.js";
import { notifyRobotTookInboundCall } from "./liveVoiceInboundPush.js";
import { selfGenderForCall, withSelfGenderReminderFor, withSelfGenderRuleFor } from "../../ai/liveVoiceSelfGender.js";
import {
  bufferToInt16LE,
  createLineToModelInterpolator,
  int16ToBufferLE,
  lowPassForRate,
  resamplePcm16,
  StreamingDecimator,
  StreamingInterpolator,
  ulawDecode,
  ulawEncode,
  designLowPassFir,
} from "./pcmCodec.js";
import { formatLiveVoiceMetricsLine, LiveVoiceMetricsTracker } from "./liveVoiceMetrics.js";
import { frameEnergy, LiveVoiceEchoGate, VAD_SPEECH_ENERGY_THRESHOLD } from "./liveVoiceEchoGate.js";
import {
  createLiveVoiceProviderClient,
  loadLiveVoiceProviderConfig,
  type LiveVoiceLanguage,
  type LiveVoiceProviderClient,
  type LiveVoiceProviderConfig,
  type LiveVoiceProviderName,
} from "../../ai/liveVoiceProvider.js";

// Чистые функции звука живут в pcmCodec.ts (02.10.2026) — здесь переизлучаются,
// чтобы прежние импорты из моста (тесты, соседние модули) не менялись.
export {
  bufferToInt16LE,
  designLowPassFir,
  int16ToBufferLE,
  resamplePcm16,
  StreamingDecimator,
  StreamingInterpolator,
  ulawDecode,
  ulawEncode,
};

/**
 * МОСТ МЕЖДУ ARI И GEMINI LIVE — пункт 5 очереди ИИ, 23.08.2026.
 *
 * ГЛАВНОЕ ПРАВИЛО ИЗОЛЯЦИИ: этот файл НЕ ИМПОРТИРУЕТ и не трогает ничего из
 * обычной маршрутизации звонков агентства (callTracker.ts, incomingCalls.ts, тот
 * websocket в ariEvents.ts, что слушает app=royal-home-crm) — только
 * loadAriCredentials (чтение тех же кредов, без побочных эффектов) и
 * startPingWatchdog (утилита keep-alive сокета, не завязанная на состояние звонков).
 * Живой голос открывает СВОЙ, ВТОРОЙ ARI websocket, подписанный на СВОЁ,
 * ОТДЕЛЬНОЕ Stasis-приложение (`royalhome-live-voice`) — станция направит сюда
 * канал, только если владелец САМ на самой станции (вне этого репозитория)
 * заведёт тестовый внутренний номер и пропишет его в `Stasis(royalhome-live-voice)`.
 * Пока этого не сделано, приложение никогда не получит ни одного канала — обычные
 * from-internal/очередь 1000/звонки агентов идут ровно как раньше.
 *
 * ⚠️ ЧЕСТНО О ПРОВЕРЕННОСТИ (23.08.2026): звук нельзя проверить тестами вообще.
 * Юнит-тестами покрыты только чистые функции ниже (resamplePcm16, кадрирование
 * RTP, сборка/разбор RTP-пакета, решение «принимать ли канал»). Всё остальное —
 * реальные ARI REST-вызовы, реальный dgram-сокет, реальное соединение с Gemini —
 * НЕ ИСПЫТАНО ни разу, потому что испытать это может только настоящий звонок на
 * живую станцию, а его ещё не было.
 *
 * ⚠️ ОТДЕЛЬНАЯ, НЕРЕШЁННАЯ ИНФРАСТРУКТУРНАЯ ЗАГВОЗДКА: аудио между Asterisk и этим
 * процессом идёт по RTP by UDP (см. ariClient.ts → createExternalMediaChannel), а
 * существующий обратный туннель со станции (docs/telephony-sip-numbering.md)
 * пробрасывает только TCP-порты ARI (8088) и AMI (5038). Проброс произвольного
 * UDP-порта для RTP туда НЕ входит — это отдельная настройка туннеля/станции,
 * без которой Asterisk физически не сможет доставить сюда ни одного аудио-пакета,
 * даже если Stasis-маршрутизация настроена идеально. См. LIVE_VOICE_RTP_HOST ниже.
 */

/** Имя Stasis-приложения — СВОЁ, не пересекается ни с чем существующим (ariClient.ts
 *  явно говорит, что своих Stasis-приложений на станции раньше не заводили вовсе). */
export const LIVE_VOICE_ARI_APP = "royalhome-live-voice";

/**
 * ГОЛОС МОДЕЛИ (эксперимент 12.09.2026, второй заход — владелец попросил
 * девушку, чистый русский). 30 голосов различаются ХАРАКТЕРОМ подачи
 * (Bright/Firm/Breathy/Warm…), а не языком или акцентом — акцент это не лечит
 * (см. докстринг liveVoicePersona.ts). `Enceladus` (Breathy) звучал мужским
 * голосом на живом звонке — заменён на `Kore`, у Google описан как «твёрдый,
 * чёткий женский» (community-сверка, официального гендерного списка Google
 * не публикует) — тот же голос уже используется по умолчанию в остальной CRM
 * (ai/tts.ts:VOICE_NAME), единообразие с озвучкой приветствия/подсказок.
 */
export const LIVE_VOICE_VOICE_NAME = process.env.LIVE_VOICE_VOICE_NAME || "Kore";

/**
 * СЛУЖЕБНАЯ РЕПЛИКА, ЗАПУСКАЮЩАЯ ПЕРВУЮ ФРАЗУ БОТА (12.09.2026).
 *
 * Live API отвечает только на входящую реплику — без неё модель молча ждёт,
 * пока не заговорит собеседник (см. LiveVoiceClient.sendText). Текст этой
 * реплики модель НЕ произносит буквально и не показывает собеседнику — это
 * инструкция «начни разговор», которую персона (liveVoicePersona.ts) уже умеет
 * превращать в приветствие по образцам из AGENCY_VOICE.
 *
 * НЕСКОЛЬКО ВАРИАНТОВ, А НЕ ОДИН (12.09.2026, разбор человечности голоса) —
 * с единственной формулировкой триггера модель на разных звонках всё равно
 * тяготеет к одной и той же самой вероятной фразе-открытию (то же самое
 * «наиболее вероятное продолжение», что и с людьми даёт одинаковые ответы на
 * один и тот же промт). Реальные звонки разных агентов не звучат словно
 * зачитан один и тот же скрипт — рандомизация здесь дешёвый способ этого
 * добиться, не трогая обязательное содержание приветствия (см. персону).
 */
const LIVE_VOICE_GREETING_TRIGGERS = [
  "(Разговор только что начался. Сразу поздоровайся и представься.)",
  "(Звонок только что подключился, ты набираешь номер. Поздоровайся и представь агентство — своими словами, не шаблоном.)",
  "(Собеседник только что снял трубку. Начни разговор: поздоровайся, скажи, откуда звонишь.)",
];

function pickLiveVoiceGreetingTrigger(): string {
  return LIVE_VOICE_GREETING_TRIGGERS[Math.floor(Math.random() * LIVE_VOICE_GREETING_TRIGGERS.length)];
}

/** Экспортирован (14.09.2026) — та же служебная реплика нужна прослушке голоса
 *  в Настройках (ai/liveVoiceClient.ts::previewLiveVoiceGreeting), чтобы
 *  прослушка реально запускала ту же модель тем же приёмом, что настоящий
 *  звонок, а не изображала его отдельной, слегка другой строкой. Прослушка
 *  берёт первый (не случайный) вариант — ей важна воспроизводимость одного
 *  прогона, а не разнообразие настоящих звонков. */
export const LIVE_VOICE_GREETING_TRIGGER = LIVE_VOICE_GREETING_TRIGGERS[0];

/**
 * ЧУВСТВИТЕЛЬНОСТЬ ОПРЕДЕЛЕНИЯ РЕЧИ (12.09.2026, разбор человечности голоса —
 * веб-поиск по практике LiveKit/Retell/Vapi + документация ai.google.dev/api/live).
 *
 * Не задано вовсе раньше — Gemini Live использовала свои значения по умолчанию,
 * а документация прямо предупреждает: `silenceDurationMs` ниже 500 мс рвёт ОДНУ
 * фразу собеседника на несколько маленьких кусков (модель решает, что человек
 * договорил, хотя он просто на долю секунды задумался посреди мысли) — ровно то,
 * от чего в проекте уже лечили function calling (бот терял конец фразы). 700 мс —
 * середина рекомендованного диапазона 500–800 мс: для консультации по недвижимости
 * это ближе к «слушающему агенту», чем к боту быстрой еды (тот же принцип, что
 * Retell описывает как разницу настройки для ресторана и для ресепшена клиники).
 * 02.10.2026: снижено до 500 мс — нижняя граница того же диапазона. Вместе с LOW
 * и задержкой модели пауза перед ответом выходила 1,5–2,5 с (жалоба владельца).
 * ⚠️ По сообщению в js-genai #1467 (не проверено) запасная
 * gemini-3.1-flash-live-preview это поле игнорирует.
 *
 * `endOfSpeechSensitivity: LOW` — тот же эффект с другой стороны: не считать
 * разговор собеседника оконченным по первой же короткой паузе.
 *
 * `startOfSpeechSensitivity: LOW` — отдельная причина, не про терпение: без неё
 * модель может принять короткий вдох, ситуационный шум в трубке или своё же эхо
 * за начало реплики собеседника и перебить саму себя (see generateBreathSound/
 * generateComfortNoiseFrame выше — это НЕ тот же тракт, что приём звука от
 * собеседника, но микрофон на стороне звонящего свой шум и наводки даёт всегда).
 * Ровно то различение «настоящая реплика vs короткий звук/бэкчаннел», которое у
 * Retell/Vapi — отдельная настраиваемая ручка; здесь это единственный рычаг,
 * который открыто даёт сама Gemini Live.
 */
const LIVE_VOICE_ACTIVITY_DETECTION: LiveVoiceActivityDetection = {
  startOfSpeechSensitivity: "START_SENSITIVITY_LOW",
  endOfSpeechSensitivity: "END_SENSITIVITY_LOW",
  // 02.10.2026: 700 → 500 (аудит моста З-3) — пауза перед ответом была 1,5–2,5 с.
  silenceDurationMs: 500,
  // 24.09.2026: 200 мс «разгона» перед началом речи — единственное, что помогло
  // на форуме Google тем, у кого сотовый оператор возвращал боту его же голос и
  // модель перебивала сама себя (эхо на SIP, подтверждено и на gemini-3.8-live).
  // Вторая половина защиты — глушение эха у нас, см. ECHO_TAIL_MS ниже.
  prefixPaddingMs: 200,
};

/**
 * ЗАЩИТА ОТ ЭХА (24.09.2026). Сотовая линия возвращает часть голоса бота обратно
 * в микрофонный канал; серверный VAD Gemini принимает это за речь собеседника,
 * шлёт `interrupted` — и бот обрывает сам себя на полуслове. Жалоба известная
 * (форум Google, май и 21.09.2026, ответа Google нет).
 *
 * Пока бот говорит и ещё ECHO_TAIL_MS после последнего своего кадра, тихие кадры
 * со стороны звонящего уходят в модель тишиной; громкие (громче
 * ECHO_BARGE_IN_ENERGY) — как есть, чтобы человек по-прежнему мог перебить.
 * Эхо на линии заметно тише живой речи в трубку. Запись звонка получает
 * настоящий звук, глушится только то, что уходит в модель.
 *
 * 10.10.2026: постоянный порог заменён порогом от самой линии (уровень бота × оценка
 * эха, шумовой пол) — замер и формулы в liveVoiceEchoGate.ts; выключатель
 * LIVE_VOICE_ADAPTIVE_ECHO=0 возвращает постоянные ECHO_BARGE_IN_ENERGY и
 * VAD_SPEECH_ENERGY_THRESHOLD.
 */
export { ECHO_TAIL_MS, ECHO_BARGE_IN_ENERGY, frameEnergy, shouldSuppressAsEcho } from "./liveVoiceEchoGate.js";

/** Порог сжатия контекста Live-сессии (24.09.2026). Google перечитывает весь
 *  накопленный контекст на каждом ходе и берёт за это деньги; 25 токенов на
 *  секунду звука дают ~24 тыс. токенов примерно за 15 минут разговора. Выше
 *  порога начало разговора сжимается скользящим окном, и сессия не обрывается
 *  по 15-минутному пределу. */
/*
 * 40 ТЫСЯЧ С 24.09.2026 (консультант на входящих). У консультанта один справочник
 * агентства весит ~12 тыс. токенов (ai/liveVoiceKnowledge.ts), и при пороге 24 тыс.
 * на сам разговор оставалось ~4 минуты: дальше сжатие съедало начало, а в нём имя
 * звонящего и что он ищет. 40 тыс. держат ~10 минут разговора целиком.
 */
const LIVE_VOICE_COMPRESSION_TRIGGER_TOKENS = 40_000;

/**
 * ФРАЗА-ИЗВИНЕНИЕ НА ТАДЖИКСКОМ, ОДИН РАЗ ЗА ЗВОНОК (13.09.2026, разбор
 * «замок держит русский, даже если клиент прямо заговорил на таджикском» —
 * см. TASKS.md). Замок (LIVE_VOICE_RUSSIAN_ONLY_OVERRIDE, liveVoicePersona.ts)
 * остаётся включённым ПОСЛЕ этой фразы — она не отменяет замок, а просто
 * объясняет его вслух один раз, вместо того чтобы молча перейти на русский
 * без единого таджикского слова.
 *
 * ТОТ ЖЕ ПРИЁМ, ЧТО У LIVE_VOICE_GREETING_TRIGGER ВЫШЕ — служебная реплика
 * от лица «пользователя» через gemini.sendText, а не правка системного
 * промта на лету: системную инструкцию нельзя поменять посреди уже идущей
 * Live-сессии, а разовую текстовую реплику — можно.
 *
 * СРАБАТЫВАЕТ ПО КОДУ (detectClientLanguage — ai/clientLanguage.ts), А НЕ ПО
 * СОБСТВЕННОЙ ИНИЦИАТИВЕ МОДЕЛИ: прежний текст замка в liveVoicePersona.ts
 * лишь просил модель «если уместно, один раз мягко скажи...» — понадеяться,
 * что модель сама заметит момент и не повторит фразу, ненадёжнее, чем то же
 * решение, принятое кодом по транскрипту (см. wireGeminiEvents, обработчик
 * "transcript") — тем же принципом, что и весь модуль ai/clientLanguage.ts.
 *
 * ⚠️ НЕ ИСПЫТАНО живым звонком (как и остальной живой голос, см. докстринг
 * файла) — sendText здесь уходит уже ПОСРЕДИ идущей аудио-сессии, а не до
 * первого байта звука, как у LIVE_VOICE_GREETING_TRIGGER; поведение Live API
 * в этот момент не проверено на настоящем звонке.
 */
const LIVE_VOICE_TAJIK_APOLOGY_TRIGGER =
  "(Собеседник только что сказал фразу на таджикском, а тебе включён замок — весь разговор должен идти по-русски. " +
  "Скажи СЕЙЧАС одну короткую фразу-извинение на таджикском, например «Мебахшед, ман бо забони русӣ ҳарф мезанам» " +
  "(или похожую по смыслу), и СРАЗУ ЖЕ продолжи разговор ПО-РУССКИ, как и раньше. Это извинение — только один раз " +
  "за весь звонок: дальше отвечай по-русски без исключений, даже если собеседник продолжит говорить по-таджикски.)";

/**
 * СТОРОЖ ТИШИНЫ СО СТОРОНЫ ЗВОНЯЩЕГО (02.10.2026, аудит надёжности робозвонка).
 *
 * Линия у консультанта одна (liveVoiceLineBusy), а сессия до этой правки жила,
 * пока не положит трубку человек, не попрощается модель или не выйдет потолок
 * LIVE_VOICE_MAX_SESSION_MS — пятнадцать минут. Звонящий, который молчит
 * (звук идёт только в одну сторону, трубку оставили на столе, сорвался RTP),
 * держал линию все пятнадцать минут, и каждый следующий звонящий уходил на
 * автоответчик.
 *
 * Речь звонящего — это либо его реплика в расшифровке, либо громкий кадр от
 * него (тот же порог, что у локального VAD, и не эхо бота — см. ECHO_TAIL_MS).
 * Пока бот говорит сам, тишина не считается: человек слушает.
 *  - NO_SPEECH_PROMPT_MS тишины на линии → модель спрашивает «Алло, вы меня
 *    слышите?» (служебной репликой, тем же приёмом, что приветствие);
 *  - NO_SPEECH_END_MS без единого звука от звонящего и не раньше
 *    NO_SPEECH_ANSWER_MS после вопроса → короткое прощание и конец сессии
 *    с причиной "no_caller_speech": звонок со станции уходит назад в диалплан
 *    (автоответчик), а не в отбой — см. handsCallerBackToDialplan.
 */
export const NO_SPEECH_PROMPT_MS = 25_000;
export const NO_SPEECH_END_MS = 50_000;
/** Сколько дать человеку ответить на «Алло, вы меня слышите?», прежде чем прощаться. */
export const NO_SPEECH_ANSWER_MS = 10_000;
const NO_SPEECH_CHECK_MS = 1_000;
/** Причина конца сессии по сторожу тишины — см. handsCallerBackToDialplan. */
export const NO_CALLER_SPEECH_REASON = "no_caller_speech";

/**
 * СТОРОЖ ЗВУКА СО СТАНЦИИ (02.10.2026, живая проба Dan).
 *
 * Звук идёт со станции к CRM отдельным путём — тоннелем OpenVPN (UDP), а
 * команды станции (ARI/AMI) — обратным SSH-туннелем по TCP. 28.09 тоннель звука
 * умер, команды продолжили ходить: робот брал трубку, Gemini здоровался в
 * пустоту, человек слышал тишину, а модель не слышала его. Пять дней ни одна
 * проверка этого не видела — звонки кандидатам и входящие уходили немыми.
 *
 * Живая линия шлёт кадр каждые 20 мс с первой секунды моста (собеседник
 * молчит — идёт его фоновый шум), поэтому ни одного пакета за
 * NO_STATION_AUDIO_MS — не тихий человек, а мёртвый путь звука. Тогда:
 *  - звонок со станции уходит назад в диалплан (автоответчик), а не в тишину;
 *  - руководству — одна проблема в журнале (ключ постоянный);
 *  - STATION_AUDIO_DEAD_HOLD_MS робот не берёт новые звонки и не набирает
 *    сценарные (те переносятся, попытку не тратят). Первый же пакет со
 *    станции снимает паузу.
 */
export const NO_STATION_AUDIO_MS = 6_000;
export { NO_STATION_AUDIO_REASON, LIVE_VOICE_STATION_AUDIO_RETRY_MS };
export const STATION_AUDIO_DEAD_HOLD_MS = 10 * 60_000;
/** Потолок паузы. Каждое следующее подряд «нет звука» удваивает паузу (10, 20,
 *  40… мин): пока тоннель мёртв, проба раз в 10 минут — это немой звонок
 *  живому человеку каждые 10 минут (разбор 02.10.2026). Пакет со станции
 *  сбрасывает и паузу, и счёт. */
export const STATION_AUDIO_DEAD_HOLD_MAX_MS = 2 * 60 * 60_000;
let stationAudioDeadUntil = 0;
let stationAudioDeadStreak = 0;

export function stationAudioHoldMs(streak: number): number {
  return Math.min(STATION_AUDIO_DEAD_HOLD_MS * 2 ** Math.max(0, streak - 1), STATION_AUDIO_DEAD_HOLD_MAX_MS);
}

/** Путь звука со станции признан мёртвым (см. NO_STATION_AUDIO_MS). */
export function liveVoiceAudioPathDown(now: number = Date.now()): boolean {
  return now < stationAudioDeadUntil;
}

/** Снять паузу «нет звука со станции» и обнулить счёт отказов. Зовёт ручная
 *  проверка (originateLiveVoiceTestCall) и первый настоящий пакет со станции. */
export function clearLiveVoiceAudioPathHold(): void {
  stationAudioDeadUntil = 0;
  stationAudioDeadStreak = 0;
}

/** Только для тестов: и пауза «нет звука», и выключатель Gemini (ниже). */
export function resetLiveVoiceAudioPathForTests(): void {
  clearLiveVoiceAudioPathHold();
  geminiStartFailStreak = 0;
  geminiPausedUntil = 0;
}

/**
 * ВЫКЛЮЧАТЕЛЬ «GEMINI ОТКАЗЫВАЕТ» (09.10.2026, аудит линии робота, п.7). Кончились
 * деньги или квота — каждый следующий звонящий ждал до 25 с подключения и всё равно
 * уходил на автоответчик. Теперь GEMINI_START_FAILS_TO_PAUSE отказов подключения
 * подряд — пауза GEMINI_PAUSE_MS: входящие сразу отдаются станции (автоответчик, без
 * секунды ожидания), сценарные звонки переносятся, как при занятой линии. Кнопка
 * «Проверить» паузу не соблюдает (это проба), а удачное подключение снимает её.
 */
export const GEMINI_START_FAILS_TO_PAUSE = 2;
export const GEMINI_PAUSE_MS = 10 * 60_000;
let geminiStartFailStreak = 0;
let geminiPausedUntil = 0;

export function liveVoiceGeminiPaused(now: number = Date.now()): boolean {
  return now < geminiPausedUntil;
}

function noteGeminiStartOk(): void {
  geminiStartFailStreak = 0;
  geminiPausedUntil = 0;
}

function noteGeminiStartFailed(reason: string): void {
  geminiStartFailStreak += 1;
  if (geminiStartFailStreak < GEMINI_START_FAILS_TO_PAUSE) return;
  geminiPausedUntil = Date.now() + GEMINI_PAUSE_MS;
  void logSystemError(
    "ai",
    `КРИТИЧНО: робот на паузе ${GEMINI_PAUSE_MS / 60_000} мин — Gemini не подключился ${geminiStartFailStreak} раза подряд ` +
      `(последний отказ: ${reason}). Входящие идут сразу на автоответчик станции. Проверьте баланс и ключ Gemini.`,
    { dedupKey: "live-voice-gemini-paused" }
  );
}

/** Почему робот сейчас не берёт звонки — для «Здоровья станции» и утреннего отчёта.
 *  Пусто — не на паузе. */
export interface LiveVoicePauseState {
  /** Путь звука станция→CRM признан мёртвым, до этого времени (мс). */
  audioPathDownUntil: number | null;
  /** Gemini отказывает подключаться, до этого времени (мс). */
  geminiPausedUntil: number | null;
}

export function liveVoicePauseState(now: number = Date.now()): LiveVoicePauseState {
  return {
    audioPathDownUntil: now < stationAudioDeadUntil ? stationAudioDeadUntil : null,
    geminiPausedUntil: now < geminiPausedUntil ? geminiPausedUntil : null,
  };
}

/** Путь звука признан мёртвым: пауза робота с удвоением (см. stationAudioHoldMs) и
 *  одна проблема в журнале. Общий для старта (ни кадра за 6 с) и середины разговора. */
function markStationAudioDead(what: string): void {
  stationAudioDeadStreak += 1;
  const holdMs = stationAudioHoldMs(stationAudioDeadStreak);
  stationAudioDeadUntil = Date.now() + holdMs;
  void logSystemError(
    "telephony",
    `Живой голос: ${what} — путь звука станция→CRM (тоннель OpenVPN, LIVE_VOICE_RTP_HOST) не работает, человек слышал бы тишину. ` +
      `Звонок отдан станции, робот на паузе ${holdMs / 60_000} мин.`,
    { dedupKey: "live-voice-no-station-audio" }
  );
}

/**
 * СТОРОЖА ЛИНИИ ПОСРЕДИ РАЗГОВОРА (09.10.2026, аудит линии робота, п.4–6). Тик раз в
 * секунду (startLineWatchdog), с момента, когда трубка снята и разговор идёт.
 *
 * 1. ЗВУК СО СТАНЦИИ ПРОПАЛ (п.4): прежний сторож смотрел только первые 6 с. Обрыв
 *    тоннеля посреди разговора давал 50–60 с тишины до сторожа молчания. Живая линия
 *    шлёт кадр каждые 20 мс (молчащий человек — это его фоновый шум), поэтому дольше
 *    STATION_AUDIO_GAP_MS без пакетов — не пауза в речи, а мёртвый путь звука.
 */
export const STATION_AUDIO_GAP_MS = 3_000;
/**
 * 2. МОДЕЛЬ МОЛЧИТ (п.6): сокет Gemini открыт, человек договорил, а ответа нет — ни
 *    звука, ни конца хода, ни идущей функции. Через MODEL_STALL_NUDGE_MS одна служебная
 *    реплика «ответь», ещё через MODEL_STALL_END_MS — конец с возвратом станции.
 */
export const MODEL_STALL_NUDGE_MS = 10_000;
export const MODEL_STALL_END_MS = 6_000;
export const GEMINI_STALLED_REASON = "gemini_stalled";
/**
 * 3. ЗВУК РОБОТА НЕ ДОХОДИТ ДО ЧЕЛОВЕКА (п.5): станция назвала адрес, но звук туда не
 *    доходит (фаервол, тоннель в одну сторону). Признак — за NO_BOT_AUDIO_WINDOW_MS
 *    после начала приветствия человек твердит «алло / не слышно» и не говорит ничего
 *    по делу. Сторож тишины этого не видит: голос человека его сбрасывает.
 */
export const NO_BOT_AUDIO_WINDOW_MS = 20_000;
/** Ранний вывод: три «алло» и ничего по делу — уже через столько после приветствия. */
export const NO_BOT_AUDIO_EARLY_MS = 10_000;
/** «Алло», сказанное в трубку, пока первое слово робота ещё летит по сети, — не в счёт. */
const NO_BOT_AUDIO_GRACE_MS = 1_500;
export const NO_BOT_AUDIO_SUSPECTED_REASON = "no_bot_audio_suspected";
const LINE_WATCH_TICK_MS = 1_000;

export interface ModelStallState {
  /** Человек договорил реплику и ждёт ответа — с этого момента; null — не ждёт. */
  awaitingSince: number | null;
  /** Когда модели напомнили ответить; null — не напоминали. */
  nudgedAt: number | null;
  /** Идёт вызов функции — модель законно молчит (поиск, перевод). */
  toolRunning: boolean;
  /** Бот говорит или звук ещё в очереди. */
  botBusy: boolean;
}

/** Шаг сторожа «модель молчит». Чистая функция — ради теста. */
export function modelStallStep(state: ModelStallState, now: number): "nudge" | "end" | null {
  if (state.botBusy || state.toolRunning || state.awaitingSince === null) return null;
  if (state.nudgedAt !== null) return now - state.nudgedAt >= MODEL_STALL_END_MS ? "end" : null;
  return now - state.awaitingSince >= MODEL_STALL_NUDGE_MS ? "nudge" : null;
}

/** Служебная реплика «ответь собеседнику» (сторож «модель молчит»). */
export const MODEL_STALL_NUDGE_TRIGGER =
  "(Собеседник договорил и ждёт ответа уже несколько секунд. Ответь ему СЕЙЧАС — коротко, по сути его последней фразы.)";

/** «Меня не слышно»: алло, не слышно, говорите, таджикское «мешунавед». Ищется
 *  подстрокой, а не словом: расшифровка приходит кусками и склеивается без пробелов
 *  («Ал»+«ло», «аллоалло»). `\w` по-русски молчит (CLAUDE.md) — буквы перечислены. */
const HELLO_RE = /ал+[оеу]+|(?:не\s*)?слыш[а-я]*|говорите|мешунав[а-яӣ]*/gu;
/** Слова без содержания: не довод, что человек слышит робота. */
const FILLER_WORDS = new Set([
  "да", "ну", "эй", "э", "а", "ой", "м", "мм", "хм", "вы", "меня", "вас", "мне", "не", "тут", "здесь", "там",
  "кто", "это", "шумо", "маро", "ҳа", "ха", "бале", "ман", "ин",
]);

/**
 * Сколько в словах человека «алло / не слышно» и сколько слов по делу (п.5 аудита).
 * Чистая функция — ради теста.
 */
export function callerHelloScore(text: string): { hellos: number; content: number } {
  const lower = text.toLowerCase().replace(/ё/g, "е");
  const hellos = lower.match(HELLO_RE)?.length ?? 0;
  const content = lower
    .replace(HELLO_RE, " ")
    .split(/[^a-zа-яӣӯқғҳҷ]+/u)
    .filter((word) => word.length >= 2 && !FILLER_WORDS.has(word)).length;
  return { hellos, content };
}

/** Вывод по окну после приветствия: true — человек робота, по всей видимости, не слышит. */
export function noBotAudioSuspected(text: string, msSinceGreeting: number): boolean {
  const { hellos, content } = callerHelloScore(text);
  if (content > 0) return false;
  if (hellos >= 3 && msSinceGreeting >= NO_BOT_AUDIO_EARLY_MS) return true;
  return hellos >= 2 && msSinceGreeting >= NO_BOT_AUDIO_WINDOW_MS;
}

export interface NoSpeechWatchState {
  /** Последний звук или реплика от звонящего (начало отсчёта — старт сторожа). */
  lastCallerActivityAt: number;
  /** Последний кадр речи бота, ушедший в линию; 0 — бот ещё не говорил. */
  lastBotAudioAt: number;
  /** Бот говорит прямо сейчас (реплика идёт или звук ещё в очереди). */
  botBusy: boolean;
  /** Когда спросили «вы меня слышите?»; null — не спрашивали (или человек ответил). */
  promptedAt: number | null;
}

/** Шаг сторожа: спросить, попрощаться или ничего. Чистая функция — ради теста. */
export function noSpeechWatchStep(state: NoSpeechWatchState, now: number): "prompt" | "end" | null {
  if (state.botBusy) return null;
  if (state.promptedAt !== null) {
    const callerQuietMs = now - state.lastCallerActivityAt;
    return callerQuietMs >= NO_SPEECH_END_MS && now - state.promptedAt >= NO_SPEECH_ANSWER_MS ? "end" : null;
  }
  const lineQuietMs = now - Math.max(state.lastCallerActivityAt, state.lastBotAudioAt);
  return lineQuietMs >= NO_SPEECH_PROMPT_MS ? "prompt" : null;
}

/** Служебная реплика «спроси, слышит ли». Язык — тот, на котором идёт разговор;
 *  с замком на русский — только по-русски (таджикского текста в промте нет). */
export function noSpeechPromptTrigger(forceRussianOnly: boolean): string {
  return forceRussianOnly
    ? "(Собеседник молчит уже почти полминуты — возможно, его плохо слышно. Спроси коротко и по-доброму: «Алло, вы меня слышите?» Больше ничего не добавляй.)"
    : // Таджикский первым (10.10.2026, владелец: «таджикский — в приоритете»).
      "(Собеседник молчит уже почти полминуты — возможно, его плохо слышно. Спроси коротко и по-доброму, слышит ли он тебя, " +
        "на том языке, на котором идёт разговор: по-таджикски «Алло, шумо маро мешунавед?», по-русски «Алло, вы меня слышите?»; " +
        "язык ещё не ясен — сначала по-таджикски, потом по-русски. Больше ничего не добавляй.)";
}

/** Служебная реплика «попрощайся»: звонящий так и не ответил. Функции модели не
 *  нужны — сессию закрывает сам мост (endWhenQuiet). */
export function noSpeechFarewellTrigger(handBack: boolean, forceRussianOnly = true): string {
  return (
    "(Собеседник так и не ответил — видимо, плохая связь. Одной короткой фразой вежливо попрощайся" +
    // Язык прощания — язык звонка (09.10.2026, P1-2): по-русски таджикоязычный
    // человек не понял бы и того, что ему можно оставить сообщение.
    (forceRussianOnly ? " по-русски" : " на том языке, на котором идёт разговор (по-русски или по-таджикски)") +
    ": скажи, что его не слышно" +
    // Без «перезвоним» (02.10.2026): повторный звонок обещает не мост, а
    // сценарий, и делает его не всегда — обещание оставалось бы пустым.
    (handBack ? " и что он может оставить сообщение после сигнала" : "") +
    ". Функции не вызывай — звонок завершится сам.)"
  );
}

/**
 * ИНСТРУМЕНТЫ МОДЕЛИ (12.09.2026, второй живой звонок: бот терял имя и
 * телефон, сказанные собеседником, — положиться на то, что модель сама всё
 * запомнит в свободной речи, оказалось недостаточно). Явный вызов функции —
 * структурные данные, а не догадка по тексту; вместе с тем же приёмом решает
 * и «звонок не завершается сам» (see LIVE_VOICE_MAX_SESSION_MS выше — тот
 * таймер остаётся подстраховкой, а не основным путём).
 */
const END_CALL_TOOL: LiveVoiceFunctionDeclaration = {
  name: "end_call",
  description:
    "Вызови это ПОСЛЕ того, как вслух попрощались с собеседником и разговор по сути закончен — например, номер взят и агент перезвонит, либо собеседник прощается сам. Это кладёт трубку, поэтому сначала произнеси прощание, а функцию вызови следующим действием.",
  parameters: {
    type: "OBJECT",
    properties: {
      reason: { type: "STRING", description: "Коротко, почему разговор закончен." },
    },
    required: ["reason"],
  },
};

/**
 * ЭСКАЛАЦИЯ К ЖИВОМУ ЧЕЛОВЕКУ (13.09.2026, разбор «бот не обрабатывает явную
 * просьбу передать оператора» — см. TASKS.md). До этого у бота был только
 * end_call — закончить разговор без разбора, ПОЧЕМУ: явная просьба передать
 * живого агента и обычное «взяли номер, дальше перезвонит агент» уходили в
 * очередь одним и тем же путём (save_contact → CallbackRequest), то есть
 * менее заметно для агентов, чем того требует прямая просьба клиента.
 * Обработчик — wireGeminiEvents (escalateLiveVoiceCallToHuman ниже).
 */
const ESCALATE_TO_HUMAN_TOOL: LiveVoiceFunctionDeclaration = {
  name: "escalate_to_human",
  description:
    "Вызови, когда собеседник ЯВНО просит живого человека/оператора/агента вместо тебя, или когда ты не справляешься и разговор зашёл в тупик. Перед вызовом вслух коротко скажи своими словами, по смыслу «хорошо, попрошу коллегу вам набрать» (это смысл, не дословная фраза), а следующим действием вызови эту функцию — она сама корректно завершит звонок, end_call вызывать не нужно.",
  parameters: {
    type: "OBJECT",
    properties: {
      reason: { type: "STRING", description: "Коротко, почему нужен живой человек — что попросил собеседник или в чём затруднение." },
      by_client_request: {
        type: "BOOLEAN",
        description:
          "true — ТОЛЬКО если собеседник сам прямо попросил живого человека/оператора. false — если ты не справляешься или разговор зашёл в тупик.",
      },
    },
    required: ["reason"],
  },
};

const LIVE_VOICE_TOOLS: LiveVoiceFunctionDeclaration[] = [
  {
    name: "save_contact",
    description:
      "Сохранить имя собеседника, как только он его назвал. Вызывай молча и сразу, не дожидаясь конца разговора — не полагайся на память до конца звонка. Номер этого человека у нас уже есть (звоним по нему мы), диктовать его не проси.",
    parameters: {
      type: "OBJECT",
      properties: {
        name: { type: "STRING", description: "Имя собеседника, как он представился." },
        phone: {
          type: "STRING",
          description: "Другой номер для связи — ТОЛЬКО если человек сам попросил звонить не на этот, и только полностью. Иначе не передавай.",
        },
      },
      required: ["name"],
    },
  },
  ESCALATE_TO_HUMAN_TOOL,
  END_CALL_TOOL,
];

/* Трубка после прощания кладётся, когда очередь RTP-пейсера доиграла, плюс
 * запас (hangupWhenDrained/endWhenQuiet, 02.10.2026). Прежний фиксированный
 * таймер 2,5 с от turnComplete обрезал «до свидания» на середине. */

/** Формат аудио канала — 16-битный линейный PCM на 16kHz. Тот же формат, что
 *  Gemini Live принимает на вход (см. ai/liveVoiceClient.ts) — конвертация нужна
 *  только на обратном пути (ответ модели 24kHz → 16kHz). */
export const CHANNEL_SAMPLE_RATE = 8_000;
export const GEMINI_OUTPUT_SAMPLE_RATE = 24_000;
/** Частота, которую ждёт Gemini Live на входе. */
export const GEMINI_INPUT_SAMPLE_RATE = 16_000;

/**
 * ФОРМАТ КАНАЛА — ulaw, И ЭТО НЕ ВОПРОС КАЧЕСТВА (12.09.2026).
 *
 * У externalMedia нет SDP-согласования: Asterisk и наш процесс не о чем не
 * договариваются, номер типа нагрузки просто берётся из конфигурации канала.
 * Поэтому ДИНАМИЧЕСКИЕ типы там не работают на приём — это прямо сказано в
 * обсуждениях сообщества Asterisk: «dynamic payloads are unsupported for
 * external media channels, only statically defined codecs work, such as ulaw,
 * alaw and g722».
 *
 * Со slin16 (динамический номер 118) получалась ровно такая картина, измеренная
 * живым звонком: станция ОТПРАВЛЯЕТ нам звук исправно — номер она выбрала сама и
 * знает его, — а наш ответ с тем же номером 118 молча отбрасывает, потому что
 * сопоставить его формату на приёме ей нечем. Ядро станции пакеты доставляло
 * (+1579 датаграмм, «нет порта» — ноль), брандмауэр не резал, тип, частота,
 * размер кадра, порядок байт и громкость совпадали, темп был верный, а человек
 * слышал тишину.
 *
 * ulaw — статический номер 0, 8 кГц. Телефонная линия всё равно живёт на 8 кГц,
 * так что ничего не теряется: раньше станция сама преобразовывала 8 → 16 кГц.
 */
export const EXTERNAL_MEDIA_FORMAT = "ulaw";
/** Статический номер типа нагрузки ulaw по RFC 3551. */
export const ULAW_PAYLOAD_TYPE = 0;

// ---------------------------------------------------------------------------
// Чистые функции — юнит-тестируемые без сети/сокетов
// ---------------------------------------------------------------------------

/** Понижатель ответа модели 24 кГц → линия 8 кГц, по одному на сессию. */
export function createGeminiToLineDecimator(): StreamingDecimator {
  return new StreamingDecimator(
    GEMINI_OUTPUT_SAMPLE_RATE / CHANNEL_SAMPLE_RATE,
    lowPassForRate(GEMINI_OUTPUT_SAMPLE_RATE, CHANNEL_SAMPLE_RATE)
  );
}

/**
 * КАДРИРОВЩИК С ОСТАТКОМ (02.10.2026, аудит моста К-5). Раньше каждый кусок
 * ответа резался на кадры отдельно, и последний неполный кадр каждого куска
 * добивался нулями — посреди слова вставлялось до 20 мс тишины («заикание»).
 * Теперь остаток (< frameSize) ждёт следующий кусок; нулями добивается только
 * конец реплики (flush на turnComplete).
 */
export class PcmFramer {
  private pending: Int16Array = new Int16Array(0);

  constructor(private readonly frameSize: number) {
    if (frameSize <= 0) throw new Error("Размер кадра должен быть положительным");
  }

  get pendingSamples(): number {
    return this.pending.length;
  }

  push(samples: Int16Array): Int16Array[] {
    const all = new Int16Array(this.pending.length + samples.length);
    all.set(this.pending, 0);
    all.set(samples, this.pending.length);
    const frames: Int16Array[] = [];
    let offset = 0;
    for (; offset + this.frameSize <= all.length; offset += this.frameSize) {
      frames.push(all.slice(offset, offset + this.frameSize));
    }
    this.pending = all.slice(offset);
    return frames;
  }

  /** Остаток, добитый нулями до кадра, — или null, если остатка нет. */
  flush(): Int16Array | null {
    if (this.pending.length === 0) return null;
    const frame = new Int16Array(this.frameSize);
    frame.set(this.pending);
    this.pending = new Int16Array(0);
    return frame;
  }

  reset(): void {
    this.pending = new Int16Array(0);
  }
}

/**
 * ПЕЙСЕР ПО ЧАСАМ (02.10.2026, аудит моста В-2). setInterval(20) срабатывает
 * через 20,5–22 мс, и по кадру на тик темп выходил на 3–8 % медленнее реального:
 * буфер станции пустел, в речи появлялись провалы. Теперь тик чаще (10 мс), а
 * число кадров считается по прошедшему времени.
 *
 * `slot` — сколько 20-мс окон уже обслужено с начала. Возвращает, сколько кадров
 * отправить сейчас (не больше maxBurst за тик — догоняем плавно) и сколько окон
 * простить без отправки (отставание больше maxDebtFrames после зависания цикла
 * событий не выплёвывается пачкой). Вызывающий прибавляет send + skip к slot.
 */
export const PACER_TICK_MS = 10;
export const PACER_MAX_BURST = 3;
export const PACER_MAX_DEBT_FRAMES = 10;
/** Столько тиков выдачи звука подряд могут упасть, прежде чем сессия закроется (≈1 с). */
export const PACER_MAX_FAILED_TICKS = 50;

export function pacerStep(
  elapsedMs: number,
  slot: number,
  frameMs = 20,
  maxBurst = PACER_MAX_BURST,
  maxDebtFrames = PACER_MAX_DEBT_FRAMES
): { send: number; skip: number } {
  const due = Math.floor(elapsedMs / frameMs) - slot;
  if (due <= 0) return { send: 0, skip: 0 };
  const skip = Math.max(0, due - maxDebtFrames);
  return { send: Math.min(maxBurst, due - skip), skip };
}

/** Сколько сэмплов на кадр при 20мс — типичный размер кадра RTP-телефонии
 *  (та же длительность, что и обычные codec-кадры G.711/G.722 на станции). */
export function samplesPerFrame(sampleRateHz: number, frameMs = 20): number {
  return Math.round((sampleRateHz * frameMs) / 1000);
}

/** Режет поток сэмплов на кадры фиксированной длины, дополняя ПОСЛЕДНИЙ кадр
 *  тишиной (нулями) — постоянный размер кадра нужен RTP-таймстампам, а нарастание
 *  или усечение времени, которое эти нули дают, на 20мс хвосте неразличимо на слух. */
export function framePcm16(samples: Int16Array, frameSize: number): Int16Array[] {
  if (frameSize <= 0) throw new Error("Размер кадра должен быть положительным");
  const frames: Int16Array[] = [];
  for (let offset = 0; offset < samples.length; offset += frameSize) {
    const chunk = samples.subarray(offset, offset + frameSize);
    if (chunk.length === frameSize) {
      frames.push(chunk);
    } else {
      const padded = new Int16Array(frameSize);
      padded.set(chunk);
      frames.push(padded);
    }
  }
  return frames;
}

/** Складывает два кадра PCM16 сэмпл-в-сэмпл, с ограничением диапазона — для
 *  подмешивания фонового шума под речь модели. Короче любого — по длине
 *  короткого (кадры всегда одной длины на практике, но без этого один лишний
 *  сэмпл на стыке кинул бы TypeError, а не тихо обрезался). */
export function mixPcm16(a: Int16Array, b: Int16Array): Int16Array {
  const len = Math.min(a.length, b.length);
  const out = new Int16Array(len);
  for (let i = 0; i < len; i++) {
    out[i] = Math.max(-32768, Math.min(32767, a[i] + b[i]));
  }
  return out;
}

/**
 * КОРОТКИЙ ВДОХ ПЕРЕД РЕПЛИКОЙ (12.09.2026, владелец: «чтобы дышал»).
 * Огибающая — половина синуса (0 → пик → 0), не резкий щелчок: нарастающий
 * и затухающий шум читается ухом как вдох, а не как помеха. Играется РОВНО
 * ОДИН РАЗ в начале реплики бота (см. session.isSpeaking в wireGeminiEvents),
 * не на каждый кусок звука.
 */
/**
 * ЛОКАЛЬНЫЙ ЭНЕРГЕТИЧЕСКИЙ VAD НА ВХОДЯЩЕМ ЗВУКЕ КЛИЕНТА (14.09.2026, разбор
 * «убрать ИИ-паузу»). БЕЗ этого детектора вдох (generateBreathSound) играет
 * только когда придёт ПЕРВЫЙ кусок звука от Gemini — то есть ПОСЛЕ всей сетевой
 * задержки и генерации первого токена (250–600 мс по замеру владельца), и в это
 * время в трубке только фоновый гул, без сигнала «сейчас отвечу». Простой
 * детектор энергии на своей же стороне (без ML-модели вроде Silero — она не
 * нужна для одной задачи «клиент вот только что замолчал») даёт этот сигнал
 * МГНОВЕННО, до всякого ответа Gemini.
 *
 * Не VAD для перебивания (barge-in) — тот уже есть и держится на серверном
 * `interrupted` от самого Gemini (см. wireGeminiEvents), трогать не нужно: он
 * видит тот же звук, что мы ему шлём, и общее решение (в т.ч. что считать
 * помехой, а что репликой) там надёжнее самодельного порога.
 *
 * Метод: скользящее среднее абсолютной амплитуды кадра (простая, не спектральная
 * оценка — этого достаточно, чтобы отличить речь от линейной тишины/гула).
 * Порог и число кадров тишины — ПЕРВАЯ ПРИКИДКА, не измерено на живом звонке:
 * см. VAD_SPEECH_ENERGY_THRESHOLD (с 10.10.2026 — от шумового пола, liveVoiceEchoGate.ts), требует подстройки на слух после
 * первого же прогона (правило проекта — не считать выдумку фактом).
 */
export interface ClientVadState {
  speaking: boolean;
  silenceStreak: number;
}

/** Сколько подряд тихих кадров (по 20мс) считать концом фразы — не одного кадра,
 *  иначе обычная пауза между словами каждый раз давала бы сигнал "конец фразы". */
const VAD_SILENCE_HANGOVER_FRAMES = 4;

/** true — ровно в кадре, где обнаружен переход "говорил → замолчал" (передний
 *  фронт события, не на каждый последующий тихий кадр). Обновляет `state`.
 *  `threshold` — порог речи: с 10.10.2026 от шумового пола линии
 *  (LiveVoiceEchoGate.vadThreshold), по умолчанию прежний постоянный 400. */
export function detectClientSpeechEnd(
  frame: Int16Array,
  state: ClientVadState,
  threshold: number = VAD_SPEECH_ENERGY_THRESHOLD
): boolean {
  const loud = frameEnergy(frame) >= threshold;
  if (loud) {
    state.speaking = true;
    state.silenceStreak = 0;
    return false;
  }
  if (!state.speaking) return false;
  state.silenceStreak += 1;
  if (state.silenceStreak === VAD_SILENCE_HANGOVER_FRAMES) {
    state.speaking = false;
    return true;
  }
  return false;
}

export function generateBreathSound(sampleCount: number, peakAmplitude: number): Int16Array {
  const out = new Int16Array(sampleCount);
  for (let i = 0; i < sampleCount; i++) {
    const envelope = Math.sin((Math.PI * i) / sampleCount);
    out[i] = Math.round((Math.random() * 2 - 1) * peakAmplitude * envelope);
  }
  return out;
}

/**
 * ЗАПИСЬ ЗВОНКА (13.09.2026, владелец после первого теста: «запись не
 * сохранилась... главное всё это должно записываться»). Обычные звонки
 * агентства пишет сама станция (MixMonitor, lib/telephony/callRecordings.ts) —
 * у живого голоса нет ни одного такого канала: звук идёт напрямую между RTP-
 * сокетом этого процесса и Gemini, мимо любого механизма записи Asterisk.
 * Строить это через ARI (запись моста) означало бы новую, непроверенную
 * зависимость от настройки станции и угадывание, куда и в каком формате
 * Asterisk положит файл, — тот же класс риска, что уже дважды подводил на
 * этом звонке (slin16, MIXMONITOR_FILENAME). Вместо этого пишем сами: обе
 * стороны разговора и так проходят через этот процесс уже как PCM на 8 кГц
 * (client — после ulawDecode в wireRtpSocket, bot — после resamplePcm16 в
 * wireGeminiEvents, ДО подмешивания фонового шума — записываем чистую речь,
 * не гул). Стерео-WAV: левый канал клиент, правый бот — один файл, видно кто
 * говорил, без отдельной синхронизации по времени.
 */
const WAV_HEADER_BYTES = 44;

/** Собирает 16-битный стерео WAV (PCM, без сжатия) из двух моно-дорожек на
 *  одной частоте. Дорожки разной длины — короче дополняется тишиной (не
 *  обрезаем длинную: конец разговора одной из сторон — тоже часть записи). */
export function buildStereoWavFile(left: Int16Array, right: Int16Array, sampleRateHz: number): Buffer {
  const frames = Math.max(left.length, right.length);
  const dataBytes = frames * 2 /* каналы */ * 2 /* байта на сэмпл */;
  const buf = Buffer.alloc(WAV_HEADER_BYTES + dataBytes);

  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write("WAVE", 8, "ascii");
  buf.write("fmt ", 12, "ascii");
  buf.writeUInt32LE(16, 16); // размер под-чанка fmt
  buf.writeUInt16LE(1, 20); // формат 1 = PCM
  buf.writeUInt16LE(2, 22); // каналов
  buf.writeUInt32LE(sampleRateHz, 24);
  buf.writeUInt32LE(sampleRateHz * 2 * 2, 28); // байт/сек = частота × каналы × байт/сэмпл
  buf.writeUInt16LE(2 * 2, 32); // байт на кадр (все каналы)
  buf.writeUInt16LE(16, 34); // бит на сэмпл
  buf.write("data", 36, "ascii");
  buf.writeUInt32LE(dataBytes, 40);

  let offset = WAV_HEADER_BYTES;
  for (let i = 0; i < frames; i++) {
    buf.writeInt16LE(i < left.length ? left[i] : 0, offset);
    buf.writeInt16LE(i < right.length ? right[i] : 0, offset + 2);
    offset += 4;
  }
  return buf;
}

/**
 * Переворачивает порядок байт 16-битного PCM (big-endian ⇄ little-endian).
 *
 * ЗАЧЕМ. Asterisk отдаёт slin16 в RTP в СЕТЕВОМ порядке байт (big-endian, так
 * велит RFC 3551 для L16), а Gemini Live и вся обработка в Node ждут
 * little-endian. Без разворота модель слышит не речь, а шум: проверено живым
 * звонком 12.09.2026 — 1500 кусков звука ушло в модель, в ответ ни одного
 * слова и пустая расшифровка, при этом сама сессия исправно жила. Разбор
 * записанных пакетов показал: при чтении как big-endian сигнал гладкий, как
 * little-endian — рваный, то есть байты действительно перевёрнуты.
 *
 * Разворот нужен в ОБЕ стороны: то, что пришло со станции, — перед отправкой
 * в модель; то, что ответила модель, — перед упаковкой в RTP.
 */
export function swapPcm16ByteOrder(buf: Buffer): Buffer {
  const out = Buffer.allocUnsafe(buf.length - (buf.length % 2));
  for (let i = 0; i + 1 < buf.length; i += 2) {
    out[i] = buf[i + 1];
    out[i + 1] = buf[i];
  }
  return out;
}


export interface RtpPacket {
  payloadType: number;
  sequenceNumber: number;
  timestamp: number;
  ssrc: number;
  payload: Buffer;
}

const RTP_VERSION = 2;
const RTP_HEADER_BYTES = 12;

/** Собирает RTP-пакет (заголовок RFC 3550 без extension/CSRC — Asterisk
 *  externalMedia их не использует, см. докстринг файла) вокруг сырых PCM-байт. */
export function buildRtpPacket(pkt: RtpPacket): Buffer {
  const header = Buffer.alloc(RTP_HEADER_BYTES);
  header[0] = RTP_VERSION << 6; // version=2, padding=0, extension=0, CSRC count=0
  header[1] = pkt.payloadType & 0x7f; // marker=0
  header.writeUInt16BE(pkt.sequenceNumber & 0xffff, 2);
  header.writeUInt32BE(pkt.timestamp >>> 0, 4);
  header.writeUInt32BE(pkt.ssrc >>> 0, 8);
  return Buffer.concat([header, pkt.payload]);
}

/** Разбирает входящий RTP-пакет. null — не похоже на RTP (короче заголовка или
 *  не та версия протокола) — такой пакет молча отбрасывается вызывающим. */
export function parseRtpPacket(buf: Buffer): RtpPacket | null {
  if (buf.length < RTP_HEADER_BYTES) return null;
  if ((buf[0] >> 6) !== RTP_VERSION) return null;
  return {
    payloadType: buf[1] & 0x7f,
    sequenceNumber: buf.readUInt16BE(2),
    timestamp: buf.readUInt32BE(4),
    ssrc: buf.readUInt32BE(8),
    payload: buf.subarray(RTP_HEADER_BYTES),
  };
}

export interface LiveVoiceGateSettings {
  liveVoiceEnabled: boolean;
  liveVoiceTestExtension: string | null;
  /** Управление ботом из интерфейса (13.09.2026, Settings → «наш бот») — см.
   *  liveVoicePersona.ts::buildLiveVoiceSystemPrompt и docstring у полей в
   *  schema.prisma. Пусто/дефолт — поведение не меняется относительно того,
   *  что было зашито в коде до этой настройки. */
  liveVoicePrompt: string | null;
  liveVoiceVoiceName: string | null;
  liveVoiceVoiceNameTajik: string | null;
  liveVoiceForceRussianOnly: boolean;
  liveVoiceBreathEnabled: boolean;
  liveVoiceOfficeAmbienceEnabled: boolean;
  liveVoiceOfficeAmbienceVolume: number;
  /** Когда консультант берёт настоящие входящие ("off" | "no_answer" | "always"),
   *  см. schema.prisma. Нет поля — "off". */
  liveVoiceInboundMode?: string;
}

/**
 * Решает, принимать ли канал, попавший в StasisStart нашего приложения.
 *
 * ДВОЙНОЙ БАРЬЕР, А НЕ ОДИН. Сам факт входа канала в это Stasis-приложение уже
 * требует ручной настройки на станции (см. докстринг файла) — но проверка
 * тумблера и номера здесь остаётся НАМЕРЕННО: если владелец выключил тумблер
 * после того, как настройка на станции осталась (забыли снять маршрут), звонок
 * не должен повиснуть молча в мосте с мёртвым кодом — код обязан вежливо
 * положить трубку (см. onLiveVoiceAriEvent), а не притвориться, что тумблера нет.
 */
/**
 * Канал, который станция подняла ПО НАШЕЙ ЖЕ просьбе под RTP (externalMedia).
 *
 * Опознаётся двумя способами, и оба нужны: по имени `UnicastRTP/...` (так
 * Asterisk называет такие каналы всегда) и по идентификатору уже живущей
 * сессии — на случай, если имя когда-нибудь изменится. Такой канал не клиент:
 * его нельзя ни принимать как звонок, ни класть ему трубку.
 */
export function isOwnExternalMediaChannel(event: AriEvent): boolean {
  const channel = event.channel;
  if (!channel) return false;
  const name = (channel as unknown as { name?: string }).name ?? "";
  if (name.startsWith("UnicastRTP/")) return true;
  if (!channel.id) return false;
  for (const session of sessions.values()) {
    if (session.externalMediaChannelId === channel.id) return true;
  }
  return false;
}

/**
 * Звонок вернулся к консультанту от агента, который не ответил (24.09.2026,
 * перевод звонка): диалплан royalhome-agent-route при RH_ROUTE_FALLBACK=ai зовёт
 * `Stasis(royalhome-live-voice,returned)`. Первый аргумент Stasis-приложения
 * приходит в StasisStart полем `args`.
 */
export const LIVE_VOICE_RETURNED_ARG = "returned";

export function stasisArgs(event: AriEvent): string[] {
  return Array.isArray(event.args) ? event.args.map((a) => String(a)) : [];
}

export function isReturnedFromAgent(event: AriEvent): boolean {
  return stasisArgs(event)[0] === LIVE_VOICE_RETURNED_ARG;
}

/**
 * Входящий, который станция отдала консультанту вместо автоответчика (24.09.2026,
 * правка 5): `Stasis(royalhome-live-voice,inbound)` — оператор не взял или ночь;
 * `…,missed` — свой клиент, его агент не ответил; `…,known` — свой клиент, станция
 * агента НЕ набирала (вердикт known_client, 03.10.2026): консультант отвечает как на
 * «агент не взял» без обещаний про агента (в зале решает agentWasRung по routeDecision).
 */
export const LIVE_VOICE_INBOUND_ARG = "inbound";
export const LIVE_VOICE_MISSED_ARG = "missed";
export const LIVE_VOICE_KNOWN_ARG = "known";

/** Как канал попал к консультанту из диалплана станции. null — не из диалплана
 *  (тестовый номер, наш собственный Originate). */
export type LiveVoiceStationArrival = "inbound" | "missed" | "returned" | "known";

export function stationArrival(event: AriEvent): LiveVoiceStationArrival | null {
  const arg = stasisArgs(event)[0];
  if (arg === LIVE_VOICE_RETURNED_ARG) return "returned";
  if (arg === LIVE_VOICE_INBOUND_ARG) return "inbound";
  if (arg === LIVE_VOICE_MISSED_ARG) return "missed";
  if (arg === LIVE_VOICE_KNOWN_ARG) return "known";
  return null;
}

/**
 * Канал своего клиента агента («known»/«missed»): с 11.10.2026 робот такие звонки не
 * берёт ни при каком режиме (см. shouldAcceptLiveVoiceChannel). Аргументы остаются
 * распознаваемыми намеренно: только так отказ отдаёт канал диалплану (автоответчик),
 * а не кладёт трубку как чужому.
 */
export function isAgentClientArrival(arrival: LiveVoiceStationArrival | null): boolean {
  return arrival === "missed" || arrival === "known";
}

/**
 * Одна сессия на процесс, если порт RTP задан числом (на сайте 40800, один порт
 * проброшен в контейнер, docker-compose.prod.yml). Второй разговор не смог бы
 * занять порт и оборвался бы у человека, который уже слышит «алло». Поэтому
 * занятый консультант второй звонок не берёт вовсе: станция ведёт его дальше
 * (автоответчик), и человек не теряется.
 */
export function liveVoiceLineBusy(): boolean {
  // Набранный, но ещё не отвеченный исходящий (приглашение, опрос после показа)
  // тоже держит линию: взяв её входящим, мы оборвали бы человека, который
  // через секунду снимет трубку и услышит тишину (порт уже занят).
  // Резерв "pending" ставится синхронно сразу после этой проверки, ДО await
  // originate (02.10.2026, разбор звонков): без него два тика (приглашение и
  // опрос) или тик и кнопка «Проверить» в одну секунду оба видели свободную
  // линию — набирались два человека, второй снимал трубку в тишину и сжигал
  // свою единственную попытку.
  return (
    externalMediaPort() !== 0 &&
    sessions.size + sessionsStarting + stationReleasing + pendingOutboundCalls.size + dialingReservations() > 0
  );
}

function dialingReservations(): number {
  let n = 0;
  for (const value of activeCallsByNumber.values()) if (value === "pending") n += 1;
  return n;
}

export function shouldAcceptLiveVoiceChannel(event: AriEvent, settings: LiveVoiceGateSettings | null): boolean {
  if (event.type !== "StasisStart") return false;
  if ((event as unknown as { application?: string }).application !== LIVE_VOICE_ARI_APP) return false;
  if (!settings?.liveVoiceEnabled) return false;
  // Вернувшийся от агента звонок — наш собственный перевод, тестовый номер тут ни
  // при чём (канал уже побывал в royalhome-agent-route).
  const arrival = stationArrival(event);
  if (arrival === "returned") return true;
  // КЛИЕНТ АГЕНТА РОБОТУ НЕ ДОСТАЁТСЯ (владелец 11.10.2026: «робот НЕ отвечает
  // клиентам агента — даже если агент не отвечает, он сам перезвонит»). «known» и
  // «missed» станция шлёт ТОЛЬКО для своего клиента агента (вердикт known_client и
  // агент своего клиента не взял); диалплан из репозитория их больше не шлёт, а
  // станция со старым диалпланом получает отказ — канал уходит обратно в диалплан,
  // где за Stasis() стоит автоответчик (handBackOrHangup в processLiveVoiceAriEvent).
  if (isAgentClientArrival(arrival)) return false;
  // Настоящий входящий вместо автоответчика — только если режим включён: станция
  // могла ещё не узнать, что его выключили (значения доезжают до неё фоном).
  if (arrival) return (settings.liveVoiceInboundMode ?? "off") !== "off";
  const testExtension = settings.liveVoiceTestExtension?.trim();
  if (!testExtension) return false;
  const dialedExten = event.channel?.dialplan?.exten;
  // Номер в событии есть не всегда (зависит от того, как канал попал в Stasis) —
  // отсутствие не блокирует приём: это тестовое Stasis-приложение и без того
  // получает канал ТОЛЬКО с настройки, сделанной вручную на станции. Но если номер
  // известен и не совпадает — это точно чужой канал, отказываем.
  if (dialedExten && dialedExten !== testExtension) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Оркестрация одной сессии
// ---------------------------------------------------------------------------

interface LiveVoiceSession {
  channelId: string;
  bridgeId: string;
  externalMediaChannelId: string;
  rtpSocket: dgram.Socket;
  /** Слух и голос звонка — Gemini Live или ElevenLabs (02.10.2026, см.
   *  ai/liveVoiceProvider.ts). Имя поля осталось от времён одного поставщика. */
  gemini: LiveVoiceProviderClient;
  /** Кто ведёт этот звонок (LiveVoiceSession.provider в журнале). */
  provider: LiveVoiceProviderName;
  /** Адрес станции, куда слать аудио-ответ (из UNICASTRTP_LOCAL_ADDRESS/PORT). */
  stationRtpTarget: { address: string; port: number } | null;
  outSeq: number;
  outTimestamp: number;
  /** Готовые RTP-пакеты, ожидающие своей очереди (см. startRtpPacer). */
  outQueue: Buffer[];
  /** Таймер пейсера (тик PACER_TICK_MS, темп по часам — см. pacerStep). */
  outTimer: ReturnType<typeof setInterval> | null;
  /** 24 кГц → 8 кГц с состоянием фильтра между кусками ответа (см. StreamingDecimator). */
  outDecimator: StreamingDecimator;
  /** Остаток 8 кГц короче кадра — ждёт следующий кусок (см. PcmFramer). */
  outFramer: PcmFramer;
  /** Переполнение очереди звука уже записано в журнал — пишем раз на звонок. */
  queueOverflowLogged: boolean;
  /** Сколько кадров выброшено из-за переполнения очереди за звонок. */
  queueOverflowDropped: number;
  /** Потолок длительности сессии (см. LIVE_VOICE_MAX_SESSION_MS) — снимается в
   *  endLiveVoiceSession, если звонок закончился раньше сам. */
  maxDurationTimer: ReturnType<typeof setTimeout> | null;
  transcript: string[];
  /** Причина, названная моделью в end_call, пока ждём turnComplete прощальной
   *  фразы — null, если завершение звонком end_call сейчас не ожидается. */
  pendingEndCallReason: string | null;
  /** Настоящий офисный амбиент (см. pickOfficeAmbienceTrack/nextOfficeAmbienceFrame) —
   *  один трек, выбранный случайно при старте сессии, и позиция в нём. */
  officeAmbience: OfficeAmbienceState;
  /** Бот сейчас произносит реплику — true с первого кадра аудио от Gemini до
   *  turnComplete/interrupted. Нужен, чтобы вдох (generateBreathSound) играл
   *  РОВНО ОДИН РАЗ в начале реплики, а не на каждый кусок звука в ней. */
  isSpeaking: boolean;
  /** Состояние локального энергетического VAD на входящем звуке клиента (см.
   *  detectClientSpeechEnd) — одно на сессию, между кадрами. */
  vadState: ClientVadState;
  /** Пороги эха и VAD от самой линии (liveVoiceEchoGate.ts): опорный сигнал бота,
   *  оценка эха, шумовой пол — одно на сессию. */
  echoGate: LiveVoiceEchoGate;
  /** Вдох (generateBreathSound) уже сыгран для текущей реплики бота — либо по
   *  сигналу локального VAD (клиент замолчал), либо по первому кадру звука от
   *  Gemini, смотря что случилось раньше. Не даёт сыграть вдох дважды на одну
   *  реплику. Сбрасывается в false в turnComplete/interrupted. */
  turnFillerPlayed: boolean;
  /** Когда пейсер последний раз отдал в линию кадр речи бота (не фон) — для
   *  защиты от эха (LiveVoiceEchoGate.classify). 0 — бот ещё не говорил. */
  lastBotAudioAt: number;
  /** Звонок заканчивается по просьбе модели (end_call/escalate) — таймер
   *  ожидания тишины уже заведён, повторно не заводить. */
  endWhenQuietStarted: boolean;
  /** Карточка клиента, если звонок настоящий (originateLiveVoiceCallToClient),
   *  а не ручной тест на произвольный номер — null для теста. Нужен, чтобы
   *  save_contact заводил CallbackRequest на РЕАЛЬНОЙ карточке, а не только
   *  писал строку в журнал ошибок (см. wireGeminiEvents). */
  clientId: string | null;
  /** save_contact уже завёл CallbackRequest в этой сессии — не заводить
   *  вторую запись, если модель вызовет функцию повторно (не должна по
   *  промту, но повторный вызов не должен создавать дубль в очереди агента). */
  callbackRequestSent: boolean;
  /** Номер, с которым ушла последняя заявка save_contact (нормализованный), и
   *  сколько заявок ушло: поправка номера допускается, но не бесконечно. */
  callbackPhoneSent: string | null;
  callbackRequestsSent: number;
  /** ЗАМОК НА РУССКИЙ (см. LiveVoiceGateSettings.liveVoiceForceRussianOnly) —
   *  снят с настроек один раз при старте сессии, как и soundDesign, чтобы
   *  тумблер, переключённый посреди уже идущего звонка, не менял поведение
   *  на лету. Нужен обработчику "transcript" (wireGeminiEvents), чтобы решить,
   *  встраивать ли таджикскую фразу-извинение (см. tajikApologySent ниже). */
  forceRussianOnly: boolean;
  /** Фраза-извинение на таджикском (LIVE_VOICE_TAJIK_APOLOGY_TRIGGER) уже
   *  сказана в этой сессии — один раз за звонок, не при каждой таджикской
   *  реплике клиента (13.09.2026). */
  tajikApologySent: boolean;
  /** Эскалация к живому агенту (см. ESCALATE_TO_HUMAN_TOOL) уже отправлена в
   *  этой сессии — тем же приёмом, что и callbackRequestSent выше: повторный
   *  вызов функции моделью не должен плодить вторую заявку и второй пуш. */
  escalationSent: boolean;
  /** Сторожа ответа робота (язык и «объекты только из подборки»), liveVoiceGuards.ts. */
  replyGuard: LiveVoiceReplyGuard;
  /** Язык звонящего по его репликам, с гистерезисом (liveVoiceCallerLanguage.ts);
   *  null — замок «только русский». */
  callerLanguage: CallerLanguageTracker | null;
  /** Разрыв петли «плохо слышно / повторите» (liveVoicePoorLine.ts); null — не консультант
   *  на входящем (задачу «перезвонить» по строке расшифровки ставит только он). */
  poorLine: PoorLineTracker | null;
  /** Шум/щелчки/вдох на эту сессию — снято с настроек один раз при старте (см.
   *  soundDesignFrom ниже), не на каждый кадр. */
  soundDesign: LiveVoiceSoundDesign;
  /** Запись разговора (см. buildStereoWavFile) — накапливается по ходу сессии,
   *  собирается и заливается в R2 один раз, при завершении (endLiveVoiceSession).
   *  Речь ДО подмешивания фонового шума — записываем чистый разговор. */
  clientAudioChunks: Int16Array[];
  botAudioChunks: Int16Array[];
  /** "sales" (продающая персона: тестовый набор и звонок клиенту) или
   *  "scenario" — разговор со своим промтом, своими инструментами и своим
   *  обработчиком итога (см. PendingLiveVoiceCall: опрос покупателя после
   *  показа, проверка собственника). Решает, что делает toolCall-обработчик.
   *
   *  Ветка "survey" (вторая реализация опроса после показа, 13.09.2026) убрана
   *  17.09.2026: владелец выбрал один механизм из двух, и это сценарный звонок
   *  (см. lib/postShowingCall.ts). */
  callKind: "sales" | "scenario" | "consultant";
  /** Обработчик итога сценарного звонка (callKind "scenario") — null иначе. */
  scenarioFinish: ((result: LiveVoiceScenarioResult) => Promise<void>) | null;
  /** Обработчик вызовов функций из задания (LiveVoiceCallTask.onToolCall) — null,
   *  если функции обрабатывает только сам мост. */
  toolHandler: LiveVoiceCallTask["onToolCall"] | null;
  transcriptionObserver: LiveVoiceCallTask["onTranscription"] | null;
  /** Досье собеседника (ContactProfile), если задание его знает. */
  contactProfileId: string | null;
  /** Номер звонящего: со звонка для входящего, набранный — для исходящего. */
  callerNumber: string | null;
  direction: LiveVoiceDirection;
  /** Когда сессия открылась — для ms в AiLog (см. endLiveVoiceSession). */
  startedAtMs: number;
  /** Последнее полученное usageMetadata сессии (см. LiveVoiceServerUpdate.usage
   *  в ai/liveVoiceClient.ts) — накопительное у Google, поэтому храним ПОСЛЕДНЕЕ
   *  значение целиком, не суммируем. emptyUsage(), пока Google ничего не прислал
   *  (⚠️ поле не проверено живым звонком — см. докстринг liveVoiceClient.ts). */
  spent: SpentTokens;
  /** Расход прошлых соединений: после переподключения Google может начать счётчик
   *  заново (значение вдруг меньше прежнего) — тогда прежнее копится здесь. */
  spentBase: SpentTokens;
  /** Сколько сэмплов (8 кГц) бот наговорил за звонок — для оценки расхода, когда Google
   *  не прислал usageMetadata (estimateLiveVoiceUsage). */
  botSpeechSamples: number;
  /** Нормализованный номер для ИСХОДЯЩИХ звонков (originateLiveVoice*) — null
   *  для входящего на тестовый номер станции. Нужен только для того, чтобы
   *  endLiveVoiceSession снял резерв в activeCallsByNumber (защита от двойного
   *  дозвона, 13.09.2026) — самого номера сессия для работы не использует. */
  phoneNumber: string | null;
  /** Звонок переведён живому человеку (transferLiveVoiceCall): канал звонящего
   *  ушёл в диалплан станции, и завершение сессии НЕ кладёт ему трубку. */
  transferred: boolean;
  /** Перевод уже идёт (transferLiveVoiceCall): второй вызов получает тот же исход,
   *  а не второй `move` (аудит В5). */
  transferPromise: Promise<"ok" | "failed" | "gone"> | null;
  /** Кому идёт перевод transferPromise (agentId), если вызывающий его назвал. */
  transferRecipientId: string | null;
  /** Канал прислала станция из своего диалплана (входящий вместо автоответчика,
   *  вернувшийся от агента): при сбое сессии его отдают назад в диалплан, где за
   *  Stasis() стоит автоответчик, а не кладут трубку живому человеку. */
  handBackOnFailure: boolean;
  /** id строки LiveVoiceSession этой сессии (02.10.2026). Канал у звонка, вернувшегося
   *  от агента, тот же, что у первой сессии, поэтому итог и запись пишутся по id
   *  строки, а не по channelId — иначе вторая сессия перетёрла бы первую. */
  dbId: string;
  /** Сторож тишины (см. NO_SPEECH_PROMPT_MS): последний звук/реплика звонящего. */
  lastCallerActivityAt: number;
  /** Когда спросили «вы меня слышите?»; null — не спрашивали или человек ответил. */
  noSpeechPromptedAt: number | null;
  noSpeechTimer: ReturnType<typeof setInterval> | null;
  /** Сторож уже прощается — end_call модели второй раз трубку не кладёт. */
  noSpeechEnding: boolean;
  /** Gemini переподключается (событие "reconnecting"): сторож тишины на паузе —
   *  человека не слышно не по его вине (аудит В3). */
  geminiReconnecting: boolean;
  /** Сколько пакетов RTP пришло со станции (сторож NO_STATION_AUDIO_MS). */
  stationPackets: number;
  /** Откуда станция шлёт звук в эту сессию: запоминается по первому настоящему
   *  RTP-пакету (или задаётся LIVE_VOICE_RTP_PEER); пакеты от других отбрасываются (Г21). */
  rtpPeer: { address: string; port: number } | null;
  /** Отправитель, не совпавший с портом станции (stationRtpTarget): принимается за
   *  станцию, только если шлёт устойчиво, а настоящая так и не объявилась. */
  rtpCandidate: { address: string; port: number; packets: number } | null;
  rtpForeignDropped: number;
  /** Функции модели: уже принятые id (повтор после переподключения не исполняется
   *  второй раз), отменённые моделью и идущие сейчас (id → имя). */
  toolCallsSeen: Set<string>;
  cancelledToolIds: Set<string>;
  runningToolCalls: Map<string, string>;
  /** id вызова end_call, пока ждём тишины перед отбоем: отмена вызова отменяет отбой. */
  endCallToolId: string | null;
  /** Отметка отложенного отбоя (endWhenQuiet/hangupWhenDrained): отмена вызова
   *  модели гасит и таймеры, уже пошедшие на отбой. */
  endToken: { cancelled: boolean } | null;
  /** Служебная реплика-приветствие — на случай повтора после запасной модели. */
  greetingText: string | null;
  /** Последний принятый пакет звука со станции (сторож STATION_AUDIO_GAP_MS). */
  lastStationPacketAt: number;
  /** Первый кадр речи бота ушёл в линию — начало окна «алло, не слышно»; 0 — ещё нет. */
  firstBotAudioAt: number;
  /** Что человек сказал в окне после приветствия (см. noBotAudioSuspected). */
  helloWindowText: string;
  /** Окно «алло, не слышно» уже разобрано — один раз за звонок. */
  helloWindowDone: boolean;
  /** Сторож «модель молчит» (см. ModelStallState). */
  awaitingModelSince: number | null;
  stallNudgedAt: number | null;
  /** Тик сторожей линии (startLineWatchdog); снимается в endLiveVoiceSession. */
  lineWatchTimer: ReturnType<typeof setInterval> | null;
  /** Речь человека в текущей реплике (между ходами модели) — см. handleTajikOnRussianLock. */
  userTurnText: string;
  /** Текущая реплика уже посчитана как таджикская. */
  tajikTurnCounted: boolean;
  /** Таджикских реплик до извинения и после него. */
  tajikTurns: number;
  tajikTurnsAfterApology: number;
  /** Замеры звонка (liveVoiceMetrics.ts): подъём, первое слово, паузы хода, перебивания. */
  metrics: LiveVoiceMetricsTracker;
  /** Подъём частоты голоса клиента 8→16 кГц с памятью между кадрами (pcmCodec.ts);
   *  null — поставщик слушает на другой частоте (тогда resamplePcm16). */
  inUpsampler: StreamingInterpolator | null;
  /** Строка журнала LiveVoiceSession заводится параллельно снятию трубки; итог ждёт её. */
  dbRowReady: Promise<unknown> | null;
  /** Произнесённых ходов модели (turnComplete после звука) — первый из них приветствие. */
  spokenTurnsCompleted: number;
  /** Приветствие доиграло в линии целиком — дальше клиент может перебивать хвосты реплик. */
  greetingPlayed: boolean;
  /** Подряд громких кадров клиента (не эхо) поверх доигрывающего хвоста — см. LOCAL_BARGE_IN_FRAMES. */
  localBargeInFrames: number;
}

/** Длительность кадра в миллисекундах — тот же шаг, что у станции. */
const FRAME_MS = 20;
/** Потолок очереди: 10 секунд звука. Больше копить незачем — если модель
 *  наговорила столько вперёд, разговор всё равно уже рассинхронизирован. */
const MAX_QUEUED_FRAMES = 500;

/** Вдох перед репликой (см. generateBreathSound) — 400 мс на 8 кГц = 3200
 *  сэмплов. Пик громче фонового амбиента, но тише самой речи — не должен
 *  звучать как отдельный «звук», скорее как то, что слышно на выдохе перед
 *  словом в трубке живого разговора. */
const BREATH_DURATION_MS = 400;
const BREATH_PEAK_AMPLITUDE = 700;

/**
 * ЗВУКОВОЕ ОФОРМЛЕНИЕ ИЗ НАСТРОЕК (13.09.2026, «полный контроль из админки») —
 * читается из Settings на старте сессии (см. onLiveVoiceAriEvent) и живёт на
 * самой сессии (LiveVoiceSession.soundDesign), а не пересчитывается на каждый
 * кадр — тумблер посреди уже идущего звонка возьмётся только со СЛЕДУЮЩЕГО
 * звонка, как и остальные настройки живого голоса (voiceName, промт).
 *
 * СИНТЕТИЧЕСКИЙ ГУЛ И ЩЕЛЧКИ КЛАВИАТУРЫ УБРАНЫ ЦЕЛИКОМ (14.09.2026, после
 * того как в Settings появился настоящий офисный амбиент — см.
 * pickOfficeAmbienceTrack/nextOfficeAmbienceFrame ниже) — решение владельца:
 * «в этих mp3 уже есть любой нужный мне шум», генерировать поверх настоящей
 * записи ещё и искусственный гул с искусственным щелчком клавиатуры стало
 * дублированием, а не запасным вариантом. Выключенный офисный амбиент теперь
 * значит настоящую цифровую тишину в паузах, не откат на синтетику.
 */
export interface LiveVoiceSoundDesign {
  breathEnabled: boolean;
  officeAmbienceEnabled: boolean;
  officeAmbienceVolume: number;
}

export function soundDesignFrom(settings: LiveVoiceGateSettings | null): LiveVoiceSoundDesign {
  return {
    // 02.10.2026: по умолчанию ВЫКЛЮЧЕНЫ (аудит моста К-1…К-3: «пшш» перед ответом,
    // фон «качается» на сотовой линии). Владелец может включить в настройках.
    breathEnabled: settings?.liveVoiceBreathEnabled ?? false,
    officeAmbienceEnabled: settings?.liveVoiceOfficeAmbienceEnabled ?? false,
    officeAmbienceVolume: settings?.liveVoiceOfficeAmbienceVolume ?? 0.35,
  };
}

/**
 * ГОЛОС ЗАРАНЕЕ, ДО ЗВОНКА (14.09.2026, владелец: один голос звучит без акцента
 * на русском, другой — на таджикском, оба сразу не могут звучать в одном
 * звонке — Gemini Live фиксирует голос на всю WebSocket-сессию, сменить его
 * посреди разговора нельзя без пересоздания сессии, которого здесь нет). Тот
 * же сигнал, что уже решает, разрешён ли таджикский в этом звонке вообще —
 * liveVoiceForceRussianOnly — решает и выбор голоса: замок включён → голос
 * для русского; замок выключен → голос для таджикского, если он задан, иначе
 * тот же голос для русского (не выдумываем новый дефолт, откатываемся на
 * привычный, если владелец не заполнил второе поле).
 */
export function resolveLiveVoiceVoiceName(settings: LiveVoiceGateSettings | null): string | undefined {
  if (!settings) return undefined;
  if (settings.liveVoiceForceRussianOnly) return settings.liveVoiceVoiceName ?? undefined;
  return settings.liveVoiceVoiceNameTajik ?? settings.liveVoiceVoiceName ?? undefined;
}

/**
 * ЯЗЫК ЗВОНКА ДЛЯ ПОСТАВЩИКА ГОЛОСА (02.10.2026, ElevenLabs). Gemini определяет
 * язык сам, а агенту ElevenLabs язык задаётся на весь разговор — от него зависит
 * распознавание речи. Решает та же логика, что выбирает голос: замок «только
 * русский» — русский; иначе язык, который знает задание (досье консультанта,
 * приглашение кандидата); не знает — русский, как основной голос.
 */
export function resolveLiveVoiceLanguage(
  forceRussianOnly: boolean,
  known: LiveVoiceLanguage | null | undefined
): LiveVoiceLanguage {
  if (forceRussianOnly) return "ru";
  return known ?? "ru";
}

/**
 * НАСТОЯЩИЙ ОФИСНЫЙ АМБИЕНТ ВМЕСТО СИНТЕТИЧЕСКОГО ШУМА (14.09.2026, владелец
 * прислал два своих mp3 с офисным гулом и голосами на фоне — «синтетический
 * шум — не то, хочу настоящие голоса вокруг»). Файлы заранее сконвертированы
 * ffmpeg'ом ВНЕ рантайма (raw PCM16 8кГц моно, 2:30 с затуханием на границах
 * цикла, уже приглушены −14dB при конвертации — источники были нормальной
 * громкости записью, а не «фоном») и лежат в assets/live-voice-ambience/ —
 * никакой библиотеки для декодирования mp3 в самом Node не нужно, декодируем
 * один раз при подготовке файла, не на каждый звонок.
 *
 * Читаются В ПАМЯТЬ ОДИН РАЗ на процесс (не на сессию — оба трека вместе это
 * ~4.8МБ, держать по копии на каждый параллельный звонок незачем) и кешируются
 * здесь же. Отсутствие файла (например, кто-то не подтянул assets/ в свою
 * копию репозитория) — не должно ронять звонок: тихо возвращаем null, вызывающий
 * (nextBackgroundNoiseFrame) откатывается на настоящую цифровую тишину — синтетического
 * генератора шума с 14.09.2026 больше нет (см. докстринг LiveVoiceSoundDesign).
 */
const OFFICE_AMBIENCE_DIR = path.join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..", "assets", "live-voice-ambience");
const OFFICE_AMBIENCE_FILES = ["office-1.pcm", "office-2.pcm"];
let officeAmbienceTracksCache: Int16Array[] | null = null;

function loadOfficeAmbienceTracks(): Int16Array[] {
  if (officeAmbienceTracksCache) return officeAmbienceTracksCache;
  const tracks: Int16Array[] = [];
  for (const file of OFFICE_AMBIENCE_FILES) {
    try {
      const buf = fs.readFileSync(path.join(OFFICE_AMBIENCE_DIR, file));
      tracks.push(bufferToInt16LE(buf));
    } catch (err) {
      void logSystemError(
        "telephony",
        `Живой голос: не удалось прочитать офисный амбиент ${file}: ${err instanceof Error ? err.message : err} — ` +
          "звонок продолжится в цифровой тишине в паузах (синтетического шума больше нет)."
      );
    }
  }
  officeAmbienceTracksCache = tracks;
  return tracks;
}

/** Один трек на сессию, выбранный случайно при старте — не на каждый кадр
 *  (иначе гул дробился бы сменой характера каждые 20мс). `position` крутится
 *  по кругу без явного кроссфейда: концы файла уже затухают в тишину при
 *  конвертации, поэтому граница цикла слышна как естественное затишье, а не щелчок. */
export interface OfficeAmbienceState {
  track: Int16Array | null;
  position: number;
}

export function pickOfficeAmbienceTrack(): OfficeAmbienceState {
  const tracks = loadOfficeAmbienceTracks();
  if (tracks.length === 0) return { track: null, position: 0 };
  const track = tracks[Math.floor(Math.random() * tracks.length)];
  return { track, position: Math.floor(Math.random() * track.length) };
}

/** Кадр из зацикленного трека, умноженный на громкость настройки — идёт в
 *  mixPcm16 на стороне вызывающего (nextBackgroundNoiseFrame). */
export function nextOfficeAmbienceFrame(state: OfficeAmbienceState, frameSize: number, volume: number): Int16Array {
  const out = new Int16Array(frameSize);
  const track = state.track;
  if (!track || track.length === 0) return out;
  for (let i = 0; i < frameSize; i++) {
    out[i] = Math.round(track[state.position] * volume);
    state.position = (state.position + 1) % track.length;
  }
  return out;
}

/**
 * ПОТОЛОК ДЛИТЕЛЬНОСТИ СЕССИИ (12.09.2026, живой звонок: «не отключает
 * телефон и просто висит»).
 *
 * У бота сегодня нет способа самому решить «разговор закончен» и положить
 * трубку — ни function calling, ни разбор транскрипта на фразы вроде «агент
 * перезвонит» здесь не заведены. Пока это не сделано, без потолка звонок
 * висит, пока не положит трубку человек, — платный эфир идёт всё это время.
 * 5 минут с запасом покрывает содержательный разговор о недвижимости; когда
 * появится осознанное завершение (например, tool call в Gemini Live), этот
 * таймер останется подстраховкой на случай, если модель промолчит.
 *
 * 15 МИНУТ С 24.09.2026. Пять минут стояли и потому, что сессия Google сама не
 * жила дольше ~10 минут. Теперь соединение продлевается по токену продолжения
 * (ai/liveVoiceClient.ts), завершение по end_call есть с 12.09, а консультация
 * с подбором квартир и переводом агенту в пять минут не укладывается. Потолок
 * остаётся страховкой от висящего платного эфира.
 */
const LIVE_VOICE_MAX_SESSION_MS = 15 * 60_000;

const sessions = new Map<string, LiveVoiceSession>();
/** Сессии, которые поднимаются прямо сейчас (мост, RTP, Gemini), но ещё не в
 *  sessions: без них два звонка в одну секунду оба сочли бы линию свободной. */
let sessionsStarting = 0;
/** Сессии, уже убранные из sessions, у которых станция ещё убирает мост и канал
 *  звука. Порт RTP фиксированный: пока UnicastRTP прошлого звонка жив и шлёт
 *  кадры, следующий звонок, занявший порт, получал чужой кадр первым (аудит
 *  02.10.2026, п.3). Линия занята, пока уборка станции не закончилась. */
let stationReleasing = 0;

/**
 * ЗВОНЯЩИЙ ПОЛОЖИЛ ТРУБКУ, ПОКА СЕССИЯ ПОДНИМАЛАСЬ (02.10.2026, аудит надёжности).
 *
 * Подъём сессии — несколько запросов к станции и чтение задания из базы, то есть
 * секунды. StasisEnd, пришедший в эти секунды, не находил сессии в `sessions` и
 * терялся, а сессия затем всё равно заводилась и говорила в пустой мост до
 * потолка в пятнадцать минут — всё это время линия была занята
 * (liveVoiceLineBusy), и каждый следующий звонящий уходил на автоответчик.
 * Теперь такой конец запоминается здесь, и сессия, едва попав в `sessions`,
 * закрывается тем же путём, что обычный отбой.
 */
const startingChannels = new Set<string>();
/** Каналы, чей StasisStart уже принят в работу, но сессия ещё не поднимается
 *  (идёт чтение настроек и проверки): дубль события не должен их увести (LIVE02). */
const acceptingStasisChannels = new Set<string>();
const endedWhileStarting = new Set<string>();
/** Станционные объекты сессий, которые ПОДНИМАЮТСЯ (ещё не в `sessions`): уборщик
 *  сирот их не трогает. */
const startingStationIds = new Set<string>();

/**
 * ЖИЗНЕННЫЙ ЦИКЛ ЗВОНКА: ВРЕМЕННЫЕ ПОТОЛКИ (02.10.2026, аудит надёжности В1/В17).
 *
 * До этой правки любой await подъёма сессии (чтение базы, ответ станции) мог
 * зависнуть навсегда: человек слушал тишину, а `sessionsStarting` держал линию
 * занятой до рестарта — каждый следующий звонящий уходил на автоответчик.
 */
/** Всё, что идёт ДО подключения к Gemini: креды, мост, станция, задание, строка журнала. */
export const LIVE_VOICE_START_TIMEOUT_MS = 20_000;
/** Подключение к Gemini (две модели по 25 с в худшем случае — человек столько не ждёт). */
export const LIVE_VOICE_CONNECT_TIMEOUT_MS = 25_000;
/** Чтение настроек/кредов из базы на пути звонка. */
const DB_READ_TIMEOUT_MS = 8_000;
/** Запись итога сессии в базу при завершении — линия к этому моменту уже свободна. */
const DB_WRITE_TIMEOUT_MS = 8_000;
/** Ждать, пока зальётся запись разговора, прежде чем отдать итог сценарию. */
const RECORDING_WAIT_MS = 20_000;
/** Задание консультанта: не пришло за это время — разговор идёт с общей ролью. */
const TASK_WAIT_MS = 5_000;
/** Один вызов функции модели: дольше модель не ждём (у 3.1 вызов блокирует разговор). */
export const LIVE_VOICE_TOOL_TIMEOUT_MS = 10_000;
/** Перевод на агента — звонок агенту и ожидание ответа идут внутри вызова, 10 с мало. */
export const LIVE_VOICE_TRANSFER_TOOL_TIMEOUT_MS = 35_000;

function toolTimeoutMs(name: string): number {
  return name === "transfer_to_agent" ? LIVE_VOICE_TRANSFER_TOOL_TIMEOUT_MS : LIVE_VOICE_TOOL_TIMEOUT_MS;
}

const TIMED_OUT = Symbol("timed_out");

/** Результат или TIMED_OUT; исход «слишком поздно» промиса игнорируется, отказ — тоже. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), ms);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/** Последние рабочие креды ARI: если база на секунду недоступна, а человек уже в
 *  мосте, отпустить его всё равно нужно (аудит В1/В2). */
let lastKnownAriCreds: AriCredentials | null = null;

/**
 * Креды ARI, не бросая и не зависая. Сбой/зависание базы — последние известные
 * креды (канал без хозяина хуже устаревшего пароля); `null` — телефония
 * действительно не настроена.
 */
async function loadCredsSafe(): Promise<AriCredentials | null> {
  try {
    const creds = await withTimeout(loadAriCredentials(), DB_READ_TIMEOUT_MS);
    if (creds === TIMED_OUT) {
      void logSystemError("telephony", "Живой голос: креды ARI не прочитались из базы за отведённое время — беру последние известные.", {
        dedupKey: "live-voice-creds-read",
      });
      return lastKnownAriCreds;
    }
    if (creds) lastKnownAriCreds = creds;
    return creds;
  } catch (err) {
    void logSystemError(
      "telephony",
      `Живой голос: креды ARI не прочитались из базы (${describeError(err)}) — беру последние известные.`,
      { dedupKey: "live-voice-creds-read" }
    );
    return lastKnownAriCreds;
  }
}

/**
 * УБОРКА СТАНЦИИ (02.10.2026, аудит В2; живая находка Dan: канал UnicastRTP висел
 * 101 час). Отказ deleteBridge/hangupCall на выходе раньше глотался: ни строки в
 * журнале, ни повтора, а ARI-мост и канал звука сами не умирают. Теперь отказ
 * пишется и запоминается; уборщик (sweepLiveVoiceStationLeftovers, тик раз в
 * 10 минут) повторяет, а заодно снимает сирот по списку станции.
 */
interface StationCleanup {
  kind: "bridge" | "channel";
  id: string;
  since: number;
  attempts: number;
}
const pendingStationCleanups = new Map<string, StationCleanup>();
const STATION_CLEANUP_MAX_ATTEMPTS = 12;

async function removeStationObject(creds: AriCredentials, kind: "bridge" | "channel", id: string): Promise<boolean> {
  const key = `${kind}:${id}`;
  const result = await (kind === "bridge" ? deleteBridge(creds, id) : hangupCall(creds, id)).catch(
    (err): { ok: false; error: string } => ({ ok: false, error: describeError(err) })
  );
  if (result.ok) {
    pendingStationCleanups.delete(key);
    return true;
  }
  const known = pendingStationCleanups.get(key);
  pendingStationCleanups.set(key, { kind, id, since: known?.since ?? Date.now(), attempts: (known?.attempts ?? 0) + 1 });
  void logSystemError(
    "telephony",
    `Живой голос: на станции не убран ${kind === "bridge" ? "мост" : "канал звука"} (${"error" in result ? result.error : "отказ"}) — ` +
      "уборщик повторит; если это повторяется, смотрите связь с АТС.",
    { dedupKey: `live-voice-cleanup-${kind}` }
  );
  return false;
}

/* Адрес и порт звука на сервере (LIVE_VOICE_RTP_HOST/PORT) — liveVoiceRtpConfig.ts:
 * их читают и Настройки, чтобы показать «не задано», а не «включено». */

/**
 * Настройки живого голоса из базы. `null` — либо строки настроек нет, либо база не
 * ответила.
 *
 * ОТКАЗ ЧТЕНИЯ ТЕПЕРЬ ПОПАДАЕТ В ЖУРНАЛ, и это не мелочь. Эти настройки читаются
 * ещё раз в момент, когда клиент УЖЕ ВЗЯЛ ТРУБКУ (StasisStart ниже), и `null`
 * там неотличим от «тумблер выключили» — звонок обрывается сразу после ответа.
 * Пока отказ молчал, такой обрыв не оставлял ни строки ни в «Здоровье системы»,
 * ни в «Последних звонках»: состоявшийся разговор выглядел так, будто клиент сам
 * бросил трубку. Одна попытка повтора здесь тоже к месту — мимолётный обрыв
 * соединения с базой стоит дешевле оборванного разговора.
 */
async function loadLiveVoiceSettings(): Promise<LiveVoiceGateSettings | null> {
  try {
    const found = await withTimeout(
      prisma.settings.findUnique({
        where: { id: "singleton" },
        select: {
          liveVoiceEnabled: true,
          liveVoiceTestExtension: true,
          liveVoicePrompt: true,
          liveVoiceVoiceName: true,
          liveVoiceVoiceNameTajik: true,
          liveVoiceForceRussianOnly: true,
          liveVoiceBreathEnabled: true,
          liveVoiceOfficeAmbienceEnabled: true,
          liveVoiceOfficeAmbienceVolume: true,
          liveVoiceInboundMode: true,
        },
      }),
      // Зависшее чтение оставило бы человека без ответа: StasisStart ждёт настройки.
      DB_READ_TIMEOUT_MS
    );
    if (found === TIMED_OUT) throw new Error(`база не ответила за ${DB_READ_TIMEOUT_MS / 1000} с`);
    const settings = found;
    if (!settings) return null;
    return {
      liveVoiceEnabled: settings.liveVoiceEnabled,
      liveVoiceTestExtension: settings.liveVoiceTestExtension,
      liveVoicePrompt: settings.liveVoicePrompt,
      liveVoiceVoiceName: settings.liveVoiceVoiceName,
      liveVoiceVoiceNameTajik: settings.liveVoiceVoiceNameTajik,
      liveVoiceForceRussianOnly: settings.liveVoiceForceRussianOnly,
      liveVoiceOfficeAmbienceEnabled: settings.liveVoiceOfficeAmbienceEnabled,
      liveVoiceOfficeAmbienceVolume: settings.liveVoiceOfficeAmbienceVolume,
      liveVoiceBreathEnabled: settings.liveVoiceBreathEnabled,
      liveVoiceInboundMode: settings.liveVoiceInboundMode,
    };
  } catch (err) {
    // База недоступна — сокет из-за этого не роняем (тот же принцип, что везде в
    // телефонии), но и молчать нельзя: следующий шаг вызывающего — положить
    // трубку клиенту, который только что ответил.
    void logSystemError(
      "telephony",
      `Живой голос: настройки не прочитались из базы (${describeError(err)}) — ` +
        `звонок оборвётся, как будто тумблер выключен. Если это повторяется, смотрите Postgres.`,
      { dedupKey: "live-voice-settings-read" }
    );
    return null;
  }
}

// ---------------------------------------------------------------------------
// Исходящий тестовый звонок (12.09.2026) — «бот сам звонит», а не «дозвонись
// сам до тестового номера». shouldAcceptLiveVoiceChannel ниже создан для
// ВХОДЯЩЕГО пути и сверяет набранный номер с liveVoiceTestExtension — для
// исходящего звонка эта сверка не имеет смысла (набранный номер — реальный
// мобильный, а не номер станции), поэтому канал, который originate создал МЫ
// САМИ, помечается здесь и пропускается в обход проверки номера, но не в обход
// тумблера liveVoiceEnabled — если его выключили после нажатия кнопки, звонок
// всё равно должен вежливо оборваться, а не повиснуть.
// ---------------------------------------------------------------------------

/** Один канал ;1 живого голоса, который originate создал ПО НАШЕЙ команде (см.
 *  originateLiveVoiceTestCall/originateLiveVoiceCallToClient) — StasisStart на
 *  такой id принимается без сверки с liveVoiceTestExtension. Контекст (клиент,
 *  готовый промт под конкретный звонок) едет вместе с записью, чтобы
 *  startLiveVoiceSession узнала о нём в тот момент, когда придёт StasisStart —
 *  до этого момента у нас есть только id канала, самого события ещё нет.
 *  Запись короткоживущая: снимается либо первым же StasisStart на этот id,
 *  либо таймером ниже, если событие почему-то не пришло вовсе (сорвавшийся
 *  Originate, разорванная подписка). */
interface PendingLiveVoiceCall {
  isManualTestCall: boolean;
  clientId?: string;
  systemInstruction?: string;
  voiceName?: string;
  callKind?: "sales" | "scenario";
  /** СЦЕНАРНЫЙ ЗВОНОК (16.09.2026) — инструменты, первая реплика и обработчик
   *  итога приезжают вместе с заданием, а не выбираются мостом по callKind.
   *  Зачем так: у моста нет и не должно быть знания о прикладной части CRM (см.
   *  докстринг файла), а сценариев уже больше одного — опрос покупателя после
   *  показа и проверка собственника показанного объекта. */
  tools?: LiveVoiceFunctionDeclaration[];
  greetingTrigger?: string;
  onFinished?: (result: LiveVoiceScenarioResult) => Promise<void>;
  /** Нормализованный номер (см. normalizeDialNumber) — нужен, чтобы снять
   *  резерв в activeCallsByNumber, когда сессия реально стартует/заканчивается
   *  (см. LiveVoiceSession.phoneNumber, защита от двойного дозвона 13.09.2026). */
  phoneNumber?: string;
  /** Снять замок «только русский» для этого звонка: сценарий сам знает, что
   *  собеседник говорит по-таджикски (приглашение кандидата, 25.09.2026). */
  forceRussianOnly?: boolean;
  /** Язык разговора, если сценарий его знает (приглашение кандидата). Нужен
   *  поставщику ElevenLabs — Gemini определяет язык сам (02.10.2026). */
  language?: LiveVoiceLanguage;
  /** Задание на разговор спросить у прикладной части (setLiveVoiceCallResolver),
   *  как для входящего: проверочный звонок из Настроек звучит ровно так, как
   *  консультант ответит настоящему звонящему (24.09.2026). */
  resolveAs?: "test";
}

/** Что мост знает о законченном сценарном разговоре — без всякой трактовки. */
export interface LiveVoiceScenarioResult {
  channelId: string;
  /** Расшифровка обеих сторон, строками «Клиент: …» / «Бот: …». */
  transcript: string[];
  /** Причина завершения, как её записал мост ("channel_ended", "gemini_error",
   *  "max_duration", "model_ended_call: …"). */
  reason: string;
  /**
   * Собеседник сказал хоть что-то.
   *
   * Отличать это от «трубку сняли» обязательно: снять и молча положить, попасть
   * на автоответчик или на сорвавшийся звонок — всё это ответ станции, но не
   * разговор. Считать такой звонок состоявшимся опросом значило бы записывать
   * людям молчание, которого они не выбирали.
   */
  clientSpoke: boolean;
  /**
   * Робот сказал в линию хоть слово (09.10.2026, аудит линии, п.3). «Трубку снял
   * робот» ещё не значит «робот ответил»: Gemini не подключился, звук не дошёл,
   * модель зависла — человек слышал тишину. Такой звонок — пропущенный, а не
   * «отвечен ИИ». Необязательное — прежние обработчики итога его не знают.
   */
  botSpoke?: boolean;
  /** Ключ записи разговора в R2 (см. saveLiveVoiceRecording) — null, если записи
   *  нет. Итог отдаётся ПОСЛЕ того, как запись залита, чтобы обработчик мог
   *  приложить её к карточке. */
  recordingKey?: string | null;
  /** Когда сессия открылась и когда закончилась. */
  startedAt?: Date;
  endedAt?: Date;
  /** Разговор закончился переводом звонка живому человеку (transferLiveVoiceCall). */
  transferred?: boolean;
}

/** Кто кому звонит. "test" — кнопка «Проверить» в Настройках: бот звонит тому,
 *  кто её нажал, но ведёт себя так, будто тот позвонил в агентство. */
export type LiveVoiceDirection = "outbound" | "inbound" | "test";

/**
 * ЗАДАНИЕ НА ЗВОНОК ОТ ПРИКЛАДНОЙ ЧАСТИ CRM (24.09.2026, консультант на входящих).
 *
 * Мост по-прежнему не знает ни клиентов, ни объектов, ни лидов (см. докстринг
 * файла): кто звонит, что знать и что делать с итогом, решает тот, кто
 * зарегистрировал обработчик (lib/telephony/liveVoiceConsultant.ts через
 * setLiveVoiceCallResolver). Тот же приём, что у сценарных звонков, только задание
 * приходит не с Originate, а по факту входящего.
 */
export interface LiveVoiceCallTask {
  systemInstruction: string;
  greetingTrigger?: string;
  tools?: LiveVoiceFunctionDeclaration[];
  voiceName?: string;
  /** Язык звонка по досье (см. liveVoiceConsultant.ts::consultantLanguage) —
   *  читает только ElevenLabs (02.10.2026). */
  language?: LiveVoiceLanguage;
  clientId?: string | null;
  contactProfileId?: string | null;
  /** Вызов функции моделью. null — «не моя», функцию обрабатывает мост
   *  (save_contact, escalate_to_human, end_call). Отказ обработчика — ответ модели
   *  {ok:false}: зависшая без ответа функция держала бы разговор. */
  onToolCall?: (call: LiveVoiceToolCall, ctx: LiveVoiceToolContext) => Promise<LiveVoiceToolReply | null>;
  /** Observation-only P16 port. Default absent; no profile/FINAL/write grant.
   * A future adapter must validate authenticated native evidence independently. */
  onTranscription?: (observation: LiveVoiceTranscriptionObservation, context: Readonly<{
    sessionId: string; channelId: string; direction: LiveVoiceDirection; isCurrent: () => boolean;
  }>) => void | Promise<void>;
  onFinished?: (result: LiveVoiceScenarioResult) => Promise<void>;
}

export interface LiveVoiceToolContext {
  channelId: string;
  /** Расшифровка на этот момент, строками «Клиент: …» / «Бот: …». */
  transcript: readonly string[];
  /** Модель отменила этот вызов (собеседник перебил): побочное действие, которое
   *  ещё не началось, делать не нужно. Необязательно — прежние обработчики не знают. */
  isCancelled?: () => boolean;
}

export interface LiveVoiceToolReply {
  response: Record<string, unknown>;
  /** Как модели с асинхронными функциями подать результат (gemini-3.8-live);
   *  прежней модели не отправляется (см. LiveVoiceClient.sendToolResponse). */
  scheduling?: "INTERRUPT" | "WHEN_IDLE" | "SILENT";
}

export interface LiveVoiceCallInfo {
  channelId: string;
  direction: Exclude<LiveVoiceDirection, "outbound">;
  /** Номер звонящего; null — скрыт. */
  callerNumber: string | null;
  settings: LiveVoiceGateSettings | null;
  /** Звонок вернулся от агента, который не взял трубку после перевода. */
  returnedFromAgent?: boolean;
  /** Свой клиент звонил агенту, агент не ответил, и станция отдала звонок
   *  консультанту вместо автоответчика. */
  agentMissed?: boolean;
}

type LiveVoiceCallResolver = (info: LiveVoiceCallInfo) => Promise<LiveVoiceCallTask | null>;
let callResolver: LiveVoiceCallResolver | null = null;

/** Регистрируется один раз при старте API (src/index.ts) — крючок вместо импорта,
 *  тот же приём, что liveIncomingLookupHook.ts: мост не тянет за собой прикладную
 *  часть CRM, и цикл импортов не замыкается. Без регистрации (тесты, воркер)
 *  входящий и проверочный звонок идут с прежней ролью исходящего звонка. */
export function setLiveVoiceCallResolver(fn: LiveVoiceCallResolver | null): void {
  callResolver = fn;
}

/** Спросить задание, не роняя звонок: отказ обработчика — прежняя роль, а не
 *  трубка, брошенная человеку, который уже ответил. */
function resolveCallTask(info: LiveVoiceCallInfo): Promise<LiveVoiceCallTask | null> | undefined {
  if (!callResolver) return undefined;
  return callResolver(info).catch((err) => {
    void logSystemError(
      "telephony",
      `Живой голос: задание консультанта для канала ${info.channelId} не собралось (${describeError(err)}) — ` +
        "звонок идёт с общей ролью, без справочника и без узнавания звонящего."
    );
    return null;
  });
}

/**
 * ЗАЩИТА ОТ ДВОЙНОГО ДОЗВОНА (13.09.2026) — Originate сам по себе не проверяет,
 * есть ли уже активный звонок на этот номер. Ключ — НОРМАЛИЗОВАННЫЙ номер (не
 * channelId: до ответа Asterisk канала ещё нет), значение — "pending" сразу
 * после решения звонить или channelId, как только Asterisk его вернул.
 *
 * Резерв ставится СИНХРОННО, без await между проверкой и записью (иначе два
 * быстрых клика/тика прошли бы оба мимо проверки) — см. каждую из
 * originateLiveVoice*. Снимается в трёх местах: Originate отказал, StasisStart
 * так и не пришёл за MANUAL_TEST_CHANNEL_TTL_MS (канал не поднялся), или сессия
 * закончилась по-настоящему (endLiveVoiceSession, через LiveVoiceSession.phoneNumber).
 */
const activeCallsByNumber = new Map<string, string>();

function hasActiveCallToNumber(normalizedNumber: string): boolean {
  return activeCallsByNumber.has(normalizedNumber);
}

/** Settings → то, что нужно buildLiveVoiceSystemPrompt (liveVoicePersona.ts) —
 *  один пересчёт в одном месте, чтобы оба originate* не разъезжались в логике
 *  «что считается заданным/пустым». */
export function promptSettingsFrom(settings: LiveVoiceGateSettings | null): LiveVoicePromptSettings {
  return {
    roleOverride: settings?.liveVoicePrompt ?? null,
    forceRussianOnly: settings?.liveVoiceForceRussianOnly ?? true,
  };
}
const pendingOutboundCalls = new Map<string, PendingLiveVoiceCall>();
const MANUAL_TEST_CHANNEL_TTL_MS = 60_000;

export interface LiveVoiceTestCallResult {
  ok: boolean;
  channelId?: string;
  error?: string;
  /** Линия занята другим разговором (один порт RTP — одна сессия, см.
   *  liveVoiceLineBusy). Не отказ номера: вызывающий просто пробует позже. */
  busy?: boolean;
}

/**
 * Звук со станции некуда принимать (LIVE_VOICE_RTP_HOST/PORT не заданы) — не
 * набираем вовсе (02.10.2026, аудит Д27/С7): человек снимал трубку, робот молчал
 * и сбрасывал, а сценарий считал это разговором. «Занято» — вызывающий перенесёт
 * звонок, не тратя попытку; в журнале одна проблема на все такие отказы.
 */
function rtpConfigRefusal(): LiveVoiceTestCallResult | null {
  const problem = liveVoiceRtpProblem();
  if (!problem) return null;
  void logSystemError("telephony", `Живой голос: звонок не набран. ${problem}`, { dedupKey: "live-voice-rtp-not-configured" });
  return { ok: false, busy: true, error: problem };
}

/** originateToStasisApp, который не бросает: исключение оставило бы резерв номера
 *  («pending») без таймера навсегда (аудит С7). */
async function originateGuarded(
  target: string,
  ...args: Parameters<typeof originateToStasisApp>
): Promise<Awaited<ReturnType<typeof originateToStasisApp>>> {
  try {
    return await originateToStasisApp(...args);
  } catch (err) {
    activeCallsByNumber.delete(target);
    return { ok: false, error: describeError(err) };
  }
}

/**
 * Исходящий тестовый звонок живого голоса на произвольный номер (кнопка в
 * Настройках → Телефония → «Живой голос»). Набор идёт ровно тем же путём, что и
 * звонок агента на свой мобильный (`Local/<номер>@from-internal/n`,
 * см. ariClient.ts:originateCall) — из диалплана FreePBX это неотличимо от
 * звонка, набранного вручную с офисного аппарата, разница только в том, куда
 * попадает плечо ;1: не агенту, а сразу в Stasis-приложение живого голоса.
 */
export async function originateLiveVoiceTestCall(phoneNumber: string): Promise<LiveVoiceTestCallResult> {
  if (!isDialableTajikNumber(phoneNumber)) {
    return { ok: false, error: "Не похоже на таджикский номер" };
  }
  const rtpRefusal = rtpConfigRefusal();
  if (rtpRefusal) return rtpRefusal;
  const target = normalizeDialNumber(phoneNumber);
  if (hasActiveCallToNumber(target)) {
    return { ok: false, error: "На этот номер уже идёт звонок" };
  }
  const [settings, creds] = await Promise.all([loadLiveVoiceSettings(), loadCredsSafe()]);
  if (!creds) return { ok: false, error: "Телефония не настроена" };
  if (!settings?.liveVoiceEnabled) return { ok: false, error: "Живой голос выключен — включите тумблер выше" };
  // Повторная проверка ПОСЛЕ await настроек/кредов — за это время параллельный
  // originate на тот же номер мог успеть зарезервировать его первым.
  if (hasActiveCallToNumber(target)) {
    return { ok: false, error: "На этот номер уже идёт звонок" };
  }
  // Тот же замок одной линии, что у сценарного звонка ниже (25.09.2026).
  if (liveVoiceLineBusy()) {
    return { ok: false, busy: true, error: "Линия живого голоса занята другим разговором" };
  }
  // Кнопка «Проверить» паузу «нет звука со станции» НЕ соблюдает (аудит 02.10.2026,
  // п.1): это и есть проба. Раньше пауза отказывала и ей, а снять паузу могла
  // только сессия со станции — тоннель починили, а робот молчал до конца паузы.
  // Успешный звонок снимает паузу первым же пакетом, неудачный заводит её заново.
  const testPrompt = buildLiveVoiceSystemPrompt(undefined, promptSettingsFrom(settings));
  activeCallsByNumber.set(target, "pending");

  const result = await originateGuarded(target, creds, `Local/${target}@${DIALPLAN_CONTEXT}/n`, LIVE_VOICE_ARI_APP, {
    callerId: "Royal Home — проверка живого голоса",
  });
  if (!result.ok || !result.channelId) {
    activeCallsByNumber.delete(target);
    return { ok: false, error: result.error ?? "Asterisk не вернул id канала" };
  }
  activeCallsByNumber.set(target, result.channelId);
  // Проба началась — пауза «нет звука» снимается сразу (и её счёт тоже): удвоенный
  // срок прошлых отказов не должен пережить починку тоннеля.
  clearLiveVoiceAudioPathHold();

  // Настройки из интерфейса (голос/промт/замок на русский, 13.09.2026) — тестовый
  // звонок должен звучать РОВНО как настоящий, иначе проверка им ничего не проверяет.
  pendingOutboundCalls.set(result.channelId, {
    isManualTestCall: true,
    phoneNumber: target,
    resolveAs: "test",
    systemInstruction: testPrompt,
    voiceName: resolveLiveVoiceVoiceName(settings),
  });
  setTimeout(() => {
    pendingOutboundCalls.delete(result.channelId!);
    // StasisStart так и не пришёл (сорвавшийся Originate/канал не поднялся) —
    // сессия не завелась, снимаем резерв сами; если сессия стартовала, резерв
    // снимет endLiveVoiceSession при завершении звонка.
    if (!sessions.has(result.channelId!) && !startingChannels.has(result.channelId!)) activeCallsByNumber.delete(target);
    runDeferredListenerRestart();
  }, MANUAL_TEST_CHANNEL_TTL_MS).unref?.();
  return { ok: true, channelId: result.channelId };
}

export interface LiveVoiceClientCallResult extends LiveVoiceTestCallResult {}

/**
 * НАСТОЯЩИЙ исходящий звонок конкретному клиенту (13.09.2026, разбор «заменить
 * оператора» — см. TASKS.md). В отличие от originateLiveVoiceTestCall выше,
 * здесь бот ЗНАЕТ, кому и, если передан propertyId, по какому объекту звонит
 * (см. buildLiveVoiceSystemPrompt/liveVoicePersona.ts) — и по факту сбора
 * контакта (см. save_contact в wireGeminiEvents) заводит настоящий
 * CallbackRequest на карточке клиента, а не только строку в журнале ошибок.
 *
 * Звонит на client.phone — не на переопределённый/запасной номер: живой голос
 * не умеет спрашивать «какой из ваших номеров звонить», это отдельная задача,
 * если понадобится (см. phoneOverride у originateCallToClient — та же
 * потребность, но для звонка ЖИВЫМ АГЕНТОМ).
 */
export async function originateLiveVoiceCallToClient(
  client: { id: string; phone: string; fullName: string },
  propertyDescription?: string | null
): Promise<LiveVoiceClientCallResult> {
  if (!isDialableTajikNumber(client.phone)) {
    return { ok: false, error: "Номер клиента не похож на таджикский — станция не сможет его набрать" };
  }
  const rtpRefusal = rtpConfigRefusal();
  if (rtpRefusal) return rtpRefusal;
  const target = normalizeDialNumber(client.phone);
  if (hasActiveCallToNumber(target)) {
    return { ok: false, error: "На этот номер уже идёт звонок" };
  }
  const [settings, creds] = await Promise.all([loadLiveVoiceSettings(), loadCredsSafe()]);
  if (!creds) return { ok: false, error: "Телефония не настроена" };
  if (!settings?.liveVoiceEnabled) return { ok: false, error: "Живой голос выключен — включите тумблер в Настройках" };
  if (hasActiveCallToNumber(target)) {
    return { ok: false, error: "На этот номер уже идёт звонок" };
  }
  // Тот же замок одной линии, что у сценарного звонка ниже (25.09.2026).
  if (liveVoiceLineBusy()) {
    return { ok: false, busy: true, error: "Линия живого голоса занята другим разговором" };
  }
  // Звук со станции не доходит (NO_STATION_AUDIO_MS) — человек снимет трубку в
  // тишину. Вызывающий переносит звонок, как при занятой линии.
  if (liveVoiceAudioPathDown()) {
    return { ok: false, busy: true, error: "Звук со станции не доходит до CRM — робот на паузе" };
  }
  // Gemini отказывал подряд (выключатель, п.7 аудита 09.10) — человек снял бы трубку в тишину.
  if (liveVoiceGeminiPaused()) {
    return { ok: false, busy: true, error: "Gemini не подключается — робот на паузе" };
  }
  // Промпт собирается ДО резерва номера: исключение между резервом и таймером
  // оставило бы номер «занятым» до рестарта (аудит С7).
  const systemInstruction = buildLiveVoiceSystemPrompt(
    { clientName: client.fullName, propertyDescription: propertyDescription ?? null },
    promptSettingsFrom(settings)
  );
  activeCallsByNumber.set(target, "pending");

  const result = await originateGuarded(target, creds, `Local/${target}@${DIALPLAN_CONTEXT}/n`, LIVE_VOICE_ARI_APP, {
    callerId: "Royal Home",
  });
  if (!result.ok || !result.channelId) {
    activeCallsByNumber.delete(target);
    return { ok: false, error: result.error ?? "Asterisk не вернул id канала" };
  }
  activeCallsByNumber.set(target, result.channelId);

  pendingOutboundCalls.set(result.channelId, {
    isManualTestCall: false,
    clientId: client.id,
    phoneNumber: target,
    systemInstruction,
    voiceName: resolveLiveVoiceVoiceName(settings),
  });
  setTimeout(() => {
    pendingOutboundCalls.delete(result.channelId!);
    if (!sessions.has(result.channelId!) && !startingChannels.has(result.channelId!)) activeCallsByNumber.delete(target);
    runDeferredListenerRestart();
  }, MANUAL_TEST_CHANNEL_TTL_MS).unref?.();
  return { ok: true, channelId: result.channelId };
}

/**
 * СЦЕНАРНЫЙ ИСХОДЯЩИЙ ЗВОНОК (16.09.2026) — общий путь для разговоров, которые
 * ведёт не продающая персона: опрос покупателя после показа и проверка
 * собственника показанного объекта (порог 5 воронки,
 * docs/buyer-antifraud-funnel-13-09-2026.md).
 *
 * Отличие от originateLiveVoiceCallToClient выше —
 * мост НЕ знает, что это за разговор: промт, инструменты, первая реплика и
 * обработчик итога целиком приезжают от вызывающего. Так прикладной модуль
 * добавляет новый сценарий, не трогая телефонию, а телефония не обрастает
 * знанием о клиентах, показах и собственниках.
 */
export async function originateLiveVoiceScenarioCall(
  phoneNumber: string,
  task: {
    systemInstruction: string;
    greetingTrigger?: string;
    tools?: LiveVoiceFunctionDeclaration[];
    clientId?: string;
    onFinished?: (result: LiveVoiceScenarioResult) => Promise<void>;
    /** Голос на весь звонок. Пусто — как у остальных сценариев
     *  (resolveLiveVoiceVoiceName). Сценарий, знающий язык собеседника, выбирает
     *  голос сам (приглашение кандидата, 25.09.2026). */
    voiceName?: string;
    /** Замок на русский для этого звонка; пусто — из Настроек. */
    forceRussianOnly?: boolean;
    /** Язык собеседника, если сценарий его знает (см. PendingLiveVoiceCall.language). */
    language?: LiveVoiceLanguage;
  },
  options?: { callerId?: string }
): Promise<LiveVoiceClientCallResult> {
  if (!isDialableTajikNumber(phoneNumber)) {
    return { ok: false, error: "Номер не похож на таджикский — станция не сможет его набрать" };
  }
  const rtpRefusal = rtpConfigRefusal();
  if (rtpRefusal) return rtpRefusal;
  const target = normalizeDialNumber(phoneNumber);
  if (hasActiveCallToNumber(target)) {
    return { ok: false, error: "На этот номер уже идёт звонок" };
  }
  const [settings, creds] = await Promise.all([loadLiveVoiceSettings(), loadCredsSafe()]);
  if (!creds) return { ok: false, error: "Телефония не настроена" };
  if (!settings?.liveVoiceEnabled) return { ok: false, error: "Живой голос выключен — включите тумблер в Настройках" };
  if (hasActiveCallToNumber(target)) {
    return { ok: false, error: "На этот номер уже идёт звонок" };
  }
  // ОДИН ПОРТ RTP — ОДНА СЕССИЯ (25.09.2026). Входящий консультант занятую
  // линию уже не брал (liveVoiceLineBusy), а сценарный исходящий набирал номер
  // всё равно: человек снимал трубку, а второй сессии не на чем было подняться,
  // и звонок обрывался на «алло». Теперь не набираем вовсе — вызывающий
  // переносит звонок на несколько минут, попытку не тратит.
  if (liveVoiceLineBusy()) {
    return { ok: false, busy: true, error: "Линия живого голоса занята другим разговором" };
  }
  // Звук со станции не доходит (NO_STATION_AUDIO_MS) — человек снимет трубку в
  // тишину. Вызывающий переносит звонок, как при занятой линии.
  if (liveVoiceAudioPathDown()) {
    return { ok: false, busy: true, error: "Звук со станции не доходит до CRM — робот на паузе" };
  }
  // Gemini отказывал подряд (выключатель, п.7 аудита 09.10) — человек снял бы трубку в тишину.
  if (liveVoiceGeminiPaused()) {
    return { ok: false, busy: true, error: "Gemini не подключается — робот на паузе" };
  }
  activeCallsByNumber.set(target, "pending");

  const result = await originateGuarded(target, creds, `Local/${target}@${DIALPLAN_CONTEXT}/n`, LIVE_VOICE_ARI_APP, {
    callerId: options?.callerId ?? "Royal Home",
  });
  if (!result.ok || !result.channelId) {
    activeCallsByNumber.delete(target);
    return { ok: false, error: result.error ?? "Asterisk не вернул id канала" };
  }
  activeCallsByNumber.set(target, result.channelId);

  pendingOutboundCalls.set(result.channelId, {
    isManualTestCall: false,
    clientId: task.clientId,
    phoneNumber: target,
    systemInstruction: task.systemInstruction,
    voiceName: task.voiceName ?? resolveLiveVoiceVoiceName(settings),
    forceRussianOnly: task.forceRussianOnly,
    language: task.language,
    callKind: "scenario",
    tools: task.tools,
    greetingTrigger: task.greetingTrigger,
    onFinished: task.onFinished,
  });
  setTimeout(() => {
    const channelId = result.channelId!;
    // Задание ещё лежит — значит, трубку так и не сняли: в Stasis канал входит
    // только по ответу, и startLiveVoiceSession забирает задание сразу. Сказать
    // об этом сценарию НЕМЕДЛЕННО (02.10.2026, «Анкеты кандидатов»): без этого
    // HR узнавал о недозвоне только от 20-минутной уборки зависших CALLING.
    const unanswered = pendingOutboundCalls.get(channelId);
    pendingOutboundCalls.delete(channelId);
    if (!sessions.has(channelId) && !startingChannels.has(channelId)) activeCallsByNumber.delete(target);
    if (unanswered?.onFinished && !sessions.has(channelId)) {
      const now = new Date();
      unanswered
        .onFinished({ channelId, transcript: [], reason: "no_answer", clientSpoke: false, startedAt: now, endedAt: now })
        .catch((err) =>
          void logSystemError(
            "telephony",
            `Живой голос: обработчик недозвона упал: ${err instanceof Error ? err.message : err}`
          )
        );
    }
    runDeferredListenerRestart();
  }, MANUAL_TEST_CHANNEL_TTL_MS).unref?.();
  return { ok: true, channelId: result.channelId };
}

type StartOptions = {
  isManualTestCall?: boolean;
  clientId?: string;
  systemInstruction?: string;
  voiceName?: string;
  soundDesign?: LiveVoiceSoundDesign;
  callKind?: "sales" | "scenario";
  tools?: LiveVoiceFunctionDeclaration[];
  greetingTrigger?: string;
  onFinished?: (result: LiveVoiceScenarioResult) => Promise<void>;
  /** Задание от прикладной части (см. LiveVoiceCallTask) — промис, запущенный
   *  вызывающим ДО подъёма моста: чтение базы идёт параллельно с Asterisk, а не
   *  после него, и приветствие не задерживается. null — работать как без него. */
  task?: Promise<LiveVoiceCallTask | null>;
  direction?: LiveVoiceDirection;
  callerNumber?: string | null;
  /** См. LiveVoiceSession.forceRussianOnly — снимается один раз здесь, тем
   *  же способом, что и soundDesign. */
  forceRussianOnly?: boolean;
  /** Язык звонка, если его знает вызывающий (см. resolveLiveVoiceLanguage). */
  language?: LiveVoiceLanguage;
  /** Нормализованный номер для исходящих звонков (см. PendingLiveVoiceCall,
   *  защита от двойного дозвона 13.09.2026) — переносится на саму сессию
   *  (LiveVoiceSession.phoneNumber), чтобы endLiveVoiceSession и путь ошибки
   *  ниже знали, какой резерв в activeCallsByNumber снять. */
  phoneNumber?: string;
  /** См. LiveVoiceSession.handBackOnFailure. */
  handBackOnFailure?: boolean;
};

/**
 * Состояние ОДНОГО подъёма сессии — общее для самого подъёма и его сторожа
 * (02.10.2026, аудит В1/В17). Сторож по таймеру отпускает человека и сообщает
 * сценарию «не поднялась», даже если подъём завис на запросе в базу; когда
 * зависший запрос потом оживёт, подъём видит `failed` и сворачивается сам.
 */
interface StartContext {
  channelId: string;
  options: StartOptions;
  creds: AriCredentials | null;
  rtpSocket: dgram.Socket | null;
  bridgeId: string | null;
  externalMediaChannelId: string | null;
  session: LiveVoiceSession | null;
  /** failStart уже отработал: человек отпущен, итог сценарию отдан — один раз. */
  failed: boolean;
  deadline: ReturnType<typeof setTimeout> | null;
  /** Будит startLiveVoiceSession, когда сторож отработал, а сам подъём всё ещё висит. */
  release: (() => void) | null;
  /** Клиент голоса, если подключение уже начато (оно идёт параллельно со станцией). */
  gemini: LiveVoiceProviderClient | null;
  /** Станционная часть подъёма готова (мост, канал звука, адрес станции). */
  stationReady: boolean;
  /** Поставщик голоса подключился (setupComplete). */
  modelReady: boolean;
  /** Начало подъёма (StasisStart) и готовность модели — для замеров (liveVoiceMetrics.ts). */
  startedAtMs: number;
  modelReadyAt: number | null;
  /** Отказал именно поставщик голоса (а не станция) — счёт выключателя Gemini. */
  modelFailed: boolean;
  /** Что уже убрано на станции — уборка идемпотентна (её зовут и поздние ветки подъёма). */
  removedIds: Set<string>;
}

/** Подъём уже признан проваленным — вызывается в точках после await. */
class StartAbandonedError extends Error {}

function closeSocketQuietly(socket: dgram.Socket | null): void {
  if (!socket) return;
  try {
    socket.close();
  } catch {
    // уже закрыт — идемпотентно
  }
}

function clearStartDeadline(ctx: StartContext): void {
  if (ctx.deadline) clearTimeout(ctx.deadline);
  ctx.deadline = null;
}

function armStartDeadline(ctx: StartContext, ms: number, what: string): void {
  clearStartDeadline(ctx);
  ctx.deadline = setTimeout(() => {
    ctx.deadline = null;
    // Станция готова, а голос всё подключается — виноват поставщик голоса (выключатель).
    if (ctx.stationReady && !ctx.modelReady && ctx.gemini) ctx.modelFailed = true;
    void failStart(ctx, `start_failed: ${what} не уложилось в ${Math.round(ms / 1000)} с`).catch(() => {});
  }, ms);
  ctx.deadline.unref?.();
}

/** Что успело создаться на станции и в сокетах за подъём — убрать (идемпотентно).
 *  Собранная сессия свои объекты убирает сама (endLiveVoiceSession). */
async function releaseStartResources(ctx: StartContext): Promise<void> {
  if (ctx.session) return;
  closeSocketQuietly(ctx.rtpSocket);
  // Подключение к голосу шло параллельно со станцией — платное соединение закрыть.
  try {
    ctx.gemini?.close();
  } catch {
    // уже закрыт
  }
  const creds = ctx.creds ?? lastKnownAriCreds;
  if (!creds) return;
  for (const [kind, id] of [
    ["bridge", ctx.bridgeId],
    ["channel", ctx.externalMediaChannelId],
  ] as const) {
    if (!id || ctx.removedIds.has(id)) continue;
    ctx.removedIds.add(id);
    await removeStationObject(creds, kind, id);
  }
}

/** Поздняя ветка параллельного подъёма (станция или голос) могла создать что-то уже
 *  ПОСЛЕ отказа подъёма: дождаться её и убрать. Линию это не держит — вызывается без await. */
function cleanupLateStartParts(ctx: StartContext, parts: Promise<unknown>[]): void {
  void Promise.allSettled(parts)
    .then(() => releaseStartResources(ctx))
    .catch(() => {})
    .finally(() => {
      // Зависший createBridge/createExternalMedia мог ожить уже после finally
      // startLiveVoiceSession и добавить свои id в startingStationIds: станция их
      // убрала, а множество — нет, и уборщик считал бы такой мост «своим» (аудит
      // 02.10.2026, п.12).
      if (ctx.session) return;
      if (ctx.bridgeId) startingStationIds.delete(ctx.bridgeId);
      if (ctx.externalMediaChannelId) startingStationIds.delete(ctx.externalMediaChannelId);
    });
}

/** Сценарию (приглашение, опрос, консультант) — «звонок не состоялся по нашей вине». */
async function notifyStartFailed(ctx: StartContext, reason: string): Promise<void> {
  let finish = ctx.options.onFinished;
  if (!finish && ctx.options.task) {
    const task = await withTimeout(ctx.options.task.catch(() => null), 1_000);
    if (task && task !== TIMED_OUT) finish = task.onFinished;
  }
  if (!finish) return;
  const now = new Date();
  await finish({ channelId: ctx.channelId, transcript: [], reason, clientSpoke: false, botSpoke: false, startedAt: now, endedAt: now }).catch(
    (err) =>
      void logSystemError(
        "telephony",
        `Живой голос: обработчик итога несостоявшегося звонка упал: ${describeError(err)}`,
        { dedupKey: "live-voice-start-failed-finish" }
      )
  );
}

/**
 * Подъём сессии не удался (исключение, потолок времени). ОДИН РАЗ: человека
 * отпускаем (звонок со станции — обратно в диалплан), станционные объекты
 * убираем, сценарию отдаём итог start_failed. Раньше сценарий об этом не
 * узнавал вовсе и ждал 20 минут (аудит В1).
 */
async function failStart(ctx: StartContext, reason: string): Promise<void> {
  if (ctx.failed) return;
  ctx.failed = true;
  clearStartDeadline(ctx);
  // Человек положил трубку на подъёме — не поломка, в журнал ошибок не идёт.
  if (reason !== "channel_ended") {
    void logSystemError("telephony", `Живой голос: сессия для канала ${ctx.channelId} не поднялась: ${reason}`, {
      dedupKey: "live-voice-start-failed",
    });
    if (ctx.modelFailed) noteGeminiStartFailed(reason);
  }
  try {
    if (ctx.session) {
      // Сессия успела собраться — убираем ТЕМ ЖЕ путём, что обычное завершение
      // (мост, оба канала, endedAt, итог сценарию). Уже закончилась сама — итог отдан.
      if (sessions.get(ctx.channelId) === ctx.session) await endLiveVoiceSession(ctx.channelId, reason, ctx.session);
      return;
    }
    if (ctx.options.phoneNumber) activeCallsByNumber.delete(ctx.options.phoneNumber);
    // ЧЕЛОВЕКА — ПЕРВЫМ (аудит 02.10.2026, п.6), как в endLiveVoiceSession: станция
    // здесь медленная (из-за неё и сработал потолок подъёма), а мост и канал звука
    // убираются по 5 с каждый — человек всё это время висел в мосте без звука.
    // Сокет закрываем сразу: слушать уже нечего.
    closeSocketQuietly(ctx.rtpSocket);
    const creds = ctx.creds ?? (await loadCredsSafe());
    if (creds) await releaseCaller(creds, ctx.channelId, ctx.options.handBackOnFailure, reason);
    await releaseStartResources(ctx);
    await notifyStartFailed(ctx, reason);
  } finally {
    ctx.release?.();
  }
}

/** Подъёмы, которые идут сейчас (канал → подъём): отбой звонящего во время подъёма
 *  сворачивает его сразу, а не после подключения к Gemini (до 25 с занятой линии). */
const startContexts = new Map<string, StartContext>();

/** Начать сессию: развести звонящего и externalMedia-канал по мосту, поднять
 *  локальный RTP-приёмник, открыть сессию Gemini Live, связать их между собой. */
async function startLiveVoiceSession(event: AriEvent, options: StartOptions = {}): Promise<void> {
  const channelId = event.channel?.id;
  if (!channelId) return;
  sessionsStarting += 1;
  startingChannels.add(channelId);
  const ctx: StartContext = {
    channelId,
    options,
    creds: null,
    rtpSocket: null,
    bridgeId: null,
    externalMediaChannelId: null,
    session: null,
    failed: false,
    deadline: null,
    release: null,
    gemini: null,
    stationReady: false,
    modelReady: false,
    startedAtMs: Date.now(),
    modelReadyAt: null,
    modelFailed: false,
    removedIds: new Set(),
  };
  startContexts.set(channelId, ctx);
  try {
    armStartDeadline(ctx, LIVE_VOICE_START_TIMEOUT_MS, "подъём сессии");
    await Promise.race([
      startLiveVoiceSessionInner(event, ctx),
      new Promise<void>((resolve) => {
        ctx.release = resolve;
      }),
    ]);
  } finally {
    clearStartDeadline(ctx);
    sessionsStarting -= 1;
    startingChannels.delete(channelId);
    if (startContexts.get(channelId) === ctx) startContexts.delete(channelId);
    endedWhileStarting.delete(channelId);
    if (ctx.bridgeId) startingStationIds.delete(ctx.bridgeId);
    if (ctx.externalMediaChannelId) startingStationIds.delete(ctx.externalMediaChannelId);
    runDeferredListenerRestart();
  }
}

/**
 * ВЕРНУТЬ ЗВОНОК СТАНЦИИ — С ПОВТОРАМИ, А ПРИ ОТКАЗЕ ПОЛОЖИТЬ ТРУБКУ (09.10.2026, аудит
 * линии робота, п.1–2). Раньше `continueInDialplan(...).catch(() => {})` стоял в
 * четырёх местах: один сетевой сбой — и человек оставался в Stasis без хозяина, слушал
 * гудки, пока его не сбросит сеть. Теперь: до трёх попыток continue; станция ответила
 * «канала нет / он уже не в нашем приложении» (404/409/422) — отдавать некого, трубку
 * НЕ кладём (там может идти чужой разговор); иначе — отбой и одна проблема в журнале
 * с постоянным ключом.
 */
const HANDBACK_RETRY_DELAYS_MS = [300, 1_000] as const;
/** Каналы, которые прямо сейчас отдаются станции или кладутся: сверка сирот их не трогает. */
const releasingCallers = new Set<string>();

export type HandBackOutcome = "handed_back" | "gone" | "hung_up" | "failed";

export async function handBackOrHangup(creds: AriCredentials, channelId: string, why: string): Promise<HandBackOutcome> {
  releasingCallers.add(channelId);
  try {
    let lastError = "отказ";
    for (let attempt = 0; ; attempt++) {
      const back = await continueInDialplan(creds, channelId).catch(
        (err): { ok: boolean; error?: string } => ({ ok: false, error: describeError(err) })
      );
      if (back.ok) return "handed_back";
      lastError = back.error || "отказ";
      if (/HTTP (404|409|422)\b/.test(lastError)) return "gone";
      if (attempt >= HANDBACK_RETRY_DELAYS_MS.length) break;
      await new Promise((resolve) => setTimeout(resolve, HANDBACK_RETRY_DELAYS_MS[attempt]));
    }
    const hung = await removeStationObject(creds, "channel", channelId);
    void logSystemError(
      "telephony",
      `Живой голос: звонок не отдан станции на автоответчик за ${HANDBACK_RETRY_DELAYS_MS.length + 1} попытки (${lastError}) — ` +
        (hung ? "трубка положена, чтобы человек не слушал гудки без конца." : "и положить трубку не вышло — смотрите связь с АТС.") +
        ` Причина возврата: ${why}.`,
      { dedupKey: "live-voice-handback-failed" }
    );
    return hung ? "hung_up" : "failed";
  } finally {
    releasingCallers.delete(channelId);
  }
}

/** Живой человек, которого сессия не смогла обслужить: канал из диалплана станции
 *  уходит назад в диалплан (там автоответчик), остальные — отбой, как раньше. */
async function releaseCaller(
  creds: AriCredentials,
  channelId: string,
  handBack: boolean | undefined,
  why = "сбой сессии"
): Promise<void> {
  if (handBack) {
    await handBackOrHangup(creds, channelId, why);
    return;
  }
  releasingCallers.add(channelId);
  try {
    // Отказ отбоя — в журнал и в очередь уборщика (раньше глотался молча).
    await removeStationObject(creds, "channel", channelId);
  } finally {
    releasingCallers.delete(channelId);
  }
}

/** Станционная часть подъёма: сокет звука, мост, канал звука в мосте, адрес станции. */
interface StationPart {
  rtpSocket: dgram.Socket;
  bridgeId: string;
  externalMediaChannelId: string;
  stationRtpTarget: { address: string; port: number };
}

async function prepareStationPart(
  ctx: StartContext,
  creds: AriCredentials,
  host: string,
  checkAlive: () => void
): Promise<StationPart> {
  const rtpSocket = dgram.createSocket("udp4");
  ctx.rtpSocket = rtpSocket;
  // Всё, что успело создаться по ходу, лежит в ctx — чтобы failStart мог убрать
  // именно это, даже если исключение прилетело ПОСЛЕ того, как сессия целиком
  // собрана. Раньше мост с RTP-каналом повисали в Asterisk навсегда при обрыве
  // связи с Gemini на старте звонка (найденный баг, 13.09.2026).
  await new Promise<void>((resolve, reject) => {
    rtpSocket.once("error", reject);
    rtpSocket.bind(externalMediaPort(), () => resolve());
  });
  checkAlive();
  const localPort = (rtpSocket.address() as AddressInfo).port;

  const bridge = await createBridge(creds);
  if (bridge.ok && bridge.bridgeId) {
    ctx.bridgeId = bridge.bridgeId;
    startingStationIds.add(bridge.bridgeId);
  }
  checkAlive();
  if (!bridge.ok || !bridge.bridgeId) throw new Error(bridge.error ?? "мост не создан");

  const externalMedia = await createExternalMediaChannel(creds, {
    app: LIVE_VOICE_ARI_APP,
    externalHost: `${host}:${localPort}`,
    format: EXTERNAL_MEDIA_FORMAT,
  });
  if (externalMedia.ok && externalMedia.channelId) {
    ctx.externalMediaChannelId = externalMedia.channelId;
    startingStationIds.add(externalMedia.channelId);
  }
  checkAlive();
  if (!externalMedia.ok || !externalMedia.channelId) throw new Error(externalMedia.error ?? "externalMedia не создан");

  // Канал звука — в мост сразу; звонящий встанет рядом, когда голос будет готов.
  const addMedia = await addChannelToBridge(creds, bridge.bridgeId, externalMedia.channelId);
  checkAlive();
  if (!addMedia.ok) throw new Error(addMedia.error);

  // Куда слать наш ответ — станция сообщает это переменными канала (не тем
  // адресом, который мы сами передали в external_host: за NAT они отличаются).
  const stationAddress = await readChannelVariable(creds, externalMedia.channelId, "UNICASTRTP_LOCAL_ADDRESS").catch(
    () => null
  );
  const stationPort = await readChannelVariable(creds, externalMedia.channelId, "UNICASTRTP_LOCAL_PORT").catch(() => null);
  checkAlive();
  // Порт — число 1..65535, иначе «станция не сообщила»: NaN уходил в socket.send
  // и бросал синхронно из таймера пейсера (аудит 02.10.2026, п.11).
  const stationRtpTarget = parseStationRtpTarget(stationAddress, stationPort);
  if (!stationRtpTarget) {
    // ЗВУК В ОДНУ СТОРОНУ — НЕ РАЗГОВОР (09.10.2026, аудит линии, п.5). Раньше сессия
    // шла дальше: мы слышали человека, он нас — нет, и сторож тишины молчал, потому
    // что человек говорил «алло». Теперь подъём проваливается ДО снятия трубки:
    // звонок со станции уходит на автоответчик без секунды тишины.
    void logSystemError(
      "telephony",
      `Живой голос: станция не сообщила UNICASTRTP_LOCAL_ADDRESS/PORT для канала ${externalMedia.channelId} — ` +
        "звук робота некуда слать (человек не услышал бы бота). Трубку робот не брал, звонок отдан станции.",
      // Ключ постоянный: id канала в начале текста делал каждый такой звонок
      // «новой проблемой» с пушем руководству (см. lib/systemError.ts).
      { dedupKey: "live-voice-no-unicastrtp" }
    );
    throw new Error("станция не сообщила адрес звука (UNICASTRTP_LOCAL_ADDRESS/PORT) — звук робота некуда слать");
  }
  ctx.stationReady = true;
  return { rtpSocket, bridgeId: bridge.bridgeId, externalMediaChannelId: externalMedia.channelId, stationRtpTarget };
}

/** События голоса, которые могут прийти раньше, чем сессия собрана (голос готов, а
 *  станция ещё поднимается): записываются и проигрываются в слушатели моста. */
const EARLY_PROVIDER_EVENTS = [
  "audio",
  "transcript",
  "turnComplete",
  "interrupted",
  "toolCall",
  "toolCallCancellation",
  "usage",
  "reconnecting",
  "resumed",
  "close",
  "error",
] as const;

function recordEarlyProviderEvents(client: LiveVoiceProviderClient): { stop: () => void; replay: () => void } {
  const recorded: { event: string; args: unknown[] }[] = [];
  const handlers = new Map<string, (...args: unknown[]) => void>();
  for (const event of EARLY_PROVIDER_EVENTS) {
    const handler = (...args: unknown[]) => {
      if (recorded.length < 2_000) recorded.push({ event, args });
    };
    handlers.set(event, handler);
    client.on(event, handler);
  }
  const stop = () => {
    for (const [event, handler] of handlers) client.off(event, handler);
    handlers.clear();
  };
  return {
    stop,
    replay: () => {
      stop();
      for (const item of recorded.splice(0)) client.emit(item.event, ...item.args);
    },
  };
}

/** Голосовая часть подъёма: задание, поставщик, подключение до setupComplete. */
interface ModelPart {
  task: LiveVoiceCallTask | null;
  providerConfig: LiveVoiceProviderConfig;
  gemini: LiveVoiceProviderClient;
  greetingText: string;
  replayEarly: () => void;
}

async function prepareModelPart(ctx: StartContext, checkAlive: () => void): Promise<ModelPart> {
  const { options } = ctx;
  // Поставщик слуха и голоса — по Настройкам на момент звонка (02.10.2026):
  // чтение идёт параллельно ожиданию задания, а не после него.
  const providerConfigRead = loadLiveVoiceProviderConfig();

  // Задание консультанта — не дольше TASK_WAIT_MS: зависшее чтение базы оставило бы
  // человека в гудках, а линию занятой (аудит С6) — без задания разговор идёт с общей ролью.
  let task: LiveVoiceCallTask | null = null;
  if (options.task) {
    const awaited = await withTimeout(options.task, TASK_WAIT_MS);
    checkAlive();
    if (awaited === TIMED_OUT) {
      void logSystemError(
        "telephony",
        `Живой голос: задание консультанта не пришло за ${TASK_WAIT_MS / 1000} с — звонок идёт с общей ролью.`,
        { dedupKey: "live-voice-task-timeout" }
      );
    } else {
      task = awaited;
    }
  }

  // По умолчанию Google, ровно как до переключателя; база не ответила за
  // DB_READ_TIMEOUT_MS — тоже Google: звонок важнее сравнения поставщиков.
  const providerRead = await withTimeout(providerConfigRead, DB_READ_TIMEOUT_MS);
  checkAlive();
  let providerConfig: LiveVoiceProviderConfig;
  if (providerRead === TIMED_OUT) {
    void logSystemError("telephony", "Живой голос: выбор поставщика голоса не прочитан вовремя — звонок идёт через Google.", {
      dedupKey: "live-voice-provider-timeout",
    });
    providerConfig = { provider: "google" };
  } else {
    providerConfig = providerRead;
  }
  const gemini = createLiveVoiceProviderClient(providerConfig);
  ctx.gemini = gemini;
  const early = recordEarlyProviderEvents(gemini);

  // РОД О СЕБЕ — ОТ ГОЛОСА, КОТОРЫЙ ЗВУЧИТ (02.10.2026, ai/liveVoiceSelfGender.ts):
  // имя голоса здесь окончательное, поэтому правило вешается тут, один раз на все роли.
  const voiceName = task?.voiceName || options.voiceName || LIVE_VOICE_VOICE_NAME;
  // У ElevenLabs пол — из Настроек (selfGenderForCall), у Gemini — по имени голоса.
  const selfGender = selfGenderForCall(providerConfig, voiceName);
  const greetingText = withSelfGenderReminderFor(
    task?.greetingTrigger ?? options.greetingTrigger ?? pickLiveVoiceGreetingTrigger(),
    selfGender
  );
  const forceRussianOnly = options.forceRussianOnly ?? true;
  const language = resolveLiveVoiceLanguage(forceRussianOnly, task?.language ?? options.language);
  try {
    await gemini.connect({
      systemInstruction: withSelfGenderRuleFor(
        task?.systemInstruction ?? options.systemInstruction ?? LIVE_VOICE_SYSTEM_PROMPT,
        selfGender
      ),
      voiceName,
      // Сценарный звонок несёт свои инструменты в задании (см. PendingLiveVoiceCall).
      tools: task?.tools ?? options.tools ?? LIVE_VOICE_TOOLS,
      activityDetection: LIVE_VOICE_ACTIVITY_DETECTION,
      turnCoverage: "TURN_INCLUDES_ONLY_ACTIVITY",
      // null — «начать новую сессию, но присылать токены продолжения»: без поля
      // sessionResumption Google их не шлёт, и после GoAway продолжать нечем.
      resumeHandle: null,
      compressionTriggerTokens: LIVE_VOICE_COMPRESSION_TRIGGER_TOKENS,
      // Язык читает только ElevenLabs; в setup Gemini это поле не уходит.
      language,
      // Код языка речи Gemini — только по явному включению (LIVE_VOICE_SPEECH_LANGUAGE_CODE=1):
      // модели с родным звуком его не поддерживают, см. liveVoiceSpeechLanguageCode.
      speechLanguageCode: liveVoiceSpeechLanguageCode(language),
      // Подсказка распознаванию речи клиента (11.10.2026, ai/liveVoiceTranscriptionHints.ts):
      // «Только русский» и досье «ru» — ["ru-RU"], иначе таджикский и русский.
      inputTranscription: liveVoiceInputTranscriptionConfig(
        liveVoiceTranscriptionHintLanguage(forceRussianOnly, task?.language ?? options.language)
      ),
    });
  } catch (err) {
    early.stop();
    // Отказ самого поставщика, а не «подъём уже свернули» (тогда сокет закрыли мы).
    if (!ctx.failed) ctx.modelFailed = true;
    throw err;
  }
  checkAlive();
  ctx.modelReady = true;
  ctx.modelReadyAt = Date.now();
  return { task, providerConfig, gemini, greetingText, replayEarly: early.replay };
}

/** Подъём частоты голоса клиента с памятью между кадрами — когда поставщик слушает
 *  16 кГц (Gemini всегда, ElevenLabs — если сам так назвал). Иначе null: resamplePcm16. */
function lineToModelUpsampler(provider: LiveVoiceProviderName, client: LiveVoiceProviderClient): StreamingInterpolator | null {
  const rate = provider === "google" ? GEMINI_INPUT_SAMPLE_RATE : client.inputSampleRateHz;
  return rate === CHANNEL_SAMPLE_RATE * 2 ? createLineToModelInterpolator() : null;
}

/** Служебная реплика-приветствие модели; ждём, что она заговорит (сторож «модель молчит»). */
function sendGreeting(session: LiveVoiceSession): void {
  if (!session.greetingText) return;
  session.gemini.sendText(session.greetingText);
  session.awaitingModelSince = Date.now();
}

/** Строка журнала сессии — с потолком DB_WRITE_TIMEOUT_MS, никогда не отклоняется. */
function createSessionRow(session: LiveVoiceSession, clientId: string | null): Promise<unknown> {
  const write = prisma.liveVoiceSession
    .create({
      data: {
        id: session.dbId,
        channelId: session.channelId,
        clientId,
        promptVersion: LIVE_VOICE_PROMPT_VERSION,
        provider: session.provider,
        direction: session.direction,
        callerNumber: session.callerNumber,
        contactProfileId: session.contactProfileId,
      },
    })
    .catch((err) => void logSystemError("telephony", `Живой голос: журнал сессии не заведён: ${describeError(err)}`));
  return withTimeout(write, DB_WRITE_TIMEOUT_MS)
    .then((created) => {
      if (created === TIMED_OUT) {
        void logSystemError("telephony", "Живой голос: журнал сессии не записался вовремя — звонок идёт без строки журнала.", {
          dedupKey: "live-voice-session-row-timeout",
        });
      }
    })
    .catch(() => {});
}

/**
 * ПОДЪЁМ СЕССИИ (09.10.2026, аудит линии робота, п.2: «не отвечать до готовности
 * Gemini»). Раньше робот снимал трубку и только потом подключался к Gemini — до 25 с
 * тишины в трубке; бросивший трубку в эту тишину человек считался «отвеченным ИИ», и у
 * незнакомого номера не оставалось ни карточки, ни задачи. Теперь:
 *  1. станция (сокет, мост, канал звука, адрес звука) и голос (задание, поставщик,
 *     подключение до setupComplete) поднимаются ПАРАЛЛЕЛЬНО, человек слышит обычные
 *     гудки (канал в Stasis не отвечен);
 *  2. трубка снимается и звонящий встаёт в мост только когда готово и то и другое;
 *  3. отказ любой части — failStart: звонок со станции уходит на автоответчик, не
 *     услышав ни секунды тишины.
 */
async function startLiveVoiceSessionInner(event: AriEvent, ctx: StartContext): Promise<void> {
  const { channelId, options } = ctx;
  /** Подъём признан проваленным сторожем — дальше не идём (после каждого await). */
  const checkAlive = () => {
    if (ctx.failed) throw new StartAbandonedError("подъём прерван сторожем");
  };
  const parts: Promise<unknown>[] = [];
  try {
    const creds = await loadCredsSafe();
    ctx.creds = creds;
    checkAlive();
    if (!creds) {
      // Телефония не настроена — отпустить нечем, но сценарий узнать обязан.
      await failStart(ctx, "start_failed: телефония не настроена (нет кредов ARI)");
      return;
    }

    // Адрес И порт звука — одной проверкой, той же, что у исходящих и Настроек
    // (liveVoiceRtpProblem). Раньше здесь проверялся только хост: при пустом порте
    // входящий консультант брал трубку, биндился на случайный непроброшенный порт и
    // человек слушал тишину (аудит 02.10.2026, п.2). failStart отдаёт звонок со
    // станции назад в диалплан (автоответчик), паузу «нет звука» не заводит.
    const rtpProblem = liveVoiceRtpProblem();
    const host = externalMediaHost();
    if (rtpProblem || !host) {
      void logSystemError(
        "telephony",
        `Живой голос: канал попал в royalhome-live-voice, но звук некуда принимать — звонок будет сброшен. ${rtpProblem ?? ""}`.trim(),
        { dedupKey: "live-voice-rtp-not-configured" }
      );
      await failStart(ctx, "start_failed: адрес звука (LIVE_VOICE_RTP_HOST/PORT) не задан");
      return;
    }

    // 1. ПАРАЛЛЕЛЬНО: станция и голос. Потолок — как у подключения к Gemini: человек
    // всё это время слышит гудки, а не тишину.
    armStartDeadline(ctx, LIVE_VOICE_CONNECT_TIMEOUT_MS, "подготовка станции и подключение к Gemini");
    const stationPart = prepareStationPart(ctx, creds, host, checkAlive);
    const modelPart = prepareModelPart(ctx, checkAlive);
    parts.push(stationPart, modelPart);
    // Отказ второй ветки после отказа первой разбирает cleanupLateStartParts — без этого
    // он стал бы unhandledRejection.
    for (const part of parts) part.catch(() => {});
    const [station, model] = await Promise.all([stationPart, modelPart]);
    checkAlive();
    noteGeminiStartOk();

    const { task, providerConfig, gemini } = model;
    const clientId = task?.clientId ?? options.clientId ?? null;
    const session: LiveVoiceSession = {
      channelId,
      bridgeId: station.bridgeId,
      externalMediaChannelId: station.externalMediaChannelId,
      rtpSocket: station.rtpSocket,
      gemini,
      provider: providerConfig.provider,
      stationRtpTarget: station.stationRtpTarget,
      outSeq: 0,
      outTimestamp: 0,
      outQueue: [],
      outTimer: null,
      outDecimator: createGeminiToLineDecimator(),
      outFramer: new PcmFramer(samplesPerFrame(CHANNEL_SAMPLE_RATE)),
      queueOverflowLogged: false,
      queueOverflowDropped: 0,
      maxDurationTimer: null,
      transcript: [],
      pendingEndCallReason: null,
      officeAmbience: pickOfficeAmbienceTrack(),
      isSpeaking: false,
      vadState: { speaking: false, silenceStreak: 0 },
      echoGate: new LiveVoiceEchoGate(),
      turnFillerPlayed: false,
      lastBotAudioAt: 0,
      endWhenQuietStarted: false,
      clientId,
      callbackRequestSent: false,
      callbackPhoneSent: null,
      callbackRequestsSent: 0,
      forceRussianOnly: options.forceRussianOnly ?? true,
      tajikApologySent: false,
      escalationSent: false,
      replyGuard: new LiveVoiceReplyGuard({
        language: resolveLiveVoiceLanguage(options.forceRussianOnly ?? true, task?.language ?? options.language),
        knowledgeText: task?.systemInstruction ?? options.systemInstruction ?? "",
        tajikAllowed: !(options.forceRussianOnly ?? true),
      }),
      callerLanguage: createCallerLanguageTracker(
        options.forceRussianOnly ?? true,
        resolveLiveVoiceLanguage(options.forceRussianOnly ?? true, task?.language ?? options.language)
      ),
      poorLine: task && (options.direction ?? "outbound") === "inbound" ? new PoorLineTracker() : null,
      transferred: false,
      transferPromise: null,
      transferRecipientId: null,
      handBackOnFailure: !!options.handBackOnFailure,
      soundDesign: options.soundDesign ?? soundDesignFrom(null),
      clientAudioChunks: [],
      botAudioChunks: [],
      callKind: task ? "consultant" : options.callKind ?? "sales",
      scenarioFinish: task?.onFinished ?? options.onFinished ?? null,
      toolHandler: task?.onToolCall ?? null,
      transcriptionObserver: task?.onTranscription ?? null,
      contactProfileId: task?.contactProfileId ?? null,
      callerNumber: options.callerNumber ?? null,
      direction: options.direction ?? "outbound",
      startedAtMs: Date.now(),
      spent: emptyUsage(),
      spentBase: emptyUsage(),
      botSpeechSamples: 0,
      phoneNumber: options.phoneNumber ?? null,
      dbId: randomUUID(),
      lastCallerActivityAt: Date.now(),
      noSpeechPromptedAt: null,
      noSpeechTimer: null,
      noSpeechEnding: false,
      geminiReconnecting: false,
      stationPackets: 0,
      rtpPeer: null,
      rtpCandidate: null,
      rtpForeignDropped: 0,
      toolCallsSeen: new Set(),
      cancelledToolIds: new Set(),
      runningToolCalls: new Map(),
      endCallToolId: null,
      endToken: null,
      greetingText: model.greetingText,
      lastStationPacketAt: 0,
      firstBotAudioAt: 0,
      helloWindowText: "",
      helloWindowDone: false,
      awaitingModelSince: null,
      stallNudgedAt: null,
      lineWatchTimer: null,
      userTurnText: "",
      tajikTurnCounted: false,
      tajikTurns: 0,
      tajikTurnsAfterApology: 0,
      metrics: new LiveVoiceMetricsTracker(ctx.startedAtMs),
      inUpsampler: lineToModelUpsampler(providerConfig.provider, gemini),
      dbRowReady: null,
      spokenTurnsCompleted: 0,
      greetingPlayed: false,
      localBargeInFrames: 0,
    };
    if (ctx.modelReadyAt !== null) session.metrics.markModelReady(ctx.modelReadyAt);
    ctx.session = session;
    sessions.set(channelId, session);
    startingStationIds.delete(station.bridgeId);
    startingStationIds.delete(station.externalMediaChannelId);
    // События голоса — сразу, до снятия трубки: то, что поставщик прислал, пока
    // поднималась станция, проигрывается в слушатели моста (ничего не теряется).
    wireGeminiEvents(session);
    model.replayEarly();
    // Модель умерла сразу после setup, и клиент открыл запасную (аудит В4): новая
    // сессия не слышала приветствия — повторяем его, если бот ещё не говорил.
    gemini.on(
      "fallback",
      guarded("fallback-greeting", () => {
        if (sessions.get(channelId) === session && session.lastBotAudioAt === 0 && !session.isSpeaking && session.greetingText) {
          gemini.sendText(session.greetingText);
        }
      })
    );
    // Звонящий положил трубку, пока поднимался мост (см. endedWhileStarting):
    // закрываем сразу, тем же путём, что обычный отбой.
    if (endedWhileStarting.has(channelId)) {
      endedWhileStarting.delete(channelId);
      clearStartDeadline(ctx);
      await endLiveVoiceSession(channelId, "channel_ended", session);
      return;
    }
    session.maxDurationTimer = setTimeout(() => {
      void logSystemError(
        "telephony",
        `Живой голос: канал ${channelId} закрыт по потолку длительности (${LIVE_VOICE_MAX_SESSION_MS / 60_000} мин).`,
        { dedupKey: "live-voice-max-duration" }
      );
      void endLiveVoiceSession(channelId, "max_duration", session);
    }, LIVE_VOICE_MAX_SESSION_MS);
    session.maxDurationTimer.unref?.();

    // ПРИВЕТСТВИЕ ЗАКАЗЫВАЕТСЯ СРАЗУ, КАК ГОЛОС ГОТОВ (09.10.2026, исследование С2,
    // docs/robot-upgrade-speed-understanding-2026-10-09.md). Раньше служебная реплика
    // уходила только после снятия трубки и моста, и человек 1,5–2 с молчал в трубку
    // (замер 2,1 с), пока модель генерировала первое слово. Теперь генерация идёт, пока
    // снимается трубка: звук ложится в очередь пейсера (потолок MAX_QUEUED_FRAMES — 10 с) и
    // начинает звучать с первым его тиком, уже в снятую трубку, — в неотвеченный канал
    // не уходит ни кадра (пейсер стартует после моста). ПЕРВЫМ ГОВОРИТ БОТ (12.09.2026):
    // Live API по умолчанию ждёт реплику собеседника, обход Google — текстовая реплика
    // после setupComplete (LiveVoiceClient.sendText).
    sendGreeting(session);

    // Строка журнала — НЕ на пути к снятию трубки (исследование С3): раньше create ждался
    // до DB_WRITE_TIMEOUT_MS перед answerChannel, и медленная база держала человека в
    // гудках. Теперь запись идёт параллельно; итог сессии (endLiveVoiceSession) ждёт её,
    // иначе обновлять было бы нечего. Сессия без строки журнала всё равно говорит.
    session.dbRowReady = createSessionRow(session, clientId);

    // 2. ГОЛОС ГОТОВ — СНЯТЬ ТРУБКУ И ПОСТАВИТЬ ЧЕЛОВЕКА В МОСТ.
    armStartDeadline(ctx, LIVE_VOICE_START_TIMEOUT_MS, "снятие трубки и мост");
    await answerChannel(creds, channelId);
    checkAlive();
    if (sessions.get(channelId) !== session) return;
    session.metrics.markAnswered(Date.now());

    // ПРОВЕРОЧНЫЙ СИГНАЛ ДЛЯ ИСХОДЯЩЕГО ТЕСТОВОГО ЗВОНКА (12.09.2026). Короткий
    // системный «beep» ДО моста с ExternalMedia — независимая проверка связки ;1↔;2:
    // если звук слышен, искать в мосте/Gemini, а не в Originate.
    if (options.isManualTestCall) {
      await playChannelSound(creds, channelId, "beep").catch(() => {});
      checkAlive();
    }

    const addCaller = await addChannelToBridge(creds, station.bridgeId, channelId);
    checkAlive();
    if (!addCaller.ok) throw new Error(addCaller.error);
    clearStartDeadline(ctx);
    if (sessions.get(channelId) !== session) return;

    // Прослушка руководством (liveVoiceMonitor): разговор попадает в реестр, а на
    // входящий — уведомление директору. Синхронно и без await; обе вещи сами не
    // бросают — звонок от них не зависит.
    liveVoiceMonitor.sessionStarted({
      key: session.dbId,
      channelId,
      callerNumber: session.callerNumber,
      direction: session.direction,
      startedAt: session.startedAtMs,
      backlog: () => liveVoiceMonitor.backlogFromTranscript(session.transcript),
    });
    if (session.direction === "inbound") {
      void notifyRobotTookInboundCall({ key: session.dbId, callerNumber: session.callerNumber });
    }

    startRtpPacer(session);
    // Курс для сверки названных робота цен (пересчёт доллар↔сомони законен); не пришёл —
    // сверка идёт без пересчёта, звонок не ждёт.
    void loadMoneyContext()
      .then((m) => {
        session.replyGuard.usdToTjs = m.usdToTjs;
      })
      .catch(() => {});
    wireRtpSocket(session);
    startStationAudioWatchdog(session);
    startLineWatchdog(session);
    // Сторож «модель молчит» считает от снятия трубки, если модель ещё не поздоровалась:
    // время подъёма моста — не её вина.
    if (session.awaitingModelSince !== null) session.awaitingModelSince = Date.now();
    // Сторож тишины — с момента, когда модель уже слушает и человек в мосте.
    startNoSpeechWatchdog(session);
  } catch (err) {
    // Отказ ElevenLabs (ключ, агент, сеть) идёт ЭТИМ ЖЕ путём, что отказ Gemini:
    // failStart ниже отдаёт человека диалплану станции — тишины в трубке нет.
    if (err instanceof StartAbandonedError) {
      // Сторож уже отпустил человека и сообщил сценарию; здесь — только добрать то,
      // что зависшие шаги успели (или ещё успеют) создать уже ПОСЛЕ него.
      cleanupLateStartParts(ctx, parts);
      return;
    }
    // Сессия, закончившаяся сама (человек положил трубку, пока шёл подъём), уже
    // отдала итог — «ошибкой старта» это не считается (аудит, низкая №6).
    if (ctx.session && sessions.get(channelId) !== ctx.session) return;
    // Человек положил трубку, пока поднимался мост (канал уже мёртв, и addChannelToBridge
    // упал): это отказ человека, а не «сбой нашей стороны» (аудит 02.10.2026, п.10).
    // Сценарию уходит channel_ended, как при отбое посреди разговора, — иначе
    // опрос возвращал попытку и звонил тому же человеку ещё раз.
    if (!ctx.session && endedWhileStarting.has(channelId)) {
      await failStart(ctx, "channel_ended");
      cleanupLateStartParts(ctx, parts);
      return;
    }
    await failStart(ctx, `start_failed: ${describeError(err)}`);
    cleanupLateStartParts(ctx, parts);
  }
}

/**
 * ВЫДАЧА ЗВУКА В ТЕМПЕ РЕАЛЬНОГО ВРЕМЕНИ — по кадру каждые 20 мс.
 *
 * ЗАЧЕМ. Модель отдаёт ответ кусками по нескольку секунд сразу. Если вывалить
 * их в сокет одним залпом, станция получит, скажем, сотню кадров за миг: для
 * её джиттер-буфера это пакеты «из будущего», он оставляет первые и
 * выбрасывает остальные. Симптом ровно тот, что наблюдался живым звонком
 * 12.09.2026: расшифровка показывает связный ответ бота, на станцию приходит
 * меньше секунды звука, человек в трубке слышит тишину.
 *
 * Поэтому готовые пакеты кладутся в очередь, а таймер выдаёт их ровно тем же
 * шагом, каким станция шлёт нам свои, — 20 мс на кадр.
 */
/** Настоящий офисный амбиент, если включён и трек загрузился — иначе тишина
 *  (см. nextOfficeAmbienceFrame). Синтетический генератор шума убран целиком
 *  14.09.2026 (см. докстринг LiveVoiceSoundDesign) — выключенный амбиент
 *  теперь значит настоящую цифровую тишину в паузах, это осознанный выбор
 *  владельца, а не забытый откат. */
function nextBackgroundNoiseFrame(session: LiveVoiceSession, frameSize: number): Int16Array {
  if (session.soundDesign.officeAmbienceEnabled && session.officeAmbience.track) {
    return nextOfficeAmbienceFrame(session.officeAmbience, frameSize, session.soundDesign.officeAmbienceVolume);
  }
  return new Int16Array(frameSize);
}

function startRtpPacer(session: LiveVoiceSession): void {
  const frameSize = samplesPerFrame(CHANNEL_SAMPLE_RATE);
  // Темп по часам (см. pacerStep): Date.now, а не performance.now — тесты
  // подменяют Date вместе с таймерами. Скачок часов назад — начинаем отсчёт заново.
  let startedAt = Date.now();
  let slot = 0;
  const sendOne = (target: { address: string; port: number }) => {
    let packet = session.outQueue.shift();
    if (packet) {
      session.lastBotAudioAt = Date.now();
      // Начало окна «алло, не слышно» (п.5 аудита 09.10) — первый кадр речи в линии.
      if (session.firstBotAudioAt === 0) session.firstBotAudioAt = session.lastBotAudioAt;
      session.metrics.onBotFrame(session.lastBotAudioAt);
      // ЗАПИСЬ РАЗГОВОРА ИДЁТ ПО ЧАСАМ ПЕЙСЕРА (02.10.2026, аудит В8): дорожка бота —
      // ровно то, что ушло в линию, кадр за кадром; пауза между репликами — нули.
      // Раньше реплики клались сразу по прибытии от модели (быстрее реального
      // времени) и без пауз, и в запись попадал недоигранный перебитый звук.
      const botPcm = ulawDecode(packet.subarray(RTP_HEADER_BYTES));
      session.botAudioChunks.push(botPcm);
      // Опорный сигнал для подавления эха: громкость того, что ушло в линию.
      session.echoGate.onBotFrame(frameEnergy(botPcm));
      // Прослушка: ровно то, что ушло в линию. Без слушателей — один выход по счётчику.
      liveVoiceMonitor.publishAudio(session.dbId, "bot", botPcm);
    } else {
      session.botAudioChunks.push(new Int16Array(frameSize));
      session.echoGate.onBotFrame(0);
      session.metrics.onBotSilence(Date.now());
      // Приветствие (первый произнесённый ход) доиграло целиком: дальше хвосты реплик
      // можно перебивать (см. LOCAL_BARGE_IN_FRAMES).
      if (!session.greetingPlayed && session.spokenTurnsCompleted > 0) session.greetingPlayed = true;
    }
    if (!packet) {
      // Бот молчит — RTP-пакет всё равно идёт (см. докстринг startRtpPacer),
      // с настоящим офисным амбиентом внутри, если он включён (nextBackgroundNoiseFrame).
      const noise = nextBackgroundNoiseFrame(session, frameSize);
      packet = buildRtpPacket({
        payloadType: ULAW_PAYLOAD_TYPE,
        sequenceNumber: session.outSeq++,
        timestamp: session.outTimestamp,
        ssrc: 0x52484c56,
        payload: ulawEncode(noise),
      });
      session.outTimestamp += frameSize;
    }
    session.rtpSocket.send(packet, target.port, target.address, (err) => {
      if (err) void logSystemError("telephony", `Живой голос: отправка RTP не удалась: ${err.message}`);
    });
  };
  // Тик НЕ выпускает исключение наружу (аудит 02.10.2026, п.11): `socket.send`
  // бросает синхронно (закрытый сокет, неверный порт), а необёрнутый throw в
  // колбэке таймера — uncaughtException, по которому index.ts делает process.exit(1):
  // падал бы весь API со ВСЕМИ звонками. Остальные слушатели моста обёрнуты
  // (guarded), этот интервал был единственным без защиты. Ошибка пишется в журнал
  // (ключ постоянный); если тик падает без перерыва PACER_MAX_FAILED_TICKS раз
  // подряд — сессия закрывается как rtp_socket_error, а не тянет тишину до потолка.
  let failedTicks = 0;
  session.outTimer = setInterval(() => {
    try {
      const now = Date.now();
      if (now < startedAt + slot * FRAME_MS - FRAME_MS * PACER_MAX_DEBT_FRAMES) {
        startedAt = now;
        slot = 0;
      }
      const { send, skip } = pacerStep(now - startedAt, slot, FRAME_MS);
      slot += skip;
      if (send === 0) return;
      slot += send;
      const target = session.stationRtpTarget;
      if (!target) return;
      for (let i = 0; i < send; i++) sendOne(target);
      failedTicks = 0;
    } catch (err) {
      failedTicks += 1;
      void logSystemError("telephony", `Живой голос: тик выдачи звука канала ${session.channelId} упал: ${describeError(err)}`, {
        dedupKey: "live-voice-pacer-tick-failed",
      });
      if (failedTicks >= PACER_MAX_FAILED_TICKS) {
        failedTicks = 0;
        void endLiveVoiceSession(session.channelId, "rtp_socket_error", session);
      }
    }
  }, PACER_TICK_MS);
  session.outTimer.unref?.();
}

/** Кладёт кадр в очередь пейсера. Очередь полна — кадр выбрасывается, и это
 *  записывается в журнал один раз за звонок (аудит моста В-4: раньше молча). */
function enqueueOutFrame(session: LiveVoiceSession, samples: Int16Array): boolean {
  if (session.outQueue.length >= MAX_QUEUED_FRAMES) {
    session.queueOverflowDropped += 1;
    if (!session.queueOverflowLogged) {
      session.queueOverflowLogged = true;
      void logSystemError(
        "telephony",
        `Живой голос: очередь звука переполнена на канале ${session.channelId} ` +
          `(потолок ${MAX_QUEUED_FRAMES} кадров = ${(MAX_QUEUED_FRAMES * FRAME_MS) / 1000} с) — часть ответа бота выброшена.`,
        { dedupKey: "live-voice-out-queue-overflow" }
      );
    }
    return false;
  }
  session.outQueue.push(
    buildRtpPacket({
      payloadType: ULAW_PAYLOAD_TYPE,
      sequenceNumber: session.outSeq++,
      timestamp: session.outTimestamp,
      ssrc: 0x52484c56, // "RHLV" — Royal Home Live Voice, произвольная, но стабильная метка потока
      payload: ulawEncode(samples),
    })
  );
  session.outTimestamp += samples.length;
  return true;
}

/** Звук ответа поставщика → линия 8 кГц. Gemini (по умолчанию) — потоковый
 *  дециматор сессии, ровно как до второго поставщика, независимо от того, что
 *  клиент сообщает о частоте. Другой поставщик (ElevenLabs) отдаёт звук на своей
 *  частоте: при 8 кГц resamplePcm16 возвращает его как есть, иначе пересчитает
 *  разовым куском. Чистая функция — ради теста. */
export function providerSpeechToLine(
  provider: LiveVoiceProviderName,
  outputRateHz: number,
  decimator: StreamingDecimator,
  pcm: Int16Array
): Int16Array {
  return provider === "google" ? decimator.process(pcm) : resamplePcm16(pcm, outputRateHz, CHANNEL_SAMPLE_RATE);
}

function speechToLine(session: LiveVoiceSession, pcm: Int16Array): Int16Array {
  return providerSpeechToLine(session.provider, session.gemini.outputSampleRateHz, session.outDecimator, pcm);
}

/** Частота звука ответа, с которой поставщик говорит (для учёта речи бота). */
function providerOutputRateHz(session: LiveVoiceSession): number {
  return session.provider === "google" ? GEMINI_OUTPUT_SAMPLE_RATE : session.gemini.outputSampleRateHz;
}

/** Кадр речи бота в очередь — с тихим гулом под ним, если амбиент включён (см.
 *  nextBackgroundNoiseFrame): иначе граница «бот заговорил» слышна резким переходом. */
function enqueueSpeechFrame(session: LiveVoiceSession, frame: Int16Array): boolean {
  const noise = nextBackgroundNoiseFrame(session, frame.length);
  return enqueueOutFrame(session, mixPcm16(frame, noise));
}

/** Конец реплики (turnComplete): хвост фильтра и неполный кадр — в очередь,
 *  нулями добивается только он (см. PcmFramer). */
function flushOutgoingSpeech(session: LiveVoiceSession): void {
  // У второго поставщика (ElevenLabs) частота иная — потокового Gemini-дециматора
  // он не касался, хвоста у фильтра нет.
  const tail = session.provider === "google" ? session.outDecimator.flush() : new Int16Array(0);
  for (const frame of session.outFramer.push(tail)) {
    if (!enqueueSpeechFrame(session, frame)) break;
  }
  const last = session.outFramer.flush();
  if (last) enqueueSpeechFrame(session, last);
}

/** Кладёт короткий вдох в очередь RTP — ровно один раз за реплику бота, откуда
 *  бы ни пришёл сигнал "пора" (см. LiveVoiceSession.turnFillerPlayed): либо
 *  локальный VAD засёк, что клиент замолчал (wireRtpSocket, играет МГНОВЕННО,
 *  до всякого ответа Gemini), либо, если VAD почему-то не сработал, первый
 *  кусок звука от самой модели (запасной путь — так было раньше). */
function queueBreathIfDue(session: LiveVoiceSession): void {
  if (session.turnFillerPlayed || !session.soundDesign.breathEnabled) return;
  session.turnFillerPlayed = true;
  const frameSize = samplesPerFrame(CHANNEL_SAMPLE_RATE);
  const breathSamples = Math.round((BREATH_DURATION_MS / 1000) * CHANNEL_SAMPLE_RATE);
  const breath = generateBreathSound(breathSamples, BREATH_PEAK_AMPLITUDE);
  for (const breathFrame of framePcm16(breath, frameSize)) {
    if (!enqueueOutFrame(session, breathFrame)) break;
  }
}

/**
 * Слушатель событий Gemini, не выпускающий исключение наружу (02.10.2026, аудит В7).
 * Исключение в слушателе выходит из `ws.on("message")` как uncaughtException, а
 * index.ts по нему делает process.exit(1): падал весь API со ВСЕМИ звонками. У
 * RTP-сокета такая защита была с 13.09, у Gemini — нет. Ошибка одного события
 * пишется в журнал (ключ постоянный) и звонок продолжается.
 */
function guarded<A extends unknown[]>(name: string, fn: (...args: A) => void): (...args: A) => void {
  return (...args: A) => {
    try {
      fn(...args);
    } catch (err) {
      void logSystemError("telephony", `Живой голос: обработчик события «${name}» упал: ${describeError(err)}`, {
        dedupKey: `live-voice-listener-${name}`,
      });
    }
  };
}

/** Аудио-токенов на секунду звука — по документации Gemini (32 токена/с, одинаково
 *  для входа и выхода). Нужна только оценке ниже. */
export const GEMINI_AUDIO_TOKENS_PER_SECOND = 32;

/**
 * ОЦЕНКА расхода звонка, когда Google не прислал usageMetadata (03.10.2026). Вход —
 * весь звук линии за время разговора (он уходит в модель целиком), выход — то, что
 * бот реально сказал; всё считается как звук. ЗАНИЖЕНА: Live API перечитывает
 * накопленный контекст на каждом ходе, а этого по длительности не посчитать.
 */
export function estimateLiveVoiceUsage(durationMs: number, botSpeechSamples: number): SpentTokens {
  const inputTokens = Math.round((Math.max(0, durationMs) / 1000) * GEMINI_AUDIO_TOKENS_PER_SECOND);
  const outputTokens = Math.round((Math.max(0, botSpeechSamples) / CHANNEL_SAMPLE_RATE) * GEMINI_AUDIO_TOKENS_PER_SECOND);
  return {
    inputTokens,
    outputTokens,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
    audioInputTokens: inputTokens,
    audioOutputTokens: outputTokens,
  };
}

function addTokens(a: SpentTokens, b: SpentTokens): SpentTokens {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    audioInputTokens: (a.audioInputTokens ?? 0) + (b.audioInputTokens ?? 0),
    audioOutputTokens: (a.audioOutputTokens ?? 0) + (b.audioOutputTokens ?? 0),
  };
}

/** Аргументы функции — только объект: null/строка/массив от модели не должны
 *  ронять обработчик (аудит С1). */
function plainArgs(args: unknown): Record<string, unknown> {
  return args && typeof args === "object" && !Array.isArray(args) ? (args as Record<string, unknown>) : {};
}

function cleanText(value: unknown, max: number): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "";
}

function wireGeminiEvents(session: LiveVoiceSession): void {
  const on = <A extends unknown[]>(event: string, fn: (...args: A) => void) =>
    session.gemini.on(event, guarded(event, fn));
  const alive = () => sessions.get(session.channelId) === session;

  // Расход токенов (13.09.2026, «стоимость звонка нигде не видна») — Google по
  // документации шлёт usageMetadata НАКОПИТЕЛЬНЫМ итогом за сессию, поэтому
  // заменяем прошлое значение, а не прибавляем (см. докстринг SpentTokens в
  // LiveVoiceSession выше). Исключение — переподключение (02.10.2026, аудит В3):
  // если счётчик нового соединения начался заново (значение стало МЕНЬШЕ
  // прежнего), прежний итог копится в spentBase. Само событие может не прийти
  // вовсе — тогда spent так и останется нулевым, и endLiveVoiceSession честно
  // не запишет AiLog.
  on("usage", (u: { inputTokens: number; outputTokens: number; cacheReadTokens: number; audioInputTokens?: number; audioOutputTokens?: number }) => {
    const prev = { inputTokens: session.spent.inputTokens - session.spentBase.inputTokens, outputTokens: session.spent.outputTokens - session.spentBase.outputTokens };
    if (u.inputTokens < prev.inputTokens || u.outputTokens < prev.outputTokens) session.spentBase = session.spent;
    session.spent = addTokens(session.spentBase, { ...u, cacheWriteTokens: 0 });
  });
  on("audio", (chunk: Buffer) => {
    noteModelResponded(session);
    session.botSpeechSamples += Math.round(chunk.length / 2 / (providerOutputRateHz(session) / CHANNEL_SAMPLE_RATE));
    if (!session.stationRtpTarget) return;
    if (!session.isSpeaking) {
      session.isSpeaking = true;
      // Обычно вдох уже сыгран локальным VAD (см. queueBreathIfDue) в тот
      // момент, когда клиент замолчал — здесь он не сработает повторно
      // (флаг turnFillerPlayed). Остаётся как запасной путь, если VAD почему-то
      // не поймал переход (например клиент не говорил вслух вовсе — реплику
      // начал сам бот первым, см. LIVE_VOICE_GREETING_TRIGGER).
      queueBreathIfDue(session);
    }
    // Ответ модели — 24 кГц, линия — 8 кГц. Фильтр и остаток кадра живут между
    // кусками (StreamingDecimator/PcmFramer): нулями кадр добивается только в
    // конце реплики, а не на каждом куске посреди слова. Запись разговора берёт
    // дорожку бота у пейсера — то, что реально ушло в линию (см. startRtpPacer).
    const resampled = speechToLine(session, bufferToInt16LE(chunk));
    for (const frame of session.outFramer.push(resampled)) {
      if (!enqueueSpeechFrame(session, frame)) break;
    }
  });

  on("transcription", (observation: LiveVoiceTranscriptionObservation) => {
    const observer = session.transcriptionObserver;
    if (!alive() || !observer) return;
    // Retain the original observer/context; no renewal across the deferred call.
    const context = Object.freeze({ sessionId: session.dbId, channelId: session.channelId,
      direction: session.direction, isCurrent: alive });
    void invokeLiveVoiceTranscriptionObserver(() => observer(observation, context), alive, () =>
      logSystemError("telephony", "Живой голос: обработчик наблюдения транскрипции недоступен.",
        { dedupKey: "live-voice-transcription-observer" }));
  });

  on("transcript", (e: LiveVoiceTranscriptEvent) => {
    session.transcript.push(`${e.role === "user" ? "Клиент" : "Бот"}: ${e.text}`);
    liveVoiceMonitor.publishTranscript(session.dbId, e.role === "user" ? "client" : "bot", e.text);
    if (e.role === "user" && e.text.trim()) {
      markCallerActivity(session);
      // Человек сказал реплику — ждём ответа модели (сторож «модель молчит»).
      if (session.awaitingModelSince === null) session.awaitingModelSince = Date.now();
      collectHelloWindow(session, e.text);
    }
    // Сторожа ответа робота (язык, «объекты только из подборки»): расшифровка ответа
    // приходит кусками, звук к этому моменту уже ушёл — сторож журналирует и поправляет.
    if (e.role === "user") session.replyGuard.addClientText(e.text);
    else handleReplyGuardFindings(session, session.replyGuard.onModelText(e.text));
    // Петля «плохо слышно» и язык звонящего (10.10.2026): см. handlePoorLine/handleCallerLanguage.
    if (e.role === "user") {
      handlePoorLine(session, e.text);
      if (session.callerLanguage) handleCallerLanguage(session, session.callerLanguage.onCallerText(e.text));
    } else {
      session.poorLine?.onModelText(e.text);
    }
    // Замок на русский, но клиент впервые за этот звонок заговорил по-таджикски
    // (13.09.2026) — см. LIVE_VOICE_TAJIK_APOLOGY_TRIGGER выше. detectClientLanguage —
    // тот же определитель, что у текстового бота (ai/clientLanguage.ts), не
    // догадка модели: код решает по факту слов клиента, а не по тому, заметит
    // ли модель момент сама.
    if (e.role === "user") handleTajikOnRussianLock(session, e.text);
  });

  on("interrupted", () => {
    // Человек заговорил поверх бота — он сейчас говорит, ответа ещё не ждёт.
    session.awaitingModelSince = null;
    session.metrics.onModelInterrupted();
    session.replyGuard.onInterrupted();
    session.poorLine?.onInterrupted();
    // Клиент перебил модель — недоигранный ответ выбрасываем немедленно, иначе
    // бот будет договаривать поверх человека. Теперь это не пустой крючок:
    // очередь появилась вместе с выдачей в темпе (startRtpPacer).
    resetBotSpeech(session);
  });

  // Связь с Gemini оборвалась и восстанавливается (02.10.2026, аудит В3): реплика,
  // которую модель говорила, уже не дойдёт до конца, — без сброса `isSpeaking`
  // залипал, `botBusy` сторожа тишины был вечно «да», и звонящий, замолчав, держал
  // линию до потолка в 15 минут. На время обрыва сторож тишины стоит: человека не
  // слышно не по его вине; после — отсчёт заново.
  on("reconnecting", () => {
    session.geminiReconnecting = true;
    resetBotSpeech(session, false);
  });
  on("resumed", () => {
    session.geminiReconnecting = false;
    resetBotSpeech(session, false);
    markCallerActivity(session);
  });
  // Запасная модель после ранней смерти основной (аудит В4) — то же самое; само
  // приветствие повторяет слушатель, заведённый в startLiveVoiceSessionInner.
  on("fallback", () => {
    session.geminiReconnecting = false;
    resetBotSpeech(session, false);
    markCallerActivity(session);
  });

  on("close", (info?: unknown) => {
    const outcome = providerCloseOutcome(info);
    if (outcome.normal) {
      // Агент ElevenLabs сам закончил разговор (02.10.2026) — тот же путь, что
      // end_call: дать доиграть прощание из очереди и положить трубку как обычно.
      // Звука от поставщика больше не будет, «говорит» снимаем сами.
      session.transcript.push(`[разговор завершил поставщик голоса] ${outcome.reason}`);
      session.isSpeaking = false;
      endWhenQuiet(session, `model_ended_call: ${outcome.reason}`);
      return;
    }
    void endLiveVoiceSession(session.channelId, "gemini_closed", session);
  });
  on("error", () => {
    void endLiveVoiceSession(session.channelId, "gemini_error", session);
  });

  // Модель отменила свои вызовы (человек перебил, пока функция выполнялась):
  // побочное действие, которое ещё не началось, не выполняется (аудит С1/п.1).
  on("toolCallCancellation", (ids: string[]) => {
    for (const id of Array.isArray(ids) ? ids : []) {
      session.cancelledToolIds.add(id);
      if (session.endCallToolId === id) cancelPendingEnd(session);
    }
  });

  on("toolCall", (calls: LiveVoiceToolCall[]) => {
    noteModelResponded(session);
    for (const raw of calls) {
      if (!alive()) return;
      // Один id — один ответ: после переподключения сервер может прислать
      // неотвеченный вызов ещё раз, и перевод/поиск выполнились бы дважды.
      if (session.toolCallsSeen.has(raw.id)) {
        // Вызов ещё исполняется (или модель его отменила) — второй раз не запускаем и
        // не отвечаем: ответ придёт сам. А вот если он уже НЕ исполняется, значит
        // ответ был отправлен и не дошёл (протух в очереди переподключения, пропал при
        // ранней смерти модели): молчание держало бы модель в ожидании до потолка
        // звонка (у gemini-3.1 вызов блокирует разговор) — повторяем ответ из кэша
        // клиента, а если его нет — просим повторить (аудит 02.10.2026, п.9).
        if (!session.runningToolCalls.has(raw.id) && !session.cancelledToolIds.has(raw.id)) {
          const call: LiveVoiceToolCall = { ...raw, args: plainArgs(raw.args) };
          if (!session.gemini.resendToolResponse(call)) {
            session.gemini.sendToolResponse(call, { ok: false, error: "ответ потерялся — повтори просьбу" });
          }
        }
        console.log(`[живой голос] повторный вызов функции ${raw.name} (id ${raw.id}) — не исполняется заново`);
        continue;
      }
      session.toolCallsSeen.add(raw.id);
      if (session.toolCallsSeen.size > 200) session.toolCallsSeen.delete(session.toolCallsSeen.values().next().value as string);
      const call: LiveVoiceToolCall = { ...raw, args: plainArgs(raw.args) };
      try {
        if (session.toolHandler) void handleTaskToolCall(session, session.toolHandler, call);
        else handleBuiltinToolCall(session, call);
      } catch (err) {
        void logSystemError("telephony", `Живой голос: функция ${call.name} упала: ${describeError(err)}`, {
          dedupKey: "live-voice-tool-failed",
        });
        if (alive()) session.gemini.sendToolResponse(call, { ok: false, error: "временная ошибка" });
      }
    }
  });

  on("turnComplete", () => {
    noteModelResponded(session);
    // Ход модели закончен — следующая речь человека будет новой репликой.
    session.userTurnText = "";
    session.tajikTurnCounted = false;
    session.replyGuard.onTurnComplete();
    session.poorLine?.onModelTurnComplete();
    if (session.callerLanguage) handleCallerLanguage(session, session.callerLanguage.onModelTurnComplete());
    // Хвост реплики (остаток кадра и фильтра) — в очередь, только если звук был.
    if (session.isSpeaking) {
      flushOutgoingSpeech(session);
      session.spokenTurnsCompleted += 1;
    }
    // Реплика закончена — следующая будет НОВОЙ, снова с вдохом в начале.
    session.isSpeaking = false;
    session.turnFillerPlayed = false;
    if (session.pendingEndCallReason === null) return;
    const reason = session.pendingEndCallReason;
    session.pendingEndCallReason = null;
    // Прощальная фраза после ответа на end_call ещё доигрывает из очереди
    // RTP-пейсера: трубку кладём, когда очередь опустела, плюс запас
    // (аудит моста З-5: таймер от turnComplete обрезал «до свидания»).
    hangupWhenDrained(session, `model_ended_call: ${reason}`, session.endToken);
  });
}

/** Реплика бота оборвана (перебили, связь с Gemini пропала): очередь, фильтр и
 *  остаток кадра сбрасываются, следующая реплика — снова новая, с вдохом.
 *  `dropQueue=false` — очередь уже готовых кадров доигрывается (обрыв связи). */
function resetBotSpeech(session: LiveVoiceSession, dropQueue = true): void {
  if (dropQueue) session.outQueue.length = 0;
  session.outDecimator.reset();
  session.outFramer.reset();
  session.isSpeaking = false;
  session.turnFillerPlayed = false;
}

/** Модель отменила end_call (перебили на прощании): отбой не нужен, разговор идёт. */
function cancelPendingEnd(session: LiveVoiceSession): void {
  if (session.endToken) session.endToken.cancelled = true;
  session.endToken = null;
  session.endCallToolId = null;
  session.pendingEndCallReason = null;
  session.endWhenQuietStarted = false;
  console.log(`[живой голос] end_call отменён моделью — трубку не кладём (канал ${session.channelId})`);
}

/**
 * Функция из задания (LiveVoiceCallTask.onToolCall). Обработчик вернул null —
 * функция общая (save_contact, escalate_to_human, end_call), её ведёт мост. Любой
 * исход кончается ответом модели: вызов без ответа держит модель в ожидании.
 *
 * Не дольше LIVE_VOICE_TOOL_TIMEOUT_MS (02.10.2026, аудит С1): у gemini-3.1 вызов
 * блокирует разговор, и зависший поиск замораживал бы звонок; поздний результат
 * игнорируется — на один id один ответ.
 */
async function handleTaskToolCall(
  session: LiveVoiceSession,
  handler: NonNullable<LiveVoiceCallTask["onToolCall"]>,
  call: LiveVoiceToolCall
): Promise<void> {
  session.runningToolCalls.set(call.id, call.name);
  let timedOut = false;
  const alive = () => sessions.get(session.channelId) === session;
  const timeoutMs = toolTimeoutMs(call.name);
  try {
    let reply: LiveVoiceToolReply | null;
    try {
      const raced = await withTimeout(
        Promise.resolve(
          handler(call, {
            channelId: session.channelId,
            transcript: session.transcript,
            isCancelled: () => timedOut || session.cancelledToolIds.has(call.id),
          })
        ),
        timeoutMs
      );
      if (raced === TIMED_OUT) {
        void logSystemError(
          "telephony",
          `Живой голос: функция ${call.name} не ответила за ${timeoutMs / 1000} с — модели отдан отказ.`,
          { dedupKey: "live-voice-tool-timeout" }
        );
        if (alive() && !session.cancelledToolIds.has(call.id)) {
          session.gemini.sendToolResponse(call, { ok: false, error: "таймаут — не получилось вовремя" }, "INTERRUPT");
        }
        // Модель уже получила отказ, а обработчик продолжает работу: его позднее
        // побочное действие (перевод канала к агенту) считается отменённым (LIVE05).
        // Отдельный признак, а не cancelledToolIds: повтор того же id после таймаута
        // по-прежнему получает кэшированный отказ (см. toolCall выше).
        timedOut = true;
        return;
      }
      reply = raced;
    } catch (err) {
      void logSystemError("telephony", `Живой голос: функция ${call.name} упала: ${describeError(err)}`, {
        dedupKey: "live-voice-tool-failed",
      });
      if (alive() && !session.cancelledToolIds.has(call.id)) {
        session.gemini.sendToolResponse(call, { ok: false, error: "временная ошибка" });
      }
      return;
    }
    if (!alive()) return;
    if (session.cancelledToolIds.has(call.id) && reply) {
      console.log(`[живой голос] ответ на отменённый вызов ${call.name} не отправлен`);
      return;
    }
    if (reply) {
      // Что вернула функция — законный источник адресов и цен, которые робот вправе назвать.
      session.replyGuard.addToolResult(reply.response);
      // Что вернула функция — строкой в расшифровку: при разборе звонка видно, откуда
      // робот взял цену или номер объекта (liveVoiceGuards.ts::toolResultTranscriptLine).
      const toolLine = toolResultTranscriptLine(call.name, reply.response);
      if (toolLine) session.transcript.push(toolLine);
      session.gemini.sendToolResponse(call, reply.response, reply.scheduling);
    } else handleBuiltinToolCall(session, call);
  } finally {
    session.runningToolCalls.delete(call.id);
  }
}

/**
 * Эскалация к человеку и штатное завершение звонка («агент свяжется»): заявка и пуш
 * (escalateLiveVoiceCallToHuman) один раз за звонок, трубку кладёт та же логика, что у
 * end_call (ожидание пустой очереди — endWhenQuiet). Общий путь для функции
 * escalate_to_human и для сторожа языка (handleReplyGuardFindings): второй ветки
 * отбоя не заводим.
 */
function escalateAndEndCall(
  session: LiveVoiceSession,
  reason: string,
  byClientRequest: boolean,
  toolCallId: string | null,
  /** Модели только что велено проститься — трубку не класть до начала её речи (endWhenQuiet). */
  awaitSpeechSince?: number
): void {
  session.transcript.push(`[эскалация к оператору] ${reason}`);
  if (!session.escalationSent) {
    session.escalationSent = true;
    void escalateLiveVoiceCallToHuman(session, reason, byClientRequest);
  }
  session.pendingEndCallReason = `escalate_to_human: ${reason}`;
  session.endCallToolId = toolCallId;
  endWhenQuiet(session, `model_ended_call: escalate_to_human: ${reason}`, awaitSpeechSince);
}

/**
 * Решения по находкам сторожей ответа (liveVoiceGuards.ts). Журнал — один раз за звонок
 * (постоянные dedupKey: с id канала каждый звонок становился бы новой проблемой с пушем
 * руководству, lib/systemError.ts). Сторож не бросает: звонок важнее проверки.
 */
/**
 * ТАДЖИКСКИЙ ПРИ ЗАМКЕ «ТОЛЬКО РУССКИЙ» (09.10.2026, отложенное в мост из
 * docs/journal/2026-10-09-robot-guards-and-callbacks.md, P1-3/P2-9).
 *  - Извинение (LIVE_VOICE_TAJIK_APOLOGY_TRIGGER) — не на первом же слове: одно
 *    «салом» в начале русского разговора извинения не стоит. Нужно две таджикские
 *    реплики или одна от TAJIK_APOLOGY_MIN_WORDS слов.
 *  - После извинения человек продолжает по-таджикски вторую реплику подряд — робот
 *    ему не поможет: эскалация к живому человеку (escalateAndEndCall), как у сторожа языка.
 * Реплика — речь человека между ходами модели (расшифровка приходит кусками).
 */
export const TAJIK_APOLOGY_MIN_WORDS = 4;
export const TAJIK_TURNS_AFTER_APOLOGY_TO_ESCALATE = 2;
const TAJIK_HANDOFF_FAREWELL_TRIGGER =
  "(Собеседник говорит только по-таджикски. Скажи ОДНОЙ короткой фразой ПО-ТАДЖИКСКИ, что коллега перезвонит и " +
  "поговорит с ним по-таджикски, и попрощайся. Функции не вызывай — звонок завершится сам.)";

function handleTajikOnRussianLock(session: LiveVoiceSession, text: string): void {
  if (!session.forceRussianOnly || session.escalationSent || session.noSpeechEnding) return;
  if (session.userTurnText.length < 2_000) session.userTurnText += text;
  const turn = session.userTurnText.trim();
  // Только кириллица (10.10.2026): мусорную латиницу определитель чат-бота считает
  // таджикским («salom, hona darkor»), а расшифровка Live пишет ею и РУССКУЮ речь
  // («am 20 Uhr», «Não, é para o próximo mês» на звонке владельца) — по мусору замок
  // извинялся бы по-таджикски перед русскоговорящим и отдавал звонок человеку.
  if (!turn || classifyCallerUtterance(turn) !== "tg") return;
  if (!session.tajikTurnCounted) {
    session.tajikTurnCounted = true;
    if (session.tajikApologySent) session.tajikTurnsAfterApology += 1;
    else session.tajikTurns += 1;
  }
  if (!session.tajikApologySent) {
    const words = turn.split(/\s+/).filter(Boolean).length;
    if (session.tajikTurns >= 2 || words >= TAJIK_APOLOGY_MIN_WORDS) {
      session.tajikApologySent = true;
      session.gemini.sendText(LIVE_VOICE_TAJIK_APOLOGY_TRIGGER);
    }
    return;
  }
  if (session.tajikTurnsAfterApology >= TAJIK_TURNS_AFTER_APOLOGY_TO_ESCALATE) {
    session.transcript.push("[собеседник говорит только по-таджикски, а у робота замок на русский — нужен человек]");
    // Прощание — на языке человека: по-русски его уже не поняли (P1-2).
    const since = Date.now();
    session.gemini.sendText(TAJIK_HANDOFF_FAREWELL_TRIGGER);
    escalateAndEndCall(
      session,
      "собеседник говорит только по-таджикски, робот на замке «только русский» — перезвоните по-таджикски",
      false,
      null,
      since
    );
  }
}

/** Звонок уже заканчивается (прощание, перевод, эскалация) — служебных реплик о языке не шлём. */
function callWindingDown(session: LiveVoiceSession): boolean {
  return session.noSpeechEnding || session.endWhenQuietStarted || session.escalationSent || session.transferred || !!session.transferPromise;
}

/**
 * ЯЗЫК ЗВОНЯЩЕГО (10.10.2026, liveVoiceCallerLanguage.ts). Переключение — после двух уверенных
 * кириллических реплик подряд на другом языке; мусорная расшифровка (арабица, латиница…) языка
 * не меняет. Язык так и не ясен — один раз спросить на обоих языках, таджикский первым.
 */
function handleCallerLanguage(session: LiveVoiceSession, action: CallerLanguageAction | null): void {
  if (!action || callWindingDown(session)) return;
  try {
    if (action.kind === "switch") {
      session.replyGuard.setLanguage(action.to);
      session.transcript.push(`[язык] звонящий говорит ${action.to === "ru" ? "по-русски" : "по-таджикски"} — робот переходит на этот язык`);
      session.gemini.sendText(callerLanguageSwitchNote(action.to));
    } else {
      session.transcript.push("[язык] язык звонящего не ясен — робот спрашивает, на каком удобнее");
      session.gemini.sendText(callerLanguageAskNote());
    }
  } catch (err) {
    console.warn(`[живой голос] язык звонящего: ${describeError(err)}`);
  }
}

/**
 * РАЗРЫВ ПЕТЛИ «ПЛОХО СЛЫШНО» (10.10.2026, liveVoicePoorLine.ts): после двух переспросов
 * подряд третьего не будет — как только звонящий снова заговорил, модель уходит на перезвон
 * (или соединение с человеком), а в расшифровку ложится строка, по которой итог звонка
 * ставит задачу «перезвонить» (liveVoiceConsultant.ts::rememberPromise).
 */
function handlePoorLine(session: LiveVoiceSession, text: string): void {
  if (!session.poorLine || callWindingDown(session)) return;
  const known = session.callerLanguage?.knownLanguage ?? (session.forceRussianOnly ? "ru" : null);
  const step = session.poorLine.onCallerText(text, known !== null);
  if (!step) return;
  try {
    if (step === "ask") {
      session.callerLanguage?.markAsked();
      session.transcript.push("[плохо понимает] два переспроса подряд — робот спрашивает язык, а не «повторите»");
      session.gemini.sendText(callerLanguageAskAfterRepromptsNote());
      return;
    }
    session.transcript.push(poorLineTranscriptLine(known));
    session.gemini.sendText(
      poorLineBreakNote({ tajikAllowed: !session.forceRussianOnly, numberKnown: /\d{6,}/.test(session.callerNumber ?? "") })
    );
  } catch (err) {
    console.warn(`[живой голос] петля «плохо слышно»: ${describeError(err)}`);
  }
}

/** Сколько поправок «вне подборки» модель получает за звонок (см. handleReplyGuardFindings). */
const OFF_CATALOG_MAX_CORRECTIONS = 2;

function handleReplyGuardFindings(session: LiveVoiceSession, findings: ReplyGuardFinding[]): void {
  for (const f of findings) {
    try {
      if (f.kind === "wrong_language") {
        if (f.logIt) {
          const lang = session.replyGuard.language === "tg" ? "таджикском" : "русском";
          void logSystemError(
            "telephony",
            `Робот ответил не на том языке (разговор на ${lang}, чужих букв ${Math.round(f.share * 100)} %): «${f.sample}». ` +
              `Звонок ${session.channelId}. Вероятно, распознавание речи выдало мусор, и модель ответила на нём.`,
            { dedupKey: "live-voice-wrong-language", dedupScope: session.channelId }
          );
        }
        if (f.endCall && f.callerLanguage) {
          // Звонящий сам говорит по-узбекски/по-английски (09.10.2026, исследование П2):
          // не сбрасывать, а проститься на его языке и передать человеку. Решения владельца
          // «отвечать ли на этих языках самому» ещё нет — это безопасное значение по умолчанию.
          const name = f.callerLanguage === "uz" ? "узбекский" : "английский";
          session.transcript.push(`[сторож языка] собеседник говорит на языке «${name}» — прощание на его языке и передача человеку`);
          if (!session.noSpeechEnding && !session.endWhenQuietStarted) {
            const since = Date.now();
            session.gemini.sendText(foreignLanguageFarewellTrigger(f.callerLanguage));
            escalateAndEndCall(session, `язык: ${name} — клиент говорит не по-русски и не по-таджикски, перезвоните на его языке`, false, null, since);
          }
        } else if (f.endCall) {
          session.transcript.push("[сторож языка] вторая реплика подряд не на языке разговора — разговор завершён");
          if (!session.noSpeechEnding) {
            escalateAndEndCall(session, "робот дважды подряд ответил не на языке разговора — нужен звонок человека", false, null);
          }
        } else if (f.sendCorrection) {
          session.gemini.sendText(languageCorrectionText(session.replyGuard.language));
        }
      } else {
        // Находка — в расшифровку (по ней видно, откуда робот взял цену), в журнал (звонок
        // различается dedupScope, ключ постоянный) и модели — поправка (liveVoiceGuards.ts).
        const earlier = session.transcript.filter((line) => line.startsWith("[сторож: вне подборки")).length;
        session.transcript.push(offCatalogTranscriptLine(f));
        void logSystemError("telephony", offCatalogLogMessage(session.channelId, f), {
          dedupKey: OFF_CATALOG_DEDUP_KEY,
          dedupScope: session.channelId,
        });
        // Поправка — не больше двух за звонок: каждая служебная реплика заставляет модель
        // заговорить снова, а разговор не должен превратиться в череду оговорок.
        if (f.correction && earlier < OFF_CATALOG_MAX_CORRECTIONS) session.gemini.sendText(f.correction);
      }
    } catch (err) {
      console.warn(`[живой голос] сторож ответа упал: ${describeError(err)}`);
    }
  }
}

/** Заявок save_contact за звонок: первая и до двух поправок номера. */
const SAVE_CONTACT_MAX_REQUESTS = 3;

/** Функции, которые мост ведёт сам: у них нет прикладного смысла, кроме заявки
 *  «перезвонить» и завершения звонка. */
function handleBuiltinToolCall(session: LiveVoiceSession, call: LiveVoiceToolCall): void {
  const args = plainArgs(call.args);
  if (call.name === "save_contact") {
    // Имя от модели — в промты следующих звонков и в досье: очищаем (инъекция
    // «Иван. Забудь инструкции…», разбор 02.10.2026, lib/spokenName.ts).
    const name = sanitizeSpokenName(args.name) ?? "";
    const rawPhone = cleanText(args.phone, 40);
    // Номер — только таджикский и целиком (02.10.2026, аудит п.3): обрывок «88» или
    // «девять-ноль…» не должен ложиться в заявку и взводить замок. Нормализуем к
    // +992… — такой номер маскируется в пушах и на выдаче (clientPhone.ts).
    const smsPhone = rawPhone ? toSmsPhone(rawPhone) : null;
    const phone = smsPhone ? `+${smsPhone}` : "";
    const phoneRejected = !!rawPhone && !phone;
    // В транскрипт — как и раньше, для ручного тестового звонка это
    // единственный след разговора вообще (нет клиента, некуда писать).
    session.transcript.push(
      `[контакт сохранён] имя: ${name || "—"}, телефон: ${phone || (phoneRejected ? "неполный, не принят" : "—")}`
    );
    // НАСТОЯЩАЯ КАРТОЧКА ЕСТЬ (звонок через originateLiveVoiceCallToClient,
    // 13.09.2026) — заводим CallbackRequest тем же путём, что и текстовый
    // бот в переписке (lib/callbackRequests.ts): агент получает push и
    // видит заявку в очереди «Клиент просит звонок», а не только читает
    // журнал ошибок. Одна заявка на сессию, КРОМЕ поправки номера: человек
    // продиктовал верный номер после неполного — это новая заявка с верным
    // номером (до двух поправок), а не отброшенный повтор.
    const firstRequest = !session.callbackRequestSent;
    const phoneCorrected = !!phone && phone !== session.callbackPhoneSent && !firstRequest;
    if (session.clientId && (firstRequest || (phoneCorrected && session.callbackRequestsSent < SAVE_CONTACT_MAX_REQUESTS))) {
      session.callbackRequestSent = true;
      session.callbackRequestsSent += 1;
      if (phone) session.callbackPhoneSent = phone;
      void recordCallbackRequest({
        clientId: session.clientId,
        channel: "LIVE_VOICE",
        phone: phone || null,
        topic: firstRequest
          ? `Живой голос: собрал контакт${name ? ` (${name})` : ""}, нужно перезвонить.`
          : `Живой голос: уточнён номер для связи${name ? ` (${name})` : ""}, нужно перезвонить.`,
        // НЕ соединять сейчас (13.09.2026, живой звонок владельца: contact
        // взят серединой разговора с ботом — авто-соединение позвонило бы
        // на тот же номер клиента ВТОРОЙ раз поверх ещё идущего звонка,
        // а это и есть то самое «переключили на агента», которое никто не
        // просил). Заявка остаётся в очереди — агент перезвонит, когда
        // разговор с ботом закончится.
        autoConnect: false,
        // Просьбы о человеке не было: бот сам собрал контакт по ходу
        // разговора. Это обычная работа агентов, трубку дежурного она не
        // поднимает (владелец 22.09.2026, см. ai/operatorHandoff.ts).
        byClientRequest: false,
      });
    }
    if (phoneRejected) {
      session.gemini.sendToolResponse(
        call,
        { ok: false, error: "номер неполный — дослушай до конца и вызови функцию ещё раз с полным номером" },
        "WHEN_IDLE"
      );
      return;
    }
    session.gemini.sendToolResponse(call, { ok: true }, "SILENT");
  } else if (call.name === "escalate_to_human") {
    const reason = cleanText(args.reason, 300) || "не указана";
    // «По просьбе клиента» — только если модель так и сказала: флаг запускает
    // автодозвон дежурного оператора (callbackRequests.ts), и «бот не справился»
    // его поднимать не должен (02.10.2026, аудит п.8).
    const byClientRequest = args.by_client_request === true;
    session.gemini.sendToolResponse(call, { ok: true }, "SILENT");
    escalateAndEndCall(session, reason, byClientRequest, call.id);
  } else if (call.name === "end_call") {
    const reason = cleanText(args.reason, 300) || "не указана";
    session.gemini.sendToolResponse(call, { ok: true }, "SILENT");
    // Сторож тишины уже прощается сам и вернёт звонок станции (no_caller_speech) —
    // end_call модели не должен подменить это обычным отбоем.
    if (session.noSpeechEnding) return;
    session.pendingEndCallReason = reason;
    session.endCallToolId = call.id;
    endWhenQuiet(session, `model_ended_call: ${reason}`);
  } else {
    // Незнакомая функция — не должно происходить (объявлены только две
    // выше), но ответить обязаны: модель у которой end_call ждёт результат
    // не должна виснуть навсегда из-за одной опечатки в имени.
    session.gemini.sendToolResponse(call, { ok: false, error: "неизвестная функция" });
  }
}

/**
 * ПОЛОЖИТЬ ТРУБКУ, КОГДА БОТ ДОГОВОРИЛ (24.09.2026). До новой модели хватало
 * turnComplete: у gemini-3.1 вызов функции блокирует разговор, и прощание
 * заканчивалось ходом с turnComplete уже после ответа на end_call. У моделей с
 * асинхронными функциями (gemini-3.8-live) ход с прощанием может закончиться
 * РАНЬШЕ, чем придёт сам вызов, — и следующего turnComplete не будет вовсе:
 * звонок висел бы до потолка длительности. Поэтому ждём тишины сами: дать модели
 * секунду начать хвост фразы, дождаться, пока она замолчит и очередь звука
 * опустеет, и после короткой паузы завершить. turnComplete-путь остаётся —
 * какой сработает первым, тот и кладёт трубку (endLiveVoiceSession идемпотентна).
 */
const END_WHEN_QUIET_START_DELAY_MS = 1_500;
const END_WHEN_QUIET_POLL_MS = 300;
/** Запас после опустевшей очереди: звук ещё идёт через туннель и буфер станции
 *  0,2–0,5 с (аудит моста З-5, 02.10.2026: было 600 мс). */
const END_WHEN_QUIET_GRACE_MS = 1_000;
const END_WHEN_QUIET_MAX_MS = 20_000;
/** Сколько ждём НАЧАЛА прощальной реплики, которую просим у модели сами (сторож
 *  тишины): задержка до первого звука у модели 1–2,5 с, а «тихо» без неё истинно уже
 *  на первом опросе — звонок возвращался станции до слова «до свидания» (аудит
 *  02.10.2026, п.7). */
export const FAREWELL_SPEECH_START_MAX_MS = 4_000;

/** `endReason` — причина целиком, как её запишет endLiveVoiceSession
 *  ("model_ended_call: …" у функций модели, NO_CALLER_SPEECH_REASON у сторожа тишины).
 *  `awaitSpeechSince` — момент, когда модели велено проститься: до первого кадра её
 *  речи после него (но не дольше FAREWELL_SPEECH_START_MAX_MS) «тихо» не считается. */
function endWhenQuiet(session: LiveVoiceSession, endReason: string, awaitSpeechSince?: number): void {
  if (session.endWhenQuietStarted) return;
  session.endWhenQuietStarted = true;
  const token = { cancelled: false };
  session.endToken = token;
  const startedAt = Date.now();
  // Закрываем именно ЭТУ сессию (не любую на том же канале — звонок мог вернуться
  // от агента и завести новую, аудит С7) и только если модель не отменила вызов.
  const poll = () => {
    if (token.cancelled || sessions.get(session.channelId) !== session) return;
    // Часы ушли назад (поправили время) — отсчёт ожидания считается истёкшим, а не
    // «отрицательным»: иначе ожидание растянулось бы на величину скачка.
    const waited = Date.now() - startedAt;
    const waitingForFarewell =
      awaitSpeechSince !== undefined &&
      session.lastBotAudioAt <= awaitSpeechSince &&
      waited >= 0 &&
      waited < FAREWELL_SPEECH_START_MAX_MS;
    const quiet = !waitingForFarewell && !session.isSpeaking && session.outQueue.length === 0;
    if (quiet || Date.now() - startedAt > END_WHEN_QUIET_MAX_MS) {
      setTimeout(() => {
        if (token.cancelled || sessions.get(session.channelId) !== session) return;
        // Пока шла пауза, модель могла начать говорить (прощание, которое обгоняет
        // «тихо») — трубку не кладём, ждём конца фразы (аудит 02.10.2026, п.7).
        if ((session.isSpeaking || session.outQueue.length > 0) && Date.now() - startedAt <= END_WHEN_QUIET_MAX_MS) {
          poll();
          return;
        }
        void endLiveVoiceSession(session.channelId, endReason, session);
      }, END_WHEN_QUIET_GRACE_MS).unref?.();
      return;
    }
    setTimeout(poll, END_WHEN_QUIET_POLL_MS).unref?.();
  };
  setTimeout(poll, END_WHEN_QUIET_START_DELAY_MS).unref?.();
}

/** Положить трубку, когда очередь звука доиграла (опустела), плюс
 *  END_WHEN_QUIET_GRACE_MS — для пути turnComplete прощальной реплики. Отсчёт от
 *  конца звука, а не от turnComplete: модель генерирует быстрее реального
 *  времени, и к turnComplete в очереди лежат секунды прощания. */
function hangupWhenDrained(session: LiveVoiceSession, endReason: string, token: { cancelled: boolean } | null = null): void {
  const startedAt = Date.now();
  const poll = () => {
    if (token?.cancelled || sessions.get(session.channelId) !== session) return;
    if (session.outQueue.length === 0 || Date.now() - startedAt > END_WHEN_QUIET_MAX_MS) {
      setTimeout(() => {
        if (token?.cancelled || sessions.get(session.channelId) !== session) return;
        // За паузу очередь могла пополниться (следующая реплика) — доиграть её.
        if (session.outQueue.length > 0 && Date.now() - startedAt <= END_WHEN_QUIET_MAX_MS) {
          poll();
          return;
        }
        void endLiveVoiceSession(session.channelId, endReason, session);
      }, END_WHEN_QUIET_GRACE_MS).unref?.();
      return;
    }
    setTimeout(poll, END_WHEN_QUIET_POLL_MS).unref?.();
  };
  poll();
}

/** Модель ответила (звук, конец хода, вызов функции) — сторож «модель молчит» сброшен. */
function noteModelResponded(session: LiveVoiceSession): void {
  session.awaitingModelSince = null;
  session.stallNudgedAt = null;
}

/** Слова человека в окне после приветствия (см. noBotAudioSuspected). Склеиваются без
 *  разделителя: расшифровка приходит кусками, пробелы несёт сама. */
function collectHelloWindow(session: LiveVoiceSession, text: string): void {
  if (session.helloWindowDone || session.firstBotAudioAt === 0) return;
  const since = Date.now() - session.firstBotAudioAt;
  if (since < NO_BOT_AUDIO_GRACE_MS || since > NO_BOT_AUDIO_WINDOW_MS) return;
  if (session.helloWindowText.length < 2_000) session.helloWindowText += text;
}

/**
 * Тик сторожей линии (см. STATION_AUDIO_GAP_MS, MODEL_STALL_NUDGE_MS,
 * NO_BOT_AUDIO_WINDOW_MS) — с момента, когда человек в мосте, снимается в
 * endLiveVoiceSession. Не бросает: звонок важнее сторожа.
 */
function startLineWatchdog(session: LiveVoiceSession): void {
  session.lineWatchTimer = setInterval(() => {
    try {
      if (sessions.get(session.channelId) !== session) return;
      // Звонок уже заканчивается (прощание, перевод) — сторожить нечего.
      if (session.noSpeechEnding || session.endWhenQuietStarted || session.transferPromise || session.transferred) return;
      const now = Date.now();

      // 1. Звук со станции пропал посреди разговора (п.4).
      if (session.stationPackets > 0 && now - session.lastStationPacketAt > STATION_AUDIO_GAP_MS) {
        const gapS = Math.round((now - session.lastStationPacketAt) / 1000);
        session.transcript.push(`[звук со станции пропал посреди разговора на ${gapS} с — звонок отдан станции]`);
        markStationAudioDead(`посреди разговора ${gapS} с не пришло ни одного кадра звука от станции`);
        void endLiveVoiceSession(session.channelId, NO_STATION_AUDIO_REASON, session);
        return;
      }

      // 2. Человек робота не слышит: «алло, не слышно» и ничего по делу (п.5).
      if (!session.helloWindowDone && session.firstBotAudioAt > 0) {
        const since = now - session.firstBotAudioAt;
        if (noBotAudioSuspected(session.helloWindowText, since)) {
          session.helloWindowDone = true;
          session.transcript.push("[звонящий повторяет «алло» и не слышит робота — звонок отдан станции]");
          void logSystemError(
            "telephony",
            "Живой голос: звонящий после приветствия только повторял «алло / не слышно» — звук робота, похоже, не доходит " +
              "до станции (адрес UNICASTRTP, фаервол, тоннель в одну сторону). Звонок отдан станции (автоответчик).",
            { dedupKey: "live-voice-no-bot-audio-suspected" }
          );
          void endLiveVoiceSession(session.channelId, NO_BOT_AUDIO_SUSPECTED_REASON, session);
          return;
        }
        if (since >= NO_BOT_AUDIO_WINDOW_MS) session.helloWindowDone = true;
      }

      // 3. Модель молчит (п.6). Переподключение Gemini — не зависание: его потолок свой.
      if (session.geminiReconnecting) return;
      const step = modelStallStep(
        {
          awaitingSince: session.awaitingModelSince,
          nudgedAt: session.stallNudgedAt,
          toolRunning: session.runningToolCalls.size > 0,
          botBusy: session.isSpeaking || session.outQueue.length > 0,
        },
        now
      );
      if (step === "nudge") {
        session.stallNudgedAt = now;
        session.transcript.push("[модель не ответила на реплику — напомнили ответить]");
        session.gemini.sendText(MODEL_STALL_NUDGE_TRIGGER);
      } else if (step === "end") {
        session.transcript.push("[модель так и не ответила — звонок отдан станции]");
        void logSystemError(
          "ai",
          `Живой голос: модель (${session.gemini.activeModel ?? "неизвестна"}) не отвечает ` +
            `${Math.round((MODEL_STALL_NUDGE_MS + MODEL_STALL_END_MS) / 1000)} с — ни звука, ни конца хода при открытом ` +
            "соединении. Звонок отдан станции (автоответчик).",
          { dedupKey: "live-voice-gemini-stalled" }
        );
        void endLiveVoiceSession(session.channelId, GEMINI_STALLED_REASON, session);
      }
    } catch (err) {
      void logSystemError("telephony", `Живой голос: сторож линии упал: ${describeError(err)}`, {
        dedupKey: "live-voice-line-watch-failed",
      });
    }
  }, LINE_WATCH_TICK_MS);
  session.lineWatchTimer.unref?.();
}

/** Звонящий подал голос: реплика в расшифровке или громкий кадр (не эхо бота). */
function markCallerActivity(session: LiveVoiceSession): void {
  session.lastCallerActivityAt = Date.now();
  session.noSpeechPromptedAt = null;
}

/** Сторож тишины (см. NO_SPEECH_PROMPT_MS) — заводится, когда модель уже слушает,
 *  снимается в endLiveVoiceSession. */
function startNoSpeechWatchdog(session: LiveVoiceSession): void {
  session.lastCallerActivityAt = Math.max(session.lastCallerActivityAt, Date.now());
  session.noSpeechTimer = setInterval(() => {
    if (sessions.get(session.channelId) !== session || session.noSpeechEnding || session.endWhenQuietStarted) return;
    // Связь с Gemini восстанавливается: человека не слышно не по его вине (аудит В3).
    if (session.geminiReconnecting) return;
    const step = noSpeechWatchStep(
      {
        lastCallerActivityAt: session.lastCallerActivityAt,
        lastBotAudioAt: session.lastBotAudioAt,
        botBusy: session.isSpeaking || session.outQueue.length > 0,
        promptedAt: session.noSpeechPromptedAt,
      },
      Date.now()
    );
    if (step === "prompt") {
      session.noSpeechPromptedAt = Date.now();
      session.transcript.push("[звонящий молчит — бот переспросил, слышно ли его]");
      session.gemini.sendText(noSpeechPromptTrigger(session.forceRussianOnly));
    } else if (step === "end") {
      session.noSpeechEnding = true;
      if (session.noSpeechTimer) clearInterval(session.noSpeechTimer);
      session.noSpeechTimer = null;
      session.transcript.push("[звонящий так и не ответил — звонок завершён]");
      session.gemini.sendText(noSpeechFarewellTrigger(session.handBackOnFailure, session.forceRussianOnly));
      endWhenQuiet(session, NO_CALLER_SPEECH_REASON, Date.now());
    }
  }, NO_SPEECH_CHECK_MS);
  session.noSpeechTimer.unref?.();
}

/**
 * ЭСКАЛАЦИЯ К ЖИВОМУ ЧЕЛОВЕКУ ПОСРЕДИ ЗВОНКА (см. ESCALATE_TO_HUMAN_TOOL выше,
 * 13.09.2026). Две части, ОБЕ переиспользуют существующие пути, а не заводят
 * новые:
 *  1. recordCallbackRequest — тот же приём, что у save_contact в
 *     wireGeminiEvents: заявка в очередь агента + свой пуш (callbackRequests.ts
 *     сам решает, кому — дежурному или тем, кто работает с сообщениями).
 *     autoConnect: false по той же причине, что и у save_contact — клиент ещё
 *     говорит с ботом по телефону, второй звонок на тот же номер сейчас не нужен.
 *  2. ОТДЕЛЬНЫЙ пуш агентам с правом ВИДЕТЬ ЗВОНКИ (calls.transcripts) — это не
 *     то же самое, что «работает с сообщениями» из recordCallbackRequest: явная
 *     просьба передать человека посреди живого звонка — про звонки, и видеть её
 *     должны те, кто вообще смотрит раздел «Звонки». Тот же паттерн эскалации
 *     руководству, что у missedCallEscalation.ts::notifyLeadership и
 *     finishShowingSurveyCall выше (createNotifications + sendPushToAgents,
 *     kind "oversight").
 *
 * Без карточки клиента (ручной тестовый звонок, clientId === null) заводить
 * CallbackRequest не на кого — тогда только пуш держателям calls.transcripts,
 * тем же способом, что и остальной живой голос без карточки (только журнал/
 * пуш, без записи на конкретного клиента).
 *
 * Не бросает — звонок обязан завершиться (см. pendingEndCallReason в
 * wireGeminiEvents) даже если ни заявка, ни пуш не записались.
 */
async function escalateLiveVoiceCallToHuman(
  session: LiveVoiceSession,
  reason: string,
  byClientRequest: boolean
): Promise<void> {
  try {
    if (session.clientId) {
      void recordCallbackRequest({
        clientId: session.clientId,
        channel: "LIVE_VOICE",
        topic: (byClientRequest
          ? `Живой голос: клиент попросил живого человека. ${reason}`
          : `Живой голос: бот не справился, нужен человек. ${reason}`
        ).slice(0, 500),
        autoConnect: false,
        // Дежурный оператор — только когда просьба о человеке прозвучала прямо (см.
        // ai/operatorHandoff.ts): раньше здесь стояло безусловное true, и любая
        // эскалация «бот не справился» запускала автодозвон оператора (аудит 02.10.2026).
        byClientRequest,
      });
    }

    const [agentIds, client] = await Promise.all([
      findAgentsWithPermission("calls.transcripts"),
      session.clientId
        ? prisma.client.findUnique({ where: { id: session.clientId }, select: { shortId: true, fullName: true } })
        : Promise.resolve(null),
    ]);
    if (agentIds.length === 0) return;
    const payload = {
      kind: "oversight" as const,
      title: byClientRequest ? "🆘 Живой голос: клиент просит оператора" : "🆘 Живой голос: боту нужен человек",
      body: `${client?.fullName ?? "Клиент"}: ${reason}`,
      url: client ? `/clients/${client.shortId}` : "/settings",
      tag: `live-voice-escalation-${session.channelId}`,
    };
    await createNotifications(agentIds, payload);
    void sendPushToAgents(agentIds, payload).catch((err) =>
      logSystemError(
        "telephony",
        `Живой голос: пуш об эскалации не отправлен (канал ${session.channelId}): ${err instanceof Error ? err.message : err}`
      )
    );
  } catch (err) {
    void logSystemError(
      "telephony",
      `Живой голос: эскалация к человеку не записана (канал ${session.channelId}): ${err instanceof Error ? err.message : err}`
    );
  }
}

/** Ни одного кадра со станции за NO_STATION_AUDIO_MS — путь звука мёртв (см. там).
 *  Пропажа звука ПОСЛЕ первых кадров — сторож линии (startLineWatchdog). */
function startStationAudioWatchdog(session: LiveVoiceSession): void {
  setTimeout(() => {
    if (sessions.get(session.channelId) !== session || session.stationPackets > 0) return;
    markStationAudioDead(`за ${NO_STATION_AUDIO_MS / 1000} с от станции не пришло ни одного кадра звука`);
    void endLiveVoiceSession(session.channelId, NO_STATION_AUDIO_REASON, session);
  }, NO_STATION_AUDIO_MS).unref?.();
}

/**
 * Сколько кадров подряд от одного НЕ совпавшего с портом станции отправителя
 * признают его станцией (NAT переписал порт и UNICASTRTP_LOCAL_PORT не сходится с
 * тем, что видим мы). 25 кадров = полсекунды: запоздавший хвост прошлой сессии
 * столько не тянется, а настоящая станция, чей порт совпал бы, объявляется с
 * первого же кадра и забирает замок раньше.
 */
export const RTP_UNMATCHED_SOURCE_ADOPT_PACKETS = 25;

/**
 * ОТКУДА ПРИНИМАЕМ ЗВУК (02.10.2026, аудит Г21 и аудит моста п.3): порт RTP слушал
 * пакеты от кого угодно — чужой или запоздавший трафик подмешивался в разговор и
 * обманывал сторож «нет звука со станции». Порт фиксированный, и кадр прошлой
 * сессии (или канала-сироты) мог прийти ПЕРВЫМ в новой: замок запоминал его, все
 * настоящие кадры отбрасывались как посторонние, а через 6 с робот уходил на
 * паузу на пустом месте. Поэтому замок берёт того, кто назвался станцией:
 *  1. LIVE_VOICE_RTP_PEER, если задан, — адрес (и порт) обязателен;
 *  2. порт станции для ЭТОГО канала (stationRtpTarget, из UNICASTRTP_LOCAL_PORT) —
 *     у каждого канала свой; не совпал — кадр не берёт замок, а при устойчивом
 *     потоке (RTP_UNMATCHED_SOURCE_ADOPT_PACKETS) станцией признаётся всё же;
 *  3. цели нет — замок на первом настоящем кадре, как раньше.
 */
function acceptRtpSource(session: LiveVoiceSession, from: dgram.RemoteInfo): boolean {
  if (!session.rtpPeer) {
    const expected = expectedRtpPeer();
    if (expected && (expected.address !== from.address || (expected.port !== null && expected.port !== from.port))) {
      dropForeignRtp(session, from);
      return false;
    }
    const verdict = rtpSourceMatchesTarget(session.stationRtpTarget, from);
    if (verdict === "mismatch") {
      const known = session.rtpCandidate;
      session.rtpCandidate =
        known && known.address === from.address && known.port === from.port
          ? { ...known, packets: known.packets + 1 }
          : { address: from.address, port: from.port, packets: 1 };
      if (session.rtpCandidate.packets < RTP_UNMATCHED_SOURCE_ADOPT_PACKETS) {
        dropForeignRtp(session, from);
        return false;
      }
      void logSystemError(
        "telephony",
        `Живой голос: звук канала ${session.channelId} идёт с ${from.address}:${from.port}, а станция назвала порт ` +
          `${session.stationRtpTarget?.port} — принят первый устойчивый отправитель (NAT переписал порт?).`,
        { dedupKey: "live-voice-rtp-source-port-differs" }
      );
    }
    session.rtpPeer = { address: from.address, port: from.port };
    session.rtpCandidate = null;
    return true;
  }
  if (session.rtpPeer.address === from.address && session.rtpPeer.port === from.port) return true;
  dropForeignRtp(session, from);
  return false;
}

function dropForeignRtp(session: LiveVoiceSession, from: dgram.RemoteInfo): void {
  session.rtpForeignDropped += 1;
  if (session.rtpForeignDropped !== 1) return;
  const expected = session.rtpPeer ?? expectedRtpPeer() ?? (session.stationRtpTarget ? { address: "станции", port: session.stationRtpTarget.port } : null);
  void logSystemError(
    "telephony",
    `Живой голос: RTP-пакет от постороннего адреса ${from.address}:${from.port} отброшен` +
      (expected ? ` (звук принимается только от ${expected.address}${expected.port ? `:${expected.port}` : ""}).` : "."),
    { dedupKey: "live-voice-rtp-foreign-source" }
  );
}

/**
 * ПЕРЕБИВАНИЕ ХВОСТА РЕПЛИКИ (09.10.2026, исследование С7: «клиент заговорил посреди
 * реплики бота, а бот говорил дальше больше 0,5 с — 8–10 раз за звонок»).
 *
 * ОШИБКА. Модель генерирует быстрее реального времени: к `turnComplete` её ход для
 * сервера закончен, а в очереди пейсера лежат ещё секунды недоигранной речи. Gemini
 * шлёт `interrupted`, только пока сама генерирует, — заговори человек поверх этого
 * хвоста, перебивать модели уже нечего, и бот договаривал всю очередь поверх человека
 * (а новый ответ модели вставал в очередь ПОСЛЕ старого хвоста).
 *
 * ПОЧИНКА. Пока модель молчит (`!isSpeaking`), а в линии доигрывает очередь, мост сам
 * сбрасывает хвост, если человек говорит LOCAL_BARGE_IN_FRAMES кадров подряд — не эхо и
 * громче уровня перебивания (длительность — та же, что `prefixPaddingMs` серверного VAD).
 * Уровень с 10.10.2026 — от линии: не тише порога эха и 2 × порога VAD, но не строже
 * прежних ECHO_BARGE_IN_ENERGY (EchoGateDecision.bargeIn, liveVoiceEchoGate.ts).
 * Не трогаем: приветствие (человек отвечает «алло» поверх него), прощание и
 * «соединяю» (endWhenQuiet, отложенный отбой, перевод).
 * Выключатель на случай сюрприза на живой линии — LIVE_VOICE_LOCAL_BARGE_IN=0.
 */
export const LOCAL_BARGE_IN_FRAMES = Math.round((LIVE_VOICE_ACTIVITY_DETECTION.prefixPaddingMs ?? 200) / FRAME_MS);

function noteLocalBargeIn(session: LiveVoiceSession, callerLoudOverEcho: boolean): void {
  const tailPlaying = !session.isSpeaking && session.outQueue.length > 0 && session.metrics.botOnLine;
  if (!callerLoudOverEcho || !tailPlaying) {
    session.localBargeInFrames = 0;
    return;
  }
  session.localBargeInFrames += 1;
  if (session.localBargeInFrames < LOCAL_BARGE_IN_FRAMES) return;
  session.localBargeInFrames = 0;
  if (process.env.LIVE_VOICE_LOCAL_BARGE_IN === "0") return;
  if (!session.greetingPlayed) return;
  if (
    session.endWhenQuietStarted ||
    session.endToken ||
    session.pendingEndCallReason !== null ||
    session.endCallToolId ||
    session.noSpeechEnding ||
    session.transferPromise ||
    session.transferred
  ) {
    return;
  }
  session.metrics.onLocalBargeIn();
  resetBotSpeech(session);
}

function wireRtpSocket(session: LiveVoiceSession): void {
  session.rtpSocket.on("message", (msg, from) => {
    try {
      // Не RTP или не от станции — не звук станции: ни сторож «нет звука», ни
      // разговор его не видят.
      const packet = parseRtpPacket(msg);
      if (!packet) return;
      if (!acceptRtpSource(session, from)) return;
      // Любой настоящий пакет со станции — путь звука жив (сторож NO_STATION_AUDIO_MS
      // на старте и STATION_AUDIO_GAP_MS посреди разговора).
      session.stationPackets += 1;
      session.lastStationPacketAt = Date.now();
      clearLiveVoiceAudioPathHold();
      // Канал в ulaw на 8 кГц, Gemini ждёт линейный PCM на 16 кГц:
      // разворачиваем таблицей и поднимаем частоту.
      const pcm8k = ulawDecode(packet.payload);
      session.clientAudioChunks.push(pcm8k);
      liveVoiceMonitor.publishAudio(session.dbId, "client", pcm8k);
      // Клиент только что замолчал — вдох уходит в трубку СЕЙЧАС, не дожидаясь
      // первого звука от Gemini (см. queueBreathIfDue). Только пока бот сам не
      // говорит — во время его реплики это уже работа серверного barge-in
      // (session.gemini.on("interrupted")), не этого детектора.
      const now = Date.now();
      // Эхо собственного голоса бота — в модель тишиной (см. ECHO_TAIL_MS); пороги
      // эха и VAD — от самой линии (liveVoiceEchoGate.ts).
      const gate = session.echoGate.classify(
        pcm8k,
        session.lastBotAudioAt > 0 ? now - session.lastBotAudioAt : Number.POSITIVE_INFINITY
      );
      if (!session.isSpeaking && detectClientSpeechEnd(pcm8k, session.vadState, gate.vadThreshold)) {
        queueBreathIfDue(session);
        // Человек договорил фразу — ждём ответа модели (сторож «модель молчит»).
        if (session.awaitingModelSince === null) session.awaitingModelSince = now;
        // Конец речи — последний громкий кадр: VAD видит его через VAD_SILENCE_HANGOVER_FRAMES тихих.
        session.metrics.onClientSpeechEnd(now - VAD_SILENCE_HANGOVER_FRAMES * FRAME_MS);
      }
      const toModel = gate.echo ? new Int16Array(pcm8k.length) : pcm8k;
      session.metrics.onEchoDecision(gate);
      // Громкий кадр, и это не эхо бота, — человек на линии (сторож тишины).
      const callerLoud = gate.speech;
      if (callerLoud) {
        markCallerActivity(session);
        // Человек всё ещё говорит — ответа от модели пока не ждём.
        session.awaitingModelSince = null;
        session.metrics.onClientLoudFrame(now);
      }
      noteLocalBargeIn(session, gate.bargeIn);
      if (session.inUpsampler) {
        // Подъём частоты 8→16 кГц с памятью между кадрами (pcmCodec.ts::StreamingInterpolator):
        // без ступенек на стыках кадров и без копий спектра выше 4 кГц (исследование С8).
        const pcm16k = int16ToBufferLE(session.inUpsampler.process(toModel));
        if (session.provider === "google") session.gemini.sendAudioChunk(pcm16k);
        else session.gemini.sendAudioChunk(pcm16k, CHANNEL_SAMPLE_RATE * 2);
      } else {
        // ElevenLabs принимает звук в частоте формата разговора (при ulaw_8000
        // подъём частоты не нужен вовсе) — клиент сам называет её.
        const inputRate = session.gemini.inputSampleRateHz;
        session.gemini.sendAudioChunk(int16ToBufferLE(resamplePcm16(toModel, CHANNEL_SAMPLE_RATE, inputRate)), inputRate);
      }
    } catch (err) {
      // Один плохой пакет НЕ должен ронять ни сессию, ни (что важнее) весь
      // процесс: необёрнутый throw в колбэке dgram-сокета — синхронный, Node
      // ничего не ловит, и падал бы ВЕСЬ API разом, обрывая ВСЕ активные
      // звонки (найденный баг, 13.09.2026). Пропускаем один кадр, а не сессию.
      void logSystemError(
        "telephony",
        `Живой голос: пакет RTP канала ${session.channelId} не обработан, пропущен: ${err instanceof Error ? err.message : err}`
      );
    }
  });
  session.rtpSocket.on("error", (err) => {
    void logSystemError("telephony", `Живой голос: RTP-сокет канала ${session.channelId} упал: ${err.message}`);
    void endLiveVoiceSession(session.channelId, "rtp_socket_error", session);
  });
}

/** Сколько ждать, пока модель договорит «соединяю», прежде чем уводить канал. */
const TRANSFER_QUIET_MAX_MS = 8_000;
/** Сколько перевод ждёт закрытия сессии после ухода канала (см. runTransfer). */
const TRANSFER_END_WAIT_MS = 3_000;
/** Имя функции перевода (liveVoiceTransfer.ts::TRANSFER_TOOL) — здесь строкой: мост
 *  не импортирует прикладной модуль, а тот импортирует мост. */
const TRANSFER_TOOL_NAME = "transfer_to_agent";

/** Модель отменила идущий вызов перевода (собеседник перебил) — уводить канал не нужно. */
function transferCancelled(session: LiveVoiceSession): boolean {
  for (const [id, name] of session.runningToolCalls) {
    if (name === TRANSFER_TOOL_NAME && session.cancelledToolIds.has(id)) return true;
  }
  return false;
}

/**
 * ПЕРЕВОД ЗВОНКА ЖИВОМУ ЧЕЛОВЕКУ (24.09.2026, консультант на телефоне, правка 4).
 *
 * Мост не знает, кому и как переводить: это решает задание (liveVoiceTransfer.ts)
 * и отдаёт сюда `move` — вывести канал звонящего из Stasis в диалплан станции.
 * Мост отвечает за три вещи:
 *  1. дать модели договорить («сейчас соединю вас с Умедом») — иначе человек
 *     услышит обрывок фразы и гудок;
 *  2. пометить сессию переведённой ДО вывода канала: станция тут же шлёт
 *     StasisEnd, и завершение сессии не должно класть трубку уходящему к агенту
 *     человеку;
 *  3. закрыть сессию (Gemini, мост, externalMedia, запись, итог заданию).
 *
 * ОДИН ПЕРЕВОД НА СЕССИЮ ЗА РАЗ (02.10.2026, аудит В5): повторный вызов (модель
 * повторила transfer_to_agent после перебивания или резюма) получает исход
 * первого, а не второй `move`. Раньше проваленный второй `move` сбрасывал
 * `transferred=false` после УСПЕШНОГО первого — и конец сессии клал трубку
 * человеку, которого только что передали агенту.
 *
 * "failed" — канал остался с консультантом, разговор продолжается; "gone" —
 * сессии уже нет (человек положил трубку).
 */
export function transferLiveVoiceCall(
  channelId: string,
  move: (channelId: string) => Promise<boolean>,
  recipientId?: string,
  /** Вызов перевода отменён моделью или исчерпал потолок (LiveVoiceToolContext.isCancelled). */
  isCancelled?: () => boolean
): Promise<"ok" | "failed" | "gone"> {
  const session = sessions.get(channelId);
  if (!session) return Promise.resolve("gone");
  if (session.transferPromise) {
    // КОМУ переводят (аудит 02.10.2026, п.8): второй вызов с ДРУГИМ получателем (человек
    // передумал: «нет, по объекту Б») получал «ок» первого — канал уходил к одному
    // агенту, а CRM записывала передачу другому. Чужой перевод не присваиваем:
    // отказ, модель скажет человеку, что соединяют уже сейчас.
    if (recipientId && session.transferRecipientId && recipientId !== session.transferRecipientId) {
      return Promise.resolve("failed");
    }
    return session.transferPromise;
  }
  const run = runTransfer(session, move, isCancelled);
  session.transferPromise = run;
  session.transferRecipientId = recipientId ?? null;
  // Неудачный перевод можно повторить позже; удавшийся закрывает сессию.
  void run.then((outcome) => {
    if (outcome !== "ok" && session.transferPromise === run) {
      session.transferPromise = null;
      session.transferRecipientId = null;
    }
  });
  return run;
}

async function runTransfer(
  session: LiveVoiceSession,
  move: (channelId: string) => Promise<boolean>,
  isCancelled?: () => boolean
): Promise<"ok" | "failed" | "gone"> {
  const channelId = session.channelId;
  const startedAt = Date.now();
  while (sessions.get(channelId) === session && (session.isSpeaking || session.outQueue.length > 0)) {
    if (Date.now() - startedAt > TRANSFER_QUIET_MAX_MS) break;
    await new Promise((resolve) => setTimeout(resolve, END_WHEN_QUIET_POLL_MS));
  }
  if (sessions.get(channelId) !== session) return "gone";
  // Отмену берём и у самого вызова: handleTaskToolCall стирает его из runningToolCalls
  // по таймауту, и transferCancelled уже не видит отменённый id (LIVE05).
  if (transferCancelled(session) || isCancelled?.()) return "failed";
  session.transferred = true;
  const moved = await move(channelId).catch((err) => {
    void logSystemError("telephony", `Живой голос: перевод канала ${channelId} упал: ${describeError(err)}`, {
      dedupKey: "live-voice-transfer-move-failed",
    });
    return false;
  });
  if (!moved) {
    session.transferred = false;
    if (sessions.get(channelId) === session) return "failed";
    // Сессия закончилась по другой причине, пока шёл перевод, и из-за `transferred`
    // не отпустила канал; перевод не удался — человек остался в Stasis без хозяина.
    const creds = await loadCredsSafe();
    if (creds) await releaseCaller(creds, channelId, session.handBackOnFailure);
    return "gone";
  }
  // Итог перевода не ждёт конца закрытия целиком (аудит 02.10.2026, п.16): запись
  // разговора в R2 (до 20 с) и итог консультанта шли внутри этого await, и ответ
  // функции перевода запаздывал, а то и упирался в её потолок. Линия станции
  // освобождается в начале закрытия — ждём это короткое время, остальное доезжает само.
  await Promise.race([
    endLiveVoiceSession(channelId, "transferred", session),
    new Promise<void>((resolve) => setTimeout(resolve, TRANSFER_END_WAIT_MS).unref?.()),
  ]);
  return "ok";
}

/**
 * Закрытие сессии поставщиком: вежливый конец разговора или сбой (02.10.2026).
 * Gemini признака normal не шлёт — для него любое закрытие, как и раньше, сбой
 * ("gemini_closed"). ElevenLabs помечает normal, когда агент сам закончил
 * разговор (ai/elevenLabsVoiceClient.ts::isElevenLabsNormalEnd) — тогда звонок
 * заканчивается как по end_call: причина `model_ended_call: …`, не сбой.
 */
export function providerCloseOutcome(info: unknown): { normal: boolean; reason: string } {
  const normal = !!info && typeof info === "object" && (info as { normal?: unknown }).normal === true;
  return normal
    ? { normal: true, reason: "агент ElevenLabs завершил разговор" }
    : { normal: false, reason: "gemini_closed" };
}

/** Сессия закончилась не разговором, а поломкой: отдать человека диалплану можно
 *  только тогда — договорённый конец разговора (модель попрощалась, человек положил
 *  трубку, потолок длительности) кладёт трубку, как раньше.
 *
 *  Молчащий звонящий (NO_CALLER_SPEECH_REASON, 02.10.2026) — того же рода: чаще
 *  всего это звук в одну сторону, то есть поломка линии, а не конец разговора.
 *  Звонок со станции уходит на её автоответчик — человек, которого мы не слышали,
 *  может оставить сообщение. */
export function handsCallerBackToDialplan(reason: string): boolean {
  return (
    reason.startsWith("start_failed") ||
    reason === "gemini_error" ||
    reason === "gemini_closed" ||
    reason === "rtp_socket_error" ||
    reason === "listener_stopped" ||
    reason === NO_CALLER_SPEECH_REASON ||
    reason === NO_STATION_AUDIO_REASON ||
    // 09.10.2026 (аудит линии, п.5–6): модель зависла или человек робота не слышит —
    // та же поломка линии, не конец разговора.
    reason === GEMINI_STALLED_REASON ||
    reason === NO_BOT_AUDIO_SUSPECTED_REASON
  );
}

/**
 * Завершить сессию: закрыть сокеты, отпустить человека, развалить мост, положить
 * итог в журнал и отдать его сценарию.
 *
 * ПОРЯДОК И НЕУБИВАЕМОСТЬ (02.10.2026, аудит В2). Раньше первой шла запись в базу,
 * потом чтение кредов из базы БЕЗ защиты: при сбое Postgres функция отклонялась на
 * этой строке, и не выполнялось ничего — ни отбоя, ни итога сценарию, а человек
 * оставался в мосте без звука. Теперь:
 *   1. линия: отбой/возврат станции, мост, канал звука — и отказ каждого шага
 *      попадает в журнал и в очередь уборщика, а не глотается;
 *   2. запись итога в базу — с потолком времени;
 *   3. итог сценарию — ВСЕГДА, даже если предыдущие шаги упали;
 *   4. запись разговора — не дольше RECORDING_WAIT_MS перед итогом (раньше до
 *      10 минут таймаута R2: итог опроса/анкеты ждал заливку).
 * `only` — закрыть, только если на канале лежит именно ЭТА сессия: таймеры и
 * события Gemini не должны закрыть новую сессию, начатую на том же канале (звонок
 * вернулся от агента).
 */
async function endLiveVoiceSession(channelId: string, reason: string, only?: LiveVoiceSession): Promise<void> {
  const session = sessions.get(channelId);
  if (!session) return;
  if (only && session !== only) return;
  sessions.delete(channelId);
  liveVoiceMonitor.sessionEnded(session.dbId, reason);
  stationReleasing += 1;
  let lineReleased = false;
  const releaseLine = () => {
    if (lineReleased) return;
    lineReleased = true;
    stationReleasing -= 1;
  };
  // Перевод мог быть начат и провалиться уже после этой строки — решение «класть ли
  // трубку» принимается по значению на момент закрытия (аудит В5).
  const transferred = session.transferred;
  // Снять резерв номера (защита от двойного дозвона, 13.09.2026) — только для
  // исходящих звонков (originateLiveVoice*), у входящего на тестовый номер
  // phoneNumber всегда null.
  if (session.phoneNumber) activeCallsByNumber.delete(session.phoneNumber);

  if (session.outTimer) clearInterval(session.outTimer);
  session.outTimer = null;
  if (session.maxDurationTimer) clearTimeout(session.maxDurationTimer);
  session.maxDurationTimer = null;
  if (session.noSpeechTimer) clearInterval(session.noSpeechTimer);
  session.noSpeechTimer = null;
  if (session.lineWatchTimer) clearInterval(session.lineWatchTimer);
  session.lineWatchTimer = null;
  session.outQueue.length = 0;
  try {
    session.gemini.close();
  } catch (err) {
    void logSystemError("telephony", `Живой голос: сокет Gemini не закрылся: ${describeError(err)}`, {
      dedupKey: "live-voice-gemini-close-failed",
    });
  }
  closeSocketQuietly(session.rtpSocket);
  const endedAt = new Date();

  try {
    // 1. ЛИНИЯ — ПЕРВОЙ: трубка освобождается сразу, до записей в базу.
    try {
      await releaseStationSide(session, channelId, reason, transferred);
    } catch (err) {
      void logSystemError("telephony", `Живой голос: уборка станции на выходе упала: ${describeError(err)}`, {
        dedupKey: "live-voice-end-station-failed",
      });
    } finally {
      releaseLine();
    }

    // 2. ИТОГ В БАЗУ — с потолком: зависшая запись не должна держать итог сценария.
    // Замеры звонка — строкой в конце расшифровки (без миграции схемы, liveVoiceMetrics.ts)
    // и в лог; сценарию уходит расшифровка без неё (ниже, session.transcript).
    const metricsLine = formatLiveVoiceMetricsLine(session.metrics.snapshot(session.echoGate.state()));
    console.log(`[живой голос] замеры канала ${channelId} (${reason}): ${metricsLine}`);
    const wrote = await withTimeout(
      // Строка журнала заводится параллельно снятию трубки — сперва дождаться её (у неё
      // свой потолок), иначе обновлять было бы нечего.
      Promise.resolve(session.dbRowReady).then(() =>
        prisma.liveVoiceSession
          .updateMany({
            // По id строки, а не по каналу: у вернувшегося от агента звонка канал тот же,
            // что у первой сессии (см. LiveVoiceSession.dbId).
            where: { id: session.dbId, endedAt: null },
            data: {
              endedAt,
              endedReason: reason,
              transcript: [...session.transcript, metricsLine].join("\n"),
            },
          })
          .catch((err) => void logSystemError("telephony", `Живой голос: итог сессии не записан: ${describeError(err)}`))
      ),
      DB_WRITE_TIMEOUT_MS * 2
    );
    if (wrote === TIMED_OUT) {
      void logSystemError("telephony", "Живой голос: итог сессии не записался в базу вовремя.", {
        dedupKey: "live-voice-end-db-timeout",
      });
    }

    // СТОИМОСТЬ ЗВОНКА В AiLog (13.09.2026) — conversationId = channelId, тот же
    // ключ, что уже хранит ShowingSurveyCall.channelId (см. schema.prisma), чтобы
    // GET /settings/live-voice/sessions и звонок-опрос могли посчитать её на лету
    // (routes/ai.ts:/cost). Пишем ТОЛЬКО если Google реально прислал usageMetadata
    // (session.spent не нулевой) — иначе честное «нет данных» лучше выдуманного
    // нуля (⚠️ поле не проверено живым звонком, см. докстринг liveVoiceClient.ts).
    // Не прислал (03.10.2026) — ОЦЕНКА по длительности с пометкой `:estimate` в endpoint:
    // без неё такой звонок выглядел бесплатным, хотя Google его посчитал.
    const hasUsage =
      session.spent.inputTokens > 0 || session.spent.outputTokens > 0 || session.spent.cacheReadTokens > 0;
    const callMs = Date.now() - session.startedAtMs;
    // Звонок ElevenLabs в журнал ИИ НЕ пишется (02.10.2026): поставщик расход не
    // присылает, а оценка по длительности была бы посчитана по цене Gemini — то есть
    // выдуманной. Известное ограничение; стоимость — в кабинете ElevenLabs.
    if (session.provider === "google") {
      void logAiCall({
        endpoint: hasUsage ? `live-voice:${session.callKind}` : `live-voice:${session.callKind}:estimate`,
        // Модель, на которой звонок реально шёл: при отказе основной сессия
        // открывается на запасной (ai/liveVoiceClient.ts), и цена считается по ней.
        model: session.gemini.activeModel ?? GEMINI_LIVE_MODEL,
        spent: hasUsage ? session.spent : estimateLiveVoiceUsage(callMs, session.botSpeechSamples),
        ms: callMs,
        ok: reason !== "gemini_error" && reason !== "ari_error",
        conversationId: channelId,
      });
    }

    // РАСШИФРОВКИ В ЖУРНАЛЕ ОШИБОК БОЛЬШЕ НЕТ (02.10.2026, аудит надёжности). С
    // 12.09.2026 каждый звонок робота писал сюда весь разговор: id канала стоял в
    // начале текста, по которому журнал узнаёт повтор (lib/systemError.ts), поэтому
    // КАЖДЫЙ звонок был «новой проблемой» с пушем руководству, а имена и номера
    // звонящих лежали в «Здоровье системы». Разговор хранит LiveVoiceSession
    // (Настройки → «Живой голос» → «Последние звонки»), запись — R2.

    // ЗАПИСЬ — ПОСЛЕ ТОГО КАК ЛИНИЯ УЖЕ ОСВОБОЖДЕНА (13.09.2026, см.
    // buildStereoWavFile выше), но не дольше RECORDING_WAIT_MS перед итогом сценария:
    // консультанту нужен ключ записи, чтобы приложить её к карточке, а медленный R2
    // (таймаут 10 минут) не должен держать итог. Опоздавшая запись всё равно
    // допишет ключ в строку сессии (saveLiveVoiceRecording).
    // НА ВЫКАТЕ (listener_stopped) ИТОГ — ДО ЗАЛИВКИ (02.10.2026): процесс ждёт
    // закрытия сессий всего несколько секунд, и заливка в R2 съедала их целиком —
    // сценарий (приглашение, опрос) не узнавал итога звонка вовсе. Запись в этом
    // случае заливается следом, ключ обработчику не нужен.
    const shuttingDown = reason === "listener_stopped";
    let recordingKey: string | null = null;
    if (!shuttingDown) {
      const key = await withTimeout(saveLiveVoiceRecording(channelId, session), RECORDING_WAIT_MS);
      if (key === TIMED_OUT) {
        void logSystemError("telephony", "Живой голос: запись разговора заливается дольше обычного — итог отдан без неё.", {
          dedupKey: "live-voice-recording-slow",
        });
      } else {
        recordingKey = key;
      }
    }

    // 3. ИТОГ ЗВОНКА — ВЛАДЕЛЬЦУ ЗАДАНИЯ. Прикладной модуль (опрос после показа,
    // проверка собственника, консультант) кладёт разговор в свою запись сам: мост о
    // ней ничего не знает и знать не должен.
    if (session.scenarioFinish) {
      const clientSpoke = session.transcript.some((line) => line.startsWith("Клиент:"));
      await session
        .scenarioFinish({
          channelId,
          transcript: session.transcript,
          reason,
          clientSpoke,
          // Речь робота реально ушла в линию (пейсер) и пришла от модели (п.3 аудита 09.10).
          botSpoke: session.lastBotAudioAt > 0 && session.botSpeechSamples > 0,
          recordingKey,
          startedAt: new Date(session.startedAtMs),
          endedAt,
          transferred,
        })
        .catch((err) =>
          void logSystemError("telephony", `Живой голос: обработчик итога звонка (канал ${channelId}) упал: ${describeError(err)}`, {
            dedupKey: "live-voice-finish-handler-failed",
          })
        );
    }
    if (shuttingDown) await saveLiveVoiceRecording(channelId, session, []);
  } finally {
    releaseLine();
    runDeferredListenerRestart();
  }
}

/** Линия на выходе: человеку — отбой или возврат станции, станции — убрать мост и
 *  канал звука. Каждый отказ в журнале и в очереди уборщика (аудит В2). */
async function releaseStationSide(
  session: LiveVoiceSession,
  channelId: string,
  reason: string,
  transferred: boolean
): Promise<void> {
  const creds = await loadCredsSafe();
  if (!creds) {
    // Креды недоступны (база не отвечает, а запомненных нет) — уборку отложить
    // уборщику: id мост и канала запоминаем.
    for (const [kind, id] of [
      ["bridge", session.bridgeId],
      ["channel", session.externalMediaChannelId],
    ] as const) {
      pendingStationCleanups.set(`${kind}:${id}`, { kind, id, since: Date.now(), attempts: 0 });
    }
    void logSystemError(
      "telephony",
      "Живой голос: сессия закрыта, но креды ARI недоступны — мост и канал звука на станции не убраны, оставлены уборщику.",
      { dedupKey: "live-voice-end-no-creds" }
    );
    return;
  }
  // Канал собеседника (channelId) — идемпотентно (hangupCall молчит на 404):
  // при обычном завершении (StasisEnd/ChannelDestroyed) его уже нет и это
  // не сработает, а по потолку длительности (LIVE_VOICE_MAX_SESSION_MS) он
  // ещё живой, и без этого вызова звонок повис бы дальше — маршрутизация
  // событий этой функции его не касается.
  // Переведённый звонок продолжается у агента — трубку ему не кладём.
  // Сессия упала сама (Gemini, RTP, рестарт CRM на выкате), а канал пришёл из
  // диалплана станции — человек уходит на автоответчик станции, а не в гудки.
  if (!transferred) {
    try {
      await releaseCaller(creds, channelId, session.handBackOnFailure && handsCallerBackToDialplan(reason));
    } catch (err) {
      void logSystemError("telephony", `Живой голос: человека не отпустили на станции: ${describeError(err)}`, {
        dedupKey: "live-voice-release-caller-failed",
      });
    }
  }
  await removeStationObject(creds, "bridge", session.bridgeId);
  await removeStationObject(creds, "channel", session.externalMediaChannelId);
}

/** Общая длина сэмплов во всех накопленных кусках (см. concatInt16 ниже) — без
 *  самой конкатенации, только для решения «стоит ли вообще собирать файл». */
function totalSamples(chunks: Int16Array[]): number {
  return chunks.reduce((sum, chunk) => sum + chunk.length, 0);
}

function concatInt16(chunks: Int16Array[]): Int16Array {
  const out = new Int16Array(totalSamples(chunks));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/** R2-ключ записи — свой префикс, тот же бакет, что у старых вложений/записей
 *  (см. r2Client.ts) — заводить отдельный бакет ради одной фичи незачем.
 *  Дата — момент заливки (конец звонка), не начала: разница в секундах/минутах
 *  разговора не стоит того, чтобы заводить под неё отдельное поле сессии. */
export function liveVoiceRecordingKey(channelId: string, startedAtMs: number): string {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  // Под `call-recordings/` с 24.09.2026: запись с этим префиксом прослушивание
  // разговора в карточке и в «Звонках» (routes/interactions.ts → fetchRecording)
  // берёт прямо из R2, как записи до 07.08.2026. Звонок консультанта ложится в
  // хронологию клиента тем же путём, что звонок агента, без своего плеера.
  // Время начала сессии в имени (02.10.2026): звонок, вернувшийся от агента, —
  // вторая сессия на том же канале, и по одному каналу её запись перетирала
  // запись первой части разговора.
  return `${LIVE_VOICE_RECORDING_PREFIX}${y}/${m}/${channelId}-${startedAtMs}.wav`;
}

/**
 * Собирает и заливает запись разговора — не бросает никогда (та же дисциплина,
 * что у остального в endLiveVoiceSession: запись — дополнение к звонку, а не
 * его условие). Меньше секунды суммарно с обеих сторон — считаем, что
 * содержательного разговора не было (тестовый звонок, сорвавшийся дозвон),
 * заливать нечего.
 */
const MIN_RECORDING_SAMPLES = CHANNEL_SAMPLE_RATE; // 1 секунда на 8 кГц

/** Паузы между попытками заливки записи в R2 (попыток на одну больше). */
export const RECORDING_UPLOAD_RETRY_DELAYS_MS = [1_000, 3_000] as const;

/** Повторить асинхронный вызов: попыток на одну больше, чем пауз. Последняя
 *  ошибка пробрасывается вызывающему. */
export async function retryAsync<T>(fn: (attempt: number) => Promise<T>, delaysMs: readonly number[]): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= delaysMs.length; attempt++) {
    try {
      return await fn(attempt + 1);
    } catch (err) {
      lastErr = err;
      if (attempt < delaysMs.length) await new Promise((resolve) => setTimeout(resolve, delaysMs[attempt]));
    }
  }
  throw lastErr;
}

/** Возвращает ключ записи в R2 — null, если
 *  писать было нечего или заливка не удалась (звонок это не должно ронять).
 *  retryDelaysMs: на выкате (listener_stopped) процесс ждёт закрытия сессий считанные
 *  секунды — там повторов нет (передаётся []). */
async function saveLiveVoiceRecording(
  channelId: string,
  session: LiveVoiceSession,
  retryDelaysMs: readonly number[] = RECORDING_UPLOAD_RETRY_DELAYS_MS
): Promise<string | null> {
  const samples = totalSamples(session.clientAudioChunks) + totalSamples(session.botAudioChunks);
  if (samples < MIN_RECORDING_SAMPLES) return null;
  if (!isR2Configured()) {
    void logSystemError(
      "telephony",
      `Живой голос: запись канала ${channelId} не сохранена — R2 не настроен (R2_ACCOUNT_ID/R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY).`
    );
    return null;
  }
  try {
    const wav = buildStereoWavFile(
      concatInt16(session.clientAudioChunks),
      concatInt16(session.botAudioChunks),
      CHANNEL_SAMPLE_RATE
    );
    const key = liveVoiceRecordingKey(channelId, session.startedAtMs);
    // Три попытки с паузами (03.10.2026): одна сетевая заминка R2 на конце звонка
    // теряла запись разговора навсегда — звука больше нигде нет.
    await retryAsync(() => r2Upload(key, wav, "audio/wav"), retryDelaysMs);
    await prisma.liveVoiceSession
      .updateMany({ where: { id: session.dbId }, data: { recordingUrl: key } })
      .catch((err) => void logSystemError("telephony", `Живой голос: путь записи не сохранён в карточке сессии: ${err instanceof Error ? err.message : err}`));
    return key;
  } catch (err) {
    void logSystemError(
      "telephony",
      `Живой голос: запись канала ${channelId} не залита в R2 за ${retryDelaysMs.length + 1} ${retryDelaysMs.length === 0 ? "попытку" : "попытки"}: ${err instanceof Error ? err.message : err}`
    );
    return null;
  }
}

// ---------------------------------------------------------------------------
// Подписка на события — ВТОРОЙ, ОТДЕЛЬНЫЙ websocket ARI (см. докстринг файла)
// ---------------------------------------------------------------------------

/** Экспортирован для тестов (тот же приём, что handleAriEvent в ariEvents.ts):
 *  событие станции проходит ровно тот путь, что из живой подписки. */
export async function onLiveVoiceAriEvent(event: AriEvent): Promise<void> {
  // ВТОРОЙ StasisStart НА ТОТ ЖЕ КАНАЛ — ИГНОРИРОВАТЬ (02.10.2026, аудит В6): дубль
  // события (переоткрытие подписки ARI) падал на занятом порту, а его catch
  // стирал из `sessions` ЧУЖУЮ, первую сессию — платный Gemini и таймеры
  // оставались жить без хозяина. Канал, у которого сессия идёт или поднимается,
  // повторно не принимается и ни в чём не затрагивается.
  // Канал резервируется СИНХРОННО, до первого await (LIVE02, 04.10.2026): раньше
  // `startingChannels` заполнялся лишь в startLiveVoiceSession, после чтения
  // настроек, и дубль, пришедший в это окно, проходил проверку, видел занятую
  // линию (liveVoiceLineBusy) и возвращал в диалплан канал только что запускаемого
  // звонка.
  const dupId = event.type === "StasisStart" && !isOwnExternalMediaChannel(event) ? event.channel?.id : undefined;
  if (dupId) {
    if (sessions.has(dupId) || startingChannels.has(dupId) || acceptingStasisChannels.has(dupId)) {
      void logSystemError("telephony", "Живой голос: повторный StasisStart на канал с идущей сессией проигнорирован.", {
        dedupKey: "live-voice-duplicate-stasis-start",
      });
      return;
    }
    acceptingStasisChannels.add(dupId);
  }
  try {
    await processLiveVoiceAriEvent(event);
  } catch (err) {
    // СИРОТА В STASIS (09.10.2026, аудит линии, п.1): исключение между чтением
    // настроек и подъёмом сессии (задание, промт, звуковое оформление) раньше
    // оставляло канал в приложении без хозяина — человек слушал гудки, пока его не
    // сбросит сеть. Теперь такой канал отдаётся станции (или кладётся, если он наш).
    await rescueOwnerlessChannel(event, err);
  } finally {
    if (dupId) acceptingStasisChannels.delete(dupId);
  }
}

/** Канал, у которого после сбоя обработки нет хозяина (сессия не поднимается и не
 *  идёт): станционный — назад в диалплан, наш собственный — отбой. Не бросает. */
async function rescueOwnerlessChannel(event: AriEvent, err: unknown): Promise<void> {
  try {
    const channelId = event.channel?.id;
    void logSystemError("telephony", `Живой голос: ошибка обработки события АТС ${event.type}: ${describeError(err)}`, {
      dedupKey: "live-voice-event-failed",
    });
    if (event.type !== "StasisStart" || !channelId || isOwnExternalMediaChannel(event)) return;
    if (sessions.has(channelId) || startingChannels.has(channelId)) return; // хозяин есть — его путь отказа свой
    const creds = await loadCredsSafe();
    if (!creds) return;
    if (stationArrival(event)) await handBackOrHangup(creds, channelId, `сбой обработки звонка: ${describeError(err)}`);
    else await removeStationObject(creds, "channel", channelId);
  } catch (rescueErr) {
    console.warn(`[живой голос] канал после сбоя не отпущен: ${describeError(rescueErr)}`);
  }
}

async function processLiveVoiceAriEvent(event: AriEvent): Promise<void> {
  if (event.type === "StasisStart") {
    // НАШ СОБСТВЕННЫЙ КАНАЛ ЗВУКА — ПРОПУСКАТЬ МОЛЧА (найдено первым живым
    // звонком, 12.09.2026). createExternalMediaChannel обязан указать Stasis-
    // приложение, поэтому канал UnicastRTP, который станция поднимает для RTP,
    // ВХОДИТ В ЭТО ЖЕ приложение и даёт свой StasisStart. Он приходит без
    // номера и в контексте `default`, не проходит проверку тумблера/номера
    // ниже — и код клал ему трубку как чужому. Через миг после этого
    // startLiveVoiceSession пытался добавить его в мост и получал
    // `HTTP 400 Channel not found`: канал уже убит нами же. Симптом со стороны
    // звонящего — трубку снял, звонок сразу оборвался.
    if (isOwnExternalMediaChannel(event)) return;
    const settings = await loadLiveVoiceSettings();
    // Канал нашего же исходящего звонка (originateLiveVoiceTestCall или
    // originateLiveVoiceCallToClient) — сверка с liveVoiceTestExtension здесь
    // бессмысленна (набранный номер реальный мобильный, а не станционный),
    // поэтому принимается по одному факту происхождения. Запись одноразовая:
    // снимается сразу, чтобы чужой канал с тем же (уже переиспользуемым
    // Asterisk-ом) id не прошёл по ошибке.
    const channelId = event.channel?.id;
    const pendingOutboundCount = pendingOutboundCalls.size;
    const pendingCall = channelId ? pendingOutboundCalls.get(channelId) : undefined;
    if (channelId && pendingCall) pendingOutboundCalls.delete(channelId);
    const isOurOutboundCall = !!pendingCall;
    if (!isOurOutboundCall && !shouldAcceptLiveVoiceChannel(event, settings)) {
      // Диагностика исходящего звонка (12.09.2026): ждали ЭТОТ канал (только что
      // создан нашим Originate), а StasisStart пришёл с другим id — значит id,
      // которым Asterisk представил канал в событии, отличается от id в ответе
      // Originate (например, Asterisk отдал ;2 вместо ;1, или переименовал
      // канал). Без этой строки такой перекос выглядел бы как обычный отказ
      // «чужой канал» и терялся бы среди штатных.
      if (channelId && pendingOutboundCount > 0) {
        void logSystemError(
          "telephony",
          `Живой голос: ждали свой исходящий звонок, но StasisStart пришёл с id ${channelId}, ` +
            `который не совпал ни с одним из ${pendingOutboundCount} ожидаемых — сброшен как чужой.`
        );
      }
      // Чужой/неожиданный канал в нашем приложении (например, тумблер выключили
      // уже после того, как маршрут на станции остался) — не виснем молча.
      if (channelId) {
        const creds = await loadCredsSafe();
        // Канал из диалплана станции (входящий вместо автоответчика, вернувшийся от
        // агента) — живой клиент, трубку ему не кладём: отдаём диалплану, где за
        // Stasis() стоит запасной путь (автоответчик).
        const arrival = stationArrival(event);
        const why = isAgentClientArrival(arrival)
          ? "свой клиент агента — робот не берёт (владелец 11.10.2026), автоответчик"
          : "канал не принят (тумблер, режим или номер)";
        if (creds && arrival) await handBackOrHangup(creds, channelId, why);
        else if (creds) await removeStationObject(creds, "channel", channelId);
      }
      return;
    }
    if (isOurOutboundCall && !settings?.liveVoiceEnabled) {
      // Тумблер выключили в промежутке между нажатием кнопки и ответом станции —
      // звонок обязан вежливо оборваться, а не притвориться рабочим.
      //
      // Клиент при этом УЖЕ ВЗЯЛ ТРУБКУ, поэтому обрыв объясняется словами:
      // раньше он не оставлял ни следа, и состоявшийся звонок выглядел как
      // сорвавшийся сам. Про нечитаемые настройки (тот же `null` здесь) пишет
      // loadLiveVoiceSettings отдельной строкой — по паре строк видно, что это
      // было: решение человека или сбой базы.
      void logSystemError(
        "telephony",
        `Живой голос: клиент ответил, но тумблер «Живой голос» выключен — звонок ${channelId ?? "без id"} прерван.`,
        { dedupKey: "live-voice-disabled-midcall" }
      );
      if (channelId) {
        const creds = await loadCredsSafe();
        if (creds) await removeStationObject(creds, "channel", channelId);
      }
      // Сценарию — «звонок не состоялся по нашей вине» (аудит В1): без этого он
      // ждал 20-минутной уборки, а человека, снявшего трубку, просто сбросили.
      if (pendingCall?.phoneNumber) activeCallsByNumber.delete(pendingCall.phoneNumber);
      if (pendingCall?.onFinished && channelId) {
        const now = new Date();
        await pendingCall
          .onFinished({
            channelId,
            transcript: [],
            reason: "start_failed: живой голос выключен в момент ответа",
            clientSpoke: false,
            startedAt: now,
            endedAt: now,
          })
          .catch((err) =>
            void logSystemError("telephony", `Живой голос: обработчик итога несостоявшегося звонка упал: ${describeError(err)}`, {
              dedupKey: "live-voice-start-failed-finish",
            })
          );
      }
      runDeferredListenerRestart();
      return;
    }
    if (pendingCall?.isManualTestCall) {
      // Ключи постоянные (02.10.2026): с id канала в начале текста каждый звонок
      // робота становился «новой проблемой» с пушем руководству (lib/systemError.ts).
      void logSystemError("telephony", `Живой голос: исходящий тестовый звонок принят, канал ${channelId} — поднимаю сессию.`, {
        dedupKey: "live-voice-test-call-accepted",
      });
    } else if (pendingCall) {
      void logSystemError(
        "telephony",
        // Сценарный звонок (приглашение, опрос) идёт без карточки клиента: раньше сюда
        // печаталось «клиенту undefined» (02.10.2026).
        `Живой голос: исходящий звонок ${pendingCall.clientId ? `клиенту ${pendingCall.clientId}` : "по сценарию (без карточки клиента)"} принят, канал ${channelId} — поднимаю сессию.`,
        { dedupKey: "live-voice-outbound-accepted" }
      );
    }
    // Входящий на тестовый внутренний номер станции (см. shouldAcceptLiveVoiceChannel
    // выше) не заводит запись в pendingOutboundCalls вовсе — это не наш Originate, а
    // чужой звонок, который станция сама направила в Stasis. Настройки из интерфейса
    // (голос/промт/замок на русский) должны действовать и здесь: без этого фолбэка
    // входящий на тестовый номер звучал бы иначе, чем оба исходящих пути.
    // Кто звонит и в какую сторону. Проверочный звонок и входящий на тестовый
    // номер спрашивают задание у консультанта (см. setLiveVoiceCallResolver);
    // исходящие звонки клиенту и сценарные несут своё с Originate.
    const direction: LiveVoiceDirection = pendingCall?.resolveAs ?? (pendingCall ? "outbound" : "inbound");
    const arrival = pendingCall ? null : stationArrival(event);
    // Звук некуда принимать (нет LIVE_VOICE_RTP_HOST или PORT): трубку не берём вовсе
    // и паузу «нет звука» не заводим — станция ведёт звонок дальше, на автоответчик
    // (аудит 02.10.2026, п.2: раньше проверялся только хост).
    if (arrival && channelId && liveVoiceRtpProblem()) {
      void logSystemError(
        "telephony",
        `Живой голос: входящий ${channelId} отдан станции (автоответчик), трубку робот не брал. ${liveVoiceRtpProblem()}`,
        { dedupKey: "live-voice-rtp-not-configured" }
      );
      const creds = await loadCredsSafe();
      if (creds) await handBackOrHangup(creds, channelId, "звук некуда принимать");
      return;
    }
    // Консультант уже говорит с другим человеком, а второй разговор линия не
    // потянет (см. liveVoiceLineBusy): станция ведёт звонок дальше, на автоответчик.
    if (arrival && channelId && liveVoiceAudioPathDown()) {
      void logSystemError(
        "telephony",
        `Живой голос: звук со станции не доходит — входящий ${channelId} отдан станции (автоответчик), трубку робот не брал.`,
        { dedupKey: "live-voice-audio-path-down" }
      );
      const creds = await loadCredsSafe();
      if (creds) await handBackOrHangup(creds, channelId, "робот на паузе: нет звука со станции");
      return;
    }
    // Gemini отказывал подключаться несколько раз подряд — робот на паузе (выключатель,
    // п.7 аудита 09.10): звонок сразу станции, без 25 с ожидания подключения.
    if (arrival && channelId && liveVoiceGeminiPaused()) {
      void logSystemError(
        "telephony",
        `Живой голос: робот на паузе (Gemini отказывает) — входящий ${channelId} отдан станции (автоответчик), трубку робот не брал.`,
        { dedupKey: "live-voice-gemini-paused-skip" }
      );
      const creds = await loadCredsSafe();
      if (creds) await handBackOrHangup(creds, channelId, "робот на паузе: Gemini отказывает");
      return;
    }
    if (arrival && channelId && liveVoiceLineBusy()) {
      void logSystemError(
        "telephony",
        `Живой голос: консультант занят другим разговором — входящий ${channelId} ушёл на автоответчик станции.`,
        { dedupKey: "live-voice-line-busy" }
      );
      const creds = await loadCredsSafe();
      if (creds) await handBackOrHangup(creds, channelId, "линия робота занята");
      return;
    }
    const returnedFromAgent = arrival === "returned";
    // «known» — тот же случай, что «missed», но агента не набирали: различает их
    // routeDecision звонка (liveVoiceConsultant.ts::agentWasRung), не аргумент.
    const agentMissed = arrival === "missed" || arrival === "known";
    const callerNumber = pendingCall
      ? pendingCall.phoneNumber ?? null
      : event.channel?.caller?.number?.trim() || null;
    const task =
      channelId && direction !== "outbound"
        ? resolveCallTask({ channelId, direction, callerNumber, settings, returnedFromAgent, agentMissed })
        : undefined;
    await startLiveVoiceSession(event, {
      task,
      direction,
      callerNumber,
      isManualTestCall: pendingCall?.isManualTestCall,
      clientId: pendingCall?.clientId,
      systemInstruction:
        pendingCall?.systemInstruction ?? buildLiveVoiceSystemPrompt(undefined, promptSettingsFrom(settings)),
      voiceName: pendingCall?.voiceName ?? resolveLiveVoiceVoiceName(settings),
      soundDesign: soundDesignFrom(settings),
      callKind: pendingCall?.callKind,
      tools: pendingCall?.tools,
      greetingTrigger: pendingCall?.greetingTrigger,
      onFinished: pendingCall?.onFinished,
      forceRussianOnly: pendingCall?.forceRussianOnly ?? settings?.liveVoiceForceRussianOnly ?? true,
      language: pendingCall?.language,
      phoneNumber: pendingCall?.phoneNumber,
      handBackOnFailure: !!arrival,
    });
    return;
  }
  if ((event.type === "StasisEnd" || event.type === "ChannelDestroyed") && event.channel?.id) {
    const id = event.channel.id;
    // Сессия ещё поднимается — запомнить отбой, иначе он потеряется (см. endedWhileStarting).
    if (!sessions.has(id) && startingChannels.has(id)) {
      endedWhileStarting.add(id);
      // Подъём идёт параллельно с подключением к Gemini (до 25 с): человек уже ушёл —
      // сворачиваем сразу, линию не держим (09.10.2026, п.2 аудита).
      const starting = startContexts.get(id);
      if (starting) await failStart(starting, "channel_ended");
    }
    await endLiveVoiceSession(id, "channel_ended");
  }
}

/** Потолок рукопожатия подписки — тот же, что у основной (ariEvents.ts): 15 с с
 *  запасом над TLS+HTTP upgrade по локальному туннелю. */
const LIVE_HANDSHAKE_TIMEOUT_MS = 15_000;

const LIVE_RECONNECT_MS = 5_000;
const LIVE_DISABLED_RECHECK_MS = 60_000;
const LIVE_PING_INTERVAL_MS = 10_000;

let liveSocket: WebSocket | null = null;
let liveStopped = true;
let liveConnecting = false;
let liveReconnectTimer: ReturnType<typeof setTimeout> | null = null;
/** Подписку хоть раз открывали в этом процессе — restartLiveVoiceListener() не
 *  должен заводить её первым в тестах/скриптах, которые startLiveVoiceListener()
 *  не звали вовсе (тот же приём, что у everStarted в ariEvents.ts). */
let liveEverStarted = false;
/** Сокеты, закрытые нами (остановка, перезапуск подписки): их «close» — не поломка. */
const liveClosedOnPurpose = new WeakSet<WebSocket>();
/** Когда подписка последний раз открылась (быстрый реконнект после долгой жизни). */
let liveOpenedAt = 0;
/** С какого момента подписки нет при включённом роботе; 0 — подписка есть. */
let liveDownSince = 0;
/** Тик сверки сирот в Stasis (sweepStasisOrphans). */
let stasisSweepTimer: ReturnType<typeof setInterval> | null = null;

/** Подписки нет дольше этого при включённом роботе — проблема в журнале. */
export const LIVE_SUBSCRIPTION_DOWN_ALARM_MS = 60_000;
/** Первая попытка после обрыва ЖИВШЕЙ подписки — почти сразу, как у основной
 *  (ariEvents.ts), а не через 5 с: эти секунды станция шлёт звонки в пустоту. */
const LIVE_FAST_RECONNECT_MS = 250;

/**
 * ПОДПИСКА РОБОТА УПАЛА (09.10.2026, аудит линии, п.10). Раньше «close» живого сокета
 * не писался никуда: станция считала приложение мёртвым и вела звонки мимо робота, а
 * в «Здоровье системы» было зелено. Пишется при обрыве живой подписки и, если она не
 * поднимается дольше LIVE_SUBSCRIPTION_DOWN_ALARM_MS, ещё раз — ключ постоянный.
 */
function noteLiveSubscriptionDown(detail: string): void {
  const now = Date.now();
  if (liveDownSince === 0) liveDownSince = now;
  const downMs = now - liveDownSince;
  if (downMs > 0 && downMs < LIVE_SUBSCRIPTION_DOWN_ALARM_MS) return;
  void logSystemError(
    "telephony",
    downMs === 0
      ? `Живой голос: подписка ARI робота оборвалась (${detail}) — переподключаюсь; пока её нет, станция ведёт звонки мимо робота.`
      : `Живой голос: подписка ARI робота не поднимается уже ${Math.round(downMs / 1000)} с (${detail}) — робот не берёт звонки.`,
    { dedupKey: "live-voice-subscription-down" }
  );
}

/** Состояние подписки робота — для «Здоровья станции» (stationHealth.ts). */
export function liveVoiceSubscriptionState(now: number = Date.now()): { connected: boolean; downForMs: number } {
  return { connected: isLiveVoiceListenerConnected(), downForMs: liveDownSince ? now - liveDownSince : 0 };
}

function scheduleLiveReconnect(delayMs: number): void {
  if (liveStopped) return;
  if (liveReconnectTimer) clearTimeout(liveReconnectTimer);
  liveReconnectTimer = setTimeout(() => {
    liveReconnectTimer = null;
    void connectLiveVoiceSocket();
  }, delayMs);
  liveReconnectTimer.unref?.();
}

/** Сколько незакрытых сессий разбираем за одну переподписку. Больше двадцати
 *  разом — это не «после рестарта», а поломка, и её видно по журналу. */
/** Сколько ждём ответа станции на список живых каналов — как RESYNC_TIMEOUT_MS
 *  у обычной телефонии. */
const LIVE_RESYNC_ARI_TIMEOUT_MS = 5_000;

const LIVE_RESYNC_LIMIT = 20;

/** Запас на гонку: сессию, начатую только что, не считаем брошенной, даже если
 *  станция ещё не назвала её канал среди живых. */
const LIVE_RESYNC_MIN_AGE_MS = 60_000;

/**
 * СВЕРКА ПОСЛЕ ПЕРЕПОДПИСКИ — то же, что resyncActiveChannels делает для обычной
 * телефонии, но для живого голоса, у которого своя, отдельная подписка ARI.
 *
 * Зачем: `sessions` — это Map в памяти процесса, и `endLiveVoiceSession` работает
 * только по ней. Перезапуск посреди живого разговора (контейнеры перезапускаются
 * на каждый мерж в main — норма, а не редкость) оставлял клиента подключённым к
 * мосту, из которого больше никто не шлёт звук: он слышал тишину, и трубку ему
 * никто не кладёт, пока он не положит сам. Запись `LiveVoiceSession` при этом
 * навсегда оставалась с пустым `endedAt` — в «Последних звонках» такой звонок
 * выглядит как никогда не закончившийся.
 *
 * Трогаем ТОЛЬКО каналы, у которых в базе есть незакрытая сессия, и только те,
 * которых нет в `sessions` этого процесса: живой разговор перебить нельзя.
 * Станцию не спросили — не закрываем ничего: пометить живой разговор
 * законченным хуже, чем подождать следующей переподписки.
 */
/**
 * Что делать после перезапуска с живым каналом незакрытой сессии (02.10.2026).
 *
 * До этой правки ему всегда клали трубку — и тому, кого станция прислала из своего
 * диалплана вместо автоответчика (входящий, «агент не ответил», вернувшийся от
 * агента). Такого человека отдаём назад в диалплан, где за Stasis() стоит
 * автоответчик: тот же исход, что у сессии, упавшей при живом процессе
 * (releaseCaller). Канал, который уже не в нашем приложении (ушёл к агенту, в
 * диалплан), не трогаем вовсе: там идёт чужой разговор.
 *
 * Станция не назвала приложение (app_name нет) — решаем по записи сессии: входящий
 * отдаём диалплану, остальное — отбой, как раньше.
 */
export function orphanChannelAction(channel: AriChannel, direction: string | null): "hand_back" | "hangup" | "leave" {
  const app = channel.dialplan?.app_name?.trim();
  if (app) {
    if (app.toLowerCase() !== "stasis") return "leave";
    const [name, arg] = (channel.dialplan?.app_data ?? "").split(",").map((part) => part.trim());
    if (name && name !== LIVE_VOICE_ARI_APP) return "leave";
    return arg === LIVE_VOICE_INBOUND_ARG ||
      arg === LIVE_VOICE_MISSED_ARG ||
      arg === LIVE_VOICE_KNOWN_ARG ||
      arg === LIVE_VOICE_RETURNED_ARG
      ? "hand_back"
      : "hangup";
  }
  return direction === "inbound" ? "hand_back" : "hangup";
}

export async function resyncLiveVoiceSessions(creds: AriCredentials): Promise<void> {
  let open: { id: string; channelId: string; startedAt: Date; direction: string | null }[];
  try {
    open = await prisma.liveVoiceSession.findMany({
      where: { endedAt: null },
      orderBy: { startedAt: "desc" },
      take: LIVE_RESYNC_LIMIT,
      select: { id: true, channelId: true, startedAt: true, direction: true },
    });
  } catch (err) {
    void logSystemError(
      "telephony",
      `Живой голос: незакрытые сессии не прочитались после переподписки: ${describeError(err)}`,
      { dedupKey: "live-voice-resync-db" }
    );
    return;
  }
  const orphans = open.filter((row) => !sessions.has(row.channelId));
  if (orphans.length === 0) return;

  let live: Map<string, AriChannel>;
  try {
    live = new Map((await listActiveChannels(creds, LIVE_RESYNC_ARI_TIMEOUT_MS)).map((c) => [c.id, c]));
  } catch (err) {
    void logSystemError(
      "telephony",
      `Живой голос: станцию не спросили о живых каналах после переподписки (${describeError(err)}) — ` +
        `${orphans.length} незакрытых сессий оставлены как есть до следующего раза.`,
      { dedupKey: "live-voice-resync-ari" }
    );
    return;
  }

  for (const row of orphans) {
    // За время запроса к станции на этом канале могла начаться НОВАЯ сессия (звонок
    // вернулся от агента): живой разговор не трогаем (аудит 02.10.2026, п.13).
    if (sessions.has(row.channelId) || startingChannels.has(row.channelId)) continue;
    const channel = live.get(row.channelId);
    const stillLive = !!channel;
    if (!stillLive && Date.now() - row.startedAt.getTime() < LIVE_RESYNC_MIN_AGE_MS) continue;
    const action = channel ? orphanChannelAction(channel, row.direction) : null;
    let handedBack = false;
    if (action === "hand_back") {
      // Звонок со станции — назад в её диалплан (автоответчик), а не в отбой.
      // С повторами; не вышло — отбой (handBackOrHangup), а не тишина в мосте.
      handedBack = (await handBackOrHangup(creds, row.channelId, "сверка после перезапуска")) === "handed_back";
    }
    if (action === "hangup") {
      // Клиент подключён к мосту, из которого больше никто не шлёт звук, —
      // кладём трубку сами, иначе он слушает тишину, пока не положит сам.
      await removeStationObject(creds, "channel", row.channelId);
    }
    // Только если строка всё ещё не закрыта: сессия могла кончиться сама, пока шла
    // сверка, — её настоящая причина («transferred», «channel_ended») не перетирается.
    await prisma.liveVoiceSession
      .updateMany({
        where: { id: row.id, endedAt: null },
        data: {
          endedAt: new Date(),
          endedReason: !stillLive ? "ended_while_offline" : action === "leave" ? "orphan_left_stasis" : "orphan_after_restart",
        },
      })
      .catch(() => {});
    void logSystemError(
      "telephony",
      !stillLive
        ? `Живой голос: сессия ${row.channelId} закрыта задним числом — звонок закончился, пока подписки не было.`
        : action === "leave"
          ? `Живой голос: сессия ${row.channelId} закрыта после перезапуска — канал уже не у консультанта, его не трогали.`
          : handedBack
            ? `Живой голос: разговор ${row.channelId} остался подключённым к мосту после перезапуска — звонок отдан станции (автоответчик), сессия закрыта.`
            : `Живой голос: разговор ${row.channelId} остался подключённым к мосту после перезапуска — трубка положена, сессия закрыта.`,
      { dedupKey: `live-voice-resync-${row.channelId}` }
    );
  }
}

/**
 * СИРОТЫ В STASIS (09.10.2026, аудит линии робота, п.1, сценарии 1–3). Канал попал в
 * приложение робота, а хозяина у него нет: StasisStart ушёл в полуживой сокет, или
 * обработка упала, или подписка переоткрылась (StasisStart не повторяется). Прежняя
 * сверка (resyncLiveVoiceSessions) смотрит только строки LiveVoiceSession — у такого
 * канала строки нет вовсе, и человек слушал гудки, пока его не сбросит сеть.
 *
 * Источник здесь — сама станция (GET /channels): каналы, стоящие в
 * `Stasis(royalhome-live-voice,…)`, которых нет ни в сессиях, ни в подъёме, ни в
 * приёме события, ни в отпускании, и которых видно так дольше STASIS_ORPHAN_MIN_AGE_MS
 * (запас на событие в пути). Станционный — назад в диалплан (автоответчик), наш
 * собственный (исходящий робота) — отбой (orphanChannelAction). Тик — раз в
 * STASIS_ORPHAN_SWEEP_MS и на каждом открытии подписки.
 */
export const STASIS_ORPHAN_MIN_AGE_MS = 8_000;
export const STASIS_ORPHAN_SWEEP_MS = 15_000;
const stasisOrphanFirstSeen = new Map<string, number>();
let stasisSweepRunning = false;

export interface StasisOrphanSweepResult {
  found: number;
  handedBack: number;
  hungUp: number;
  skipped?: string;
}

/** Канал стоит в приложении робота и хозяина у него нет. Чистая проверка — ради теста. */
export function isOwnerlessLiveVoiceStasisChannel(channel: AriChannel, owned: ReadonlySet<string>): boolean {
  if (!channel?.id || owned.has(channel.id)) return false;
  if ((channel.name ?? "").startsWith("UnicastRTP/")) return false;
  if (channel.dialplan?.app_name?.trim().toLowerCase() !== "stasis") return false;
  const appName = (channel.dialplan?.app_data ?? "").split(",")[0]?.trim();
  return appName === LIVE_VOICE_ARI_APP;
}

function ownedLiveVoiceChannelIds(): Set<string> {
  const owned = liveStationIds();
  for (const id of sessions.keys()) owned.add(id);
  for (const id of startingChannels) owned.add(id);
  for (const id of acceptingStasisChannels) owned.add(id);
  for (const id of releasingCallers) owned.add(id);
  for (const id of pendingOutboundCalls.keys()) owned.add(id);
  return owned;
}

export async function sweepStasisOrphans(now: number = Date.now()): Promise<StasisOrphanSweepResult> {
  const result: StasisOrphanSweepResult = { found: 0, handedBack: 0, hungUp: 0 };
  if (stasisSweepRunning) return { ...result, skipped: "сверка уже идёт" };
  stasisSweepRunning = true;
  try {
    const creds = await loadCredsSafe();
    if (!creds) return { ...result, skipped: "нет кредов ARI" };
    let channels: AriChannel[];
    try {
      channels = await listActiveChannels(creds, LIVE_RESYNC_ARI_TIMEOUT_MS);
    } catch (err) {
      void logSystemError("telephony", `Живой голос: сверка сирот в Stasis не получила список каналов станции: ${describeError(err)}`, {
        dedupKey: "live-voice-stasis-sweep-list-failed",
      });
      return { ...result, skipped: "станция не ответила" };
    }
    const owned = ownedLiveVoiceChannelIds();
    const candidates = channels.filter((channel) => isOwnerlessLiveVoiceStasisChannel(channel, owned));
    const candidateIds = new Set(candidates.map((c) => c.id));
    for (const id of [...stasisOrphanFirstSeen.keys()]) if (!candidateIds.has(id)) stasisOrphanFirstSeen.delete(id);
    for (const channel of candidates) {
      const firstSeen = stasisOrphanFirstSeen.get(channel.id);
      if (firstSeen === undefined) {
        stasisOrphanFirstSeen.set(channel.id, now);
        continue;
      }
      if (now - firstSeen < STASIS_ORPHAN_MIN_AGE_MS) continue;
      // Пока шёл запрос к станции, у канала мог появиться хозяин (StasisStart дошёл).
      if (ownedLiveVoiceChannelIds().has(channel.id)) continue;
      stasisOrphanFirstSeen.delete(channel.id);
      result.found += 1;
      if (orphanChannelAction(channel, null) === "hand_back") {
        const outcome = await handBackOrHangup(creds, channel.id, "сирота в Stasis без хозяина");
        if (outcome === "handed_back") result.handedBack += 1;
        else if (outcome === "hung_up") result.hungUp += 1;
      } else if (await removeStationObject(creds, "channel", channel.id)) {
        result.hungUp += 1;
      }
    }
    if (result.found > 0) {
      void logSystemError(
        "telephony",
        `Живой голос: в приложении робота нашлись каналы без хозяина (${result.found}) — отданы станции ` +
          `(${result.handedBack}) или положены (${result.hungUp}). Человек слушал гудки: событие станции до робота не дошло ` +
          "или его обработка упала.",
        { dedupKey: "live-voice-stasis-orphans" }
      );
    }
    return result;
  } catch (err) {
    void logSystemError("telephony", `Живой голос: сверка сирот в Stasis упала: ${describeError(err)}`, {
      dedupKey: "live-voice-stasis-sweep-failed",
    });
    return { ...result, skipped: "сбой сверки" };
  } finally {
    stasisSweepRunning = false;
  }
}

/** Только для тестов: забыть, кого сверка уже видела. */
export function resetStasisOrphanSweepForTests(): void {
  stasisOrphanFirstSeen.clear();
}

async function connectLiveVoiceSocket(): Promise<void> {
  if (liveStopped || liveConnecting) return;
  if (liveSocket && (liveSocket.readyState === WebSocket.CONNECTING || liveSocket.readyState === WebSocket.OPEN)) return;

  liveConnecting = true;
  try {
    const [settings, creds] = await Promise.all([loadLiveVoiceSettings(), loadCredsSafe()]);
    if (!settings?.liveVoiceEnabled || !creds) {
      // Выключено (штатно) или телефония вообще не настроена — не долбим Postgres
      // на каждый тик, проверяем реже (тот же приём, что у NOT_CONFIGURED_RETRY_MS
      // в ariEvents.ts). Робот выключен — подписки и не должно быть, это не поломка.
      if (!settings?.liveVoiceEnabled) liveDownSince = 0;
      scheduleLiveReconnect(LIVE_DISABLED_RECHECK_MS);
      return;
    }

    const url = new URL(`${creds.url}/ari/events`);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("app", LIVE_VOICE_ARI_APP);
    url.searchParams.set("api_key", `${creds.username}:${creds.password}`);

    /**
     * ПОТОЛОК РУКОПОЖАТИЯ — ТОТ ЖЕ, ЧТО У ОСНОВНОЙ ПОДПИСКИ (ariEvents.ts).
     *
     * Без него станция, принявшая TCP, но не ответившая на upgrade («полуживой»
     * туннель офис↔VPS), оставляла сокет в CONNECTING навсегда. А начало этой
     * же функции при liveSocket в CONNECTING просто выходит — значит
     * переподключение не завелось бы уже никогда, и живой голос молча умирал бы
     * до перезапуска контейнера. `ws` по истечении сам закрывает сокет и шлёт
     * "error", а обработчики ниже переподключаются как при любом обрыве.
     */
    const ws = new WebSocket(url.toString(), { handshakeTimeout: LIVE_HANDSHAKE_TIMEOUT_MS });
    liveSocket = ws;
    let watchdog: ReturnType<typeof startPingWatchdog> | undefined;

    ws.on("open", () => {
      console.log("[живой голос] подписка ARI открыта (экспериментально, app=" + LIVE_VOICE_ARI_APP + ")");
      liveOpenedAt = Date.now();
      liveDownSince = 0;
      // Сверка со станцией — как у обычной телефонии на её подписке: подхватить
      // то, что случилось, пока связи не было (см. resyncLiveVoiceSessions).
      void resyncLiveVoiceSessions(creds);
      // Каналы, попавшие в Stasis, пока подписки не было (StasisStart не повторится),
      // — сразу и ещё раз после порога возраста (sweepStasisOrphans).
      void sweepStasisOrphans();
      setTimeout(() => void sweepStasisOrphans(), STASIS_ORPHAN_MIN_AGE_MS + 500).unref?.();
      watchdog = startPingWatchdog(ws, LIVE_PING_INTERVAL_MS);
    });
    ws.on("pong", () => watchdog?.markAlive());
    ws.on("message", (raw) => {
      watchdog?.markAlive();
      let event: AriEvent;
      try {
        event = JSON.parse(String(raw)) as AriEvent;
      } catch {
        return;
      }
      void onLiveVoiceAriEvent(event).catch((err) =>
        void logSystemError("telephony", `Живой голос: ошибка обработки события АТС: ${err instanceof Error ? err.message : err}`)
      );
    });
    ws.on("close", (code: number) => {
      watchdog?.stop();
      if (liveSocket === ws) liveSocket = null;
      if (liveClosedOnPurpose.has(ws) || liveStopped) return;
      // Подписка жила (а не упала на рукопожатии) — первая попытка почти сразу.
      const lived = liveOpenedAt > 0 && Date.now() - liveOpenedAt > LIVE_RECONNECT_MS;
      liveOpenedAt = 0;
      noteLiveSubscriptionDown(`сокет закрыт, код ${code}`);
      scheduleLiveReconnect(lived ? LIVE_FAST_RECONNECT_MS : LIVE_RECONNECT_MS);
    });
    ws.on("error", (err) => {
      // В журнал, а не только в console: без этого «Здоровье системы» показывало
      // зелёное при мёртвой подписке — отказ внешнего вызова обязан попадать в
      // журнал (CLAUDE.md), и основная подписка (ariEvents.ts) так и делает.
      void logSystemError(
        "telephony",
        `Живой голос: ошибка подписки ARI: ${err instanceof Error ? err.message : err}`
      );
      ws.close();
    });
  } catch (err) {
    void logSystemError(
      "telephony",
      `Живой голос: подписка ARI не открылась: ${err instanceof Error ? err.message : err}`
    );
    noteLiveSubscriptionDown(describeError(err));
    scheduleLiveReconnect(LIVE_RECONNECT_MS);
  } finally {
    liveConnecting = false;
  }
}

/** Запускается при старте API — ровно как startAriEvents(), но независимо от
 *  него: своя лестница переподключения, своё состояние, ничего общего. Если
 *  Settings.liveVoiceEnabled = false (по умолчанию), сокет не откроется никогда —
 *  только опрос Настроек раз в минуту. */
export function startLiveVoiceListener(): void {
  liveStopped = false;
  liveEverStarted = true;
  // Сверка сирот в Stasis — тиком, независимо от состояния сокета: при полуживой
  // подписке именно она выводит человека из приложения без хозяина.
  if (!stasisSweepTimer) {
    stasisSweepTimer = setInterval(() => void sweepStasisOrphans(), STASIS_ORPHAN_SWEEP_MS);
    stasisSweepTimer.unref?.();
  }
  // Лестница задержек начинается заново — тот же приём, что у startAriEvents().
  void connectLiveVoiceSocket();
}

/**
 * Настройки, от которых зависит эта подписка, поменялись (тумблер, тестовый номер,
 * креды ARI) — переоткрыть её, а не ждать следующего обрыва или ближайшего тика
 * LIVE_DISABLED_RECHECK_MS. Вызывается из lib/settingsSideEffects.ts тем же
 * приёмом, что restartAriEvents() для обычной телефонии.
 */
export function restartLiveVoiceListener(): void {
  if (!liveEverStarted) return;
  // ИДУЩИЕ РАЗГОВОРЫ НЕ РВЁМ (02.10.2026, аудит С5/В18): сохранение настроек
  // телефонии перезапускало подписку, а перезапуск закрывал все сессии — звонящего
  // обрывало посреди фразы, а сценарий считал это «сбоем на нашей стороне».
  // Теперь перезапуск ждёт, пока разговоры закончатся (runDeferredListenerRestart);
  // новые звонки тем временем проверяют настройки на каждое событие, так что
  // выключенный тумблер или смена тестового номера действуют сразу.
  if (callsInFlight()) {
    listenerRestartDeferred = true;
    console.log("[живой голос] перезапуск подписки отложен до конца идущих разговоров");
    return;
  }
  listenerRestartDeferred = false;
  stopLiveVoiceListener();
  startLiveVoiceListener();
}

/** Перезапуск подписки ждёт конца разговоров (см. restartLiveVoiceListener). */
let listenerRestartDeferred = false;

function runDeferredListenerRestart(): void {
  if (!listenerRestartDeferred || callsInFlight()) return;
  restartLiveVoiceListener();
}

/** Идёт разговор, он поднимается, или номер набран и ещё не отвечен: во всех трёх
 *  случаях переоткрытие подписки (~1 с без подписчика у Stasis-приложения) оборвало
 *  бы человека — набранный, но не отвеченный звонок станция не смогла бы отдать
 *  приложению в момент ответа (аудит 02.10.2026, мост, п.4). */
function callsInFlight(): boolean {
  return sessions.size > 0 || sessionsStarting > 0 || pendingOutboundCalls.size > 0 || dialingReservations() > 0;
}

/**
 * УБОРЩИК СТАНЦИИ (02.10.2026, аудит В2; живая находка Dan: канал UnicastRTP висел
 * 101 час). Раз в 10 минут (тик live-voice-orphan-sweep):
 *  1. повторяет уборки, которые не удались на выходе сессии (pendingStationCleanups);
 *  2. снимает каналы звука UnicastRTP нашего приложения, у которых нет сессии и
 *     возраст больше потолка сессии с запасом, и мосты, в которых они стояли.
 * Живые и поднимающиеся сессии не трогает; канал без `creationtime` считается по
 * времени первого появления в списке.
 */
export const LIVE_VOICE_ORPHAN_AGE_MS = LIVE_VOICE_MAX_SESSION_MS + 5 * 60_000;
const orphanFirstSeen = new Map<string, number>();

export interface LiveVoiceSweepResult {
  retried: number;
  channelsHungUp: number;
  bridgesDeleted: number;
  skipped?: string;
}

function liveStationIds(): Set<string> {
  const ids = new Set<string>(startingStationIds);
  for (const session of sessions.values()) {
    ids.add(session.bridgeId);
    ids.add(session.externalMediaChannelId);
  }
  return ids;
}

export async function sweepLiveVoiceStationLeftovers(now: number = Date.now()): Promise<LiveVoiceSweepResult> {
  const result: LiveVoiceSweepResult = { retried: 0, channelsHungUp: 0, bridgesDeleted: 0 };
  const creds = await loadCredsSafe();
  if (!creds) return { ...result, skipped: "нет кредов ARI" };

  // 1. Неудавшиеся уборки с выхода сессий.
  for (const [key, item] of [...pendingStationCleanups]) {
    const inUse = sessions.has(item.id) || startingChannels.has(item.id) || liveStationIds().has(item.id);
    if (inUse) {
      pendingStationCleanups.delete(key);
      continue;
    }
    if (item.attempts >= STATION_CLEANUP_MAX_ATTEMPTS) {
      pendingStationCleanups.delete(key);
      void logSystemError(
        "telephony",
        `Живой голос: ${item.kind === "bridge" ? "мост" : "канал"} на станции убрать не удаётся после ${item.attempts} попыток — уборщик сдался, уберите вручную.`,
        { dedupKey: `live-voice-cleanup-gave-up-${item.kind}` }
      );
      continue;
    }
    result.retried += 1;
    await removeStationObject(creds, item.kind, item.id);
  }

  // 2. Сироты по списку станции.
  let channels: Awaited<ReturnType<typeof listActiveChannels>>;
  try {
    channels = await listActiveChannels(creds, LIVE_RESYNC_ARI_TIMEOUT_MS);
  } catch (err) {
    void logSystemError("telephony", `Живой голос: уборщик не получил список каналов станции: ${describeError(err)}`, {
      dedupKey: "live-voice-sweep-list-failed",
    });
    return { ...result, skipped: "станция не ответила" };
  }
  const ours = liveStationIds();
  const present = new Set(channels.map((c) => c.id));
  for (const id of [...orphanFirstSeen.keys()]) if (!present.has(id)) orphanFirstSeen.delete(id);
  const orphans = channels.filter((channel) => {
    if (!channel.name.startsWith("UnicastRTP/") || ours.has(channel.id)) return false;
    // Канал другого приложения станции (если она называет приложение) — не наш.
    const appData = channel.dialplan?.app_data?.trim();
    if (appData && !appData.startsWith(LIVE_VOICE_ARI_APP)) return false;
    const created = channel.creationtime ? Date.parse(channel.creationtime) : NaN;
    const since = Number.isFinite(created) ? created : (orphanFirstSeen.get(channel.id) ?? now);
    if (!Number.isFinite(created) && !orphanFirstSeen.has(channel.id)) orphanFirstSeen.set(channel.id, now);
    return now - since > LIVE_VOICE_ORPHAN_AGE_MS;
  });
  if (orphans.length === 0) return result;

  // Мосты со станции — ДО отбоя каналов: после отбоя в мосте уже никого не найти.
  const orphanIds = new Set(orphans.map((c) => c.id));
  let bridges: Awaited<ReturnType<typeof listBridges>> = [];
  try {
    bridges = await listBridges(creds, LIVE_RESYNC_ARI_TIMEOUT_MS);
  } catch (err) {
    void logSystemError("telephony", `Живой голос: уборщик не получил список мостов станции: ${describeError(err)}`, {
      dedupKey: "live-voice-sweep-bridges-failed",
    });
  }
  for (const channel of orphans) {
    if (await removeStationObject(creds, "channel", channel.id)) result.channelsHungUp += 1;
  }
  for (const bridge of bridges) {
    if (ours.has(bridge.id) || !bridge.channels.some((id) => orphanIds.has(id))) continue;
    if (await removeStationObject(creds, "bridge", bridge.id)) result.bridgesDeleted += 1;
  }
  void logSystemError(
    "telephony",
    `Живой голос: уборщик снял со станции осиротевшие каналы звука (${result.channelsHungUp}) и мосты (${result.bridgesDeleted}) — ` +
      "их не убрали на выходе сессий.",
    { dedupKey: "live-voice-orphans-swept" }
  );
  return result;
}

/** Закрыть подписку и все идущие разговоры; промисы их завершения — вызывающему. */
function stopListenerAndEndSessions(): Promise<void>[] {
  liveStopped = true;
  if (liveReconnectTimer) {
    clearTimeout(liveReconnectTimer);
    liveReconnectTimer = null;
  }
  if (stasisSweepTimer) {
    clearInterval(stasisSweepTimer);
    stasisSweepTimer = null;
  }
  if (liveSocket) liveClosedOnPurpose.add(liveSocket);
  liveDownSince = 0;
  liveSocket?.close();
  liveSocket = null;
  // listener_stopped отдаёт звонок со станции назад в её диалплан (автоответчик),
  // см. handsCallerBackToDialplan.
  return [...sessions.keys()].map((channelId) => endLiveVoiceSession(channelId, "listener_stopped").catch(() => {}));
}

/** Только для тестов и перезапуска подписки (restartLiveVoiceListener). */
export function stopLiveVoiceListener(): void {
  void stopListenerAndEndSessions();
}

/**
 * БЮДЖЕТЫ ОСТАНОВКИ — ОДНА ЦЕПОЧКА (аудит 02.10.2026, мост, п.5). Было три
 * несогласованных числа: 5 с на разговоры робота, 15 с жёсткого выхода процесса
 * (index.ts) и 45 с терпения Docker (docker-compose.prod.yml), из-за чего итог
 * сценария и запись разговора не успевали, а комментарий в compose обещал то, чего
 * index.ts не давал. Теперь:
 *   PROCESS_SHUTDOWN_GRACE_MS — потолок мягкой остановки процесса; index.ts держит
 *     то же число в SHUTDOWN_GRACE_MS (тест live-voice-bridge-shutdown-budget
 *     сверяет их), Docker (stop_grace_period) обязан быть не меньше;
 *   LIVE_VOICE_SHUTDOWN_WAIT_MS — сколько из них отдано разговорам робота: остаток
 *     (SHUTDOWN_TAIL_MS) нужен index.ts на досброс посещений, фоновые задачи
 *     (2,5 с) и отключение базы.
 */
export const PROCESS_SHUTDOWN_GRACE_MS = 15_000;
const SHUTDOWN_TAIL_MS = 4_000;
/** Сколько остановка процесса ждёт, пока разговоры отдадут станции. */
export const LIVE_VOICE_SHUTDOWN_WAIT_MS = PROCESS_SHUTDOWN_GRACE_MS - SHUTDOWN_TAIL_MS;

/**
 * ОСТАНОВКА ПРОЦЕССА ПОСРЕДИ РАЗГОВОРА (02.10.2026, аудит надёжности). Выкат
 * перезапускает контейнер на каждый мерж в main, а мягкая остановка (src/index.ts)
 * подписку живого голоса не трогала вовсе: процесс выходил, звонящий оставался в
 * мосте без звука, пока не положит трубку сам, а следующий процесс лишь после
 * переподписки находил его сверкой (resyncLiveVoiceSessions). Теперь каждый
 * разговор закрывается с причиной listener_stopped — звонок со станции уходит на её
 * автоответчик, остальным кладётся трубка, — и остановка ждёт этого не дольше
 * timeoutMs. Возвращает, сколько разговоров закрывалось.
 */
export async function shutdownLiveVoiceListener(timeoutMs = LIVE_VOICE_SHUTDOWN_WAIT_MS): Promise<number> {
  const ending = stopListenerAndEndSessions();
  if (ending.length === 0) return 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    Promise.allSettled(ending),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
      timer.unref?.();
    }),
  ]);
  if (timer) clearTimeout(timer);
  return ending.length;
}

export function isLiveVoiceListenerConnected(): boolean {
  return liveSocket?.readyState === WebSocket.OPEN;
}
