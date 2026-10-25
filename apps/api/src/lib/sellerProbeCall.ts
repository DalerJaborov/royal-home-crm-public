import { isDialableTajikNumber } from "@royal-home/shared";
import { prisma } from "../db.js";
import { recordInvestigationSignal } from "./investigationCases.js";
import { buildSellerProbeCallPrompt, SELLER_PROBE_CALL_GREETING_TRIGGER, SELLER_PROBE_CALL_TOOLS } from "../ai/sellerProbeCallPersona.js";
import { parseSellerProbeCall } from "../ai/sellerProbeCallParse.js";
import { logSystemAudit } from "./audit.js";
import { enqueueDirectorAlert } from "./directorAlertQueue.js";
import { scenarioCallBlockReason } from "./scenarioCallEligibility.js";
import {
  alignToCallHours,
  hasSubstantialClientSpeech,
  isOurSideCallFailure,
  isWithinPostShowingCallHours,
  POST_SHOWING_CALL_BUSY_RETRY_MS,
  POST_SHOWING_CALL_RETRY_MS,
  POST_SHOWING_CALL_STUCK_MS,
  scenarioEndKind,
} from "./postShowingCall.js";
import { loadCompanyDaysOff } from "./daysOffCalendar.js";
import { hasScenarioCallMark, withScenarioCallMark } from "./postShowingCalls.js";
import type { ScenarioCallMark } from "./postShowingCalls.js";
import { buildBypassDossier, findSellerProbeCandidates } from "./sellerBypassProbe.js";
import { logSystemError } from "./systemError.js";
import { originateLiveVoiceScenarioCall } from "./telephony/liveVoiceBridge.js";
import { LIVE_VOICE_STATION_AUDIO_RETRY_MS } from "./telephony/liveVoiceAudioPath.js";
import { scenarioVoice } from "./telephony/scenarioVoice.js";
import { clientLinesOf, looksLikeVoicemail } from "../ai/scenarioTranscript.js";
import type { LiveVoiceScenarioResult } from "./telephony/liveVoiceBridge.js";
import type { SellerProbeCallOutcome } from "../generated/prisma/client.js";

/**
 * ЗВОНОК СОБСТВЕННИКУ ПОКАЗАННОГО ОБЪЕКТА — порог 5.2 воронки
 * (docs/buyer-antifraud-funnel-13-09-2026.md).
 *
 * Кого звать, решает не этот файл, а `lib/sellerBypassProbe.ts`: там сужается
 * круг до одного объекта и считаются признаки. Здесь — только «когда набрать,
 * что сказать, что сделать с ответом».
 *
 * ЧАСЫ ТЕ ЖЕ, ЧТО У ОПРОСА ПОКУПАТЕЛЯ: 09:00–19:00 по Душанбе (решение владельца
 * 16.09.2026). Константы и выравнивание часа переиспользуются из
 * `lib/postShowingCall.ts`, а не копируются: правило одно на оба звонка, и менять
 * его придётся в одном месте.
 *
 * РЕДКИЙ ЗВОНОК, А НЕ ПОТОК. До него доходят единицы в месяц — по построению
 * лестницы (отправили ~5 объектов → показали ~2 → покупатель молчит по 1 → и
 * продавец замолчал). Поэтому тик часовой, а не пятиминутный.
 */

/** Сколько раз пытаемся дозвониться. Столько же, сколько покупателю. */
export const SELLER_PROBE_MAX_ATTEMPTS = 2;

/** Сколько записей разбирает один проход. */
const BATCH = 10;

/**
 * Станция не приняла набор (не настроена, живой голос выключили посреди тика,
 * Asterisk не ответил за 5 с, 5xx) — через сколько пробуем снова. Это не исход
 * звонка: попытка не тратится, номер «мёртвым» не становится (аудит фона
 * 02.10.2026, №3). Час — как у самого тика: чаще звонить некуда.
 */
