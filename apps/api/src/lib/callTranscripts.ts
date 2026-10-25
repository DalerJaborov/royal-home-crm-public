import { canViewInvestigations } from "@royal-home/shared";
import type { PermissionId } from "@royal-home/shared";
import { maskPhonesDeep, phoneSafeText } from "./clientPhone.js";

/**
 * Кому виден текст разговора — одно правило на всю CRM.
 *
 * ИСТОРИЯ ПРАВИЛА. Решение владельца 07.08.2026: записи и расшифровки не видит
 * никто, кроме администрации, — включая самого агента на его собственные звонки.
 * 15.08.2026 владелец эту часть отменил: «его звонки он сам может и видеть, и
 * посмотреть расшифровку, или прослушать — пусть в хронологии тоже это будет».
 *
 * ЧТО ОСТАЛОСЬ ПРЕЖНИМ. Чужой разговор закрыт по-прежнему, и закрыт он по той же
 * причине: разбор работы сотрудника не должен править тот, чью работу разбирают, а
 * расшифровка целиком — это ещё и контакты, договорённости и формулировки, которым
 * незачем покидать компанию вместе с уходящим человеком.
 *
 * ЧТО ИЗМЕНИЛОСЬ. Свой разговор агент слушает и читает целиком, вместе с разбором и
 * советом, который этим разбором ему же и написан (право calls.ownTranscripts).
 * «Свой» здесь — тот, где агент указан автором записи в хронологии: именно он вёл
 * разговор (у входящих автором становится оператор либо ответственный агент, см.
 * lib/telephony/incomingInteractions.ts).
 *
 * ВХОДЯЩИЙ, ПРИНЯТЫЙ ОПЕРАТОРОМ, ПО-ПРЕЖНЕМУ «СВОЙ» ДЛЯ ОТВЕТСТВЕННОГО АГЕНТА
 * (найдено 16.08.2026 разбором жалобы «не могу найти разговор в карточке»).
 *
 * У входящего звонка автором в хронологии становится ОПЕРАТОР, если станция
 * назвала внутренний номер снявшего трубку (см. lib/telephony/incomingCalls.ts,
 * authorId = operator?.id ?? assignedAgentId). Ответственный агент в этот момент
 * получает push «Ваш клиент звонил в офис — загляните в карточку»
 * (incomingCalls.ts, notifyAnsweredToAgent) — то есть CRM сама зовёт его смотреть
 * именно этот разговор. Но по буквальному правилу «свой = я автор записи» агент
 * автором не значится, и открыв карточку по приглашению самой системы, видит
 * запись под замком «слушать может тот, кто вёл, и администрация» — хотя вёл-то
 * С ЕГО клиентом, просто трубку снял дежурный по очереди.
 *
 * Отличие от передачи клиента (тест call-transcripts-privacy: «разговор коллеги
 * закрыт») принципиальное: там agentId — это ДРУГОЙ ЖИВОЙ АГЕНТ, чья прежняя
 * переписка с клиентом не должна открываться новому владельцу карточки. Здесь
 * agentId — дежурный оператор, ответивший по очереди на ЧУЖОЙ участок; сам
 * разговор всё равно про клиента текущего агента. Различаются они по признаку
 * IncomingCall.interactionId (см. incomingInteractionIds ниже) — передача клиента
 * такой связи не оставляет, только настоящий маршрутизированный звонок.
 *
 * Поэтому «свой» расширен: агент слышит СВОЙ разговор (agentId = он) и
 * маршрутизированный ЕМУ входящий (IncomingCall есть, а клиент карточки сейчас
 * закреплён за ним) — оба варианта под одним и тем же правом calls.ownTranscripts,
 * снять которое директор по-прежнему может одной галочкой.
 *
 * Отдельный файл, а не функция внутри маршрута, — по тому же уроку, что и с
 * телефонами клиентов (lib/clientPhone.ts): правило, записанное в одном маршруте,
 * обходят все остальные, и выглядит это как работающее ограничение.
 *
 * ЧТЕНИЕ И СЛУШАНИЕ РАЗВЕДЕНЫ (04.09.2026, сужение решения 15.08.2026). Владелец
 * сузил доступ к ЗВУКУ: агент по-прежнему читает расшифровку и совет по СВОЕМУ
 * разговору (calls.ownTranscripts не тронуто), но прослушать саму запись не может
 * — ни свою, ни чужую. Слушать целиком (любой разговор) остаётся у DIRECTOR/ADMIN,
 * SECURITY и MARKETING (новое право calls.hearRecording, см. packages/shared/
 * permissions.ts). Причина та же, что у маскировки номеров в тексте: текст можно
 * заменить звёздочками, звук — нет, а в разговоре клиент называет и контакты, и
 * условия сделки открытым текстом.
 *
 * `canReadCall` — старое правило («свой или calls.transcripts»), теперь отвечает
 * ТОЛЬКО за текст (расшифровка, перевод, разбор, notes-маскировка). `canHearCall`
 * — то же самое условие ДОПОЛНИТЕЛЬНО requires calls.hearRecording, отвечает
 * ТОЛЬКО за recordingUrl/аудио-прокси. Кто может слушать, тот всегда может и
 * читать (calls.hearRecording без calls.transcripts/ownTranscripts в пресетах не
 * встречается), обратное — нет.
 */

