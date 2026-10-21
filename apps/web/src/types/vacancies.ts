import type { CustomerRecruitmentPortfolio, RecruitmentResume, RecruitmentFactKey } from "@royal-home/shared";
import type { ConversationMessage, MessageAttachment } from "../types";

// API DTOs are independent of React hooks and query builders.
/** Анкета кандидата, собранная ботом в переписке (см. раздел «Вакансии»). */
export interface JobApplication {
  recruitmentResume?: RecruitmentResume | null;
  recruitmentAssessment?: { missing: RecruitmentFactKey[]; warnings: string[]; readyForReview: boolean };
  positionKey?: string | null;
  customerInquiryId?: string | null;
  positionTitle?: string | null;
  customerPortfolio?: CustomerRecruitmentPortfolio;
  id: string;
  conversationId: string | null;
  channel: string;
  contactName: string | null;
  name: string | null;
  age: number | null;
  /** Учится ли сейчас в вузе. Курсы и тренинги сюда не входят. */
  studyingUniversity: boolean | null;
  /** Учится ли сейчас где угодно: школа, лицей, колледж, техникум, вуз. Курсы не в счёт. */
  studyingNow: boolean | null;
  /** Работает ли сейчас где-то ещё — совмещение нам не подходит. */
  employedNow: boolean | null;
  city: string | null;
  education: string | null;
  /** Приоритет отбора. Внутренняя пометка — кандидату её никогда не называют. */
  priority: "GREEN" | "YELLOW" | "RED" | null;
  priorityReason: string | null;
  /** Прошёл ли обязательный фильтр: от 24 лет, нигде сейчас не учится и не работает. */
  eligible: boolean | null;
  /** «Всё равно позвать» (02.10.2026): руководитель взял в работу вопреки отбору.
   *  true — анкета в «Подходят», хотя eligible=false. Нет у старого сервера. */
  eligibleOverride?: boolean | null;
  /** Какие обязательные поля бот ещё не выяснил (возраст, учёба, работа, телефон).
   *  Опционально: старый сервер это поле не присылает — экран считает четыре
   *  проверки сам по age/studyingNow/studyingUniversity/employedNow/phone,
   *  см. vacancyChecks в lib/vacanciesView.ts, и `missing` не требуется. */
  missing?: string[];
  /** Почему обязательный отбор не пройден, словами сервера («моложе 24», «учится»,
   *  «работает сейчас»). Опционально по той же причине, что и `missing`; экран,
   *  если поля нет, показывает то же самое через vacancyFilterReason на клиенте. */
  rejectReasons?: string[];
  experience: string | null;
  hasCar: boolean | null;
  languages: string | null;
  startWhen: string | null;
  phone: string | null;
  /** Последний звонок робота с приглашением; `text` — готовая строка от сервера. */
  inviteCall?: {
    status: string;
    outcome: string | null;
    proposedTime: string | null;
    summary: string | null;
    interviewAt: string;
    talkedAt: string | null;
    /** Почему робот не звонил или бросил (no_phone, too_late…); строка `text`
     *  уже называет её словами. Нет у старого сервера. */
    skipReason?: string | null;
    /** Есть запись разговора — анкета показывает «Послушать разговор». Нет у старого сервера. */
    hasRecording?: boolean;
    text: string;
  } | null;
  /** Язык переписки из досье (ru/tg…), null — не решено. Нет у старого сервера. */
  chatLanguage?: string | null;
  /** Был ли опыт именно в продажах/недвижимости; нет у старого сервера. */
  salesExperience?: boolean | null;
  /** Диплом по целевой специальности; нет у старого сервера. */
  targetEducation?: boolean | null;
  /** Сильное желание работать (машина + желание = зелёный, 28.09.2026); нет у старого сервера. */
  strongMotivation?: boolean | null;
  /** Самое большое достижение, словами кандидата; нет у старого сервера. */
  achievements?: string | null;
  rawText: string | null;
  /** Имя файла резюме в закрытом хранилище. Открывается своим маршрутом
   *  /vacancies/:id/cv по праву раздела (02.10.2026): общий /attachments/:name
   *  требует права на вложения переписки, которого у руководителя нет. */
  cvFile: string | null;
  /** Воронка найма (владелец 31.08.2026): NEW → REVIEWED → INTERVIEW →
   *  INTERVIEWED → HIRED, и REJECTED — достижим с любой нетерминальной стадии.
   *  NOT_CANDIDATE (25.09.2026) — анкету завели по ошибке (продавец, покупатель):
   *  сервер исключает такие анкеты из выдачи насовсем, ни в одну корзину они не
   *  попадают, поэтому в VACANCY_PIPELINE/SECTION_ORDER это значение не участвует. */
  status: "NEW" | "REVIEWED" | "INTERVIEW" | "INTERVIEWED" | "HIRED" | "REJECTED" | "NOT_CANDIDATE";
  /** Когда назначено собеседование — обязательно при статусе INTERVIEW. */
  interviewAt: string | null;
  /** Заметки по итогам общения — впечатление, сильные/слабые стороны. */
  interviewNote: string | null;
  /** Почему отказали, словами того, кто принял решение. */
  rejectionReason: string | null;
  rejectionReasonVoiceUrl?: string | null;
  rejectionReasonVoiceTranscript?: string | null;
  /** Когда фактически вышел на работу — выставляется сервером один раз. */
  hiredAt: string | null;
  /** Сильный кандидат, который сейчас не подошёл — вернуться к нему при
   *  следующем наборе. Пометка поверх REJECTED, не отдельная стадия. */
  talentPool: boolean;
  createdAt: string;
  /** Тот же диалог в разделе «Сообщения»: /messages?open=<inboxId>. null —
   *  анкета без переписки. Склейку идентификатора делает сервер (у Telegram
   *  свой префикс), чтобы ссылка не собиралась в двух местах по-разному. */
  inboxId: string | null;
}