export const SELLER_PROBE_STATION_RETRY_MS = 60 * 60 * 1000;

/**
 * Заводит проверки по показам, где сошлись признаки. Ничего не набирает.
 *
 * Идемпотентно: на один звонок покупателю — одна проверка продавца
 * (`@@unique` по postShowingCallId), повторный проход no-op.
 */
export async function scheduleSellerProbeCalls(now: Date = new Date()): Promise<number> {
  const automation = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { buyerSellerAutomationMode: true } });
  const candidates = await findSellerProbeCandidates(now, BATCH * 3);
  let created = 0;

  for (const postShowingCallId of candidates) {
    const exists = await prisma.sellerProbeCall.findUnique({
      where: { postShowingCallId },
      select: { id: true },
    });
    if (exists) continue;

    const dossier = await buildBypassDossier(postShowingCallId, now);
    if (!dossier?.shouldAskSeller || !dossier.propertyId || !dossier.sellerClientId) continue;

    try {
      await prisma.sellerProbeCall.create({
        data: {
          postShowingCallId,
          previewOnly: automation?.buyerSellerAutomationMode !== "LIVE",
          propertyId: dossier.propertyId,
          sellerClientId: dossier.sellerClientId,
          agentId: dossier.agentId,
          scheduledFor: alignToCallHours(now, null),
          signals: dossier.signals.map((s) => s.key),
        },
      });
      created++;
    } catch {
      // Гонка двух проходов — @@unique не даст завести вторую проверку.
    }
  }
  return created;
}

/**
 * Один проход: завести новые проверки, освободить зависшие, набрать те, чей час
 * настал. Возвращает число начатых звонков.
 */
export async function runSellerProbeCallTick(now: Date = new Date()): Promise<number> {
  const settings = await prisma.settings.findUnique({
    where: { id: "singleton" },
    select: { postShowingCallEnabled: true, liveVoiceEnabled: true },
  });
  // Тот же рубильник, что у опроса покупателя: проверка продавца — его
  // продолжение, а не самостоятельная функция. Включать её отдельно от опроса
  // бессмысленно (звонить будет не по чему) и опасно (звонки собственникам
  // пошли бы без понимания, откуда они взялись).
  if (!settings?.postShowingCallEnabled || !settings.liveVoiceEnabled) return 0;

  // Снимок общих выходных для часов звонков (postShowingCall.ts, 11.10.2026).
  await loadCompanyDaysOff();
  await scheduleSellerProbeCalls(now);
  await releaseStuckSellerProbeCalls(now);

  if (!isWithinPostShowingCallHours(now)) return 0;

  const due = await prisma.sellerProbeCall.findMany({
    where: { previewOnly: false, status: { in: ["PENDING", "NO_ANSWER"] }, scheduledFor: { lte: now } },
    orderBy: { scheduledFor: "asc" },
    take: BATCH,
    select: { id: true },
  });

  /**
   * НЕ БОЛЬШЕ ОДНОГО ЗВОНКА ЗА ТИК (02.10.2026, аудит фона №4). Порт RTP у моста
   * один — одна беседа. Набрать пачку значило бы, что первый ответивший
   * разговаривает, а остальные, сняв трубку, слышат обрыв на «алло», и попытка
   * у них списана. Пропущенные записи (собственник удалён, нет номера) не в
   * счёт — идём к следующей; линия занята или станция отказала — дальше в этом
   * тике не пробуем вовсе (отказ станции почти всегда общий для всех номеров).
   */
  for (const row of due) {
    const outcome = await dialSellerProbeCall(row.id, now);
    if (outcome !== "skipped") return outcome === "started" ? 1 : 0;
  }
  return 0;
}