export interface InteractionWithRecording {
  /** Автор записи в хронологии — тот, чей это разговор. */
  agentId?: string | null;
  transcript?: string | null;
  /** Русский перевод расшифровки. Закрывается ровно так же, как оригинал: пока его
   *  забывали закрыть, весь разговор утекал агенту переводом (найдено 15.08.2026). */
  transcriptRu?: string | null;
  recordingUrl?: string | null;
  /** Разбор качества разговора: счёт, шаги, возражения, совет агенту. */
  callAnalysis?: unknown;
  /** Запись в хронологии — свободный текст, куда номер попадает и руками агента,
   *  и автоматикой из расшифровки. Маскируется по clients.viewPhone (см. ниже). */
  notes?: string | null;
  /** Пересказ разговора и его таджикский вариант — тот же свободный текст. */
  summary?: string | null;
  summaryTj?: string | null;
}

/** Что этот сотрудник вправе услышать и прочитать. */
export interface TranscriptAccess {
  investigations?: boolean;
  /** Кто смотрит — по нему разговор считается своим или чужим. */
  viewerId: string | null;
  /** Право на ЧУЖИЕ разговоры (calls.transcripts). */
  all: boolean;
  /** Право на СВОИ разговоры (calls.ownTranscripts). */
  own: boolean;
  /**
   * Право ВИДЕТЬ НОМЕР клиента (clients.viewPhone) — отдельное от двух верхних
   * (владелец 30.08.2026).
   *
   * «Слушать свой разговор» и «видеть номер клиента» — разные разрешения, и до
   * сих пор второе в этом файле не участвовало вовсе: агент со своим правом на
   * свои разговоры получал расшифровку целиком, а клиент в ней диктует номер
   * голосом. Поле `phone` в том же ответе честно приходило маской — рассогласование
   * было видно невооружённым глазом (routes/calls.ts).
   *
   * Поэтому правило теперь такое: слушать — по правам на разговоры, ЧИТАТЬ
   * НОМЕРА в этих текстах — по clients.viewPhone, независимо друг от друга.
   */
  phone: boolean;
  /**
   * Право СЛУШАТЬ звук (calls.hearRecording, 04.09.2026) — независимо от `all`/
   * `own`, которые теперь отвечают только за ТЕКСТ. См. заголовок файла.
   */
  hearRecording: boolean;
}

/** Из req.agent — без импорта express в общий модуль правил. */
export function transcriptAccess(
  agent: { id: string; role?: string; can: (permission: PermissionId) => boolean } | undefined
): TranscriptAccess {
  if (!agent) return { viewerId: null, all: false, own: false, phone: false, hearRecording: false };
  return {
    viewerId: agent.id,
    investigations: canViewInvestigations(agent.role) && agent.can("clients.securityReview"),
    all: agent.can("calls.transcripts"),
    own: agent.can("calls.ownTranscripts"),
    phone: agent.can("clients.viewPhone"),
    hearRecording: agent.can("calls.hearRecording"),
  };
}

