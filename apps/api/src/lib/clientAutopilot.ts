import { prisma } from "../db.js";
import type { Prisma } from "../generated/prisma/client.js";
import { buildCardFillSuggestion } from "../ai/cardFill.js";
import { scoreClient, SCORABLE_CLIENT_STATUSES } from "../ai/scoring.js";
import { describeError } from "./describeError.js";
import { fromTjs, loadMoneyContext } from "./money.js";
import { isPlaceholderName } from "./placeholderName.js";
import { logSystemAudit } from "./audit.js";
import { logSystemError } from "./systemError.js";

/**
 * Карточка клиента заполняется и оценивается САМА.
 *
 * Решение владельца 01.08.2026, дословно: «пусть всё будет на автомате и меньше
 * кнопок в карточке клиента, чтобы люди не тратили много времени». До этого и
 * заполнение карточки, и оценка клиента жили на кнопках «Заполнить карточку» и
 * «Оценить (ИИ)». Кнопка означает ровно одно: действие происходит, только если
 * агент про него вспомнит, — то есть почти никогда. В карточке, заведённой ботом
 * этим утром, бюджет и район были известны из переписки с первой минуты, а
 * оценка не появилась вовсе.
 *
 * ЧЕГО ЗДЕСЬ НЕТ И ПОЧЕМУ: перезаписи. Автозаполнение трогает ТОЛЬКО пустые поля.
 * Агент, поправивший бюджет руками после звонка, знает о клиенте больше, чем
 * модель, читающая переписку, — и его правка не должна исчезать оттого, что
 * ночью что-то пересчиталось. Это же делает функцию безопасной для повторного
 * запуска: сколько раз ни вызови, заполненное не изменится.
 *
 * Расход на ИИ владельцем принят осознанно: «везде можно автоматический скоринг
 * делать, ничего страшного если мы платим». Поэтому дешёвых оговорок вроде «раз в
 * сутки на клиента» здесь нет — есть только защита от бессмысленной работы
 * (см. shouldRun ниже).
 */

/** Статусы, в которых оценка ещё о чём-то говорит — общий список с ai/scoring.ts
 *  (см. doc-comment у SCORABLE_CLIENT_STATUSES там: раньше это был свой отдельный
 *  набор, разошедшийся с проверкой внутри scoreClient). Закрытую сделку и архив
 *  считать незачем. */
const SCORABLE = new Set<string>(SCORABLE_CLIENT_STATUSES);

/**
 * ТРОТТЛИНГ `client_message` (24.09.2026, разведка владельца: «Коротко от ИИ»
 * пересчитывался на КАЖДОЕ входящее сообщение клиента — messengers/conversation.ts
 * зовёт автопилот с этой причиной на каждую реплику). В живом диалоге клиент часто
 * шлёт 3-5 сообщений подряд («здравствуйте» / «ищу квартиру» / «в центре» /
 * «до 700») — каждое запускало отдельный платный вызов модели, хотя сводка
 * успевала устареть только с последним из них.
 *
 * Окно взято от последнего УСПЕШНОГО пересчёта (`aiInsightAt`, пишет scoring.ts),
 * не от последнего запуска автопилота: если модель промолчала (blockReason, сеть),
 * `aiInsightAt` не сдвигается, и следующее сообщение обязано попробовать снова, а
 * не ждать окно впустую.
 *
 * Только `client_message` — остальные причины (`lead_created`, `interaction_added`,
 * `agent_changed`, `deal_closed`, ручная кнопка `/api/ai/score/:clientId`, ночной
 * `scoreAllActiveClients`) редкие и каждая сигналит о разовом факте, который сводка
 * обязана отразить сразу же, а не через 20 минут.
 */
const CLIENT_MESSAGE_THROTTLE_MS = 20 * 60 * 1000;

