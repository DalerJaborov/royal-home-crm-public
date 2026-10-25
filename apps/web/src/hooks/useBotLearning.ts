import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { currentSessionEpoch, rollbackInSameSession } from "../lib/sessionGuard";
import { SAFETY_REFETCH_MS } from "../lib/refetchIntervals";

/**
 * Чему бот научился и о чём он спрашивает. Данные закрыты правом settings.view,
 * поэтому хук годится только для экрана Настроек.
 */
export interface BotLesson {
  id: string;
  /** Historical investigation material: view only, excluded from the prompt. */
  investigationOnly?: boolean;
  createdAt: string;
  /** "operator_override" — вместо бота ответил человек; "client_confused" — клиент не понял. */
  kind: "operator_override" | "client_confused" | string;
  channel: string;
  conversationId: string | null;
  /** Что бот сказал перед тем, как всё пошло не так. */
  botMessage: string;
  /** Реплика человека: ответ оператора или слова непонимания клиента. */
  humanMessage: string;
  /** Выведенное правило. null или «—» — правила нет, это вопрос к владельцу. */
  lesson: string | null;
  /** Участвует ли правило в промте бота. */
  active: boolean;
}

/**
 * Одна карточка на экране — представитель группы схлопнутых повторов (владелец
 * 17.09.2026: «повторы исключить полностью, чтобы я сто раз не отвечал на
 * одинаковые сообщения»). `dupCount` === 1 — повторов нет, поле можно не
 * показывать. `dupExamples` — остальные записи той же группы (без текущей,
 * самые свежие первыми, ограничено сервером), нужны только для раскрытия
 * «ещё N таких» и для того, чтобы собрать полный список id перед групповым
 * действием (см. useUpdateBotLessonGroup).
 */
export interface BotLessonGroup extends BotLesson {
  dupCount: number;
  dupExamples: BotLesson[];
}

/** Все id одной группы (представитель + примеры) — то, что уходит в групповое
 *  действие одним запросом. */
export function groupIds(item: BotLessonGroup): string[] {
  return [item.id, ...item.dupExamples.map((x) => x.id)];
}

export interface BotLearning {
  /** Страница ГРУПП (по 20), не сырых строк — см. rulesGroupsTotal ниже. */
  rules: BotLessonGroup[];
  questions: BotLessonGroup[];
  /** Честный count() сырых строк по всей базе (сколько случаев всего, до
   *  схлопывания повторов). */
  rulesTotal: number;
  questionsTotal: number;
  /**
   * Сколько УНИКАЛЬНЫХ групп (18.09.2026, доделка: группировка теперь по
   * всему скану на сервере, а не только по одной странице — иначе один и тот
   * же вопрос всплывал бы на 1-й и 3-й странице отдельными карточками). Это
   * число показывают плитки сверху и счётчик «показано N из M» — не
   * rulesTotal/questionsTotal, те считают сырые строки, а не то, что реально
   * видно на экране.
   */
  rulesGroupsTotal: number;
  questionsGroupsTotal: number;
  activeCount: number;
  /** id правил, которые прямо сейчас реально уходят в промт (после дедупа по
   *  тексту — см. selectActiveLessons на сервере), — честная замена «действует
   *  N из M»: включённых может быть много, а до бота доходят только эти. */
  promptLessonIds: string[];
  /** Длина promptLessonIds — тут же, чтобы не считать на клиенте. */
  promptCount: number;
  /** Потолок промта (12) — сколько правил туда вообще может поместиться. */
  promptLimit: number;
  /** Смещение следующей порции ГРУПП — передать назад в loadMoreBotLessons,
   *  чтобы получить следующую. null — дальше ничего нет. */
  rulesNextOffset: number | null;
  questionsNextOffset: number | null;
}

/**
 * Следующая страница ГРУПП ленты «Обучение бота» (14.09.2026, жалоба владельца:
 * до хвоста списков было не добраться; 18.09.2026 — смещение по группе вместо
 * курсора по сырой строке, тем же приёмом, что уже стоит у находок судьи).
 * Отдельная функция, а не второй useQuery: страниц может быть сколько угодно,
 * и держать их все под своим ключом кэша незачем — компонент сам копит уже
 * показанное в локальном состоянии (см. BotLessonsSection, BotQuestionsSection).
 */
export function loadMoreBotLessons(kind: "rules" | "questions", offset: number) {
  const param = kind === "rules" ? "rulesOffset" : "questionsOffset";
  return api<BotLearning>(`/bot-learning?${param}=${offset}`);
}

