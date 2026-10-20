/**
 * КАТАЛОГ СОБЫТИЙ ROYAL SCORE — ОДИН НА СЕРВЕР И НА ЭКРАН НАСТРОЕК.
 *
 * Список и цены по умолчанию — таблица владельца (01.08.2026, часть 3),
 * дословно в `docs/owner-spec-verbatim-31-07-01-08-2026.md`. Правило оттуда же:
 * «ни одно число не должно быть прописано в коде» — цену каждого события
 * владелец меняет в Настройках → Команда → Royal Score, и умолчание здесь это
 * именно умолчание, а не значение.
 *
 * ПОЧЕМУ КАТАЛОГ ПЕРЕЕХАЛ СЮДА (10.09.2026). Список жил в двух копиях: цены —
 * в `apps/api/src/lib/scoreJournal.ts`, подписи и группы — в
 * `apps/web/src/pages/settings/TeamTab.tsx`. Копии разошлись молча, и это не
 * косметика: экран Настроек отправляет `royalScoreEventPoints` ЦЕЛИКОМ, тем
 * набором ключей, который знает сам, а сервер записывает присланный объект
 * поверх прежнего. Значит событие, которого на экране нет, не только нельзя
 * настроить — сохранение формы стирало ранее заданную ему цену. Так вышло с
 * `lead_ignored` (заведён 12.08.2026) и `client_recovered_bonus` (01.09.2026):
 * оба начисляются на проде и оба были невидимы владельцу.
 *
 * Теперь и цены, и подписи берутся отсюда: разойтись больше нечему.
 */

export interface RoyalScoreEventDef {
  key: string;
  /** Подпись в Настройках — как её читает владелец, без служебных слов. */
  label: string;
  /** Цена по умолчанию, баллы. Дробные допустимы (п. 20 таблицы — 2.7). */
  points: number;
  /**
   * false — вид события оставлен только для чтения старых записей журнала:
   * ничего больше не начисляет, и поле для правки было бы кнопкой в никуда.
   * Такие в Настройках не показываются и в PATCH не принимаются.
   */
  editable: boolean;
}

export interface RoyalScoreEventGroup {
  title: string;
  events: readonly RoyalScoreEventDef[];
}