async function releaseStuckSellerProbeCalls(now: Date): Promise<void> {
  // Порог выше потолка сессии моста (15 мин + гудки): прежние 10 минут
  // объявляли номер мёртвым посреди живого разговора (аудит 02.10.2026, №14).
  const stuck = await prisma.sellerProbeCall.findMany({
    where: { status: "CALLING", lastAttemptAt: { lt: new Date(now.getTime() - POST_SHOWING_CALL_STUCK_MS) } },
    take: BATCH,
    select: { id: true, attempts: true, skipReason: true, channelId: true },
  });
  // Недозвон мост сообщает сам (reason "no_answer"); строка, провисевшая дольше
  // потолка сессии, — итог, потерянный нами (выкат, упавший обработчик). Это не
  // довод «номер мёртвый».
  for (const row of stuck) {
    // ЗАНЯТА, НО НЕ НАБРАНА (третий аудит 02.10.2026, В3): канала нет, `attempts` не
    // увеличивался — звонка не было. Возвращать попытку нечего; прежний «возврат»
    // вычитал её у строки, которой никто не набирал (см. postShowingCall.ts).
    if (!row.channelId) {
      await prisma.sellerProbeCall.updateMany({
        where: { id: row.id, status: "CALLING", channelId: null },
        data: {
          status: row.attempts > 0 ? "NO_ANSWER" : "PENDING",
          ...(row.attempts === 0 ? { lastAttemptAt: null } : {}),
          scheduledFor: alignToCallHours(new Date(now.getTime() + POST_SHOWING_CALL_BUSY_RETRY_MS), null),
        },
      });
      continue;
    }
    await handleSellerProbeOurSideFailure(row, now);
  }
}

/**
 * Попытка кончилась без разговора.
 *
 * `answered` — трубку всё-таки сняли: автоответчик, «перезвоните позже», не тот
 * человек. Номер тогда заведомо живой, и пометка `line_alive` остаётся на
 * записи до конца. МЁРТВЫМ номер становится только тогда, когда НИ В ОДНОЙ
 * попытке трубку не сняли (аудит 02.10.2026, №6): раньше два автоответчика или
 * два «перезвоните» давали deadNumber и аларм директору «номер вписан вручную»
 * про живой номер — ложное подозрение на агента.
 */
async function markSellerProbeNoAnswer(
  probe: { id: string; attempts: number; skipReason: string | null },
  now: Date,
  marks: ScenarioCallMark[] = []
): Promise<void> {
  const skipReason = marks.length ? withScenarioCallMark(probe.skipReason, ...marks) : probe.skipReason;
  if (probe.attempts >= SELLER_PROBE_MAX_ATTEMPTS) {
    const lineAlive = hasScenarioCallMark(skipReason, "line_alive");
    // Обе попытки прошли, и ни одна не дошла до разговора. Если ни в одной
    // трубку не сняли — для собственника это и значит «номер выключен,
    // недоступен или неверен»: большего станция нам не скажет. Само по себе это
    // не улика (телефон мог сесть); что с этим делать, решает правило про
    // карточку, заведённую агентом вручную.
    await prisma.sellerProbeCall.update({
      where: { id: probe.id },
      data: { status: "GIVEN_UP", deadNumber: !lineAlive, skipReason },
    });
    if (!lineAlive) await raiseDeadNumberAlertIfManualCard(probe.id);
    return;
  }
  await prisma.sellerProbeCall.update({
    where: { id: probe.id },
    data: {
      status: "NO_ANSWER",
      skipReason,
      scheduledFor: alignToCallHours(new Date(now.getTime() + POST_SHOWING_CALL_RETRY_MS), null),
    },
  });
}

/**
 * Сбой на нашей стороне (немая линия, упавшая модель, выкат — см.
 * isOurSideCallFailure): это не «не дозвонились» и не довод о мёртвом номере.
 * Попытка возвращается, но не больше одного раза на запись (аудит №3, №4);
 * второй такой сбой закрывает проверку как SKIPPED `station_down` — без
 * deadNumber и без аларма.
 */