/** Переписка кандидата и то, что он прислал файлом (резюме, диплом, фото).
 *  Грузится по требованию — при раскрытии анкеты, а не для всего списка. */
export interface VacancyConversation {
  inboxId: string | null;
  messages: ConversationMessage[];
  /** Вложения из реплик САМОГО кандидата. Наши фотографии объектов сюда не идут. */
  files: MessageAttachment[];
}

/** Тело PATCH — любое подмножество полей. null очищает дату/заметку/причину;
 *  undefined (ключ не передан) оставляет значение как было. */
export interface VacancyPatch {
  /** Explicit HR assignment for legacy applications only; core position is immutable. */
  positionKey?: string;
  status?: JobApplication["status"];
  interviewAt?: string | null;
  interviewNote?: string | null;
  rejectionReason?: string | null;
  rejectionReasonVoiceUrl?: string | null;
  rejectionReasonVoiceTranscript?: string | null;
  talentPool?: boolean;
  /** Правка телефона (найдено 04.09.2026): у бота это единственное поле,
   *  решающее, попадёт ли анкета в очередь — исправить его, если бот записал
   *  криво, было нечем. Сервер нормализует так же, как и записи бота. */
  phone?: string | null;
  /** Робот позвонит кандидату и пригласит на назначенное время (25.09.2026). */
  inviteCall?: boolean;
  /** «Всё равно позвать» из корзины «Не подходят» (02.10.2026): руководитель
   *  берёт кандидата в работу вопреки автоматическому отбору. Сервер хранит это
   *  отдельно от решения бота, и следующий ход бота его не отменяет; false
   *  снимает решение. */
  eligibleOverride?: boolean;
}

/** Ответ PATCH. `inviteCallNote` — почему робот НЕ поставил звонок, простыми
 *  словами (02.10.2026); старый сервер его не присылает. */
export interface VacancyPatchResponse {
  ok: true;
  inviteCallQueued?: boolean;
  inviteCallNote?: string;
}

/** Ответ списка. Кроме анкет — почему список может быть пуст: сколько записей
 *  спрятал обязательный фильтр и собирает ли бот анкеты вообще (рубильник
 *  Настройки → Бот → «Вакансии»). Без этих двух чисел пустой экран врал: он
 *  выглядел одинаково и когда кандидатов не было, и когда их всех отсеяли,
 *  и когда сбор выключен (разбор 03.09.2026). */