/**
 * Можно ли этому сотруднику ЧИТАТЬ (расшифровку, перевод, разбор, совет) ИМЕННО
 * ЭТОТ разговор. Звука здесь нет — см. canHearCall ниже.
 *
 * Разговор без автора (такого в базе быть не должно, но поле необязательное в типах
 * выборок) своим не считается: неизвестный автор — не основание открывать запись.
 *
 * `routedToViewersClient` — третий, более редкий случай «свой»: входящий звонок,
 * который станция направила в очередь и трубку снял оператор (не сам смотрящий),
 * но клиент СЕЙЧАС закреплён за смотрящим. Считает и передаёт этот признак
 * вызывающий код (нужен join с IncomingCall и текущим assignedAgentId клиента —
 * этого в самом Interaction нет), см. шапку файла.
 */
export function canReadCall(
  access: TranscriptAccess,
  callAgentId: string | null | undefined,
  routedToViewersClient = false
): boolean {
  if (access.all) return true;
  if (!access.own) return false;
  if (!!callAgentId && callAgentId === access.viewerId) return true;
  return routedToViewersClient;
}

/**
 * Можно ли этому сотруднику ПРОСЛУШАТЬ аудиозапись именно этого разговора
 * (04.09.2026). Условие строже, чем у чтения: помимо того же самого «свой или
 * calls.transcripts», обязательно ещё и calls.hearRecording — по умолчанию оно
 * есть только у DIRECTOR/ADMIN (весь набор прав), SECURITY и MARKETING. AGENT и
 * MANAGER читают текст (canReadCall), но эта функция для них всегда false.
 */
export function canHearCall(
  access: TranscriptAccess,
  callAgentId: string | null | undefined,
  routedToViewersClient = false
): boolean {
  return access.hearRecording && canReadCall(access, callAgentId, routedToViewersClient);
}

export type PresentedInteraction<T extends InteractionWithRecording> = Omit<
  T,
  "transcript" | "transcriptRu" | "recordingUrl" | "callAnalysis"
> & {
  transcript: string | null;
  transcriptRu: string | null;
  recordingUrl: string | null;
  callAnalysis: T["callAnalysis"] | null;
  /** Разговор записан и лежит на станции — видно всем, слушать может не каждый. */
  hasRecording: boolean;
  /** Разговор расшифрован — значит карточка могла обогатиться сама. */
  hasTranscript: boolean;
  /**
   * Можно ли этому сотруднику ПРОСЛУШАТЬ запись (не текст — текст управляется
   * отдельно, см. transcript/transcriptRu/callAnalysis ниже, которые присутствуют
   * или равны null уже по признаку чтения).
   *
   * Отдаётся явно, чтобы интерфейс не гадал по пустым полям: «записи нет» и
   * «запись есть, но не для вас» выглядят в JSON одинаково, а на экране должны
   * выглядеть по-разному — плеер либо не показывается вовсе, либо показывается и
   * работает. С 04.09.2026 это ТОЛЬКО про звук (calls.hearRecording) — текст
   * агенту по своим разговорам открыт независимо от этого флага (см. `canRead`).
   */
  canHear: boolean;
  /**
   * Можно ли этому сотруднику ЧИТАТЬ (расшифровку, перевод, разбор) — то, чем до
   * 04.09.2026 был `canHear` целиком. Интерфейс использует этот флаг, чтобы решать,
   * запрашивать ли ленивый текст (см. InteractionTimeline.tsx), не путая его с
   * правом на звук.
   */
  canRead: boolean;
};

