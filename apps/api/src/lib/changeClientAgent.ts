/**
 * Единственная точка записи в `Client.assignedAgentId` (аудит владения
 * 11.09.2026, `docs/ownership-audit-11-09.md`, ТОП-10 дыра №1/№2 и
 * «предлагаемое правило»). До этой правки поле меняли из полутора десятков
 * мест россыпью — где-то писался Interaction, где-то нет (freeze — самый
 * заметный пример: `updateMany` без единой строки в истории карточки),
 * где-то `lastAgentId` терялся. Правило владельца («клиент не должен уйти
 * молча») выполняется, только если запись ровно одна и она ВСЕГДА пишет и
 * Interaction, и AuditLog.
 *
 * СТОРОЖ. `apps/api/tests/assigned-agent-single-writer.test.ts` грепает
 * `src` на прямые `assignedAgentId:` внутри `update(`/`updateMany(` вне
 * этого файла (и вне seed/tests) и падает при находке — новый обходной путь
 * не должен появиться незамеченным.
 *
 * КАК ПОЛЬЗОВАТЬСЯ. Вызывающий код может передать `tx` (если уже находится
 * внутри своей транзакции — большинство мест так и делают, потому что меняют
 * заодно другие поля клиента) или оставить пустым — тогда функция откроет
 * транзакцию сама. Любые сопутствующие поля (status, refusalCount,
 * escalatedAt и т.п.) идут через `data` — тем самым не нужно разбивать один
 * логический апдейт на два похода к базе.
 *
 * ЗАКОН О ВЛАДЕНИИ КЛИЕНТОМ (17.09.2026, `docs/law/lead-ownership.md`,
 * `services/leads/ownershipPolicy.ts`) — ЖЁСТКАЯ ИНТЕГРАЦИЯ ПРЯМО ЗДЕСЬ, а не
 * в каждом из полутора десятков механизмов по отдельности: раз это
 * единственная точка записи, это же единственное место, где закон гарантированно
 * не обойти НОВЫМ механизмом, который забудут спросить. `run()` проверяет
 * П-3 (принят + был контакт → автопередача запрещена, эскалация вместо неё) и
 * П-5 (источники-люди обязаны нести `actorId`) до самой записи — см. комментарии
 * у соответствующих блоков ниже. Три автоматических механизма этой пачки
 * (`reassignment.ts`, `firstCall.ts`) уже проверяют политику САМИ и передают
 * `policyVerdict`, чтобы не грузить снимок клиента дважды; остальные механизмы
 * (batch А2) её пока не спрашивают явно — но эта проверка всё равно ловит их,
 * раз она внутри самой записи, а не только там, где её явно позвали.
 */
import { prisma } from "../db.js";
import { closeOwnershipSatellites } from "./ownershipSatellites.js";
import { runClientAutopilotInBackground } from "./clientAutopilot.js";
import { canAutoTransfer, requireHumanActor, type AutoTransferVerdict } from "../services/leads/ownershipPolicy.js";
import { loadOwnershipSnapshot, escalateInsteadOfTransfer } from "../services/leads/ownershipLoad.js";
import { logSystemError } from "./systemError.js";
import { logTimeline } from "./timeline.js";
import { OWN_PROPERTY_ASSIGN_REASONS, propertyOwnerAgentId } from "./propertyOwner.js";
import { transferSellerPropertiesWithClient } from "./propertyHandover.js";

// `prisma` — расширенный клиент (`base.$extends(...)`, см. db.ts) — стандартный
// `Prisma.TransactionClient` с ним несовместим (тот же приём, что уже
// используют другие места с интерактивной транзакцией; см. комментарий в
// db.ts у `base.$extends`). Тип tx выводим прямо из сигнатуры `$transaction`
// самого расширенного клиента, а не из сгенерированного модуля.
export type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

