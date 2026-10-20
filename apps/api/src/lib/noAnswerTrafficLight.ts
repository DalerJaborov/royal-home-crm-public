import { prisma } from "../db.js";
import { deactivateClient, hasNewerContactSince } from "./clientWorkStatus.js";
import { logSystemError } from "./systemError.js";

/**
 * АВТОПЕРЕВОД «3 НЕДОЗВОНА ПОДРЯД» В СВЕТОФОР (план
 * docs/audit-02-09-2026/19-plan-03-09-evening.md, раздел C, 03.09.2026 вечер).
 *
 * До этой правки входа в светофор неактивных без действия человека не было вовсе —
 * ни один автоматический источник не переводил клиента в workStatus=INACTIVE по
 * одним недозвонам. Три подряд неудачных дозвона через CRM без единого разговора
 * между ними технически УЖЕ означают «ни разу не дозвонились» — ровно то, что
 * classifyInactiveLevelByDepth (lib/inactiveTrafficLight.ts) само же и посчитало
 * бы RED, доберись клиент до светофора любым другим путём. Здесь просто
 * открывается вход.
 *
 * ПОЧЕМУ callAttempt, А НЕ outcome. В этом репозитории УЖЕ есть два счётчика серии
 * недозвонов, и оба считают по-другому:
 *  - lib/clientAutoStatus.ts::collectFacts/collectFactsForSeller — по
 *    Interaction.outcome, двигает косметический ClientStatus.UNRESPONSIVE
 *    («статус-надпись» в карточке, не трогает workStatus и лимит активных
 *    лидов); с 15.09.2026 этот путь открыт и для продавца (раньше движок был
 *    buyer-only, и до продавца эта надпись вообще не доезжала) — светофора
 *    ниже это по-прежнему не касается, он на workStatus не завязан ни у кого;
 *  - lib/noAnswerStreak.ts::countTrailingNoAnswer — тоже по outcome, двигает темп
 *    автоперезвонов и эскалацию руководителю (noAnswerMaxAttempts, отдельная
 *    настройка, по умолчанию тоже 3, но владелец может сделать её и 5, и 10).
 * Ни один из них не годится как есть для входа в СВЕТОФОР: первый ничего не решает
 * про workStatus/лимит, второй завязан на настраиваемый порог эскалации, который
 * может разойтись с «3» из этого раздела. gate canDeactivateWithReason
 * (lib/inactiveTrafficLight.ts) и сам светофор считают попытки строго по
 * `callAttempt` (машиночитаемое поле, которое проставляет ТОЛЬКО CRM-телефония,
 * см. схему) — здесь используется тот же признак, чтобы «недозвон» в контексте
 * светофора значил ровно то же самое, что и everywhere else в этом механизме.
 * Отдельная копия счётчика — тот же приём, что уже применён в noAnswerStreak.ts
 * относительно clientAutoStatus.ts (см. комментарий там): три параллельных
 * счётчика с разными полями и разным назначением, а не один спутанный.
 *
 * ПОЧЕМУ ПРИЧИНА "OTHER", А НЕ "STOPPED_RESPONDING". Решение принято самостоятельно
 * (задание владельца оставило выбор на усмотрение агента, реализующего раздел C).
 * STOPPED_RESPONDING в этом кодовой базе уже занята другим, узким смыслом —
 * ai/callAnalysis.ts прямым текстом объясняет, что она «описывает ровно
 * противоположное — молчание в переписке», и lib/silentClientAutoDeactivate.ts
 * применяет её ИМЕННО к клиенту, который перестал отвечать боту. Недозвон — другое
 * по природе событие: клиент не молчит в переписке, он не берёт трубку, что для
 * CRM с телефонией — отдельный, самостоятельный сигнал. Переиспользовать
 * STOPPED_RESPONDING значило бы смешать два разных факта под одной причиной и
 * сломать точность будущей аналитики «почему клиенты уходят в неактив». OTHER —
 * ровно тот раздел, для которого в схеме и предусмотрен комментарий в самой
 * Interaction (см. comment ниже), а универсальность и не должна быть точнее, чем
 * сам факт «дозвониться не смогли ни разу».
 */
const STREAK_THRESHOLD = 3;

/**
 * НЕ ГЛУШИТЬ КЛИЕНТА, ЖИВОГО В ПЕРЕПИСКЕ, ТРЕМЯ НЕДОЗВОНАМИ (владелец 18.09.2026,
 * разбор «что если номер неправильный или не отвечает»: «сделай логичным, без
 * таких ошибок»).
 *
 * Счётчик ниже смотрит ТОЛЬКО на звонки — он физически не видит, что человек
 * прямо сейчас переписывается в WhatsApp/Instagram/Telegram, просто не любит
 * звонки. Без этой проверки светофор молча уводил бы в Неактивные (со всеми
 * последствиями: слот в лимите освобождается, карточка выпадает из портфеля)
 * клиента, который на самом деле на связи — «не отвечает по телефону» и
 * «неактивен» это разные вопросы, и текущий гейт (`canDeactivateWithReason`,
 * lib/inactiveTrafficLight.ts) от этого не защищает: он требует хотя бы
 * несколько ПОПЫТОК связаться когда-либо, а не отсутствие ответа ПРЯМО СЕЙЧАС —
 * три недозвона сами по себе уже проходят этот порог.
 *
 * Порог короче COLD_AFTER_DAYS (clientAutoStatus.ts, 7 дней остывания лида
 * целиком) НАРОЧНО: там вопрос «остыл ли лид вообще», здесь — «жив ли клиент
 * прямо сейчас», и для него хватает куда более свежего признака.
 *
 * Защита продавца с объектом в работе (lib/sellerCardState.ts::
 * sellersWithPropertyInWork) живёт глубже, в самом deactivateClient, и работает
 * независимо от этой проверки: покупатель, живой в чате, отсекается здесь,
 * продавец с объектом — там.
 */