/**
 * КАРТОЧКУ, КОТОРУЮ АГЕНТ ЕЩЁ НЕ ПРИНЯЛ, НЕ СКОРИМ (24.09.2026).
 *
 * `acceptedAt === null` — карточка лежит в очереди на приём, ей ещё может владеть
 * кто угодно (карусель «не принял — следующему», см. services/leads/intake.ts) или
 * не владеть никто. Три причины сюда не пускать ИИ-вызов:
 *
 *  - `client_message`/`interaction_added` бьют чаще всего именно по непринятым
 *    карточкам (бот продолжает разговор, пока агент не нажал «Принять») — платный
 *    вызов на карточку, которую могут ещё десять раз перекинуть другому агенту.
 *  - `lead_created` тоже сюда: проверено 24.09.2026 grep'ом по `aiScore` в
 *    `services/leads/*.ts` (assignment.ts, selection.ts, reassignment.ts,
 *    intake.ts, firstCall.ts, ownershipLoad.ts, ownershipPolicy.ts) — НИ ОДНО место,
 *    решающее, кому достанется лид, оценку не читает (очередь берёт KPI агента,
 *    `selection.ts::orderByKpiQueue`). `aiScore`/`aiInsight` читают только
 *    дашборды и сортировки ПОСЛЕ приёма (routes/ai.ts::insights, clients/list.ts
 *    sort=score_*, routes/team.ts, routes/oversight.ts, routes/security.ts) — им
 *    нечего показывать по карточке, которую агент ещё не открыл. Значит первая
 *    оценка ничего не теряет, если подождёт приёма: как только карточку примут,
 *    следующее сообщение клиента или запись взаимодействия её оценят (throttle
 *    выше это не блокирует — `aiInsightAt` у непринятой карточки ещё пуст).
 *  - `agent_changed`/`deal_closed`/ручная кнопка/ночной крон СЮДА НЕ ВХОДЯТ
 *    намеренно: это разовые факты (сменился владелец, сделка закрылась, человек
 *    сам нажал кнопку, крон обходит все активные карточки раз в сутки), а не поток
 *    сообщений по неразобранной заявке.
 */
const SKIP_WHEN_UNACCEPTED: ReadonlySet<AutopilotReason> = new Set(["client_message", "interaction_added", "lead_created"]);

/**
 * agent_changed — карточка сменила владельца (`lib/changeClientAgent.ts`, единый
 * вход для ЛЮБОГО переназначения: не дозвонился за 15 мин, ручная передача,
 * освобождение и т.п.) — найдено 18.09.2026: без этого «Коротко от ИИ» продолжало
 * называть прежнего агента, хотя карточку уже вёл другой человек.
 * deal_closed — сделка дошла до COMPLETED или CANCELLED (`routes/deals.ts`).
 */
export type AutopilotReason =
  | "lead_created"
  | "client_message"
  | "interaction_added"
  | "call_result_logged"
  | "agent_changed"
  | "deal_closed"
  /** Сделка заведена или сменила этап (29.09.2026, routes/deals.ts). */
  | "deal_changed";

export interface AutopilotResult {
  filled: string[];
  scored: boolean;
}

/**
 * Дозаполняет пустые поля карточки по переписке и пересчитывает оценку.
 *
 * Наружу не бросает НИЧЕГО: это фоновая работа поверх основного действия (приём
 * заявки, ответ клиенту, запись разговора), и уронить его она права не имеет.
 * Причина отказа уходит в журнал — молчаливый провал означал бы, что карточки
 * перестали заполняться, а на экране здоровья зелено.
 */
