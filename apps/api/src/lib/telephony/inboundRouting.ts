import { prisma } from "../../db.js";
import { logSystemError } from "../systemError.js";
import { describeError } from "../describeError.js";
import { reactivateClientFromLost } from "../clientLifecycle.js";
import { returningAgentStillAvailable } from "../returningClientRouting.js";
import { returnDeferredClientEarly } from "../deferredClients.js";
import { amiAction, loadAmiCredentials, withAmiConnection, type AmiCredentials } from "./amiClient.js";
import {
  agentDeviceOnline,
  continueInDialplan,
  listEndpoints,
  loadAgentDialMode,
  loadAriCredentials,
  normalizeDialNumber,
  resolveAgentDialTarget,
  setChannelVariable,
  type AriCredentials,
} from "./ariClient.js";
import { hasLiveCall } from "./callTracker.js";
import { loadIncomingSettings } from "./incomingSettings.js";
import { findPhoneOwners } from "../clientPhones.js";
import { whisperFileForCall } from "./whisperSync.js";
import {
  ROUTE_DIALPLAN_FILE,
  resetDialplanContextCache,
  stationHasContext,
  type DialplanStatus,
} from "./dialplanContext.js";

/**
 * ВХОДЯЩИЙ — СРАЗУ СВОЕМУ АГЕНТУ (решение владельца 16.08.2026).
 *
 * Клиент, у которого в карточке уже есть ответственный, звонит не «в агентство», а
 * своему человеку: тот знает, какие объекты смотрели вчера и о чём договорились. До
 * сих пор такой звонок падал в общую очередь 1000, оператор выслушивал «соедините с
 * Мадиной» и переводил вручную — если Мадина на месте и если оператор вообще снял
 * трубку. Теперь станция сначала звонит агенту, а очередь остаётся запасным путём.
 *
 * ЧЕГО ЭТОТ МОДУЛЬ НЕ ДЕЛАЕТ — НЕ ВЕДЁТ ЗВОНОК. Перевод выполняется ОДНИМ действием
 * AMI `Redirect`, после которого канал уходит в диалплан станции и живёт там сам.
 * Причина не в лени: ARI-канала у входящего звонка нет (в Stasis он не заходит, см.
 * ariClient.ts), а главное — запасной путь обязан работать, когда CRM недоступна.
 * Веди мы звонок сами («не ответил за 25 секунд — набираю очередь»), выкат контейнера
 * посреди звонка оставил бы клиента в тишине. Поэтому «позвонить агенту, а если он
 * не взял — вернуть в очередь» описано НА СТАНЦИИ, одним контекстом диалплана
 * (`royalhome-agent-route`, см. docs/telephony-inbound-routing.md), — ровно тем же
 * приёмом, что и запасной путь очереди (failoverSync.ts).
 *
 * ПОЭТОМУ ПЕРЕД ПЕРЕВОДОМ СПРАШИВАЕМ СТАНЦИЮ, ЕСТЬ ЛИ У НЕЁ ЭТОТ КОНТЕКСТ. Перевод в
 * контекст, которого нет, — это не «не сработало», это сброшенный звонок клиента:
 * Asterisk не находит расширение и кладёт трубку. Настройку включает владелец, а
 * диалплан добавляет тот, у кого есть доступ к FreePBX, и между этими двумя
 * событиями может пройти неделя. Проверка (`GetConfig` файла диалплана) стоит один
 * запрос к станции раз в пять минут и превращает «клиент в тишине» в строку журнала.
 *
 * КРУГЛОСУТОЧНО, БЕЗ ОГЛЯДКИ НА ЧАСЫ ПРИЁМА (владелец 16.08.2026: «24/7»). Ночью
 * звонок своему агенту тем более уместен — очередь в это время пуста. Защита от
 * «звоним в мёртвый аппарат» здесь не расписание, а подбор цели: нет трубки на
 * связи — звоним на мобильный агента ТЕМ ЖЕ путём, каким CRM звонит ему, когда он
 * сам набирает клиента (resolveAgentDialTarget, ariClient.ts); нет и мобильного —
 * в станцию не ходим вовсе, звонок остаётся в очереди.
 *
 * РАБОТАЕТ И КОГДА ПРИЁМ ПЕРЕВЕДЁН НА ПРЯМОЙ АППАРАТ (владелец 21.08.2026,
 * `Settings.incomingPrimaryTarget = "extension"`, см. failoverSync.ts). До
 * 29.08.2026 этот режим полностью отключал перевод: запасной путь диалплана вёл в
 * общую очередь 1000, а операторов из приёма как раз сняли — звонок звонил бы у
 * того, кто его больше не ждёт.
 *
 * ЗАПАСНОЙ ПУТЬ ПЕРЕПИСАН 29.08.2026 (решение владельца): звонок известного
 * клиента вообще не должен доставаться оператору/приёмному аппарату — ни при
 * каком исходе. Агенту звонят дольше обычного (`Settings.incomingRouteRingSeconds`,
 * по умолчанию 150 с = 2.5 минуты), а не взял трубку — станция сама пишет
 * голосовую почту (диалплан `royalhome-agent-route`, метка `voicemail`) в тот же
 * каталог и тем же именем файла, что и общий приём (`royalhome-inbound`). Её
 * забирает `voicemailIngest.ts` — там уже зашито «у звонка есть свой агент, лид
 * дальше не раздаётся»: карточка получает расшифровку и задачу перезвонить, но
 * не уходит в общую раздачу. CRM здесь по-прежнему ничего не ведёт — решает
 * станция (см. docs/telephony-inbound-routing.md), а от направления перехвата
 * (`Settings.incomingPrimaryTarget`) поведение теперь не зависит вовсе.
 *
 * ОТВЕТСТВЕННЫЙ ЧИТАЕТСЯ ЖИВЫМ ЗАПРОСОМ НА КАЖДЫЙ ЗВОНОК и не кэшируется нигде.
 * Клиента передают другому агенту, от клиента отказываются, карточку удаляют — и
 * звонок, ушедший к прежнему владельцу карточки, хуже звонка в очередь: клиент
 * слышит человека, который его не ведёт. По той же причине не переводим лид,
 * который агенту только ПРЕДЛОЖЕН и ещё не принят (acceptedAt пуст).
 */

/** Контекст диалплана на станции. Меняется только вместе с самим диалпланом. */
export const ROUTE_CONTEXT = "royalhome-agent-route";

/**
 * Единственное расширение контекста: КУДА звонить, станция узнаёт из переменных
 * канала, а не из набранного номера. Так внутренний номер и мобильный набираются
 * по-разному, не заставляя диалплан гадать о длине строки.
 */
export const ROUTE_EXTEN = "agent";

/** Кому звонить: внутренний номер агента либо его мобильный (местные девять цифр). */
export const ROUTE_TARGET_VAR = "RH_ROUTE_TARGET";
/** "1" — цель мобильная (набирается наружу), "0" — внутренний аппарат. */
export const ROUTE_MOBILE_VAR = "RH_ROUTE_MOBILE";
/**
 * Сколько звонить агенту. Значение настраивается владельцем; у диалплана есть
 * собственное умолчание на случай, если `Setvar` не доехал.
 */
export const ROUTE_TIMEOUT_VAR = "RH_ROUTE_TIMEOUT";
/**
 * Что проиграть агенту в ухо, когда он снимет трубку, — имя файла на станции без
 * расширения (см. lib/telephony/whisperSync.ts и docs/telephony-whisper.md).
 * Пусто или переменной нет — диалплан просто соединяет, как раньше.
 */