async function handleSellerProbeOurSideFailure(
  probe: { id: string; attempts: number; skipReason: string | null },
  now: Date
): Promise<void> {
  if (hasScenarioCallMark(probe.skipReason, "attempt_returned")) {
    await prisma.sellerProbeCall.update({ where: { id: probe.id }, data: { status: "SKIPPED", skipReason: "station_down" } });
    return;
  }
  const attemptsLeft = Math.max(0, probe.attempts - 1);
  await prisma.sellerProbeCall.update({
    where: { id: probe.id },
    data: {
      status: attemptsLeft > 0 ? "NO_ANSWER" : "PENDING",
      attempts: attemptsLeft,
      scheduledFor: alignToCallHours(new Date(now.getTime() + LIVE_VOICE_STATION_AUDIO_RETRY_MS), null),
      skipReason: withScenarioCallMark(probe.skipReason, "attempt_returned"),
    },
  });
}

/** Чем кончилась попытка набора: начат звонок, линия занята, станция отказала, запись закрыта без звонка. */
type DialOutcome = "started" | "busy" | "station_failed" | "skipped";

async function dialSellerProbeCall(id: string, now: Date): Promise<DialOutcome> {
  const probe = await prisma.sellerProbeCall.findUnique({
    where: { id },
    select: {
      id: true,
      attempts: true,
      previewOnly: true,
      sellerClientId: true,
      seller: { select: { fullName: true, phone: true, deletedAt: true } },
      property: { select: { title: true, status: true, deletedAt: true } },
    },
  });
  if (!probe || probe.previewOnly) return "skipped";

  if (probe.seller.deletedAt) {
    await prisma.sellerProbeCall.update({ where: { id }, data: { status: "SKIPPED", skipReason: "seller_gone" } });
    return "skipped";
  }
  // Ночная проверка 24.09.2026: объект успел уйти в Корзину между тем, как
  // проверку завели, и тем, как настал час звонка — `property.deletedAt` уже
  // выбирался выше, но никогда не сравнивался, и робот звонил собственнику про
  // объект, которого в системе больше нет.
  if (probe.property.deletedAt) {
    await prisma.sellerProbeCall.update({ where: { id }, data: { status: "SKIPPED", skipReason: "property_gone" } });
    return "skipped";
  }
  if (!probe.seller.phone) {
    // Телефона нет вовсе — это не «не дозвонились», а отсутствие данных.
    await prisma.sellerProbeCall.update({ where: { id }, data: { status: "SKIPPED", skipReason: "no_phone" } });
    return "skipped";
  }
  // «Не беспокойте» и чёрный список станции (аудит 02.10.2026, А4): собственник,
  // попросивший оставить его в покое, роботом не набирается. Это не «мёртвый
  // номер» и не повод для тревоги — запись просто закрывается.
  const block = await scenarioCallBlockReason({ phone: probe.seller.phone, clientId: probe.sellerClientId });
  if (block) {
    await prisma.sellerProbeCall.update({ where: { id }, data: { status: "SKIPPED", skipReason: block } });
    return "skipped";
  }
  /**
   * НОМЕР, КОТОРЫЙ СТАНЦИЯ НАБРАТЬ НЕ МОЖЕТ, — ВОТ ОН «МЁРТВЫЙ» (02.10.2026).
   * Неправильный номер — тот случай, ради которого владелец просил сигнал:
   * номер, вписанный агентом руками, никем не проверен и может быть неверным
   * нарочно. Проверка та же, что первой делает сам мост
   * (originateLiveVoiceScenarioCall → isDialableTajikNumber), только здесь: так
   * «дело в номере» отличается от «дело в станции» не по тексту ошибки.
   */
  if (!isDialableTajikNumber(probe.seller.phone)) {
    await prisma.sellerProbeCall.update({
      where: { id },
      data: { status: "GIVEN_UP", deadNumber: true, attempts: SELLER_PROBE_MAX_ATTEMPTS },
    });
    await raiseDeadNumberAlertIfManualCard(probe.id);
    return "skipped";
  }

  // Голос — до промта: имя и «сотрудница/сотрудник» в нём от пола голоса (02.10.2026).
  const voice = await scenarioVoice();
  const prompt = buildSellerProbeCallPrompt({
    sellerName: firstName(probe.seller.fullName),
    propertyLabel: probe.property.title,
    voiceGender: voice.gender,
  }, voice.forceRussianOnly);

  /**
   * ЗАНЯТЬ ПРОВЕРКУ ДО НАБОРА (№172 ночной проверки 24.09). «Звоним» ставилось
   * после того, как станция приняла набор, — рестарт процесса в этот миг
   * (каждый выкат) оставлял проверку ждущей, и следующий проход звонил
   * собственнику второй раз. Теперь CALLING ставится условно, только из ждущих
   * статусов: кто занял — тот звонит. Зависшее занятие (процесс умер посреди
   * набора) снимет releaseStuckSellerProbeCalls.
   */
  const before = await prisma.sellerProbeCall.findUnique({ where: { id }, select: { status: true, lastAttemptAt: true } });
  if (!before || (before.status !== "PENDING" && before.status !== "NO_ANSWER")) return "skipped";
  const claimed = await prisma.sellerProbeCall.updateMany({
    where: { id, status: before.status, previewOnly: false },
    data: { status: "CALLING", channelId: null, lastAttemptAt: now },
  });
  if (claimed.count !== 1) return "skipped";
  const releaseClaim = (scheduledFor?: Date) =>
    prisma.sellerProbeCall.updateMany({
      where: { id, status: "CALLING", channelId: null },
      data: { status: before.status, lastAttemptAt: before.lastAttemptAt, ...(scheduledFor ? { scheduledFor } : {}) },
    });

  let result: Awaited<ReturnType<typeof originateLiveVoiceScenarioCall>>;
  try {
    result = await originateLiveVoiceScenarioCall(
      probe.seller.phone,
      {
        investigationOnly: true,
        systemInstruction: prompt,
        voiceName: voice.voiceName,
        forceRussianOnly: voice.forceRussianOnly,
        greetingTrigger: SELLER_PROBE_CALL_GREETING_TRIGGER,
        tools: SELLER_PROBE_CALL_TOOLS,
        clientId: probe.sellerClientId,
        onFinished: (callResult) => finishSellerProbeCall(callResult),
      },
      { callerId: "Royal Home" }
    );
  } catch (err) {
    await releaseClaim();
    throw err;
  }

  if (result.busy) {
    // Линия живого голоса занята другим разговором (25.09.2026) — это не
    // «номер не отвечает» и не повод поднимать тревогу о вписанном руками
    // номере. Пробуем на следующем часовом проходе, попытку не тратим.
    await releaseClaim();
    return "busy";
  }
  if (!result.ok || !result.channelId) {
    /**
     * ОТКАЗ СТАНЦИИ — НЕ ПРИГОВОР НОМЕРУ (02.10.2026, аудит фона №3). Раньше любой
     * отказ набора закрывал проверку как GIVEN_UP + deadNumber и поднимал
     * директору «номер вписан вручную… Объект вёл <агент>»: станция моргнула на
     * пять секунд — и агент ложно обвинён. Номер, который набрать нельзя,
     * отсеян выше; здесь остаются причины на стороне станции и настроек
     * (телефония не настроена, живой голос выключили, Asterisk не ответил, 5xx,
     * на этот номер уже идёт звонок). Запись ждёт следующей попытки: попытка не
     * тратится, «мёртвым» номер не становится, тревоги нет. Мёртвым его делает
     * только finishSellerProbeCall — две попытки без разговора.
     */
    void logSystemError(
      "telephony",
      `Проверка продавца: станция не приняла набор (проверка ${probe.id}): ${result.error ?? "без причины"}`,
      { dedupKey: "seller-probe-originate" }
    );
    await releaseClaim(alignToCallHours(new Date(now.getTime() + SELLER_PROBE_STATION_RETRY_MS), null));
    return "station_failed";
  }

  await prisma.sellerProbeCall.update({
    where: { id },
    data: { status: "CALLING", channelId: result.channelId, lastAttemptAt: now, attempts: { increment: 1 } },
  });
  return "started";
}

