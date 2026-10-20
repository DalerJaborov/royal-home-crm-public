/**
 * Штраф за длительное бездействие — ПОСЛЕ предупреждения, а не вместо него.
 *
 * Последний пункт Fair Play из спецификации. В прошлый заход он сознательно не был
 * сделан: штрафовать за то, о чём человека не предупредили, — это не Fair Play, а
 * ровно то, от чего Fair Play должен защищать. Значит сначала предупреждение.
 *
 * ДВА ШАГА, И ОБА ВИДНЫ АГЕНТУ.
 * 1. Клиент принят, но по нему нет ни одной записи дольше положенного — приходит
 *    предупреждение и запись в журнале Royal Score с нулевой ценой. Ноль не
 *    случайность: это ещё не наказание, это «мы заметили».
 * 2. Прошёл второй срок, записи по-прежнему нет — тогда штраф, и в журнале видно,
 *    что ему предшествовало предупреждение.
 *
 * PUSH «КЛИЕНТ БЕЗ ДВИЖЕНИЯ» УБРАН (владелец 20.09.2026: «Клиент без движения
 * удалить»). Оба шага выше остаются как были — предупреждение и штраф
 * записываются в журнал Royal Score, порядок «сначала предупреждение» не
 * нарушен, — но телефон агента по этому поводу больше не звонит: карточки без
 * движения он и так видит списком на главной, а вибрация про них приходила по
 * каждому клиенту отдельно и каждую ночь.
 *
 * ЧТО СЧИТАЕТСЯ ДЕЙСТВИЕМ: любая запись в хронологии клиента. Не «открыл карточку»
 * — открыть можно случайно, и мерить работу открытиями значит поощрять открытия.
 *
 * ПОЧЕМУ ОБА СРОКА В НАСТРОЙКАХ. Владелец правит любое число сам, и особенно это
 * число: слишком короткий срок превратит штрафы в фон, слишком длинный — в
 * бесполезную формальность, и подобрать его можно только на живой работе.
 */

import { prisma } from "../db.js";
import { loadEventPoints, recordScoreEvent } from "./scoreJournal.js";

const FALLBACK = { warnAfterDays: 3, penaltyAfterDays: 5, penaltyPoints: 5 };

export interface InactivityRules {
  warnAfterDays: number;
  penaltyAfterDays: number;
  penaltyPoints: number;
}

export async function loadInactivityRules(): Promise<InactivityRules> {
  try {
    const s = await prisma.settings.findUnique({
      where: { id: "singleton" },
      select: {
        inactivityWarnAfterDays: true,
        inactivityPenaltyAfterDays: true,
        inactivityPenaltyPoints: true,
      },
    });
    return {
      warnAfterDays: s?.inactivityWarnAfterDays ?? FALLBACK.warnAfterDays,
      penaltyAfterDays: s?.inactivityPenaltyAfterDays ?? FALLBACK.penaltyAfterDays,
      penaltyPoints: s?.inactivityPenaltyPoints ?? FALLBACK.penaltyPoints,
    };
  } catch {
    return { ...FALLBACK };
  }
}

export interface InactivityRun {
  warned: number;
  penalized: number;
}

/**
 * Один проход: предупредить тех, кто молчит, и оштрафовать тех, кого уже
 * предупреждали.
 *
 * Идёт по клиентам, а не по агентам: бездействие — это про конкретную брошенную
 * карточку, и «агент вообще работал сегодня» её не оправдывает. Записи в журнале
 * идут с sourceId клиента, поэтому повторный проход не начислит второй штраф за
 * ту же карточку — защита от двойного начисления та же, что у сделок.
 */