export const ROUTE_WHISPER_VAR = "RH_WHISPER";
/**
 * Куда возвращать звонок, если агент не ответил, — "voicemail" | "queue"
 * (владелец 29.08.2026). Известному клиенту его собственного агента заменять
 * очередью операторов нельзя: очередь — для незнакомых и новых обращений.
 * Незнакомому звонку по KPI-очереди/дежурному (`kpiQueueRouting.ts`,
 * `dutyRosterRouting.ts`) очередь операторов, наоборот, остаётся законным
 * запасным путём — этим двум путям и известному клиенту нельзя разъезжаться
 * молча, поэтому решение приходит переменной канала, а не зашито в диалплане.
 */
export const ROUTE_FALLBACK_VAR = "RH_ROUTE_FALLBACK";

/**
 * Станции на ответ даётся меньше обычного: на том конце ЖИВОЙ человек слушает
 * музыку ожидания, и три секунды раздумий CRM — это три секунды, украденные у
 * дозвона до агента. Не ответила — звонок просто остаётся в очереди.
 */
const ROUTE_AMI_TIMEOUT_MS = 3_000;

/**
 * Почему звонок остался в очереди. Код пишется в журнал входящих (`routeDecision`),
 * чтобы на вопрос «маршрутизация работает?» отвечала CRM, а не догадки.
 */
export type RouteSkipReason =
  | "disabled"
  | "no_client"
  | "ambiguous_phone"
  | "client_deleted"
  | "no_agent"
  | "lead_not_accepted"
  | "client_closed"
  | "agent_inactive"
  /** Ответственный не уволен и не отключён вручную, а временно заморожен
   *  (`frozenAt`, отпуск/долгое отсутствие, см. routes/agents.ts) — 20.09.2026,
   *  до этой правки заморозка не проверялась вовсе на этом пути, и звонок
   *  замороженного агента продолжал уходить на его личный мобильный. */
  | "agent_frozen"
  | "no_extension"
  | "agent_offline"
  | "agent_busy"
  | "already_answered"
  | "station_not_configured"
  | "no_dialplan"
  /** Станция НЕ ОТВЕТИЛА на вопрос о контексте диалплана (таймаут/обрыв AMI) — это
   *  не то же самое, что честное «контекста нет» (`no_dialplan`): временная заминка
   *  связи, а не решение админа. Ретраится (см. RETRYABLE_REASONS), `no_dialplan`
   *  — нет: 20.09.2026, разбор находки владельца (see dialplanContext.ts). */
  | "dialplan_unknown"
  | "redirect_failed";

export type RouteOutcome =
  | { routed: true; agentId: string; extension: string; /** Куда звоним на самом деле: внутренний номер или мобильный. */ dialTarget: string; viaMobile: boolean }
  | { routed: false; reason: RouteSkipReason };

/** Человеческая расшифровка кода — для журнала и экрана телефонии. */
export const ROUTE_SKIP_TEXT: Record<RouteSkipReason, string> = {
  disabled: "перевод на ответственного выключен в настройках",
  no_client: "номера нет в базе",
  ambiguous_phone: "по номеру нашлось несколько карточек",
  client_deleted: "карточка в Корзине",
  no_agent: "у карточки нет ответственного",
  lead_not_accepted: "ответственный ещё не принял лид",
  client_closed: "сделка по клиенту закрыта или клиент потерян",
  agent_inactive: "ответственный отключён",
  agent_frozen: "ответственный временно заморожен (отсутствует)",
  no_extension: "у ответственного нет внутреннего номера",
  agent_offline: "ни трубки, ни мобильного ответственного не доступно",
  agent_busy: "ответственный уже разговаривает",
  already_answered: "оператор снял трубку раньше",
  station_not_configured: "управление станцией (AMI) не настроено",
  no_dialplan: "на станции нет контекста запасного пути",
  dialplan_unknown: "станция не ответила на проверку диалплана",
  redirect_failed: "станция отказала в переводе",
};

/** Состояния клиента, при которых звонок агенту не адресуется (см. decideRoute). */
const CLOSED_STATUSES = new Set(["DEAL_CLOSED", "LOST", "ARCHIVED"]);

/**
 * Карточка звонящего в том виде, в каком её видит решение. Все поля читаются из
 * базы В МОМЕНТ ЗВОНКА и нигде не кэшируются: передача клиента другому агенту,
 * отказ от клиента и удаление карточки происходят между звонками, и решение,
 * принятое по вчерашнему снимку, отправило бы человека к бывшему агенту.
 */
export interface RouteClient {
  deletedAt: Date | null;
  status: string;
  workStatus: string;
  /** Момент, когда агент ПРИНЯЛ лид. null — лид ему только предложен. */
  acceptedAt: Date | null;
  /** Кто вёл карточку до потери — ему первому возвращается позвонивший LOST-клиент. */
  lastAgentId?: string | null;
  /** `phone` — мобильный агента: им звонят, когда трубки нет на связи.
   *  `whisperLanguage` — на каком языке играть ему подсказку о звонящем (см. whisperText.ts). */
  assignedAgent: {
    id: string;
    isActive: boolean;
    /** Временно заморожен (отпуск/долгое отсутствие) — не путать с `isActive`,
     *  см. decideRoute и routes/agents.ts. */
    frozenAt: Date | null;
    sipExtension: string | null;
    phone: string | null;
    whisperLanguage: string | null;
  } | null;
}

/**
 * Кого спрашивает решение о переводе. Вынесено отдельной структурой намеренно: сам
 * выбор — чистая функция, и проверяется на образцах без станции и без базы.
 */
export interface RouteCandidate {
  enabled: boolean;
  /** Сколько карточек нашлось по номеру звонящего. Больше одной — не переводим. */
  matchCount: number;
  client: RouteClient | null;
  /** Куда реально звонить агенту — ответ resolveAgentDialTarget (см. ariClient.ts).
   *  null означает «звонить некуда»: ни живой трубки, ни мобильного. */
  dial: { target: string; viaMobile: boolean } | null;
  /** Агент уже говорит по другому звонку из CRM. */
  busy: boolean;
  /** Оператор успел снять трубку, пока мы думали. */
  answered: boolean;
}

/**
 * ПЕРЕВОДИМ, ТОЛЬКО КОГДА УВЕРЕНЫ. Каждое «нет» здесь — это звонок, оставшийся в
 * очереди, где сидит живой человек; каждое ошибочное «да» — клиент, отправленный к
 * тому, кто его не ведёт, или в тишину. Сомнение всегда трактуется в пользу очереди.
 */