/** Разговор кончился — записать исход и, если нужно, поднять руководителя. */
export async function finishSellerProbeCall(result: LiveVoiceScenarioResult, now: Date = new Date()): Promise<void> {
  const probe = await prisma.sellerProbeCall.findFirst({
    where: { channelId: result.channelId },
    orderBy: { lastAttemptAt: "desc" },
    select: { id: true, attempts: true, skipReason: true, status: true },
  });
  if (!probe) return;
  // Итог принимается только у звонка, который ещё идёт (третий аудит 02.10.2026, С6):
  // повторный или задержанный итог по тому же каналу не должен перезаписывать строку.
  if (probe.status !== "CALLING") return;

  // Человек снял трубку, но разговора не вышло по НАШЕЙ вине: немая линия
  // (сторож NO_STATION_AUDIO_MS в мосте), упавшая модель, выкат. Его молчание —
  // не ответ и не «мёртвый номер» (аудит №3, №4). Исключение — сбой ПОСЛЕ состоявшегося
  // разговора (С2): слова собственника разбираются, а не выбрасываются.
  if (isOurSideCallFailure(result.reason) && !hasSubstantialClientSpeech(result.transcript)) {
    await handleSellerProbeOurSideFailure(probe, now);
    return;
  }

  // Автоответчик оператора модель не всегда называет сама (end_call(voicemail)): его
  // выдают реплики «клиента» вроде «абонент недоступен, оставьте сообщение».
  const kind = scenarioEndKind(result.reason) ?? (looksLikeVoicemail(clientLinesOf(result.transcript)) ? "voicemail" : null);

  // Трубку взял не собственник: о квартире с ним не говорили, повторяем.
  // Номер при этом живой (аудит №6, №12).
  if (kind === "wrong_person") {
    logSystemAudit("seller_probe_call_wrong_person", "SellerProbeCall", probe.id, { attempts: probe.attempts });
    await markSellerProbeNoAnswer(probe, now, ["line_alive", "wrong_person"]);
    return;
  }
  // Автоответчик и «перезвоните позже» — трубку сняли, номер живой.
  if (kind === "voicemail" || kind === "call_back_later") {
    await markSellerProbeNoAnswer(probe, now, ["line_alive"]);
    return;
  }
  if (!result.clientSpoke) {
    // Ответила станция, а человек не сказал ни слова, — или трубку не сняли
    // вовсе (reason "no_answer"). Живым номер считаем только по первому.
    await markSellerProbeNoAnswer(probe, now, result.reason === "no_answer" ? [] : ["line_alive"]);
    return;
  }

  const parsed = await parseSellerProbeCall(result.transcript);
  await prisma.sellerProbeCall.update({
    where: { id: probe.id },
    data: {
      status: "DONE",
      talkedAt: now,
      outcome: parsed?.outcome ?? "UNCLEAR",
      quote: parsed?.quote ?? null,
      summary: parsed?.summary ?? null,
    },
  });

  await routeSellerProbeOutcome(probe.id, parsed?.unconfirmedOutcome ?? null);
}