export function useBotLearning(options?: { enabled?: boolean }) {
  return useQuery({
    refetchInterval: SAFETY_REFETCH_MS,
    queryKey: ["bot-learning"],
    queryFn: () => api<BotLearning>("/bot-learning"),
    // По умолчанию включён (как было): опция нужна только странице
    // «Обучение бота» — там же читается сводка для шапки, а хук зовётся до
    // проверки права settings.view (правило хуков), и без gate неавторизованная
    // роль ловила бы лишний 403 при каждом заходе на страницу.
    enabled: options?.enabled ?? true,
  });
}

/** Один разбор оборванной переписки — пример под недельными числами. */
export interface LostReview {
  id: string;
  channel: string;
  /** "opted_out" | "follow_ups_exhausted" | "silent" — см. LOST_REASON_LABELS. */
  reason: string;
  /** Шаг, на котором ушёл человек — см. LOST_STAGE_LABELS. */
  stage: string;
  lastMessageAt: string;
  clientMessages: number;
  followUpsSent: number;
  finding: string;
  /** Пусто — вины бота не видно, человек просто ушёл. */
  suggestion: string;
  botMessage: string;
  clientMessage: string;
}

/** Недельная сводка «куда уходят клиенты». */
export interface LostDigest {
  id: string;
  periodStart: string;
  periodEnd: string;
  lostCount: number;
  /** Заявок из мессенджеров за ту же неделю — знаменатель к числу потерь. */
  wonCount: number;
  stageCounts: Record<string, number>;
  reasonCounts: Record<string, number>;
  /** Предложения владельцу. Выключены, пока он их не отметил, — в промт не идут. */
  proposals: BotLesson[];
  reviews: LostReview[];
}

export interface LostDigests {
  digests: LostDigest[];
  /** Разборы, которые войдут в ближайшую сводку. */
  pendingReviews: number;
  /** Сколько разборов всего — примеры внутри сводок обрезаны пределом. */
  reviewsTotal: number;
  /** Честный count() предложений «на решение» по всей базе — не длина текущей
   *  выдачи (14.09.2026: счётчик врал при накоплении сводок старше DIGESTS_LIMIT). */
  pendingProposalsCount: number;
}

/** Что владелец решил по отдельной оборванной переписке. */
export type LostVerdict = "bot_right" | "bot_error" | "delete";

export function useLostDigests() {
  return useQuery({
    refetchInterval: SAFETY_REFETCH_MS,
    queryKey: ["bot-learning", "lost"],
    queryFn: () => api<LostDigests>("/bot-learning/lost"),
  });
}

/**
 * Правило встречается сразу в двух лентах — «Чему бот научился» и предложения в
 * недельной сводке. Обе лежат под ключом ["bot-learning"], поэтому переключённое
 * правило правим в каждой закешированной ленте, а не только в той, где нажали.
 *
 * `ids` — не всегда один элемент (17.09.2026, групповое действие на повторы):
 * тумблер одной схлопнутой карточки на самом деле переключает всю группу, и
 * счётчик «действует N из M» обязан посчитать все переключённые записи разом,
 * а не одну — иначе после группового действия он разъезжается с тем, что видно
 * под ним (часть строк списка ещё не долистана, но реально уже переключена).
 */
function patchLessonEverywhere(qc: ReturnType<typeof useQueryClient>, ids: string[], active: boolean) {
  const idSet = new Set(ids);
  qc.setQueriesData<unknown>({ queryKey: ["bot-learning"] }, (old: unknown) => {
    if (!old || typeof old !== "object") return old;
    function map<T extends BotLesson>(list: T[]): T[] {
      return list.map((x) => (idSet.has(x.id) ? { ...x, active } : x));
    }

    if ("rules" in old) {
      const data = old as BotLearning;
      const flippedCount = data.rules.filter((x) => idSet.has(x.id) && x.active !== active).length;
      // Счётчик «действует N из M» стоит в шапке карточки: не поправить его —
      // и заголовок разойдётся с тем, что видно в списке под ним.
      const activeCount = data.activeCount + (active ? flippedCount : -flippedCount);
      return { ...data, rules: map(data.rules), questions: map(data.questions), activeCount };
    }
    if ("digests" in old) {
      const data = old as LostDigests;
      return { ...data, digests: data.digests.map((d) => ({ ...d, proposals: map(d.proposals) })) };
    }
    return old;
  });
}

/**
 * Выключить неудачное правило или вписать свой ответ вместо него.
 *
 * Выключение отзывается сразу: правило перестаёт уходить в промт бота, и ждать
 * ответа сервера, глядя на невыключившийся тумблер, тут не за чем. Отказ вернёт
 * прежнее положение, а сообщение об ошибке показывает экран.
 */