export interface VacanciesResponse {
  items: JobApplication[];
  /** Сколько всего анкет под текущим фильтром; `items` — первые `limit` из них.
   *  Экран пишет «Показаны N из M» (02.10.2026). Нет у старого сервера. */
  total?: number;
  /** Собеседования сегодня по Душанбе — все, а не только попавшие в `items`.
   *  Нет у старого сервера: тогда «Сегодня» собирается из загруженного списка. */
  todayInterviews?: JobApplication[];
  /** Сколько анкет скрыто из-за отсутствия телефона: звонить им нечем
   *  (решение владельца 03.09.2026). Данные не удалены — открываются кнопкой.
   *  Значимо только в корзине «Дособрать»: там телефон — одна из проверок. */
  noPhoneCount: number;
  /** Собирает ли бот анкеты прямо сейчас. false — рубильник выключен. */
  collecting: boolean;
  /** Сколько анкет на каждой стадии воронки — сводка над списком в корзине
   *  «Подходят», она же навигация. Считается без фильтра по статусу, но с
   *  учётом поиска, корзины и приоритета. */
  counts: Record<VacancyStage, number>;
  /** Сколько кандидатов каждого цвета. Число стоит прямо в списке выбора: цвет,
   *  за которым никого нет, видно ДО нажатия — иначе выбор без результата
   *  читается как сломанная кнопка (жалоба владельца 03.09.2026). */
  priorityCounts: Record<VacancyPriorityFilter, number>;
  /** Сколько анкет в каждой корзине отбора (25.09.2026, разбор жалобы «приходят
   *  и 23-летние, и работающие»): fit = eligible true, incomplete = eligible
   *  null (бот ещё не всё спросил), rejected = eligible false. Число нужно ДО
   *  переключения корзины — та же причина, что у priorityCounts. Опционально:
   *  старый сервер, не знающий про `bucket`, это поле не пришлёт, тогда плитки
   *  показывают 0 и переключение корзины не фильтрует список (сервер не понимает
   *  параметр `bucket` и отдаёт всё как раньше) — ограничение старого сервера,
   *  не баг экрана. */
  bucketCounts?: Record<VacancyBucket, number>;
}

/** Цвет светофора как фильтр. NONE — «опыт не выяснен»: это тоже осмысленный
 *  выбор, а не отсутствие фильтра. */
export type VacancyPriorityFilter = NonNullable<JobApplication["priority"]> | "NONE";

/** Стадии воронки, для которых сервер считает `counts`/показывает секции на
 *  экране. NOT_CANDIDATE сервер исключает из выдачи целиком (см. `status` в
 *  JobApplication) — сводки по нему никогда не бывает, поэтому он не входит. */
export type VacancyStage = Exclude<JobApplication["status"], "NOT_CANDIDATE">;

/**
 * Корзина отбора (25.09.2026, разбор жалобы сотрудника «мне приходят и
 * 23-летние, и те, кто работает» — обязательный отбор молчал, потому что
 * `eligible: null` читался как «прошёл»). Отдельное измерение от `status`
 * (воронка найма): корзина — решение автоматического отбора, `status` — где
 * кандидат в процессе найма. fit = eligible true, incomplete = eligible null
 * (бот ещё не всё спросил), rejected = eligible false.
 */
export type VacancyBucket = "fit" | "incomplete" | "rejected";

/** Что сейчас ищут и по чему нарезают очередь. Всё уходит на сервер: выборка
 *  ограничена пределом, и фильтрация на клиенте искала бы по первой сотне. */
export interface VacancyFilters {
  offset?: number;
  includeFiltered?: boolean;
  activeOnly?: boolean;
  positionKey?: string;
  status?: JobApplication["status"];
  /** Корзина отбора — заменила прежний признак `includeFiltered` (убран
   *  25.09.2026: «Отсеянных» теперь читается как корзина «Не подходят»). */
  bucket?: VacancyBucket;
  /** Показывать тех, кто не оставил телефона. Значимо только вместе с
   *  bucket:"incomplete". */
  includeNoPhone?: boolean;
  /** Поиск по имени, телефону, городу, опыту, образованию. */
  q?: string;
  priority?: VacancyPriorityFilter;
  /** Сколько анкет загрузить (сервер отдаёт не больше VACANCY_LIST_MAX). */
  limit?: number;
}