/**
 * КУДА УХОДИТ ОТВЕТ СОБСТВЕННИКА.
 *
 * «Ещё в продаже» — подозрение слабеет, круг закрыт, никого не беспокоим.
 * «Передумал» — обычное объяснение снятия объекта, тоже не тревога.
 * «Уже продал» — вот теперь владельцу, и это ЕДИНСТВЕННЫЙ исход, который его
 * поднимает. Даже он предъявляется как картина, а не как приговор: собственник
 * мог продать сам, и агент может быть ни при чём — поэтому в сигнале стоят
 * дословная фраза продавца и признаки, по которым мы вообще позвонили.
 *
 * Своей ветки эскалации здесь нет НАМЕРЕННО: «продан в обход агентства» в CRM
 * уже описан — `applySellerRefusal` с причиной SOLD_ELSEWHERE включает проверку
 * СБ на карточке. Разница только в том, что раньше эту причину выбирал агент
 * руками, а теперь её может предъявить система. Само переключение объекта делает
 * человек, решением по заявке: система не снимает объект с продажи по
 * телефонному разговору с роботом.
 *
 * ОБЕЩАНИЕ «СНИМЕМ С РЕКЛАМЫ» ИСПОЛНЯЕТ ЧЕЛОВЕК (02.10.2026, аудит №21). Робот
 * говорит собственнику «поняла, снимем с рекламы» на «продал» и на «передумал»
 * (sellerProbeCallPersona.ts) — а снимать было некому: при «передумал» писался
 * только аудит. Теперь и «передумал» доходит до руководителя — не тревогой
 * (это обычное снятие объекта), а делом «снимите объект с рекламы»; у «продал»
 * то же дело дописано в аларм.
 */