export interface ChangeClientAgentInput {
  clientId: string;
  /** Новый владелец карточки; `null` — снять с агента (очередь руководителя). */
  toAgentId: string | null;
  /** Человекочитаемая причина — идёт в текст Interaction и в AuditLog.meta. */
  reason: string;
  /** Кто совершил действие. `null`/не передан — автоматика (крон, вебхук). */
  actorId?: string | null;
  /** Короткий машинный тег механизма (freeze, refuse, decline, lost.promote, ...) —
   *  для фильтрации AuditLog и текста Interaction `[source] reason`. */
  source: string;
  /** Дополнительные поля клиента, которые нужно записать тем же апдейтом
   *  (status, refusalCount, escalatedAt, assignedAt, acceptedAt, lostAt, ...).
   *  `assignedAgentId` сюда класть не нужно — он ставится из `toAgentId`. */
  data?: Record<string, unknown>;
  /**
   * По умолчанию функция сама подставляет `lastAgentId = предыдущий agentId`,
   * когда владелец реально меняется. Передайте `false`, если вызывающий код
   * сам решает, что делать с `lastAgentId` (например пишет его в `data` явно
   * даже без смены владельца — LOST, который не покидает портфель).
   */
  setLastAgentId?: boolean;
  /**
   * По умолчанию функция сама пишет Interaction (тип SYSTEM, текст
   * `[source] reason`). Передайте `true`, если вызывающий код уже пишет
   * содержательную Interaction по этому же событию (например «Без сделки» с
   * текстом причины отказа) — тогда системная запись стала бы дублем.
   */
  skipInteraction?: boolean;
  /**
   * Явный автор Interaction, если обычная цепочка (`actorId` → прежний владелец
   * → `lastAgentId` → дежурный директор) не подходит — например круговое
   * переназначение исторически пишет запись от лица НОВОГО агента («лид
   * переназначен вам»), а не старого, который его не принял.
   */
  interactionAgentId?: string | null;
  /**
   * Дополнительное условие WHERE поверх `id` — арбитр гонок (двойной клик по
   * «Отклонить», конкурентные проходы крона над одной карточкой). Апдейт идёт
   * как `updateMany({ where: { id, ...guardWhere } })`; если под условие не
   * попало ни одной строки (кто-то уже успел раньше), функция молча возвращает
   * `{ ok: false }` — ни Interaction, ни AuditLog не пишутся, вызывающий код
   * трактует это как «уже отработано» (ровно так вели себя прежние ручные
   * `updateMany`-арбитры в assignment.ts/reassignment.ts).
   */
  guardWhere?: Record<string, unknown>;
  /** Участвовать в чужой транзакции вместо открытия своей. */
  tx?: Tx;
  /**
   * УДАЛЁННЫЙ КЛИЕНТ (Корзина, `deletedAt != null`) НЕ МЕНЯЕТ ВЛАДЕЛЬЦА —
   * дефолт `false` (аудит владения 15.09.2026: раздача 30+ клиентов из
   * Корзины новому агенту прошла успешно и без единого предупреждения,
   * потому что запись не проверяла deletedAt вовсе). Функция читает
   * `deletedAt` в том же снимке, что и `assignedAgentId`, и отказывает ДО
   * записи — `{ ok: false, reason: "deleted" }`, ни Interaction, ни
   * AuditLog не пишутся. От гонки (клиент попал в Корзину между чтением и
   * записью) защищает то же условие, добавленное прямо в WHERE самого
   * апдейта (`guardWhere` и раньше был именно для таких гонок).
   *
   * Ставьте `true` только для явных легальных исключений, когда смена
   * владельца удалённого клиента — это ЧАСТЬ самого сценария:
   *  - восстановление из Корзины (`routes/clients/card.ts::/restore`) НЕ
   *    нуждается в этом флаге: `deletedAt` там уже снят в ТОЙ ЖЕ транзакции
   *    ДО вызова changeClientAgent, поэтому снимок читает его уже пустым;
   *  - раздача карточек уволенного агента (`lib/agentHandover.ts`) тоже не
   *    нуждается — исходная выборка целенаправленно берёт только активных
   *    клиентов, удалённые остаются висеть в Корзине и уйдут в неё же
   *    после увольнения, без хозяина;
   *  - других легальных путей на 15.09.2026 не найдено — если появится
   *    (например явная «переподписка Корзины» без восстановления), сюда
   *    добавляется случай и обоснование, а не выставляется `true` молча.
   */
  allowDeleted?: boolean;
  /**
   * Не гасить спутников (пуш/лента/требования/заявка на удаление/задачи/живое
   * событие) при смене владельца. По умолчанию `changeClientAgent` гасит их
   * ВСЕГДА, когда `toAgentId` реально отличается от прежнего `assignedAgentId`
   * (аудит 11.09.2026, второй заход по осиротевшим спутникам — см.
   * `lib/ownershipSatellites.ts`). Ставьте `true` только для явных исключений,
   * когда вызывающий код гасит их сам другим путём (сейчас таких нет — если
   * понадобится, перечислить здесь, почему).
   */
  skipSatellites?: boolean;
  /**
   * ЗАКОН О ВЛАДЕНИИ КЛИЕНТОМ (17.09.2026) — готовый вердикт `canAutoTransfer`,
   * если вызывающий код уже спросил политику сам (`services/leads/ownershipPolicy.ts`)
   * до вызова `changeClientAgent` — чтобы не грузить снимок клиента дважды.
   * Учитывается только когда он `{ allowed: true }`; не передан или не
   * позитивен — `changeClientAgent` спросит политику сама (см. `run()`).
   */
  policyVerdict?: AutoTransferVerdict;
  /**
   * ИМЯ АКТОРА, ЕСЛИ ВЫЗЫВАЮЩИЙ КОД УЖЕ ЕГО ЗНАЕТ (22.09.2026, сведение N+1) —
   * пропускает собственный `resolveAgentName` (запрос `tx.agent.findUnique`).
   * Нужно местам, которые зовут `changeClientAgent` В ЦИКЛЕ с одним и тем же
   * `actorId` на каждой итерации (заморозка агента, передача дел уволенного) —
   * без этого поля каждая карточка в цикле повторно читала одно и то же имя.
   * Не передан — функция читает его сама, как и раньше.
   */
  actorName?: string;
  /**
   * НЕ тянуть за продавцом его объекты. По умолчанию при настоящей смене
   * владельца (`toAgentId` задан и отличается от прежнего) объекты продавца,
   * которыми владел прежний агент, уходят новому (24.09.2026, связка
   * «продавец + объект», lib/propertyHandover.ts). `true` ставит только
   * обратный вызов из transferPropertyToAgent — там объект уже переехал.
   */
  skipProperties?: boolean;
}