export function decideRoute(candidate: RouteCandidate): RouteOutcome {
  if (!candidate.enabled) return { routed: false, reason: "disabled" };
  // Проверка «уже ответили» стоит рано и повторяется перед самим переводом: между
  // решением и действием лежит поход к станции, и за это время оператор мог снять.
  if (candidate.answered) return { routed: false, reason: "already_answered" };
  if (candidate.matchCount === 0 || !candidate.client) return { routed: false, reason: "no_client" };
  // Дубликаты карточек в базе живут (их сливают руками), и «взять самую раннюю»
  // здесь недопустимо: у двух карточек могут быть РАЗНЫЕ ответственные, и звонок
  // ушёл бы не тому агенту. Очередь в этом случае честнее.
  if (candidate.matchCount > 1) return { routed: false, reason: "ambiguous_phone" };

  const client = candidate.client;
  // Карточку удалил человек. Оживлять её звонком нельзя — тем же правилом живёт
  // весь остальной модуль входящих (см. setupIncomingCall).
  if (client.deletedAt) return { routed: false, reason: "client_deleted" };
  // Ответственного нет вовсе: обращение из «Прочих» (kind=OTHER не распределяется),
  // отказ агента или лид, до которого распределение ещё не дошло. Звонить некому.
  if (!client.assignedAgent) return { routed: false, reason: "no_agent" };
  /**
   * ЛИД ПРЕДЛОЖЕН, НО НЕ ПРИНЯТ (`acceptedAt` пуст) — В ОЧЕРЕДЬ. Агент этого
   * человека ещё не брал: он видит предложение в списке и может от него отказаться.
   * Живой звонок тому, кто лид не принимал, — недоразумение с обеих сторон: агент
   * не понимает, кто ему звонит, клиент слышит растерянность вместо «здравствуйте,
   * Мадина».
   */
  if (!client.acceptedAt) return { routed: false, reason: "lead_not_accepted" };
  /**
   * Закрытые и потерянные не звонят своему бывшему агенту: сделка сдана, а LOST —
   * настоящая потеря клиента (решение человека после показа, см.
   * lib/clientTransfer.ts, либо ручная правка), а не техническая пауза. Такой
   * клиент распределяется заново, и решать это должен человек в очереди.
   *
   * UNRESPONSIVE и COLD здесь НЕ перечислены нарочно: «клиент остыл» и «до клиента
   * не дозвонились» — это ровно тот случай, когда его собственный звонок надо
   * отдать агенту в первую очередь.
   *
   * WorkStatus.INACTIVE (владелец 20.08.2026, отмена прежнего правила от
   * 11.08.2026) — ТОЖЕ переводим агенту напрямую. «Неактивный» — это освобождённый
   * слот в лимите (агент сам отложил клиента, или лид, который никто не подхватил
   * до первого разговора, см. leads.ts), а не решение расстаться: карточка при
   * этом остаётся закреплена за тем же агентом, и его собственный звонок — именно
   * то обращение, ради которого слот и держали за ним.
   */
  if (CLOSED_STATUSES.has(client.status)) return { routed: false, reason: "client_closed" };

  const agent = client.assignedAgent;
  if (!agent.isActive) return { routed: false, reason: "agent_inactive" };
  /**
   * ЗАМОРОЗКА (20.09.2026, симметрично agentIncomingReadiness.ts:89 — там для
   * очереди НЕЗНАКОМЫХ звонков уже проверялась, здесь для звонков СВОИХ клиентов
   * не проверялась вовсе). `frozenAt` — не производная от `isActive`
   * (routes/team.ts): замороженный агент остаётся активным сотрудником, просто
   * временно отсутствует (отпуск, длительный больничный). Без этой проверки
   * звонок собственного клиента уходил на личный мобильный человека, который не
   * может ответить, и клиент слышит либо тишину, либо чужой автоответчик — новая
   * причина, а не `agent_inactive`, чтобы в журнале было видно разницу между
   * «уволен» и «отсутствует».
   */
  if (agent.frozenAt) return { routed: false, reason: "agent_frozen" };
  if (!agent.sipExtension) return { routed: false, reason: "no_extension" };
  // Звонить некуда: аппарат не зарегистрирован, а мобильный либо не задан, либо
  // запрещён режимом «только внутренний». 25 секунд тишины вместо очереди, где
  // ждёт живой человек, — худший из возможных исходов.
  if (!candidate.dial) return { routed: false, reason: "agent_offline" };
  if (candidate.busy) return { routed: false, reason: "agent_busy" };
  return {
    routed: true,
    agentId: agent.id,
    extension: agent.sipExtension,
    dialTarget: candidate.dial.target,
    viaMobile: candidate.dial.viaMobile,
  };
}

/** Про отсутствующий диалплан пишем в журнал один раз на серию, а не на звонок. */
let dialplanAlarmed = false;

/** Только для тестов: забыть, что мы спрашивали станцию про диалплан. */
export function resetDialplanCache(): void {
  resetDialplanContextCache();
  dialplanAlarmed = false;
  attempted.clear();
}

/**
 * Есть ли на станции контекст запасного пути. Сама проверка (и почему она читает файл
 * диалплана, а не спрашивает Asterisk про контекст) — в lib/telephony/dialplanContext.ts;
 * здесь к ней добавлена ровно одна вещь: строка в «Здоровье системы», когда контекста
 * нет. Одна на серию, а не на звонок — иначе журнал заполнялся бы одной и той же
 * записью со скоростью входящих.
 */
export async function stationHasRouteContext(creds: AmiCredentials): Promise<DialplanStatus> {
  const status = await stationHasContext(creds, ROUTE_CONTEXT);
  // Станция не ОТВЕТИЛА — это не «контекста нет», а тишина связи (см.
  // dialplanContext.ts). Писать сюда тревогу «контекста не видно» значило бы врать
  // в журнале про заминку AMI как про решение админа — молчим и отдаём решение
  // вызывающему коду (attemptRoute), у него для этого свой RouteSkipReason.
  if ("unknown" in status) return status;

  if (!status.present && !dialplanAlarmed) {
    dialplanAlarmed = true;
    void logSystemError(
      "telephony",
      `Перевод входящих на ответственного включён, но контекста ${ROUTE_CONTEXT} в ` +
        `${ROUTE_DIALPLAN_FILE} на станции не видно — звонки идут в очередь как раньше ` +
        `(см. docs/telephony-inbound-routing.md)`
    );
  }
  if (status.present) dialplanAlarmed = false;
  return status;
}

/**
 * Каналы, по которым перевод уже пробовали. Второй слой защиты от повторной
 * доставки события: первый — уникальный `channelId` в журнале входящих, из-за
 * которого повторный звонок не доходит до этого модуля вовсе.
 */
const attempted = new Set<string>();
/** Потолок памяти: станция за сутки создаёт тысячи каналов, помнить все незачем. */
const ATTEMPTED_MAX = 2_000;

/**
 * ЗАЛ ОЖИДАНИЯ СВОЕГО АГЕНТА (владелец 04.09.2026).
 *
 * Разбор живого случая: агент был занят другим разговором, `decideRoute`
 * честно ответил `agent_busy` — и звонок в ту же секунду ушёл по ОБЫЧНОМУ
 * пути станции (королhome-inbound → приёмный номер), которого у клиента
 * ЧУЖОГО агента там быть не должно вовсе (владелец: «должен попасть только
 * к своему агенту и ждать, сколько надо»). Причины вроде «занят» и «аппарат
 * недоступен» часто разрешаются сами за секунды-минуты — агент кладёт
 * трубку текущего разговора, — и первая же попытка не обязана быть
 * последней.
 *
 * Контекст `royalhome-agent-wait` — та же станция, тот же приём CRM, что и
 * `royalhome-agent-route` (см. заголовок модуля и docs/telephony-inbound-
 * routing.md): CRM не ведёт звонок сама, только паркует канал музыкой
 * ожидания на станции и время от времени пробует перевод снова. Верхняя
 * граница диалплана (`MusicOnHold(...,180)`) на 30 секунд длиннее
 * `Settings.incomingRouteRingSeconds` (умолчание 150) — подстраховка на
 * случай, если процесс CRM перезапустится посреди ожидания: тогда звонок
 * доиграет музыку и сам положит трубку, а не зависнет молча навсегда.
 */
export const WAIT_CONTEXT = "royalhome-agent-wait";
export const WAIT_EXTEN = "wait";