async function routeSellerProbeOutcome(
  id: string,
  unconfirmedOutcome: SellerProbeCallOutcome | null = null
): Promise<void> {
  const probe = await prisma.sellerProbeCall.findUnique({
    where: { id },
    select: {
      id: true,
      sellerClientId: true, propertyId: true, createdAt: true, talkedAt: true, channelId: true,
      outcome: true,
      quote: true,
      summary: true,
      signals: true,
      agentId: true,
      agent: { select: { fullName: true } },
      seller: { select: { fullName: true, shortId: true } },
      property: { select: { title: true } },
    },
  });
  if (!probe) return;

  if (unconfirmedOutcome || probe.outcome === "SOLD_ELSEWHERE") {
    await recordInvestigationSignal({ clientId: probe.sellerClientId, propertyId: probe.propertyId,
      subjectAgentId: probe.agentId, assignmentAt: probe.createdAt, sourceType: "seller-probe-call", sourceId: probe.id,
      independenceKey: `call:${probe.channelId ?? probe.id}`, kind: "outcome", occurredAt: probe.talkedAt ?? probe.createdAt,
      summary: unconfirmedOutcome ? "Предположение модели не подтверждено цитатой. Нужна проверка записи, нарушение не установлено."
        : `${probe.summary ?? "Собственник сообщил о продаже"}${probe.quote ? ` Цитата: ${probe.quote}` : ""}`,
      payload: { outcome: probe.outcome, unconfirmedOutcome, channelId: probe.channelId },
    });
  }

  logSystemAudit("seller_probe_call_outcome", "SellerProbeCall", probe.id, {
    outcome: probe.outcome,
    signals: probe.signals,
    agentId: probe.agentId,
    summary: probe.summary,
  });

  // Тревожный исход назван уверенно, а цитата по расшифровке не подтвердилась (третий аудит
  // 02.10.2026, В1): аларма нет, но директору уходит дело «проверьте звонок». Цитата модели
  // здесь не приводится — она не подтверждена.
  if (unconfirmedOutcome) {
    await enqueueDirectorAlert({
      title: "Проверка собственника: проверьте звонок",
      body:
        `«${probe.property.title}»: по разговору с ${probe.seller.fullName} возможно, что ` +
        `${unconfirmedOutcome === "SOLD_ELSEWHERE" ? "квартира уже продана" : "собственник передумал продавать"}, ` +
        `но слов собственника для подтверждения в расшифровке не нашлось. Это не вывод, а просьба ` +
        `послушать запись и решить по объекту.`,
      url: `/clients/${probe.seller.shortId}`,
      tag: `seller-probe-review-${probe.id}`,
      level: "APPROVAL",
      recipientRoles: ["ADMIN", "DIRECTOR"],
      excludeAgentId: probe.agentId,
    });
    return;
  }

  if (probe.outcome === "OWNER_CHANGED_MIND") {
    await enqueueDirectorAlert({
      title: "Собственник передумал продавать",
      body:
        `«${probe.property.title}»: ${probe.seller.fullName} сказал роботу, что передумал продавать. ` +
        `Робот ответил, что объект снимут с рекламы, — снимите его с рекламы или уточните у собственника.` +
        `${probe.quote ? ` Дословно: «${probe.quote}»` : ""}`,
      url: `/clients/${probe.seller.shortId}`,
      tag: `seller-probe-changed-mind-${probe.id}`,
      level: "APPROVAL",
      recipientRoles: ["ADMIN", "DIRECTOR"],
      excludeAgentId: probe.agentId,
    });
    return;
  }

  if (probe.outcome !== "SOLD_ELSEWHERE") return;

  await enqueueDirectorAlert({
    title: "🚩 Собственник говорит, что уже продал",
    body:
      `«${probe.property.title}»: ${probe.seller.fullName} сказал, что квартира продана, а сделки в CRM нет. ` +
      `Показ вёл ${probe.agent.fullName}.` +
      `${probe.quote ? ` Дословно: «${probe.quote}»` : ""}` +
      ` Почему позвонили: ${probe.signals.length} совпавших признака.` +
      ` Робот ответил собственнику, что объект снимут с рекламы, — решите по объекту.`,
    url: `/clients/${probe.seller.shortId}`,
    tag: `seller-probe-${probe.id}`,
    recipientRoles: ["ADMIN", "DIRECTOR"],
    excludeAgentId: probe.agentId,
  });
}