export function presentInteraction<T extends InteractionWithRecording>(
  interaction: T,
  access: TranscriptAccess,
  routedToViewersClient = false,
  /** «Расшифровка есть», когда сам текст в выборку НЕ поднимался (карточка клиента
   *  с 26.08.2026 отдаёт хронологию без transcript* — текст грузится по клику). */
  hasTranscriptKnown?: boolean
): PresentedInteraction<T> {
  const hasRecording = !!interaction.recordingUrl;
  const hasTranscript = hasTranscriptKnown ?? !!interaction.transcript;
  // ЧТЕНИЕ (текст) и СЛУШАНИЕ (звук) — с 04.09.2026 разные права, см. заголовок
  // файла. canRead открывает расшифровку/перевод/разбор — как было для AGENT на
  // своих разговорах; canHear закрыт для AGENT/MANAGER независимо от canRead.
  const canRead = canReadCall(access, interaction.agentId, routedToViewersClient);
  const canHear = canHearCall(access, interaction.agentId, routedToViewersClient);
  const presented = {
    ...interaction,
    transcript: canRead ? phoneSafeText(interaction.transcript ?? null, access.phone) : null,
    transcriptRu: canRead ? phoneSafeText(interaction.transcriptRu ?? null, access.phone) : null,
    recordingUrl: canHear ? (interaction.recordingUrl ?? null) : null,
    // Разбор — это тот же разговор, пересказанный машиной: счёт, возражения и совет
    // агенту. Чужому он закрыт вместе с расшифровкой, иначе правило обходится
    // пересказом. Совет по СВОЕМУ разговору остаётся агенту — это чтение, не звук.
    callAnalysis: canRead
      ? (maskPhonesDeep(interaction.callAnalysis ?? null, access.phone) as T["callAnalysis"] | null)
      : null,
    hasRecording,
    hasTranscript,
    canHear,
    canRead,
  };

  /**
   * ХРОНОЛОГИЯ И ПЕРЕСКАЗ — ТРЕТИЙ ПУТЬ ТОГО ЖЕ НОМЕРА (владелец 30.08.2026).
   *
   * `notes` в CRM не маскировал никто и нигде, хотя в него попадает и то, что
   * агент записал руками («перезвонить на 900001016»), и то, что автоматика
   * положила из расшифровки. Стоит здесь, а не в маршрутах: presentInteraction —
   * единственное место, где запись хронологии превращается в ответ, и по тому же
   * уроку из lib/clientPhone.ts правило, записанное в одном маршруте, правилом не
   * является.
   *
   * Ключи перебором, а не по одному полю: список выше уже дважды прирастал
   * (summary, summaryTj), и каждый раз про новое поле забывали.
   *
   * ТРЕТИЙ ЗАХОД (22.09.2026): добавлены `nextAction`, `liveNote` и
   * `voiceNoteTranscript`. Все три — такой же свободный текст, и уезжали они
   * туда же, куда notes: лента активности и календарь выбирают Interaction через
   * `include` без `select`, то есть отдают ВСЕ её строковые колонки.
   * `voiceNoteTranscript` — вообще расшифровка голосового от клиента, где номер
   * звучит чаще всего.
   */
  if (!access.phone) {
    const record = presented as unknown as Record<string, unknown>;
    for (const key of ["notes", "summary", "summaryTj", "nextAction", "liveNote", "voiceNoteTranscript"]) {
      const value = record[key];
      if (typeof value === "string") record[key] = phoneSafeText(value, false);
    }
  }
  return presented;
}

export function presentInteractions<T extends InteractionWithRecording & { id: string }>(
  interactions: T[],
  access: TranscriptAccess,
  /** id тех, что смотрящему «свои» через маршрутизацию (см. canHearCall). */
  routedToViewersClientIds?: ReadonlySet<string>,
  /** id записей с расшифровкой — когда выборка шла без самого текста (см. выше). */
  transcriptIds?: ReadonlySet<string>
): PresentedInteraction<T>[] {
  return interactions.filter((i) => access.investigations || !(i as { investigationOnly?: boolean }).investigationOnly).map((i) =>
    presentInteraction(i, access, routedToViewersClientIds?.has(i.id) ?? false, transcriptIds?.has(i.id))
  );
}