export interface ChangeClientAgentResult {
  ok: boolean;
  /** Сколько объектов продавца переехало вместе с ним (связка 24.09.2026). */
  properties?: number;
  client?: { id: string; assignedAgentId: string | null; lastAgentId: string | null; shortId?: number };
  /**
   * Причина отказа, когда `ok: false` — необязательное поле для тех
   * вызывающих, которым важно ОТЛИЧИТЬ «клиент в Корзине» от «кто-то другой
   * успел первым» (обычная гонка `guardWhere`) и показать человеку внятный
   * текст вместо общего «уже разобрали». Автоматике достаточно `ok`.
   * `"policy"` — закон П-3 запретил автопередачу (`ruleNo` уточняет номер),
   * `escalateInsteadOfTransfer` уже вызван, записи не было.
   * `"open_deal"` — у клиента открытая сделка (ночная проверка 24.09.2026,
   * находка №208/С2-4, решение владельца): передачу по кнопке живому агенту не
   * делаем вовсе, записи не было — см. проверку в `run()` ниже.
   */
  reason?: "not_found" | "deleted" | "race" | "policy" | "open_deal";
  /** Номер правила закона, запретившего передачу — только при `reason: "policy"`. */
  ruleNo?: "П-3" | "П-1";
}

/**
 * ГОНКА КНОПКИ С ЧУЖИМ ПЕРЕНАЗНАЧЕНИЕМ (ночная проверка 24.09.2026, находки №5/№6).
 * «Передать» и «Без сделки» читают снимок клиента, потом секунды считают квоту,
 * подбирают получателя — и только затем пишут. Если за это время руководитель
 * через `/assign` уже отдал карточку другому, запись без `guardWhere` по
 * прежнему владельцу молча перезаписывала (или откатывала к прежнему агенту)
 * его решение. Теперь такие места передают `guardWhere: { assignedAgentId:
 * <снимок> }` и при `ok: false` бросают эту ошибку ИЗНУТРИ своей транзакции —
 * откатывается и уже записанная строка хронологии, — а снаружи она превращается
 * в 409 с текстом для человека (`userMessage`).
 */