const RECENT_MESSAGE_GRACE_DAYS = 3;
const RECENT_MESSAGE_GRACE_MS = RECENT_MESSAGE_GRACE_DAYS * 24 * 60 * 60 * 1000;

/**
 * Проверяет, не сложилась ли у клиента серия из STREAK_THRESHOLD подряд недозвонов
 * через CRM (callAttempt=NO_ANSWER, без единого TALKED между ними — иначе более
 * свежий TALKED попал бы в выборку и streak не набрался бы). При совпадении —
 * тот же путь, что и у ручного перевода/ИИ-разбора звонка: deactivateClient со
 * своим гейтом «след работы» и светофором.
 *
 * Вызывать ПОСЛЕ того, как текущий недозвон уже записан в Interaction (см.
 * lib/telephony/callTracker.ts::finishCall) — иначе последняя попытка ещё не
 * попадёт в выборку и серия посчитается на одну попытку меньше.
 *
 * Не бросает наружу — вызывается фоново (void) из обработчика событий АТС, который
 * не должен стоять из-за этой проверки.
 */
export async function checkNoAnswerStreakForTrafficLight(clientId: string, now: Date = new Date()): Promise<void> {
  try {
    const client = await prisma.client.findFirst({
      where: { id: clientId, deletedAt: null, kind: { not: "OTHER" } },
      select: { id: true, workStatus: true, assignedAgentId: true, lastClientMessageAt: true },
    });
    // Уже неактивен (в т.ч. этим же механизмом на прошлом недозвоне), потерян, в
    // архиве или без агента — переводить повторно не нужно и некому (план,
    // раздел C: «убедись, что этот механизм не переводит клиента ПОВТОРНО»).
    if (!client || client.workStatus !== "ACTIVE" || !client.assignedAgentId) return;

    // Клиент писал сам недавно — на телефон обижаться рано, он на связи другим
    // каналом. Недозвоны остаются в хронологии как есть, светофор просто не
    // трогает workStatus, пока эта переписка свежая.
    if (client.lastClientMessageAt && now.getTime() - client.lastClientMessageAt.getTime() < RECENT_MESSAGE_GRACE_MS) {
      return;
    }

    const recent = await prisma.interaction.findMany({
      where: { clientId: client.id, type: "CALL", callAttempt: { in: ["TALKED", "NO_ANSWER"] } },
      orderBy: { createdAt: "desc" },
      take: STREAK_THRESHOLD,
      select: { callAttempt: true, createdAt: true },
    });
    if (recent.length < STREAK_THRESHOLD) return;
    if (recent.some((r) => r.callAttempt !== "NO_ANSWER")) return; // TALKED затесался в тройку — серия сброшена
    // A manual call, held meeting, incoming message or return also breaks a
    // telephone-only streak. Never apply old attempts to a new work cycle.
    if (await hasNewerContactSince(client.id, recent[recent.length - 1].createdAt)) return;

    const result = await deactivateClient({
      clientId: client.id,
      expectedAgentId: client.assignedAgentId,
      evidenceAt: recent[0].createdAt,
      // П-10: серию недозвонов замечает автоматика, не человек и не ИИ-разбор.
      actor: { kind: "system", source: "no-answer-traffic-light", subjectAgentId: client.assignedAgentId },
      reason: "OTHER",
      initiator: "CLIENT",
      actualNeeds: `${STREAK_THRESHOLD} звонка подряд через CRM без ответа — клиент ни разу не взял трубку.`,
      comment:
        "Переведено автоматически: подряд недозвонов через CRM-телефонию без единого разговора между " +
        "ними (раздел C, docs/audit-02-09-2026/19-plan-03-09-evening.md).",
    });
    if (!result.ok) {
      /**
       * Гейт canDeactivateWithReason для OTHER требует полного inactivateMinAttempts
       * (по умолчанию 2) — при трёх зафиксированных недозвонах он почти всегда
       * пройдёт; отказ здесь означает что-то нетипичное (например, порог подняли
       * в Настройках выше 3). Законный отказ, не поломка — тихо логируем и не падаем.
       */
      console.log(
        `[светофор] авто-перевод по недозвонам не пройден гейтом (клиент ${client.id}): ${result.reason ?? "нет причины"}`
      );
    }
  } catch (err) {
    await logSystemError(
      "telephony",
      `Авто-перевод в Неактивные по ${STREAK_THRESHOLD} недозвонам подряд (клиент ${clientId}): ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }
}