export async function runClientAutopilot(clientId: string, reason: AutopilotReason): Promise<AutopilotResult> {
  const result: AutopilotResult = { filled: [], scored: false };
  try {
    const client = await prisma.client.findUnique({
      where: { id: clientId },
      select: {
        id: true,
        status: true,
        deletedAt: true,
        acceptedAt: true,
        aiInsightAt: true,
        fullName: true,
        budgetMin: true,
        budgetMax: true,
        currency: true,
        address: true,
        desiredDistrictId: true,
        desiredRooms: true,
        desiredType: true,
        requirementsNotes: true,
      },
    });
    if (!client || client.deletedAt) return result;

    /**
     * ИМЯ ЕЩЁ ЗАПАСНОЕ — ОБЩИЙ ПРИЗНАК НА ВЕСЬ ПРОЕКТ (lib/placeholderName.ts).
     *
     * До 30.08.2026 здесь стояла своя регулярка `^(Покупатель|Продавец) №\d+$`, а в
     * разборе входящего звонка (lib/telephony/qualifyIncoming.ts) — своя, про
     * «Входящий ». Ни одна не знала про другую, и карточка со звонка («Входящий
     * ***67») считалась ИМЕНОВАННОЙ: имя из переписки в неё не попадало никогда, а
     * заодно — см. hasGaps ниже — не запускался и весь остальной разбор.
     */
    const nameIsPlaceholder = isPlaceholderName(client.fullName);

    // Заполнять нечего — не тратим вызов модели. Это единственная причина, по
    // которой разбор переписки может не запуститься.
    const hasGaps =
      /**
       * БЮДЖЕТ СЧИТАЕТСЯ ИЗВЕСТНЫМ ПО ВЕРХНЕЙ ГРАНИЦЕ (30.08.2026).
       *
       * `budgetMin` у большинства карточек пуст НАМЕРЕННО и навсегда: клиент почти
       * всегда называет одну сумму, и разбор кладёт её в потолок, а нижнюю границу
       * специально обнуляет (ai/cardFill.ts — иначе подбор превращается в фильтр
       * «ровно 700 000»). Пока пустой budgetMin считался дырой, дыра у такой карточки
       * не закрывалась НИКОГДА, и на каждое сообщение клиента уходил платный вызов
       * card-fill и скоринга — за данными, которых заведомо нет.
       *
       * «Спросили и не узнали» от «ещё не спрашивали» отличает именно budgetMax:
       * пустой — про деньги не говорили вовсе, заполненный — бюджет известен.
       */
      client.budgetMax === null ||
      client.desiredDistrictId === null ||
      client.desiredRooms === null ||
      client.desiredType === null ||
      !client.address ||
      !client.requirementsNotes ||
      nameIsPlaceholder;

    if (hasGaps) {
      const suggestion = await buildCardFillSuggestion(clientId);
      /**
       * СНИМОК ВЫШЕ УСТАРЕЛ (аудит Codex 04.10.2026, №5). Ответ модели ждали секунды,
       * и за это время агент мог вписать бюджет, переименовать клиента или сменить
       * валюту: условия «поле пусто» и «имя — заглушка», посчитанные по прежнему
       * снимку, перезаписали бы живую правку человека. Читаем те же поля заново и
       * решаем по свежим значениям; запись ниже — ещё и условная по этому значению.
       */
      const fresh = await prisma.client.findUnique({
        where: { id: clientId },
        select: {
          deletedAt: true,
          fullName: true,
          budgetMin: true,
          budgetMax: true,
          currency: true,
          address: true,
          desiredDistrictId: true,
          desiredRooms: true,
          desiredType: true,
          requirementsNotes: true,
        },
      });
      if (!fresh || fresh.deletedAt) return result;
      // Сумма предложения посчитана в сомони по прежней валюте карточки. Валюту сменили
      // за время ответа — пересчитывать «на глаз» нельзя, деньги в этот проход пропускаем.
      const currencyChanged = fresh.currency !== client.currency;
      /** Поле для записи и значение, которое мы в нём видели: пишем, только если оно не изменилось. */
      const writes: Array<{ field: string; value: unknown; expected: unknown }> = [];

      /**
       * ВАЛЮТА КАРТОЧКИ. Разбор переписки всегда отдаёт сомони — так написан промт
       * (ai/cardFill.ts: «суммы в долларах переводи по курсу»). Карточка же хранит
       * бюджет в СВОЕЙ валюте: агент мог переключить клиента на доллары (Client.currency,
       * форма клиента). Без пересчёта в такую карточку легло бы «700 000 долларов» —
       * бюджет в двенадцать раз больше настоящего, и подбор объектов ушёл бы в пустоту
       * ровно так же, как при пустом поле. Курс тот же, по которому считается подбор
       * (lib/money.ts), и читается он только когда действительно нужен.
       */
      const money = fresh.currency === "USD" ? await loadMoneyContext() : null;
      const inCardCurrency = (tjs: number) => (money ? Math.round(fromTjs(tjs, "USD", money)) : tjs);

      // Каждое поле — только если у нас пусто, а модели есть что предложить.
      if (!currencyChanged && fresh.budgetMin === null && suggestion.budgetMin !== null) {
        writes.push({ field: "budgetMin", value: inCardCurrency(suggestion.budgetMin), expected: null });
      }
      if (!currencyChanged && fresh.budgetMax === null && suggestion.budgetMax !== null) {
        writes.push({ field: "budgetMax", value: inCardCurrency(suggestion.budgetMax), expected: null });
      }
      // Адрес — это ориентир со слов клиента («напротив кинотеатра Зебунисо»). До
      // 13.08.2026 разбор его не доставал вовсе, и он доживал только до свободных
      // заметок, где его не читает ни агент глазами, ни один фильтр.
      if (!fresh.address && suggestion.address) writes.push({ field: "address", value: suggestion.address, expected: fresh.address });
      if (fresh.desiredDistrictId === null && suggestion.districtId) {
        writes.push({ field: "desiredDistrictId", value: suggestion.districtId, expected: null });
      }
      if (fresh.desiredRooms === null && suggestion.rooms !== null) writes.push({ field: "desiredRooms", value: suggestion.rooms, expected: null });
      if (fresh.desiredType === null && suggestion.type) writes.push({ field: "desiredType", value: suggestion.type, expected: null });
      if (!fresh.requirementsNotes && suggestion.notes) {
        writes.push({ field: "requirementsNotes", value: suggestion.notes, expected: fresh.requirementsNotes });
      }
      /**
       * ИМЯ: ПОВЕРХ ЗАГЛУШКИ — ВСЕГДА, ПОВЕРХ СВОЕЙ ЖЕ ПРЕЖНЕЙ ДОГАДКИ — ТОЖЕ,
       * ПОВЕРХ ЧЕЛОВЕКА — НИКОГДА.
       *
       * Имя, вписанное агентом руками, автозаполнение не трогает: он знает о клиенте
       * больше модели (это правило и есть смысл всей функции, см. шапку файла). Но
       * своё собственное прежнее предложение оно перезаписать обязано — иначе одна
       * неудачная догадка застревала бы в карточке навсегда, а именно так на проде и
       * появились имена вроде «Чихели кунум».
       *
       * Кто вписал текущее значение, видно из истории (AuditLog, действие
       * `client.autofill` ниже): своё мы записали сами и знаем ровно то, что записали.
       * Отдельного поля в схеме для этого не заводим — оно принадлежит соседней
       * задаче, а запрос сюда уходит только в редком случае «имя не заглушка, а модель
       * предлагает другое». Решается по СВЕЖЕМУ имени: переименованное во время ответа
       * модели уже не заглушка и не наша догадка.
       */
      if (suggestion.clientName && suggestion.clientName !== fresh.fullName) {
        const mayReplace = isPlaceholderName(fresh.fullName) || (await autopilotWroteName(clientId, fresh.fullName));
        // Заглушка вместо имени сюда не доходит (её отсекает normalizeClientName в
        // ai/cardFill.ts), но проверяем ещё раз: «Покупатель Покупатель №0042» в
        // карточке уже случалось — см. lib/telephony/whisperText.ts.
        if (mayReplace && !isPlaceholderName(suggestion.clientName)) {
          writes.push({ field: "fullName", value: suggestion.clientName, expected: fresh.fullName });
        }
      }

      if (writes.length > 0) {
        // Условная запись по каждому полю: окно гонки между повторным чтением выше и
        // записью сужается с секунд до миллисекунд, а правка человека в нём не
        // затирается (поле уже не равно тому, что мы видели, — строка не обновится).
        const claimed = await prisma.$transaction(
          writes.map((w) =>
            prisma.client.updateMany({
              where: { id: clientId, deletedAt: null, [w.field]: w.expected } as Prisma.ClientWhereInput,
              data: { [w.field]: w.value } as Prisma.ClientUpdateManyMutationInput,
            })
          )
        );
        const written = writes.filter((_, i) => claimed[i].count > 0);
        result.filled = written.map((w) => w.field);
        const writtenName = written.find((w) => w.field === "fullName")?.value;
        if (written.length > 0) {
          /**
           * СЛЕД В ИСТОРИИ: что именно вписал сюда ИИ. Нужен не для отчётности, а для
           * правила выше — «поле заполнил ИИ» и «поле заполнил человек» иначе неразличимы,
           * и защита от перезаписи чужой правки распространялась бы и на собственный
           * прошлый промах. Пишется через logSystemAudit (автор «Система»): запроса и
           * агента здесь нет — это фоновая работа.
           */
          logSystemAudit("client.autofill", "Client", clientId, {
            reason,
            fields: result.filled,
            ...(typeof writtenName === "string" ? { fullName: writtenName } : {}),
          });
        }
      }
    }

    // Оценка пересчитывается, когда клиент в работе: она зависит не от пустых
    // полей, а от того, что произошло с клиентом только что — с двумя
    // оговорками (непринятая карточка, троттлинг частых сообщений), см.
    // SKIP_WHEN_UNACCEPTED и CLIENT_MESSAGE_THROTTLE_MS выше.
    /**
     * НЕ ОБЪЕДИНЕНО С ОБНОВЛЕНИЕМ ПОЛЕЙ ВЫШЕ В ОДНУ `$transaction` — сознательно
     * (аудит атомарности 13.09.2026). Две причины, обе весомее самой атомарности:
     *
     *  1. `scoreClient` ходит в ИИ по сети (secunds, не миллисекунды) и лишь ПОТОМ
     *     пишет `aiScore` своим `prisma.client.update` (scoring.ts:260). Держать
     *     интерактивную `$transaction` открытой на всё время внешнего вызова —
     *     ровно то, что раздел «Таймауты» этого файла CLAUDE.md запрещает для
     *     внешних вызовов, и вдобавок Prisma по умолчанию рвёт интерактивную
     *     транзакцию по таймауту в 5с: обычный небыстрый ответ модели превращался
     *     бы в откат ДАЖЕ ТЕХ полей выше, с которыми всё было в порядке.
     *  2. Порядок «сначала поля, потом скоринг» не случаен: `scoreClient(clientId)`
     *     сам перечитывает карточку из базы и строит промт по СВЕЖИМ данным —
     *     обязан видеть уже записанный бюджет/район/etc, а не то, что было ДО
     *     автозаполнения. Общая транзакция для двух update ничего не решала бы:
     *     сам ИИ-вызов всё равно должен произойти МЕЖДУ ними, а не до обоих.
     *
     * Остаточный риск — низкий и не разрушает состояние: если процесс упадёт
     * между этими двумя update, поля карточки (шаг 1) уже атомарно записаны сами
     * по себе (один prisma.update = одна транзакция БД), а `aiScore` просто
     * останется прежним до следующего запуска автопилота или ночного
     * `scoreAllActiveClients` (scoring.ts) — функция идемпотентна по своей же
     * шапке выше, повторный запуск ничего не портит.
     */
    if (SCORABLE.has(client.status)) {
      // Непринятая карточка — см. SKIP_WHEN_UNACCEPTED выше: очередь лидов
      // aiScore не читает, а дашборды, которые читают, показываются только
      // после приёма.
      const unaccepted = !client.acceptedAt && SKIP_WHEN_UNACCEPTED.has(reason);
      // Троттлинг только для client_message — см. CLIENT_MESSAGE_THROTTLE_MS.
      const throttled =
        reason === "client_message" &&
        !!client.aiInsightAt &&
        Date.now() - client.aiInsightAt.getTime() < CLIENT_MESSAGE_THROTTLE_MS;

      if (!unaccepted && !throttled) {
        result.scored = (await scoreClient(clientId)) !== null;
      }
    }
  } catch (err) {
    void logSystemError("ai", `Автозаполнение карточки (${reason}) не сработало: ${describeError(err)}`);
  }
  return result;
}