/**
 * НОМЕР НЕ ОТВЕЧАЕТ, А КАРТОЧКУ ЗАВОДИЛ АГЕНТ ВРУЧНУЮ — сигнал владельцу
 * (его правило от 12.09.2026, уточнённое 16.09).
 *
 * Условие узкое НАМЕРЕННО. Номер, пришедший с входящего звонка или из
 * мессенджера, подделать нельзя — он проверен самим фактом связи, и молчание
 * такого номера не значит ничего: у человека сел телефон. Номер, вписанный
 * агентом руками после встречи вне системы, не проверял никто: он может быть
 * ошибочным, а может быть вписан неверно нарочно — чтобы проверить работу
 * агента было нечем.
 */
async function raiseDeadNumberAlertIfManualCard(id: string): Promise<void> {
  const probe = await prisma.sellerProbeCall.findUnique({
    where: { id },
    select: {
      id: true,
      agentId: true,
      agent: { select: { fullName: true } },
      seller: { select: { fullName: true, shortId: true, source: true } },
      property: { select: { title: true } },
    },
  });
  if (!probe) return;
  if (probe.seller.source !== "WALK_IN") return;

  await enqueueDirectorAlert({
    title: "🚩 До собственника не дозвониться, а номер вписан вручную",
    body:
      `«${probe.property.title}»: ${probe.seller.fullName} не отвечает ни на одну попытку — номер выключен, ` +
      `недоступен или неверен. Карточку заводил сотрудник руками, номер не проверен ничем. ` +
      `Объект вёл ${probe.agent.fullName}.`,
    url: `/clients/${probe.seller.shortId}`,
    tag: `seller-probe-dead-${probe.id}`,
    recipientRoles: ["ADMIN", "DIRECTOR"],
    excludeAgentId: probe.agentId,
  });
}

function firstName(fullName: string | null): string | null {
  if (!fullName) return null;
  const first = fullName.trim().split(/\s+/)[0];
  return first && first.length > 1 ? first : null;
}