export async function runInactivityCheck(now = new Date()): Promise<InactivityRun> {
  const rules = await loadInactivityRules();
  // Цена строки штрафа — из каталога баллов, по которой его и считает счёт
  // (scoreEventPoints в scoreJournal.ts). Цена из «Дисциплины»
  // (Settings.inactivityPenaltyPoints) на счёт не влияла никогда, и агент видел
  // в журнале «−5», а счёт падал на 3 (глубокая проверка 02.10.2026, C11).
  // Решение владельца 02.10 «да, по советам»: главная — таблица баллов, поле
  // в «Дисциплине» убрано с экрана (в базе осталось, ни на что не влияет).
  const penaltyDelta = (await loadEventPoints()).inactivity_penalty;
  const result: InactivityRun = { warned: 0, penalized: 0 };

  const warnCutoff = new Date(now.getTime() - rules.warnAfterDays * 86400_000);
  const penaltyCutoff = new Date(now.getTime() - rules.penaltyAfterDays * 86400_000);

  const clients = await prisma.client.findMany({
    where: {
      deletedAt: null,
      assignedAgentId: { not: null },
      acceptedAt: { not: null, lte: warnCutoff },
      // Только те, кто ещё в работе: закрытых, потерянных и архивных трогать незачем.
      status: { in: ["NEW", "CONTACTED", "HOT"] },
    },
    select: {
      id: true,
      shortId: true,
      fullName: true,
      assignedAgentId: true,
      acceptedAt: true,
      interactions: {
        orderBy: { createdAt: "desc" },
        take: 1,
        select: { createdAt: true },
      },
    },
    /**
     * ПОРЯДОК ОБЯЗАТЕЛЕН, иначе очередь не разбирается, а голодает.
     *
     * Потолок был, а сортировки не было — Postgres отдаёт двести записей в
     * произвольном порядке, и ничто не выводит клиента из выборки после обработки:
     * условия те же самые и завтра. Обещание в комментарии «разберётся за несколько
     * ночей» не выполнялось: при 250 заброшенных карточках каждую ночь перебирались
     * примерно одни и те же двести (их события молча гасились уникальным ключом в
     * журнале), а оставшиеся полсотни не получали ни предупреждения, ни штрафа
     * НИКОГДА.
     *
     * Сортировка по дате принятия ставит в голову самых старых — тех, кто брошен
     * дольше всех. Они получают своё и уходят из выборки: предупреждённый переходит
     * к штрафу, оштрафованный больше ни на что не влияет, а очередь двигается.
     */
    orderBy: { acceptedAt: "asc" },
    take: 200,
  });

  for (const client of clients) {
    // Отсчёт идёт от последнего ДЕЙСТВИЯ, а если его не было — от принятия лида.
    const lastTouch = client.interactions[0]?.createdAt ?? client.acceptedAt!;
    const agentId = client.assignedAgentId!;

    if (lastTouch <= penaltyCutoff) {
      // Карточка могла обогнать оба срока ещё до того, как это правило вообще
      // появилось (старый лид, ни разу не тронутый) — тогда предупреждения в журнале
      // нет, а штрафовать без него нельзя: ровно от этого правило и защищает. Первый
      // проход по такой карточке только предупреждает, штраф придёт следующей ночью,
      // когда предупреждение уже будет записано.
      // Предупреждали ли ИМЕННО ЭТОГО агента. Раньше искали по (kind, sourceId) без
      // агента, и предупреждение, выданное прежнему хозяину карточки, засчитывалось
      // новому: тот получал штраф первой же ночью, не увидев ни одного предупреждения
      // (аудит 09.08.2026). Порядок «сначала предупреждение, потом штраф» обязан
      // проходить заново для каждого, с кого спрашивают.
      const alreadyWarned = await prisma.royalScoreEvent.findUnique({
        where: {
          kind_sourceId_agentId: { kind: "inactivity_warning", sourceId: client.id, agentId },
        },
        select: { id: true },
      });
      if (!alreadyWarned) {
        recordScoreEvent({
          agentId,
          kind: "inactivity_warning",
          delta: 0,
          reason: `Предупреждение: по клиенту №${client.shortId} (${client.fullName}) нет записей дольше ${rules.warnAfterDays} дн.`,
          sourceId: client.id,
        });
        result.warned++;
        continue;
      }

      recordScoreEvent({
        agentId,
        kind: "inactivity_penalty",
        delta: penaltyDelta,
        reason: `Клиент №${client.shortId} (${client.fullName}) без единой записи дольше ${rules.penaltyAfterDays} дн. после предупреждения`,
        sourceId: client.id,
      });
      result.penalized++;
      continue;
    }

    if (lastTouch <= warnCutoff) {
      // Цена ноль: это ещё не наказание, а «мы заметили». Запись в журнале нужна,
      // чтобы позже было видно — штрафу предшествовало предупреждение.
      recordScoreEvent({
        agentId,
        kind: "inactivity_warning",
        delta: 0,
        reason: `Предупреждение: по клиенту №${client.shortId} (${client.fullName}) нет записей ${rules.warnAfterDays} дн.`,
        sourceId: client.id,
      });
      result.warned++;
    }
  }

  return result;
}