/**
 * Текущее имя карточки вписал сам автопилот?
 *
 * Смотрим ПОСЛЕДНЮЮ запись автозаполнения с именем: если записанное тогда значение
 * совпадает с тем, что в карточке сейчас, значит после нас имя никто не правил, и
 * заменить свою же догадку мы вправе. Не совпало (или записи нет вовсе — карточка
 * старше этой правки) — считаем имя человеческим и не трогаем: цена ошибки здесь
 * несимметрична, затёртая правка агента хуже застрявшей догадки.
 */
async function autopilotWroteName(clientId: string, currentName: string): Promise<boolean> {
  try {
    // Ищем запись именно с ЭТИМ именем, а не последнюю вообще: следующие проходы
    // дописывают другие поля и своих записей об имени не содержат.
    const written = await prisma.auditLog.findFirst({
      where: {
        entityType: "Client",
        entityId: clientId,
        action: "client.autofill",
        meta: { path: ["fullName"], equals: currentName },
      },
      select: { id: true },
    });
    return !!written;
  } catch {
    // История — подсказка, а не условие работы: не прочиталась, значит имя чужое.
    return false;
  }
}

/**
 * То же самое, но без ожидания — для мест, где ход диалога или ответ API не должны
 * ждать модель. Отдельной функцией, а не `void runClientAutopilot(...)` в пяти
 * местах: так видно, что отказ здесь намеренно проглатывается, и его некому ловить.
 */
export function runClientAutopilotInBackground(clientId: string, reason: AutopilotReason): void {
  void runClientAutopilot(clientId, reason).catch(() => {
    /* причину уже записал runClientAutopilot */
  });
}