export class ClientOwnerRaceError extends Error {
  readonly reason: ChangeClientAgentResult["reason"];
  constructor(reason: ChangeClientAgentResult["reason"]) {
    super(`changeClientAgent: карточка не наша (${reason ?? "race"})`);
    this.name = "ClientOwnerRaceError";
    this.reason = reason;
  }
  /** Текст для того, кто нажал кнопку. */
  get userMessage(): string {
    if (this.reason === "deleted") return "Клиент перемещён в Корзину, пока вы смотрели карточку — обновите страницу";
    if (this.reason === "open_deal") return "У клиента открытая сделка — сначала закройте или отмените её";
    return "Карточку только что передали — обновите страницу";
  }
}

/** Бросить `ClientOwnerRaceError`, если запись под `guardWhere` не состоялась. */
export function throwIfNotClaimed(changed: ChangeClientAgentResult): void {
  if (!changed.ok) throw new ClientOwnerRaceError(changed.reason);
}

/** Внутренний результат run() — несёт прежнего владельца для closeOwnershipSatellites,
 *  наружу (в публичный ChangeClientAgentResult) это поле не отдаётся. */
interface RunResult extends ChangeClientAgentResult {
  fromAgentId?: string | null;
  /** Последний держатель до записи: от него задачи переезжают при выходе из очереди (CRM-02). */
  lastAgentIdBefore?: string | null;
}

/** См. комментарий у проверки открытой сделки внутри `run()`. */
const OPEN_DEAL_GUARDED_SOURCES = new Set(["lifecycle.assign", "transfer"]);

async function resolveAgentName(tx: Tx, agentId: string | null): Promise<string> {
  if (!agentId) return "Система";
  const agent = await tx.agent.findUnique({ where: { id: agentId }, select: { fullName: true } });
  return agent?.fullName ?? "Неизвестно";
}