export function useUpdateBotLesson() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: { id: string; active?: boolean; lesson?: string }) =>
      api<BotLesson>(`/bot-learning/${id}`, { method: "PATCH", body }),
    onMutate: async ({ id, active }) => {
      // Вписанный ответ переносит случай из «вопросов» в «правила» — такое
      // предсказывать не беремся, дожидаемся перезапроса.
      if (active === undefined) return { snapshot: [], epoch: currentSessionEpoch() };
      await qc.cancelQueries({ queryKey: ["bot-learning"] });
      const snapshot = qc.getQueriesData<unknown>({ queryKey: ["bot-learning"] });
      patchLessonEverywhere(qc, [id], active);
      return { snapshot, epoch: currentSessionEpoch() };
    },
    onError: (_err, _vars, context) => {
      rollbackInSameSession(context?.epoch, () => {
        for (const [key, data] of context?.snapshot ?? []) qc.setQueryData(key, data);
      });
    },
    // Ответ владельца переезжает из «вопросов» в «правила», а выключение меняет
    // счётчик действующих — обе ленты приходят одним запросом, поэтому перезапрос.
    // Ключ ["bot-learning"] совпадает по префиксу и со сводками ["bot-learning","lost"]:
    // включённое предложение из сводки переезжает в «Чему бот научился», и второй
    // список обязан обновиться тем же нажатием.
    onSuccess: () => qc.invalidateQueries({ queryKey: ["bot-learning"] }),
  });
}

/**
 * То же самое, но на ВСЮ группу схлопнутых повторов сразу — одним запросом
 * (владелец 17.09.2026: «повторы исключить полностью, чтобы я сто раз не
 * отвечал на одинаковые сообщения»). `ids` — представитель карточки на экране
 * плюс все `dupExamples` под ней (см. groupIds выше).
 */
export function useUpdateBotLessonGroup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ ids, ...body }: { ids: string[]; active?: boolean; lesson?: string }) =>
      api<{ ok: true; count: number }>(`/bot-learning/group`, { method: "PATCH", body: { ids, ...body } }),
    onMutate: async ({ ids, active }) => {
      if (active === undefined) return { snapshot: [], epoch: currentSessionEpoch() };
      await qc.cancelQueries({ queryKey: ["bot-learning"] });
      const snapshot = qc.getQueriesData<unknown>({ queryKey: ["bot-learning"] });
      patchLessonEverywhere(qc, ids, active);
      return { snapshot, epoch: currentSessionEpoch() };
    },
    onError: (_err, _vars, context) => {
      rollbackInSameSession(context?.epoch, () => {
        for (const [key, data] of context?.snapshot ?? []) qc.setQueryData(key, data);
      });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["bot-learning"] }),
  });
}

/**
 * «Поднять» — сделать правило снова самым свежим, чтобы оно попало в число тех,
 * что реально уходят в промт (см. promptLessonIds/promptLimit у BotLearning).
 * Решение владельца по умолчанию (17.09.2026): сортировка промта — по
 * `createdAt`, отдельного поля «важность» схема не заводит, обновление даты
 * существующей записи даёт тот же эффект без миграции.
 */
export function useBumpBotLesson() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<BotLesson>(`/bot-learning/${id}/bump`, { method: "POST" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["bot-learning"] }),
  });
}

/**
 * Убрать правило совсем — вместе с первоисточником, необратимо. Нужно потому, что
 * выключенные правила иначе копятся в списке навсегда и заслоняют действующие.
 * Подтверждение спрашивает экран: отменить это нечем.
 *
 * Одиночное действие нарочно (17.09.2026): в отличие от переключения и ответа,
 * удаление необратимо и стирает первоисточник — молча удалять группой то, что
 * представитель карточки лишь напоминает по смыслу, слишком рискованно.
 * Владелец удаляет ровно ту запись, которую видит, а «ещё N таких» открывается
 * рядом отдельно.
 */
export function useDeleteBotLesson() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<{ ok: true; id: string }>(`/bot-learning/${id}`, { method: "DELETE" }),
    // Тот же префикс ключа, что у правки: пропавшее правило могло быть и
    // предложением из недельной сводки, и она обязана обновиться тем же нажатием.
    onSuccess: () => qc.invalidateQueries({ queryKey: ["bot-learning"] }),
  });
}

/**
 * Решение по одной оборванной переписке: «бот прав», «бот ошибся — разобрать»
 * или «удалить». Все три убирают карточку из списка — сотня примеров, с которыми
 * нельзя ничего сделать, была главной жалобой владельца (30.08.2026).
 *
 * Без предсказания результата: «бот ошибся» заводит случай в очередь обучения, и
 * вторая лента (вопросы бота) обязана обновиться тем же нажатием — это видно
 * только с сервера. Общий префикс ключа обновляет обе.
 */
export function useResolveLostReview() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, verdict }: { id: string; verdict: LostVerdict }) =>
      api<{ ok: true; id: string; lessonCreated: boolean }>(`/bot-learning/lost/reviews/${id}/resolve`, {
        method: "POST",
        body: { verdict },
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["bot-learning"] }),
  });
}