/**
 * ВЕРДИКТ CRM ДЛЯ СТАНЦИИ: «этот звонок не наш, отдавайте оператору».
 *
 * Решение владельца 21.09.2026: «свои клиенты звонят агентам прямо, чужих
 * обслуживаю я; один звонок одному человеку, никакой гонки».
 *
 * КАК БЫЛО. Диалплан ставил входящий в очередь операторов через фиксированную
 * паузу (`MusicOnHold(royalhome,6)`), а CRM параллельно выясняла, чей это
 * клиент, и уводила его агенту. Кто успел — тот и взял. Цена схемы, замер
 * 20.09.2026: на трёх звонках известных клиентов за день оператор снял трубку
 * раньше перевода (`already_answered`, один разговор 80 секунд) — то есть чужой
 * клиент попал не к своему агенту, ровно то, что владелец запретил. А когда
 * сервер был занят сборками CI, CRM не укладывалась в шесть секунд вовсе.
 *
 * КАК СТАЛО. Очередь стартует не по таймеру, а по этой переменной: диалплан
 * ждёт её и начинает звонить оператору ровно тогда, когда CRM ответила «клиент
 * чужой». Выигрыш обоюдный — свой клиент не может попасть к оператору в
 * принципе, а чужой попадает к нему за секунду вместо шести (замер перевода на
 * живой станции: 0-2 секунды на двадцати звонках).
 *
 * ОТКАЗ CRM НЕ ДЕЛАЕТ СХЕМУ НЕМОЙ. Верхняя граница ожидания живёт на станции:
 * не дождавшись переменной, диалплан досчитывает свои секунды и отдаёт звонок
 * очереди сам. Перезапуск CRM или обрыв туннеля возвращают прежнее поведение
 * (фиксированная пауза), а не тишину в трубке.
 */
export const RELEASE_VAR = "RH_CRM_VERDICT";
/** Сколько музыки играет зал ожидания в диалплане (`MusicOnHold(...,180)`).
 *  Потолок ожидания, когда `incomingRouteRingSeconds` равен нулю («без
 *  ограничения»): дольше канала всё равно не существует. */
const WAIT_MUSIC_MS = 180_000;

/** Причины, которые могут разрешиться сами за пару минут без участия
 *  человека, — единственные, ради которых стоит ждать, а не сдаваться сразу.
 *  Остальные (нет клиента/агента, лид не принят, сделка закрыта, номер
 *  неоднозначен, у агента нет номера, заморожен, возможность выключена, на
 *  станции ЧЕСТНО нет контекста) — решение человека или конфигурации: повторный
 *  звонок сам себя не починит, а лишняя музыка в ухе клиенту только вредит.
 *  `dialplan_unknown` (20.09.2026) — ИСКЛЮЧЕНИЕ из этого правила: станция не
 *  ответила, а не отказала содержательно, и следующая попытка через
 *  retryIntervalMs почти наверняка застанет связь уже живой (см.
 *  dialplanContext.ts). `no_dialplan` (станция ОТВЕТИЛА, что секции нет) сюда
 *  намеренно не входит — это решение админа, ждать нечего. */
const RETRYABLE_REASONS = new Set<RouteSkipReason>(["agent_busy", "agent_offline", "redirect_failed", "dialplan_unknown"]);

/** Как часто перепроверять, освободился ли агент. Переопределяется в тестах
 *  (см. setRetryIntervalForTest) — реальные пять секунд умножить на до
 *  тридцати повторов ни один тест ждать не обязан. */
let retryIntervalMs = 5_000;