async function run(tx: Tx, input: ChangeClientAgentInput): Promise<RunResult> {
  const before = await tx.client.findUnique({
    where: { id: input.clientId },
    select: {
      id: true,
      assignedAgentId: true,
      lastAgentId: true,
      deletedAt: true,
      shortId: true,
      reactivationOfferedToAgentId: true,
      ownPropertyLead: true,
      assignReason: true,
      matchedProperty: { select: { intakeAgentId: true, assignedAgentId: true, createdById: true } },
    },
  });
  if (!before) return { ok: false, reason: "not_found" };
  // Отказ ДО записи — карточка уже в Корзине в том же снимке, где мы читаем
  // assignedAgentId. Ни Interaction, ни AuditLog не пишутся: операция не
  // считается состоявшейся (см. `allowDeleted` в интерфейсе выше).
  if (before.deletedAt && !input.allowDeleted) return { ok: false, reason: "deleted" };

  /**
   * ОТКРЫТАЯ СДЕЛКА БЛОКИРУЕТ ПЕРЕДАЧУ (ночная проверка 24.09.2026, находка
   * №208/С2-4, решение владельца — сделку НЕ переносить, а передачу клиента
   * запрещать). Раньше при смене владельца клиента открытая сделка (`Deal`,
   * `agentId` меняется только вручную) оставалась на прежнем агенте:
   * `routes/deals.ts` сверяет владение сделкой по `Deal.agentId`, а не по
   * `Client.assignedAgentId`, — у прежнего агента 403 на правку своей же
   * сделки, у нового владельца карточки 409 при попытке завести вторую сделку
   * по тому же объекту, а комиссия продолжала копиться на прежнем.
   *
   * Проверяем ТОЛЬКО живую передачу кнопкой человеком, а не автоматику —
   * список источников ниже это ровно два места, где решение принимает
   * человек и владелец реально меняется: «/assign» (`lifecycle.assign`) и
   * «Передать» (`transfer` — тем же источником пользуется и автоматическое
   * освобождение места в портфеле, `lib/leadAccept.ts::releaseClient`,
   * поэтому вдобавок требуем `actorId`, который оно не передаёт). Остальные
   * механизмы (раздача лидов, карусель, реактивация, освобождение при
   * увольнении и т.п.) в списке нет намеренно — решение владельца не должно
   * мешать фоновой работе.
   */
  if (
    OPEN_DEAL_GUARDED_SOURCES.has(input.source) &&
    input.actorId != null &&
    input.toAgentId !== before.assignedAgentId
  ) {
    const openDeal = await tx.deal.findFirst({
      where: { clientId: input.clientId, stage: { notIn: ["COMPLETED", "CANCELLED"] } },
      select: { id: true },
    });
    if (openDeal) return { ok: false, reason: "open_deal" };
  }

  /**
   * П-5: ИСТОЧНИКИ-ЛЮДИ ОБЯЗАНЫ НЕСТИ `actorId` (закон о владении клиентом,
   * `services/leads/ownershipPolicy.ts::requireHumanActor`). Список источников
   * там сужен до тех, чьи вызывающие УЖЕ передают настоящего актора на всех
   * путях (иначе сама эта проверка стала бы новым молчаливым отказом) —
   * `lifecycle.assign`, `restore`, `freeze`, `handover`. Не бросаем на каждый
   * прогон теста втихую: dev/test — исключение (ловится сразу, до прод-релиза),
   * прод — `logSystemError`, а не молчание (не откатывать саму операцию: клиент
   * ждать не должен из-за бага в вызывающем коде, но след обязан остаться).
   */
  if (requireHumanActor(input.source) && input.actorId == null) {
    const msg = `changeClientAgent: источник "${input.source}" обязан передавать actorId (закон П-5) — клиент ${input.clientId}`;
    if (process.env.NODE_ENV !== "production") {
      throw new Error(msg);
    }
    await logSystemError("api", msg, { dedupKey: `require-human-actor-${input.source}` });
  }

  /**
   * П-3: ПОСЛЕ ПРИНЯТИЯ И КОНТАКТА КЛИЕНТ НЕ УХОДИТ ДРУГОМУ АГЕНТУ АВТОМАТИЧЕСКИ
   * (закон о владении клиентом, `docs/law/lead-ownership.md`). Проверяем ТОЛЬКО
   * автоматику (`actorId == null`) и ТОЛЬКО настоящую смену владельца
   * (`toAgentId !== before.assignedAgentId`) — сопутствующая правка данных без
   * смены агента законом не ограничена. `input.policyVerdict` позволяет
   * вызывающему коду, который уже спросил `canAutoTransfer` сам (чтобы не
   * грузить снимок клиента дважды — см. `reassignment.ts`/`firstCall.ts`),
   * передать готовый вердикт вместо повторного запроса к базе.
   */
  if (input.actorId == null && input.toAgentId !== before.assignedAgentId && !input.policyVerdict?.allowed) {
    const snapshot = await loadOwnershipSnapshot(input.clientId, tx);
    // Клиент пропал между findUnique выше и этим моментом — тот же race, что
    // ловит guardWhere ниже; здесь просто не блокируем, дальнейший updateMany
    // сам откажет по факту (или снова не найдёт карточку).
    const verdict: AutoTransferVerdict = snapshot
      ? canAutoTransfer(snapshot, { mechanism: input.source, toAgentId: input.toAgentId })
      : { allowed: true };
    if (!verdict.allowed) {
      await escalateInsteadOfTransfer({ clientId: input.clientId, mechanism: input.source, reason: verdict.reason, tx });
      return { ok: false, reason: "policy", ruleNo: verdict.ruleNo };
    }
  }

  const data: Record<string, unknown> = { ...input.data, assignedAgentId: input.toAgentId };

  // Предложение реактивации прежнему агенту теряет смысл, как только клиент
  // достался кому-то другому (23.09.2026). Раньше оно висело дальше: адресат
  // жал «Принять» и забирал клиента у нового владельца, а снятие по сроку
  // отдавало его третьему агенту или раз в час слало прежнему ложное «клиент
  // вернулся к вам».
  if (
    data.reactivationOfferedToAgentId === undefined &&
    before.reactivationOfferedToAgentId &&
    before.reactivationOfferedToAgentId !== input.toAgentId
  ) {
    data.reactivationOfferedToAgentId = null;
    data.reactivationOfferedAt = null;
  }

  // lastAgentId: по умолчанию фиксируем прежнего владельца, если он реально
  // менялся и вызывающий код не решил вопрос сам (передав своё значение в data
  // или запретив автоподстановку).
  if (
    input.setLastAgentId !== false &&
    data.lastAgentId === undefined &&
    before.assignedAgentId &&
    before.assignedAgentId !== input.toAgentId
  ) {
    data.lastAgentId = before.assignedAgentId;
  }

  /**
   * ПОМЕТКА «СВОЙ ОБЪЕКТ» ПРИНАДЛЕЖИТ АГЕНТУ ОБЪЕКТА, А НЕ КАРТОЧКЕ (23.09.2026,
   * разбор раздачи, пункт 21). `ownPropertyLead` включает особые правила:
   * просроченный лид не крутится по кругу, а через напоминание уходит
   * руководителю (reassignment.ts), и слот «своего» не упирается в лимит
   * (leadLimits.ts). Пометка ставилась при раздаче и не снималась ни одной
   * передачей: лид, переданный постороннему агенту (передача, уход сотрудника,
   * возврат в очередь и новая раздача), вёз её дальше, и у НОВОГО агента на
   * первом же сроке шёл сразу руководителю — напоминание уже было отмечено
   * отправленным прежнему хозяину. Снимаем здесь, в единой точке смены агента:
   * пометка остаётся, только если новый держатель и есть хозяин объекта;
   * отметка о напоминании — всегда прежнего держателя. Раздача «своего» ставит
   * пометку уже после назначения (`recordAssignReason`), так что её не задевает.
   */
  if (before.assignedAgentId !== input.toAgentId) {
    if (data.ownPropertyReminderSentAt === undefined) data.ownPropertyReminderSentAt = null;
    const ownerId = before.matchedProperty ? propertyOwnerAgentId(before.matchedProperty) : null;
    const toNonOwner = input.toAgentId == null || ownerId !== input.toAgentId;
    if (before.ownPropertyLead && data.ownPropertyLead === undefined && toNonOwner) data.ownPropertyLead = false;
    /**
     * ПРИЧИНА «СВОЙ ОБЪЕКТ» УХОДИТ ВМЕСТЕ С ПОМЕТКОЙ (10.10.2026, аудит
     * docs/audit-bots-2026-10-10-object-routing.md §1.4 и §4 п.10). Пометку
     * снимали, а `assignReason` оставался «own_property_explicit»: лид у
     * третьего агента выглядел в данных лидом хозяина, новому агенту карточка
     * писала «Спрашивал про ваш объект» (lib/leadReason.ts), а отчёт «лиды по
     * своим объектам» считал чужие. Новый держатель — не хозяин объекта, значит
     * этой причины у него нет; объект (`matchedPropertyId`) остаётся следом.
     * Вызывающий, назначивший причину сам (data.assignReason), решает сам.
     * Снятие в очередь (toAgentId = null) причину НЕ стирает: держателя нет, врать
     * некому, а утренней волне она нужна, чтобы снова отдать лид по объекту
     * (reassignment.ts::assignPendingLeads).
     */
    if (
      data.assignReason === undefined &&
      input.toAgentId != null &&
      toNonOwner &&
      before.assignReason &&
      OWN_PROPERTY_ASSIGN_REASONS.includes(before.assignReason)
    ) {
      data.assignReason = null;
    }
  }

  // Гонка «клиент попал в Корзину между чтением и записью» (заявка на
  // удаление одобрена руководителем в тот самый момент, пока эта функция уже
  // проверила `before.deletedAt` и готовит запись) закрывается тем же
  // приёмом, что и обычный `guardWhere`: условие идёт прямо в WHERE самого
  // апдейта, а не только в предварительном чтении. Когда `allowDeleted` не
  // передан, `updateMany` используется ВСЕГДА (даже без своего `guardWhere`
  // от вызывающего кода), иначе гонку ловить было бы нечем.
  const guardWhere = input.allowDeleted ? input.guardWhere : { deletedAt: null, ...input.guardWhere };
  if (guardWhere) {
    const claimed = await tx.client.updateMany({ where: { id: input.clientId, ...guardWhere }, data });
    if (claimed.count === 0) {
      if (!input.allowDeleted) {
        const now = await tx.client.findUnique({ where: { id: input.clientId }, select: { deletedAt: true } });
        if (now?.deletedAt) return { ok: false, reason: "deleted" };
      }
      return { ok: false, reason: "race" };
    }
  } else {
    await tx.client.update({ where: { id: input.clientId }, data });
  }
  // Без повторного чтения (22.09.2026, сведение N+1): все поля, отдаваемые
  // наружу (id/assignedAgentId/lastAgentId/shortId), уже известны из `before` и
  // из того же `data`, которым только что записали строку — второй поход в базу
  // за тем, что мы сами туда положили секундой раньше, был чистым расходом.
  // `data.lastAgentId` может быть не задан вовсе (undefined) — Prisma такие ключи
  // в UPDATE игнорирует, и в базе остаётся прежнее значение, поэтому здесь тот
  // же fallback на `before.lastAgentId`.
  const updated = {
    id: input.clientId,
    assignedAgentId: input.toAgentId,
    lastAgentId: (data.lastAgentId as string | null | undefined) !== undefined
      ? (data.lastAgentId as string | null)
      : before.lastAgentId,
    shortId: before.shortId,
  };

  if (!input.skipInteraction) {
    /**
     * АВТОРСТВО (П-10, 17.09.2026, docs/audit/lead-ownership-17-09.md §2).
     *
     * `input.actorId` — явный человек, совершивший действие руками (кнопка
     * «Передать», решение руководителя) → actorKind AGENT. Без него — это
     * автоматика (крон, вебхук), и раньше запись всё равно подписывалась живым
     * человеком (interactionAgentId ниже) — тем же приёмом, которым директорский
     * фолбэк подписывал автоматику лично собой. Теперь `agentId` может быть
     * `null`: автоматика пишется как SYSTEM, а держателя карточки видно через
     * `subjectAgentId` — задача/лента по-прежнему находится, но подпись честная.
     *
     * `input.interactionAgentId`, если передан явно, — это ИСКЛЮЧЕНИЕ вызывающего
     * кода (например круговое переназначение исторически пишет от лица НОВОГО
     * агента, «лид переназначен вам») и трактуется как явный человек (agent),
     * а не как subjectAgentId.
     */
    const explicitAgentId = input.interactionAgentId !== undefined ? input.interactionAgentId : input.actorId ?? null;
    const subjectAgentId = before.assignedAgentId ?? before.lastAgentId ?? null;
    await logTimeline({
      clientId: input.clientId,
      actor: explicitAgentId
        ? { kind: "agent", agentId: explicitAgentId }
        : { kind: "system", source: input.source, subjectAgentId },
      type: "SYSTEM",
      // Префикс `[source]` — тот же формат, что был до П-10, сохранён для ОБОИХ
      // акторов явно (logTimeline сама добавляет его только у не-agent), чтобы не
      // сломать бэкофилл/грепы по `[manual.*]`/`[source]`, которые не смотрят на
      // actorKind.
      notes: `[${input.source}] ${input.reason}`,
      tx,
    });
  }

  const agentName = input.actorName ?? (await resolveAgentName(tx, input.actorId ?? null));
  await tx.auditLog.create({
    data: {
      action: "CLIENT_AGENT_CHANGE",
      entityType: "Client",
      entityId: input.clientId,
      agentId: input.actorId ?? null,
      agentName,
      meta: {
        source: input.source,
        reason: input.reason,
        fromAgentId: before.assignedAgentId,
        toAgentId: input.toAgentId,
      },
    },
  });

  // СВЯЗКА «ПРОДАВЕЦ + ОБЪЕКТ» (24.09.2026): объекты продавца, которыми владел
  // прежний агент, уходят новому в той же транзакции — здесь, в единственной
  // точке записи, а не в каждом из механизмов по отдельности. Снятие с агента
  // (toAgentId = null, очередь) объекты не трогает: они переедут, когда продавца
  // возьмёт следующий агент.
  let properties = 0;
  if (!input.skipProperties && input.toAgentId && before.assignedAgentId !== input.toAgentId) {
    properties = await transferSellerPropertiesWithClient({
      clientId: input.clientId,
      // Из очереди (assignedAgentId был пуст) объекты тянем от ПОСЛЕДНЕГО держателя:
      // снятие в очередь их не трогало, они всё ещё у прежнего агента.
      fromAgentId: before.assignedAgentId ?? before.lastAgentId,
      toAgentId: input.toAgentId,
      reason: input.reason,
      actorId: input.actorId ?? null,
      actorName: agentName,
      source: input.source,
      tx,
    });
  }

  return {
    ok: true,
    properties,
    client: {
      id: updated.id,
      assignedAgentId: updated.assignedAgentId,
      lastAgentId: updated.lastAgentId,
      shortId: updated.shortId,
    },
    fromAgentId: before.assignedAgentId,
    lastAgentIdBefore: before.lastAgentId,
  };
}