export const ROYAL_SCORE_EVENT_GROUPS = [
  {
    title: "Лиды",
    events: [
      { key: "lead_accepted", label: "Лид принят", points: 0, editable: true },
      { key: "lead_declined_1", label: "Отказ от лида, 1-й подряд", points: 0, editable: true },
      { key: "lead_declined_2", label: "Отказ от лида, 2-й подряд", points: -1, editable: true },
      { key: "lead_declined_3", label: "Отказ от лида, 3-й подряд", points: -2, editable: true },
      { key: "lead_declined_4plus", label: "Отказ от лида, 4-й и далее подряд", points: -3, editable: true },
      /**
       * Заведён 12.08.2026 (голосовое владельца: «пуш пришёл, он ничего не
       * сделал — минус балл»). Отдельно от отказов: там агент хотя бы явно
       * ответил. -2 — между «отказался явно» (-1..-3) и «принял, но не
       * позвонил» (-5); владелец тогда сказал «мы это ещё доработаем», для
       * того цена и настраивается.
       */
      { key: "lead_ignored", label: "Лид молча не принят — карусель отдала его дальше", points: -2, editable: true },
    ],
  },
  {
    title: "Первый контакт и обязательные окна",
    events: [
      { key: "call_15min_missed", label: "Первый звонок не совершён за 15 минут", points: -5, editable: true },
      { key: "call_on_time", label: "Первый звонок совершён вовремя", points: 2, editable: true },
      { key: "mandatory_window_on_time", label: "Обязательное окно заполнено вовремя", points: 1, editable: true },
      { key: "mandatory_window_overdue", label: "Обязательное окно просрочено", points: -2, editable: true },
    ],
  },
  {
    title: "Карточка клиента",
    events: [
      { key: "card_filled", label: "Карточка заполнена полностью", points: 2, editable: true },
      { key: "card_not_filled", label: "Карточка не заполнена", points: -2, editable: true },
    ],
  },
  {
    title: "Показы и встречи",
    events: [
      { key: "showing_done", label: "Показ проведён, итог заполнен", points: 3, editable: true },
      { key: "showing_missed", label: "Показ пропущен", points: -5, editable: true },
      { key: "meeting_done", label: "Встреча с собственником проведена", points: 2, editable: true },
      { key: "meeting_overdue", label: "Встреча просрочена", points: -3, editable: true },
      { key: "task_on_time", label: "Задача выполнена вовремя", points: 1, editable: true },
      { key: "task_overdue", label: "Задача просрочена", points: -2, editable: true },
    ],
  },
  {
    title: "Объекты",
    events: [
      { key: "property_added", label: "Объект добавлен и заполнен", points: 3, editable: true },
      { key: "property_reworked", label: "Объект возвращён на доработку", points: -3, editable: true },
      { key: "property_rework_fixed", label: "Объект исправлен после возврата", points: 2.7, editable: true },
      { key: "photos_approved_first_try", label: "Фото одобрены с первого раза", points: 1, editable: true },
      { key: "video_approved_first_try", label: "Видео одобрено с первого раза", points: 1, editable: true },
      { key: "photos_overdue", label: "Фото не сданы в срок", points: -2, editable: true },
      { key: "video_overdue", label: "Видео не сдано в срок", points: -2, editable: true },
    ],
  },
  {
    title: "Сделки и клиенты",
    events: [
      { key: "deal_closed", label: "Сделка закрыта", points: 10, editable: true },
      { key: "client_lost_agent_fault", label: "Клиент потерян по вине агента", points: -5, editable: true },
      { key: "client_lost_no_fault", label: "Клиент потерян не по вине агента", points: 0, editable: true },
      /**
       * Заведён 01.09.2026: клиента, слитого ДРУГИМ агентом, довёл до сделки
       * нынешний. Пишется вместе с deal_closed, а не вместо неё — это надбавка
       * за то, что подобрал брошенного. Меньше самой сделки (+10), больше нуля:
       * поднять брошенного труднее, чем закрыть своего тёплого.
       */
      { key: "client_recovered_bonus", label: "Довёл до сделки клиента, слитого другим агентом", points: 3, editable: true },
      /**
       * Светофор 2.0 (перенос PR #131, решение владельца 03.09.2026): награда за
       * настойчивость сразу — реальный дозвон вывел клиента из красного или
       * жёлтого светофора неактивности (lib/inactiveTrafficLight.ts), а не
       * только по факту избежания потери в LOST. Из жёлтого меньше: клиент был
       * не так далеко от потери.
       */
      { key: "client_revived_from_red", label: "Дозвон вывел клиента из красного светофора", points: 2, editable: true },
      { key: "client_revived_from_yellow", label: "Дозвон вывел клиента из жёлтого светофора", points: 1, editable: true },
      { key: "security_review", label: "Карточка ушла на проверку СБ", points: 0, editable: true },
      /**
       * Находка аудита 13.09.2026: переоценка ЗАКРЫТОЙ сделки до нулевой
       * комиссии (директор аннулирует сделку задним числом — мошенничество
       * или ошибка) раньше никак не трогала уже начисленные deal_closed/
       * client_recovered_bonus — баллы оставались висеть навсегда. Записи
       * журнала не удаляются (см. lib/scoreJournal.ts) — это КОМПЕНСИРУЮЩЕЕ
       * событие, а не правка/удаление прежней строки.
       */
      { key: "deal_closed_reversed", label: "Сделка аннулирована после закрытия (комиссия обнулена)", points: -10, editable: true },
      { key: "client_recovered_bonus_reversed", label: "Надбавка за возвращённого клиента отменена вместе со сделкой", points: -3, editable: true },
      /**
       * Пачка 11 (11.09.2026, docs/gaps-audit-11-09.md): бот спрашивает отзыв через
       * 3 дня после закрытия сделки. Оценка 4-5 — агент сработал хорошо, награда
       * меньше самой сделки; рекомендация — отдельная надбавка за то, что клиент
       * готов привести кого-то ещё, начисляется вместе, а не вместо оценки.
       */
      { key: "review_received", label: "Получен отзыв 4-5 после сделки", points: 2, editable: true },
      { key: "review_referral", label: "Клиент оставил рекомендацию (номер)", points: 3, editable: true },
    ],
  },
  {
    title: "Бездействие",
    events: [
      { key: "inactivity_warning", label: "Предупреждение о бездействии", points: 0, editable: true },
      { key: "inactivity_penalty", label: "Штраф за бездействие после предупреждения", points: -3, editable: true },
    ],
  },
  {
    title: "Только для чтения старых записей",
    events: [
      /**
       * Общая правка счёта запрещена всем с 03.08.2026 (Fair Play) — вид
       * события остался, чтобы старые строки журнала читались, а не превратились
       * в «неизвестное событие».
       */
      { key: "kpi_override", label: "Ручная правка счёта (запрещена с 03.08.2026)", points: 0, editable: false },
      { key: "lead_missed", label: "Лид не принят вовремя (старое имя call_15min_missed)", points: -5, editable: false },
    ],
  },
] as const satisfies readonly RoyalScoreEventGroup[];

/** Все виды событий журнала — union прямо из каталога, второго списка нет. */
export type ScoreEventKind = (typeof ROYAL_SCORE_EVENT_GROUPS)[number]["events"][number]["key"];

const ALL_EVENTS: readonly RoyalScoreEventDef[] = ROYAL_SCORE_EVENT_GROUPS.flatMap((g) => [...g.events]);

/** Цена каждого события по умолчанию. Переопределяется Settings.royalScoreEventPoints. */
export const DEFAULT_EVENT_POINTS = Object.fromEntries(ALL_EVENTS.map((e) => [e.key, e.points])) as Record<
  ScoreEventKind,
  number
>;

/** Что показывается в Настройках и принимается на правку. */
export const EDITABLE_SCORE_EVENT_KEYS = ALL_EVENTS.filter((e) => e.editable).map((e) => e.key) as [
  ScoreEventKind,
  ...ScoreEventKind[],
];

/** Группы для экрана Настроек — без разделов, где править нечего. */
export const EDITABLE_ROYAL_SCORE_EVENT_GROUPS: readonly RoyalScoreEventGroup[] = ROYAL_SCORE_EVENT_GROUPS.map((g) => ({
  title: g.title,
  events: g.events.filter((e) => e.editable),
})).filter((g) => g.events.length > 0);