export function setRetryIntervalForTest(ms: number | null): void {
  retryIntervalMs = ms ?? 5_000;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Паркует канал в зал ожидания и раз в retryIntervalMs пробует перевод
 * заново, пока не кончится время (Settings.incomingRouteRingSeconds — то же
 * число, что и у самого дозвона, чтобы «сколько ждать» не разъезжалось по
 * настройкам) или причина не перестанет быть RETRYABLE. Отказ парковки
 * (канал уже пропал, станция не ответила) возвращает первую попытку как есть —
 * ждать в пустоте нечего.
 */
async function waitAndRetry(request: RouteRequest, firstAttempt: RouteOutcome): Promise<RouteOutcome> {
  const creds = await loadAmiCredentials();
  if (!creds) return firstAttempt;

  const parked = await amiAction(
    creds,
    "Redirect",
    { Channel: request.channelName, Context: WAIT_CONTEXT, Exten: WAIT_EXTEN, Priority: 1 },
    { timeoutMs: ROUTE_AMI_TIMEOUT_MS }
  );
  if (!parked.ok) {
    // 06.09.2026 (разбор двойного звонка 05.09 и 02.09): раньше отказ парковки
    // проглатывался молча — вторая попытка маршрутизации (после redirect_failed)
    // тоже проваливалась без единого следа в логах. К этому моменту канал обычно
    // уже недоступен (звонящий положил трубку, пока CRM решала маршрут через
    // несколько отдельных AMI-соединений) — ждать в пустоте действительно нечего,
    // но факт неудачи не должен исчезать бесследно.
    // `await`, а не `void`: ветка редкая (парковка сорвалась), маршрутизация уже
    // закончена и ждать одну запись некому в тягость. Без ожидания след в журнале
    // появлялся ПОСЛЕ ответа, и проверка «след остался» гонялась с ним наперегонки.
    await logSystemError(
      "telephony",
      `Парковка в зал ожидания сорвалась (канал ${request.channelName}): ${parked.error}`
    );
    return firstAttempt;
  }

  const settings = await loadIncomingSettings();
  /**
   * НОЛЬ — ЭТО «БЕЗ ОГРАНИЧЕНИЯ», А НЕ «НЕ ЖДАТЬ ВОВСЕ» (разбор 20.09.2026).
   *
   * `incomingRouteRingSeconds = 0` владелец выбрал 20.08.2026 в значении «звонить,
   * пока клиент сам не положит трубку». Здесь же ноль давал `deadline = сейчас`:
   * канал парковали музыкой ожидания и НЕ пробовали перевод ни разу. Клиент
   * слушал музыку и клал трубку, а в журнале оставалась причина первой попытки —
   * ровно то, на что 20.09 пожаловался владелец («звонки агенту не доходят»):
   * 12:04 клиент ждал 33 секунды, пока агент разговаривала, и не дождался, хотя
   * она освободилась.
   *
   * Верхняя граница при нуле — те же 180 секунд, сколько играет музыка в
   * диалплане (`MusicOnHold(...,180)`, см. WAIT_CONTEXT выше): дальше станция
   * кладёт трубку сама, и пробовать перевод в пустоту незачем.
   */
  // Полное routeRingSeconds при любом режиме консультанта (владелец 11.10.2026:
  // робот клиентам агента не отвечает, укорачивать ожидание своего агента незачем).
  const limitMs = settings.routeRingSeconds > 0 ? settings.routeRingSeconds * 1000 : WAIT_MUSIC_MS;
  const deadline = Date.now() + limitMs;
  let outcome = firstAttempt;

  while (Date.now() < deadline) {
    await delay(retryIntervalMs);
    if (request.isAnswered()) return { routed: false, reason: "already_answered" };
    try {
      outcome = await attemptRoute(request);
    } catch (err) {
      void logSystemError("telephony", `Повтор перевода на ответственного сорвался: ${describeError(err)}`);
      outcome = { routed: false, reason: "redirect_failed" };
    }
    if (outcome.routed || !RETRYABLE_REASONS.has(outcome.reason)) return outcome;
  }
  return outcome;
}

function rememberAttempt(channelId: string): boolean {
  if (attempted.has(channelId)) return false;
  if (attempted.size >= ATTEMPTED_MAX) attempted.clear();
  attempted.add(channelId);
  return true;
}

export interface RouteRequest {
  channelId: string;
  /** Имя канала звонящего (`SIP/out-00000012`) — им AMI и адресует Redirect. */
  channelName: string;
  /** Номер звонящего в виде CRM. */
  phone: string;
  clientId?: string;
  /** Строка журнала входящих — туда пишется решение. */
  recordId?: string;
  /** Снял ли оператор трубку ПРЯМО СЕЙЧАС. Спрашивается дважды: до и после станции. */
  isAnswered: () => boolean;
}

/**
 * Попытаться увести звонок ответственному агенту. Ничего не бросает: любой сбой —
 * это звонок, оставшийся в очереди, то есть прежнее поведение.
 */
export async function routeIncomingToAssignedAgent(request: RouteRequest): Promise<RouteOutcome> {
  try {
    if (!rememberAttempt(request.channelId)) return { routed: false, reason: "already_answered" };
    let outcome = await attemptRoute(request);
    // Причина «может пройти сама» и звонок ещё жив — не сдаёмся сразу: клиент
    // ждёт своего агента, а не первого, кто ответит (владелец 04.09.2026).
    if (!outcome.routed && RETRYABLE_REASONS.has(outcome.reason) && !request.isAnswered()) {
      outcome = await waitAndRetry(request, outcome);
    }
    await recordDecision(request.recordId, outcome);
    return outcome;
  } catch (err) {
    void logSystemError("telephony", `Перевод входящего на ответственного сорвался: ${describeError(err)}`);
    const outcome: RouteOutcome = { routed: false, reason: "redirect_failed" };
    await recordDecision(request.recordId, outcome).catch(() => {});
    return outcome;
  }
}

async function attemptRoute(request: RouteRequest): Promise<RouteOutcome> {
  const settings = await loadIncomingSettings();
  // Флаг проверяется ПЕРВЫМ и до любого похода к станции: выключенная возможность
  // не должна стоить ни одного запроса и ни одной строки в журнале.
  // Часы приёма здесь намеренно НЕ проверяются — владелец выбрал круглосуточно.
  if (!settings.routeToAssignedAgent) return { routed: false, reason: "disabled" };
  // Режим «прямой аппарат» (settings.primaryTarget === "extension") здесь больше
  // НЕ проверяется намеренно: с 29.08.2026 запасной путь диалплана в любом режиме
  // ведёт на голосовую почту, а не на приёмный аппарат/очередь (см. комментарий
  // над модулем и docs/telephony-inbound-routing.md).
  if (!request.channelName) return { routed: false, reason: "redirect_failed" };
  if (request.isAnswered()) return { routed: false, reason: "already_answered" };

  let { matchCount, client } = await loadRouteClient(request.phone, request.clientId);

  /**
   * СНЯТИЕ LOST ВХОДЯЩИМ ЗВОНКОМ (аудит 02.09.2026, баг B3). Клиент в статусе
   * LOST, который сам звонит в CRM, больше не считается потерянным: он жив и
   * хочет говорить. Реактивируем ПЕРЕД проверкой CLOSED_STATUSES, иначе
   * decideRoute вернёт client_closed и звонок уйдёт в очередь вместо агента.
   *
   * КОМУ ВОЗВРАЩАЕТСЯ (решение владельца 19.08.2026, подтверждено 03.09.2026 —
   * одно правило для сообщений и звонков): СНАЧАЛА ПРЕЖНЕМУ АГЕНТУ (lastAgentId),
   * если он ещё работает и не заморожен; звонок и есть принятие — трубку снимает
   * он. Прежнего агента нет — в очередь руководителя. Так же возвращает клиента,
   * написавшего сам, services/leads/intake.ts.
   *
   * После реактивации перечитываем карточку, чтобы decideRoute видел
   * актуальный status/workStatus/assignedAgentId.
   */
  if (client && !client.deletedAt && client.status === "LOST" && request.clientId) {
    // Пауза лидов — не помеха своему вернувшемуся клиенту (B1, 02.10.2026, returningClientRouting).
    const previousAgentId = await returningAgentStillAvailable(client.lastAgentId);
    const reactivated = await reactivateClientFromLost({
      clientId: request.clientId,
      reason: previousAgentId
        ? "Входящий звонок от потерянного клиента — возвращён прежнему агенту"
        : "Входящий звонок от потерянного клиента — прежний агент недоступен, очередь руководителя",
      agentId: previousAgentId ?? undefined,
      accept: !!previousAgentId,
    });
    if (reactivated.ok) {
      const refreshed = await loadRouteClient(request.phone, request.clientId);
      matchCount = refreshed.matchCount;
      client = refreshed.client;
    }
  }

  /**
   * РАННИЙ ВОЗВРАТ ИЗ «ОТЛОЖЕННЫХ» ВХОДЯЩИМ ЗВОНКОМ (задача G, план 03-04.09.2026).
   * decideRoute сам по себе НЕ проверяет workStatus (только status/acceptedAt/
   * assignedAgent — см. документацию функции выше), поэтому звонок отложенного
   * клиента и без этой правки ушёл бы напрямую тому же агенту. Но
   * Client.workStatus остался бы DEFERRED навсегда (слот в лимите не
   * освобождался бы обратно, а крон позже прислал бы избыточный «возврат по
   * таймеру») — снимаем отсрочку здесь же, тем же принципом раннего возврата,
   * что и у сообщений (services/leads/intake.ts), той же функцией
   * (lib/deferredClients.ts::returnDeferredClientEarly). Агент не меняется —
   * lastAgentId/requestedAgentStillAvailable здесь не нужны, карточка и так его.
   */
  if (client && !client.deletedAt && client.workStatus === "DEFERRED" && request.clientId) {
    const returned = await returnDeferredClientEarly(request.clientId);
    if (returned.ok) {
      const refreshed = await loadRouteClient(request.phone, request.clientId);
      matchCount = refreshed.matchCount;
      client = refreshed.client;
    }
  }

  /**
   * СНАЧАЛА ВСЁ, ЧТО ЗНАЕТ БАЗА, И ТОЛЬКО ПОТОМ ВОПРОСЫ СТАНЦИИ. Справочный запрос
   * о состоянии трубки на каждом звонке с незнакомого номера — это задержка на
   * пути, где живой человек слушает музыку ожидания.
   */
  const preliminary = decideRoute({
    enabled: true,
    matchCount,
    client,
    dial: { target: "", viaMobile: false },
    busy: false,
    answered: false,
  });
  if (!preliminary.routed) return preliminary;

  const ari = await loadAriCredentials();
  if (!ari) return { routed: false, reason: "station_not_configured" };

  const decision = decideRoute({
    enabled: true,
    matchCount,
    client,
    dial: await resolveDialTarget(ari, preliminary.extension, client?.assignedAgent?.phone ?? null),
    busy: hasLiveCall(preliminary.agentId),
    answered: request.isAnswered(),
  });
  if (!decision.routed) return decision;

  const creds = await loadAmiCredentials();
  if (!creds) return { routed: false, reason: "station_not_configured" };
  const dialplanStatus = await stationHasRouteContext(creds);
  if ("unknown" in dialplanStatus) return { routed: false, reason: "dialplan_unknown" };
  if (!dialplanStatus.present) return { routed: false, reason: "no_dialplan" };
  // Последняя проверка перед действием: поход к станции занял время, и трубку
  // могли снять. Перевод уже отвеченного звонка оборвал бы живой разговор.
  if (request.isAnswered()) return { routed: false, reason: "already_answered" };

  /**
   * ПОДСКАЗКА АГЕНТУ — что он услышит в ухо, сняв трубку. Необязательна: файла может
   * ещё не быть (клиента завели минуту назад), возможность может быть выключена. Во
   * всех таких случаях соединяем молча, как соединяли до 20.08.2026.
   */
  const whisperFile = request.clientId
    ? await whisperFileForCall({
        clientId: request.clientId,
        agentWhisperLanguage: client?.assignedAgent?.whisperLanguage,
        direction: "in",
      }).catch(() => null)
    : null;

  const redirected = await redirectChannelToAgent({
    channelName: request.channelName,
    extension: decision.extension,
    dialTarget: decision.dialTarget,
    viaMobile: decision.viaMobile,
    // Свой клиент: полное routeRingSeconds при любом режиме консультанта
    // (владелец 11.10.2026; с 02.10 при консультанте было не дольше его ожидания).
    ringSeconds: settings.routeRingSeconds,
    // Решение владельца 04.09.2026: автоответчик нигде не нужен — не позвонил
    // агент за routeRingSeconds, звонок просто кладётся, без записи и без
    // очереди операторов (та же логика, что убрала дежурного — общий приём
    // не должен доставаться клиенту чужого агента). Отменяет решение 29.08.2026
    // (тогда вместо voicemail был бы возврат в очередь).
    // 22.09.2026 владелец: «не взял агент — автоответчик + задача перезвонить
    // и пуш ЭТОМУ агенту, оператору никогда». Отбой сменён на голосовую почту;
    // задачу и пуш заводит пропущенный звонок (finishIncomingCall/notifyMissed).
    // 11.10.2026 владелец: «робот НЕ отвечает клиентам агента» — "voicemail" ВСЕГДА,
    // и диалплан в этой ветке консультанта больше не зовёт (ни при каком aimode).
    // "ai" — только у перевода, который сделал сам консультант (liveVoiceTransfer.ts).
    fallback: "voicemail",
    isAnswered: request.isAnswered,
    whisperFile,
    logLabel: `входящий ${request.phone} переведён на ответственного`,
    failLabel: `Входящий не переведён на ответственного (${decision.extension})`,
  });
  if (!redirected.ok) return { routed: false, reason: redirected.reason };
  return decision;
}

/**
 * ПЕРЕВОД КАНАЛА НА АГЕНТА — весь разговор со станцией об одном звонке в одном месте.
 *
 * Вынесено отдельной функцией 20.08.2026, когда рядом появился второй путь перевода —
 * незнакомый звонок лучшему свободному агенту по очереди KPI (`kpiQueueRouting.ts`).
 * Тот путь в тот же день откатили до доработки, и сейчас вызывающий снова один, но
 * функция остаётся экспортируемой намеренно: пути отличаются ровно тем, КАК выбран
 * агент, а разговор со станцией у них обязан быть одинаковым. Своя копия Setvar и
 * Redirect во втором модуле однажды разъедется с этой, и разница вылезет посреди
 * живого звонка.
 *
 * Куда и сколько звонить станция узнаёт из переменных канала, а не из набранного
 * номера: у внутреннего номера и мобильного разные способы набора, и разбирать это в
 * диалплане по длине строки значит ждать дня, когда внутренние номера станут
 * пятизначными.
 *
 * Отказ Setvar на времени звонка не фатален (у диалплана своё умолчание), но фатален
 * на адресе: без него станция не будет знать, кому звонить, и уведёт клиента прямо в
 * очередь. Безопасно, но бессмысленно — поэтому при отказе просто не переводим.
 */
/** Куда вернуть звонок, если агент не ответил, — см. redirectChannelToAgent. */
export type RouteFallback = "voicemail" | "queue" | "hangup" | "ai";

/**
 * Обязательные переменные перевода — ОДИН список на оба способа доставить их
 * станции (AMI Setvar у redirectChannelToAgent, ARI у continueStasisChannelToAgent):
 * диалплан royalhome-agent-route читает ровно эти имена, и две копии списка
 * однажды разъехались бы посреди живого звонка.
 */
function routeVariables(input: {
  dialTarget: string;
  viaMobile: boolean;
  ringSeconds: number;
  fallback: RouteFallback;
}): [string, string][] {
  return [
    [ROUTE_TARGET_VAR, input.dialTarget],
    [ROUTE_MOBILE_VAR, input.viaMobile ? "1" : "0"],
    [ROUTE_TIMEOUT_VAR, String(input.ringSeconds)],
    [ROUTE_FALLBACK_VAR, input.fallback],
  ];
}

export async function redirectChannelToAgent(input: {
  channelName: string;
  extension: string;
  dialTarget: string;
  viaMobile: boolean;
  ringSeconds: number;
  /**
   * Куда вернуть звонок, если агент не ответил:
   * "hangup" (владелец 04.09.2026, отменяет "voicemail" от 29.08.2026) —
   * известному клиенту его агента: ни очередь операторов, ни автоответчик
   * агентству больше не нужны нигде — просто отбой (см. inboundRouting.ts,
   * вызов в attemptRoute);
   * "queue" — незнакомому звонку по KPI-очереди/дежурному (`kpiQueueRouting.ts`,
   * `dutyRosterRouting.ts`), для которого очередь операторов остаётся законным
   * запасным путём;
   * "voicemail" — оставлен диалпланом станции как штатный третий вариант
   * (см. royalhome-agent-route), сейчас в коде CRM никем не выставляется;
   * "ai" — назад к консультанту на телефоне (перевод от консультанта,
   * continueStasisChannelToAgent ниже).
   */
  fallback: RouteFallback;
  /** Проверяется ещё раз перед самим Redirect: перевод отвеченного звонка оборвал бы
   *  живой разговор. */
  isAnswered: () => boolean;
  /** Имя файла подсказки на станции; null — соединяем молча. */
  whisperFile?: string | null;
  /** Как назвать удачный перевод в консоли и неудачный — в «Здоровье системы». */
  logLabel: string;
  failLabel: string;
  // Возвращаем ровно три причины, а не весь RouteSkipReason: остальные («номера нет
  // в базе», «лид не принят», «агент занят») решаются ДО разговора со станцией и к
  // самому переводу отношения не имеют. Узкий тип позволяет обоим вызывающим —
  // и переводу известного клиента, и очереди по KPI — разобрать исход целиком.
}): Promise<
  { ok: true } | { ok: false; reason: "station_not_configured" | "redirect_failed" | "already_answered" }
> {
  const creds = await loadAmiCredentials();
  if (!creds) return { ok: false, reason: "station_not_configured" };

  const vars = routeVariables(input);

  /**
   * ОДНА AMI-СЕССИЯ НА ВСЮ ЦЕПОЧКУ (06.09.2026, разбор двойного звонка 05.09 —
   * клиент Шарипов Кодирчон). Раньше здесь было до пяти отдельных amiAction() —
   * каждый открывал свой TCP-сокет и заново проходил Login через туннель офис↔VPS.
   * Пока набиралась эта цепочка, станция уже звонила клиенту дефолтным номером
   * напрямую по диалплану, и звонящий успевал положить трубку раньше, чем CRM
   * успевала перевести звонок. `withAmiConnection` держит один сокет на всю
   * цепочку Setvar+Redirect и закрывает его сразу после — не постоянное
   * соединение (см. заголовок amiClient.ts), просто одно действие места вызова
   * вместо пяти.
   */
  try {
    return await withAmiConnection(creds, async (send) => {
      for (const [name, value] of vars) {
        const set = await send(
          "Setvar",
          { Channel: input.channelName, Variable: name, Value: value },
          { timeoutMs: ROUTE_AMI_TIMEOUT_MS }
        );
        if (!set.ok) {
          void logSystemError("telephony", `${input.failLabel}: станция не приняла ${name}: ${set.error}`);
          return { ok: false, reason: "redirect_failed" } as const;
        }
      }

      // Подсказка ставится ПОСЛЕ обязательных переменных и её отказ игнорируется:
      // звонок важнее подсказки, и молчание в ухо агенту не повод оставить клиента
      // в очереди.
      if (input.whisperFile) {
        await send(
          "Setvar",
          { Channel: input.channelName, Variable: ROUTE_WHISPER_VAR, Value: input.whisperFile },
          { timeoutMs: ROUTE_AMI_TIMEOUT_MS }
        );
      }

      // Последняя проверка перед действием: разговоры со станцией заняли время, и
      // трубку могли снять.
      if (input.isAnswered()) return { ok: false, reason: "already_answered" } as const;

      const redirect = await send(
        "Redirect",
        { Channel: input.channelName, Context: ROUTE_CONTEXT, Exten: ROUTE_EXTEN, Priority: 1 },
        { timeoutMs: ROUTE_AMI_TIMEOUT_MS }
      );
      if (!redirect.ok) {
        // Неудачный Redirect ничего не двигает: канал остаётся там, где был, — в
        // очереди. Поэтому это строка в журнале, а не потерянный клиент.
        void logSystemError("telephony", `${input.failLabel}: ${redirect.error}`);
        return { ok: false, reason: "redirect_failed" } as const;
      }

      console.log(
        `[телефония] ${input.logLabel} ${input.extension} ` +
          `(${input.viaMobile ? `мобильный ${input.dialTarget}` : "трубка"}), ` +
          `звоним ${input.ringSeconds ? `${input.ringSeconds} с` : "без ограничения"}, ` +
          `дальше ${input.fallback === "voicemail" ? "голосовая почта" : "очередь"}`
      );
      return { ok: true } as const;
    });
  } catch (err) {
    // Login отклонён или соединение не удалось вовсе — та же классификация, что у
    // провалившегося первого Setvar: станция недоступна, канал остаётся где был.
    void logSystemError("telephony", `${input.failLabel}: станция не приняла соединение: ${describeError(err)}`);
    return { ok: false, reason: "redirect_failed" };
  }
}

/**
 * ПЕРЕВОД АГЕНТУ КАНАЛА, КОТОРЫЙ ДЕРЖИТ КОНСУЛЬТАНТ (24.09.2026, робозвонок).
 *
 * Тот же контекст royalhome-agent-route и те же переменные (routeVariables), что у
 * redirectChannelToAgent, но другой транспорт: канал сидит в Stasis-приложении
 * живого голоса, и вывести его оттуда в диалплан — это ARI `continue`, родной для
 * такого канала путь. Отказ переменной-адреса — отказ перевода (канал остаётся с
 * консультантом, и тот говорит, что агент перезвонит); отказ подсказки не мешает.
 */
export async function continueStasisChannelToAgent(input: {
  channelId: string;
  dialTarget: string;
  viaMobile: boolean;
  ringSeconds: number;
  fallback: RouteFallback;
  whisperFile?: string | null;
  failLabel: string;
}): Promise<boolean> {
  const ari = await loadAriCredentials();
  if (!ari) return false;
  for (const [name, value] of routeVariables(input)) {
    const set = await setChannelVariable(ari, input.channelId, name, value);
    if (!set.ok) {
      void logSystemError("telephony", `${input.failLabel}: станция не приняла ${name}: ${set.error}`);
      return false;
    }
  }
  if (input.whisperFile) await setChannelVariable(ari, input.channelId, ROUTE_WHISPER_VAR, input.whisperFile);
  const moved = await continueInDialplan(ari, input.channelId, { context: ROUTE_CONTEXT, extension: ROUTE_EXTEN, priority: 1 });
  if (!moved.ok) {
    void logSystemError("telephony", `${input.failLabel}: ${moved.error}`);
    return false;
  }
  return true;
}

/**
 * Карточка звонящего и число карточек по этому номеру — ЖИВЫМ ЗАПРОСОМ, на каждый
 * звонок. Ответственный меняется передачей клиента, отказом и увольнением; кэш
 * здесь означал бы звонок бывшему агенту.
 */
async function loadRouteClient(
  phone: string,
  clientId: string | undefined
): Promise<{ matchCount: number; client: RouteClient | null }> {
  if (!clientId) return { matchCount: 0, client: null };

  const found = await prisma.client.findUnique({
    where: { id: clientId },
    select: {
      deletedAt: true,
      status: true,
      workStatus: true,
      acceptedAt: true,
      lastAgentId: true,
      assignedAgent: {
        select: { id: true, isActive: true, frozenAt: true, sipExtension: true, phone: true, whisperLanguage: true },
      },
    },
  });
  if (!found) return { matchCount: 0, client: null };
  const client: RouteClient = {
    deletedAt: found.deletedAt,
    status: found.status,
    workStatus: found.workStatus,
    acceptedAt: found.acceptedAt,
    lastAgentId: found.lastAgentId,
    assignedAgent: found.assignedAgent,
  };
  // Карточка удалена — считать по номеру нечего: решение уже принято, и причина
  // отказа должна назвать Корзину, а не «номера нет в базе».
  if (client.deletedAt) return { matchCount: 1, client };

  /**
   * Считаем карточки по ТОМУ ЖЕ хвосту из девяти цифр, по которому клиента искал
   * входящий звонок (см. findClientByPhoneDigits). Тот при дубликатах молча берёт
   * самую раннюю — для журнала это правильно, для маршрутизации нет: у второй
   * карточки может быть другой ответственный. Удалённые в счёт не идут: дубликат,
   * который человек уже убрал в Корзину, не должен запрещать перевод.
   *
   * Считаем ТЕМ ЖЕ поиском, что и узнавание (findPhoneOwners), а не своим SQL по
   * одной колонке: с появлением запасных номеров (18.08.2026) звонок стал находить
   * клиента и по `extraPhones`, и расхождение между «кого нашли» и «сколько нашли»
   * означало бы отказ в переводе с формулировкой «номер не один» там, где карточка
   * ровно одна, — или наоборот, тихий перевод при настоящей неоднозначности.
   */
  const owners = await findPhoneOwners([phone]);
  return { matchCount: owners.length, client };
}

/**
 * Куда на самом деле звонить агенту — ТЕМ ЖЕ путём, что и кнопка «Позвонить» в
 * карточке клиента (`resolveAgentDialTarget`). Это не экономия кода, а требование
 * владельца 16.08.2026: «если агент CRM недоступен или у него нет интернета, звонок
 * идёт на телефон агента тем же путём, что и раньше». Второй собственный подбор
 * цели означал бы, что входящие и исходящие звонят агенту по-разному, и расхождение
 * вылезло бы ночью, когда браузер закрыт.
 *
 * null — звонить некуда (см. decideRoute).
 */
export async function resolveDialTarget(
  ari: AriCredentials,
  extension: string,
  mobile: string | null
): Promise<{ target: string; viaMobile: boolean } | null> {
  try {
    const mode = await loadAgentDialMode();
    const { agentMobile } = await resolveAgentDialTarget(ari, extension, mobile, mode);
    if (agentMobile) return { target: normalizeDialNumber(agentMobile), viaMobile: true };

    /**
     * Мобильного нет или он запрещён режимом — остаётся аппарат, и он обязан быть
     * НА СВЯЗИ. В режиме «авто» станция уже ответила на этот вопрос (иначе она
     * вернула бы мобильный), но только если мобильный вообще был чем проверять;
     * в остальных случаях спрашиваем сами.
     */
    const endpoints = await listEndpoints(ari);
    return agentDeviceOnline(endpoints, extension) ? { target: extension, viaMobile: false } : null;
  } catch (err) {
    // Станция не ответила на справочный запрос. Догадка здесь стоит клиенту
    // двадцати пяти секунд тишины — оставляем звонок очереди. До 22.09.2026 сам
    // отказ терялся насовсем: звонок уходил в очередь, а причина, почему цель не
    // выбралась, не попадала никуда — владелец видел только «не дозвонились».
    void logSystemError(
      "telephony",
      `Куда звонить агенту на входящем — станция не ответила на справочный запрос, звонок остаётся в очереди: ${describeError(err)}`
    );
    return null;
  }
}

/** Решение — в журнал входящих: по нему видно, работает маршрутизация или нет. */
async function recordDecision(recordId: string | undefined, outcome: RouteOutcome): Promise<void> {
  if (!recordId) return;
  try {
    await prisma.incomingCall.update({
      where: { id: recordId },
      data: {
        // «Ушёл на мобильный» — отдельный код: по нему видно, что агент был без
        // трубки, то есть платное плечо в счёте за связь не сюрприз.
        routeDecision: outcome.routed ? (outcome.viaMobile ? "routed_mobile" : "routed") : outcome.reason,
        routedToId: outcome.routed ? outcome.agentId : null,
      },
    });
  } catch (err) {
    // Решение не записалось — сам звонок от этого не страдает, но диагностика
    // теряется, а именно её здесь и не хватало.
    void logSystemError("telephony", `Решение о переводе входящего не записано: ${describeError(err)}`);
  }
}

/**
 * Сказать станции, что этот звонок оператору можно отдавать прямо сейчас.
 *
 * Зовётся ОДИН раз и только когда решено окончательно, что своего агента у
 * звонка нет (см. RELEASE_VAR выше и routeIncoming в incomingCalls.ts). Пока
 * переменная не выставлена, диалплан держит звонящего на музыке и к оператору
 * не переводит — в этом весь смысл: очередь не должна стартовать наперегонки с
 * решением CRM.
 *
 * НЕ ЖАЛУЕТСЯ на «нет такого канала»: к этой секунде звонящий вполне мог
 * положить трубку сам, и это обычный ход событий, а не поломка (тот же разбор,
 * что у startMoh в ariClient.ts). Настоящий отказ станции — в журнал, но без
 * пуша: звонок от него не теряется, диалплан досчитает свою паузу и отдаст
 * звонок очереди, как делал до 21.09.2026.
 */
export async function releaseChannelToOperator(channelName: string, reason: string): Promise<void> {
  try {
    const creds = await loadAmiCredentials();
    if (!creds) return;
    const result = await amiAction(
      creds,
      "Setvar",
      { Channel: channelName, Variable: RELEASE_VAR, Value: reason || "free" },
      { timeoutMs: ROUTE_AMI_TIMEOUT_MS }
    );
    if (result.ok) return;
    if (/no such channel|channel not found/i.test(result.error ?? "")) return;
    void logSystemError(
      "telephony",
      `Станция не приняла вердикт «звонок не наш» (канал ${channelName}): ${result.error}`
    );
  } catch (err) {
    void logSystemError("telephony", `Вердикт «звонок не наш» не доехал до станции: ${describeError(err)}`);
  }
}

/**
 * Вердикт для станции: «клиент СВОЙ, оператору не отдавать — на автоответчик».
 * Диалплан royalhome-inbound (ops/asterisk/extensions_custom.conf) по этому
 * значению уходит в голосовую почту, а не в очередь 1000.
 */
export const KNOWN_CLIENT_VERDICT = "known_client";

/**
 * Причины отказа, при которых у звонящего НЕТ своего агента, — только они
 * законно отдают звонок оператору (takesUnknownCalls). `already_answered` —
 * трубку уже сняли, делать нечего. `disabled` — владелец сам выключил перевод
 * на ответственного: прежнее поведение целиком.
 *
 * `agent_inactive`/`agent_frozen` — ДОБАВЛЕНЫ 24.09.2026 (ночная проверка,
 * находка №221/З2-2, решение владельца). До этой правки уволенный или
 * замороженный ответственный не считался «нет агента» и звонок уходил
 * запасным путём САМОГО агента ниже (мобильный, которого у него уже нет, —
 * пусто, — и сразу автоответчик), минуя оператора целиком. Владелец решил:
 * звонок клиента уволенного/замороженного агента должен доставаться
 * оператору, как звонок незнакомого номера, — у такого клиента СЕЙЧАС нет
 * работающего ответственного ровно так же, как у клиента без агента вовсе.
 */
const OPERATOR_REASONS = new Set<RouteSkipReason>([
  "no_client",
  "no_agent",
  "client_deleted",
  "already_answered",
  "disabled",
  "agent_inactive",
  "agent_frozen",
]);

/**
 * СВОЙ КЛИЕНТ ОПЕРАТОРУ НЕ ДОСТАЁТСЯ НИКОГДА (владелец 22.09.2026).
 *
 * «Оператору идут только прямые входящие от незнакомых номеров (или клиентов
 * без агента). Клиент с назначенным агентом — никогда оператору.» Замер по
 * проду за четыре дня: 37 звонков клиентов агентов ушли в очередь оператора —
 * любая неудача перевода (занят, не в сети, лид не принят, станция отказала,
 * нет контекста) кончалась releaseChannelToOperator.
 *
 * Теперь такая неудача ведёт звонок по запасному пути САМОГО агента:
 *  1. на мобильный ответственного (Local/<номер>@from-internal — тот же
 *     контекст royalhome-agent-route), если агент работает, не заморожен и
 *     мобильный у него есть;
 *  2. не взял или звонить некуда — голосовая почта; пропущенный звонок сам
 *     заводит назначенному агенту задачу «перезвонить» и пуш
 *     (finishIncomingCall → callbackAgentId/notifyMissed в incomingCalls.ts).
 * Станция не приняла перевод или контекста нет — вердикт KNOWN_CLIENT_VERDICT,
 * и royalhome-inbound уходит в автоответчик, а не в очередь.
 *
 * УВОЛЕННЫЙ/ЗАМОРОЖЕННЫЙ ОТВЕТСТВЕННЫЙ СЮДА НЕ ПОПАДАЕТ ВООБЩЕ (24.09.2026):
 * `agent_inactive`/`agent_frozen` теперь в OPERATOR_REASONS выше, эта функция
 * возвращает `false` для них раньше первой же строки, и звонок идёт обычным
 * путём оператору (releaseChannelToOperator в incomingCalls.ts) — работающий
 * мобильный у такого агента всё равно недоступен ни разу.
 *
 * true — звонок взят этим путём, отпускать его оператору нельзя.
 */
export async function holdKnownClientAwayFromOperator(
  request: RouteRequest,
  reason: RouteSkipReason
): Promise<boolean> {
  if (OPERATOR_REASONS.has(reason)) return false;
  try {
    const { client } = await loadRouteClient(request.phone, request.clientId);
    const agent = client && !client.deletedAt ? client.assignedAgent : null;
    if (!agent) return false;
    if (request.isAnswered()) return true;

    const settings = await loadIncomingSettings();
    const mobile = agent.isActive && !agent.frozenAt && agent.phone ? normalizeDialNumber(agent.phone) : "";
    const creds = await loadAmiCredentials();
    const dialplan = creds ? await stationHasRouteContext(creds) : null;
    if (dialplan && "present" in dialplan && dialplan.present) {
      const redirected = await redirectChannelToAgent({
        channelName: request.channelName,
        extension: agent.sipExtension ?? "",
        // Пустая цель — диалплан сразу уходит на запасной путь (голосовую почту).
        dialTarget: mobile,
        viaMobile: !!mobile,
        ringSeconds: settings.routeRingSeconds,
        fallback: "voicemail",
        isAnswered: request.isAnswered,
        logLabel: `входящий ${request.phone} (${reason}) — мимо оператора, своему агенту`,
        failLabel: `Свой клиент ${request.phone} не уведён от оператора (${reason})`,
      });
      if (redirected.ok || redirected.reason === "already_answered") return true;
    }
    await setKnownClientVerdict(request.channelName);
    return true;
  } catch (err) {
    void logSystemError("telephony", `Свой клиент: запасной путь мимо оператора сорвался: ${describeError(err)}`);
    await setKnownClientVerdict(request.channelName);
    return true;
  }
}

async function setKnownClientVerdict(channelName: string): Promise<void> {
  try {
    const creds = await loadAmiCredentials();
    if (!creds) return;
    const result = await amiAction(
      creds,
      "Setvar",
      { Channel: channelName, Variable: RELEASE_VAR, Value: KNOWN_CLIENT_VERDICT },
      { timeoutMs: ROUTE_AMI_TIMEOUT_MS }
    );
    if (result.ok || /no such channel|channel not found/i.test(result.error ?? "")) return;
    void logSystemError("telephony", `Станция не приняла вердикт «свой клиент» (канал ${channelName}): ${result.error}`);
  } catch (err) {
    void logSystemError("telephony", `Вердикт «свой клиент» не доехал до станции: ${describeError(err)}`);
  }
}