/**
 * ДЕЖУРНОГО ДИРЕКТОРА В ХРОНОЛОГИИ БОЛЬШЕ НЕТ (было решено 17.09.2026 утром;
 * доведено до конца заданием Б1 тем же днём — П-10, docs/audit/lead-ownership-17-09.md §2).
 *
 * Системная запись без явного актора подписывалась ПЕРВЫМ АКТИВНЫМ ДИРЕКТОРОМ
 * (`agent.findFirst({ role: "DIRECTOR" })`), и в карточке это выглядело так,
 * будто действие совершил директор лично. Разбирая живые случаи, приходилось не
 * верить собственной истории.
 *
 * `Interaction.agentId` теперь nullable, у записи есть `actorKind` — автоматика
 * без явного актора пишется как SYSTEM через `lib/timeline.ts::logTimeline`,
 * `agentId: null`, а держатель карточки (нажавший → текущий агент → последний
 * агент) уходит в `subjectAgentId`, чтобы задача/лента по-прежнему находилась.
 * Запись теперь пишется ВСЕГДА (раньше при отсутствии кандидата в «человека»
 * запись не делалась вовсе — «отсутствующая запись честнее выдуманной»; теперь
 * честный вариант есть и без этой жертвы).
 */
export async function changeClientAgent(input: ChangeClientAgentInput): Promise<ChangeClientAgentResult> {
  const result = input.tx ? await run(input.tx, input) : await prisma.$transaction((tx) => run(tx, input));

  if (result.ok && result.client && !input.skipSatellites) {
    const fromAgentId = result.fromAgentId ?? null;
    if (fromAgentId !== input.toAgentId) {
      // «Коротко от ИИ» называет текущего агента (ai/scoring.ts, факт «агент: …») —
      // владелец сменился, сводка обязана перегенерироваться и назвать нового,
      // а не молчать до следующего звонка/сообщения (найдено 18.09.2026). Тот же
      // фоновый, best-effort вызов, что и у остальных мест автопилота — сюда же
      // стекаются ВСЕ механизмы переназначения, это единый вход.
      runClientAutopilotInBackground(input.clientId, "agent_changed");
      const satellites = closeOwnershipSatellites({
        clientId: input.clientId,
        clientShortId: result.client.shortId ?? null,
        fromAgentId,
        toAgentId: input.toAgentId,
        reason: `[${input.source}] ${input.reason}`,
        // Карточка вышла из очереди (владельца не было): задачи последнего держателя поедут
        // к новому, как объекты выше (аудит 04.10.2026, CRM-02).
        queueReturnFromAgentId: fromAgentId ? null : result.lastAgentIdBefore ?? null,
      });
      if (input.tx) {
        /**
         * ВЫЗЫВАЮЩИЙ КОД УЧАСТВУЕТ В ЧУЖОЙ, ЕЩЁ НЕ ЗАКОММИЧЕННОЙ ТРАНЗАКЦИИ —
         * НЕ ДОЖИДАЕМСЯ closeOwnershipSatellites ЗДЕСЬ.
         *
         * Найдено 11.09.2026 на `lib/agentHandover.ts::handoverAgentWork`: там
         * `changeClientAgent` вызывается ВНУТРИ `prisma.$transaction(...)` с
         * дефолтным таймаутом 5000мс, и синхронный `await` спутников (пуш +
         * лента + требования + заявка + задачи + живое событие — несколько
         * дополнительных походов в базу) съедал время самой транзакции и
         * валил её по таймауту. closeOwnershipSatellites использует обычный
         * `prisma` (не переданный `tx`), поэтому ждать её из ЧУЖОЙ транзакции
         * незачем и вредно — гасим спутников в фоне (`void`), они всё равно
         * best-effort и не участвуют в атомарности самой передачи владельца.
         */
        void satellites;
      } else {
        // Своя транзакция уже закоммичена (await выше) — дожидаемся спутников
        // здесь безопасно, лишней транзакции они не удлиняют.
        await satellites;
      }
    }
  }

  return result;
}
