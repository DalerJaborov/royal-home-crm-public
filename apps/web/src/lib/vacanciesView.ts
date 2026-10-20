import {
  CLIENT_SOURCE_LABELS,
  CONVERSATION_CHANNEL_LABELS,
  DUSHANBE_OFFSET_MS,
  type PermissionId,
} from "@royal-home/shared";
import type { JobApplication, VacancyBucket, VacancyStage } from "../hooks/useVacancies";
import { ApiError } from "./apiError";
import { dushanbeDate, dushanbeInputToIso, dushanbeTime } from "./date";

/**
 * Словари показа анкет кандидатов для экрана «Вакансии» (pages/Vacancies.tsx,
 * один на обе ширины): подписи статусов и приоритетов.
 */

/**
 * Воронка найма (владелец 31.08.2026, по разбору ATS-практик для маленькой
 * команды — без сложного конструктора этапов, просто линейный путь кандидата):
 * NEW → REVIEWED → INTERVIEW → INTERVIEWED → HIRED, и REJECTED — тупиковая
 * стадия, достижимая с любого нетерминального шага, не только с конца очереди.
 * VACANCY_PIPELINE — порядок для кнопок «дальше»/«назад» и для доски; REJECTED
 * и HIRED в него не входят (терминальные, к ним не «идут по кругу»).
 */
export const VACANCY_PIPELINE: readonly VacancyStage[] = [
  "NEW",
  "REVIEWED",
  "INTERVIEW",
  "INTERVIEWED",
  "HIRED",
];

/**
 * Корзина отбора (25.09.2026): решение автоматического отбора, отдельное от
 * стадии найма (VACANCY_PIPELINE). Три плитки сверху экрана в этом порядке —
 * подходят звонить первыми, поэтому корзина по умолчанию.
 */
export const VACANCY_BUCKET_ORDER: readonly VacancyBucket[] = ["fit", "incomplete", "rejected"];

export const VACANCY_BUCKET_LABEL: Record<VacancyBucket, string> = {
  // Коротко: на телефоне плитка в треть ширины, длинная подпись резалась
  // многоточием («Подходят …»). Пояснение — в VACANCY_BUCKET_HINT.
  fit: "Подходят",
  incomplete: "Дособрать",
  rejected: "Не подходят",
};

/** Что лежит в корзине — подсказка к плитке и строка под заголовком списка. */
export const VACANCY_BUCKET_HINT: Record<VacancyBucket, string> = {
  fit: "Прошли отбор и оставили номер — звонить",
  incomplete: "Бот ещё спрашивает возраст, учёбу, работу или номер",
  rejected: "Моложе 24, учатся или работают сейчас",
};

export const VACANCY_STATUS_LABEL: Record<VacancyStage, string> = {
  NEW: "Новая",
  REVIEWED: "Просмотрена",
  INTERVIEW: "Собеседование",
  INTERVIEWED: "Собеседовали",
  HIRED: "Принят на работу",
  REJECTED: "Отказ",
};

/** Короткая формулировка «что делать на этой стадии» — подсказка в пустой
 *  колонке/разделе, тот же приём, что у EMPTY_STAGE_HINT в Deals.tsx. */
export const VACANCY_STATUS_HINT: Record<VacancyStage, string> = {
  NEW: "Анкета пришла, ещё не смотрели.",
  REVIEWED: "Посмотрели анкету, решаем, звать ли на собеседование.",
  INTERVIEW: "Собеседование назначено, дата видна в карточке.",
  INTERVIEWED: "Поговорили, осталось решить: нанять или отказать.",
  HIRED: "Вышел на работу.",
  REJECTED: "Отказали. Кого стоит вспомнить позже, помечены «Кадровый резерв».",
};

export const VACANCY_STATUS_CLASS: Record<VacancyStage, string> = {
  NEW: "bg-blue/10 text-blue",
  REVIEWED: "bg-line-soft text-gray-500",
  INTERVIEW: "bg-amber-bg text-amber",
  INTERVIEWED: "bg-line-soft text-gray-600",
  HIRED: "bg-green-bg text-green",
  REJECTED: "bg-red-bg text-red",
};

/**
 * Те же статусы в языке темы «Royal Home 2026»: классы пилюли `.chip` из
 * прототипа (docs/pult/theme-2026/screens/_components.css), а не Tailwind
 * приложения. Держим рядом с VACANCY_STATUS_CLASS, чтобы подписи и тона
 * задавались в одном месте на оба экрана раздела.
 */
export const VACANCY_STATUS_CHIP: Record<VacancyStage, string> = {
  NEW: "chip",
  REVIEWED: "chip mute",
  INTERVIEW: "chip warn",
  INTERVIEWED: "chip mute",
  HIRED: "chip ok",
  REJECTED: "chip crit",
};

/**
 * Приоритет отбора (правила владельца 16.08.2026). Подписи человеческие, а не
 * «GREEN»: руководителю нужен смысл, а не код из базы. Жёлтого токена в теме нет,
 * поэтому средний приоритет показывается нейтрально.
 *
 * RED раньше подписывался «Без профильного опыта» и красным — тем же цветом, что
 * и статус «Отказ» рядом. У HR это читалось как «этого не берём», хотя решение
 * владельца 31.08.2026 обратное: без опыта продаж мы тоже берём и учим с нуля —
 * это не хуже, а просто другая категория. Цвет и подпись сменили на нейтральные,
 * чтобы карточка не выглядела отказом раньше, чем человек её открыл.
 */
/** Цвета нет — опыт ещё не выяснен. Отдельная пометка, а не пустое место:
 *  пустота читается как «система не сработала», хотя это просто «бот не успел
 *  спросить» (владелец 03.09.2026 про логику светофора). */
export const VACANCY_PRIORITY_UNKNOWN = {
  label: "Опыт не выяснен",
  hint: "Бот ещё не спросил про опыт и образование, цвет появится, когда кандидат расскажет.",
  /** Нейтральный `.dot` темы «Royal Home 2026» — тот же класс, что и у
   *  YELLOW/RED в VACANCY_PRIORITY_DOT_CLASS: цвет здесь не единственный
   *  носитель смысла, слово есть рядом. */
  dotClass: "dot",
} as const;

export const VACANCY_PRIORITY_LABEL: Record<NonNullable<JobApplication["priority"]>, string> = {
  GREEN: "Опыт продаж",
  // Переименовано 25.09.2026 (разбор жалобы «в жёлтых электрики и учителя»):
  // «Смежный опыт» читалось как «что-то около продаж», а правило владельца —
  // конкретный список дипломов (юрист, международник, дизайнер, IT, «усто»).
  // Подпись называет критерий, а не расплывчатую категорию.
  YELLOW: "Диплом по профилю",
  RED: "Без опыта, обучим",
};

/** Короткое пояснение — почему именно такая категория. Живёт в подсказке
 *  (title) у точки светофора, а не отдельным абзацем на карточке: причину
 *  цвета читают по требованию, а не на каждом кандидате сразу (разбор
 *  03.09.2026 — абзац объяснения был самой тяжёлой частью старой карточки). */
export const VACANCY_PRIORITY_HINT: Record<NonNullable<JobApplication["priority"]>, string> = {
  GREEN: "Подтверждённый опыт в продажах или недвижимости, готов включиться быстро",
  YELLOW: "Смежное образование или опыт, быстро войдёт в профессию",
  RED: "Опыта в продажах нет, но берём и таких: курс подготовки риелторов с нуля",
};

/**
 * СВЕТОФОР — ТОЧКА, А НЕ ПИЛЮЛЯ (перерисовано 03.09.2026: «слишком бардачный
 * вид карточки, хочу аккуратную и минималистичную»).
 *
 * Было три закрашенных пилюли на одной строке (приоритет, статус, «отсеян») —
 * карточка спорила сама с собой, что в ней главное. Раздел один: статус
 * воронки — единственная пилюля на карточке; опыт кандидата теперь метит
 * точка перед подписью, тем же приёмом, что у «онлайн»-статуса в мессенджерах.
 * Подпись остаётся нейтрально-серой (text-gray-500 у вызывающих) — цвет несёт
 * одна точка, а не весь ряд текста.
 */
export const VACANCY_PRIORITY_DOT_CLASS: Record<NonNullable<JobApplication["priority"]>, string> = {
  GREEN: "dot ok",
  // Светофор должен читаться светофором (жалоба 25.09.2026: «жёлтые» были
  // серыми и не отличались от «не выяснен»).
  YELLOW: "dot warn",
  RED: "dot crit",
};

/**
 * ОТКУДА ПРИШЁЛ КАНДИДАТ — СЛОВАМИ, НИКОГДА КОДОМ (02.10.2026).
 *
 * Был свой словарь на четыре мессенджера, а `channel` анкеты бывает и каналом
 * переписки (`TELEGRAM_DM`, `LIVE_VOICE`, `WEBSITE`), и источником клиента,
 * переведённого в кандидаты (`PHONE_CALL`, `WALK_IN`, `REFERRAL`,
 * `GOOGLE_ADS` — lib/clientToCandidate.ts на сервере). Всё, чего не было в
 * словаре, строка показывала как есть: «Душанбе · WALK_IN · сегодня».
 *
 * Слова берутся из общих словарей `@royal-home/shared` (канал переписки, затем
 * источник клиента) — своей третьей копии не заводим. Незнакомый код — «Другое»,
 * а не сам код: служебное слово на экране хуже, чем общее.
 */
const VACANCY_EXTRA_CHANNEL_LABEL: Record<string, string> = {
  // Личные сообщения в Telegram через свой аккаунт (новый канал сервера).
  TELEGRAM_DIRECT: "личка Telegram",
};

export function vacancyChannelLabel(channel: string | null | undefined): string {
  if (!channel) return "Другое";
  const label =
    CONVERSATION_CHANNEL_LABELS[channel] ??
    (CLIENT_SOURCE_LABELS as Record<string, string>)[channel] ??
    VACANCY_EXTRA_CHANNEL_LABEL[channel];
  if (!label) return "Другое";
  // Общие словари пишут по-разному («сайт» и «Сайт»): в строке — с заглавной.
  return label.charAt(0).toUpperCase() + label.slice(1);
}

/**
 * ДАТА СОБЕСЕДОВАНИЯ В ФОРМЕ — ВСЕГДА ДУШАНБИНСКОЕ ВРЕМЯ (02.10.2026).
 *
 * Форма делала `new Date(поле).toISOString()`, а строка из
 * <input type="datetime-local"> без пояса трактуется как час УСТРОЙСТВА.
 * Владелец из Стамбула (UTC+3) выбирал 14:00, в базу уезжало 11:00 UTC, а
 * карточка и робот, считающие по Душанбе, называли кандидату 16:00. Обратно —
 * то же: «Перенести» заполняло поле часами браузера.
 *
 * Теперь поле читается и заполняется по Душанбе, как и остальной экран
 * (lib/date.ts, dushanbeInputToIso). Секунды, если браузер их дописал, отбрасываем.
 */
export function interviewInputToIso(local: string): string | null {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::\d{2}(?:\.\d+)?)?$/.exec(local.trim());
  if (!m) return null;
  const iso = new Date(`${m[1]}T${m[2]}:00+05:00`);
  if (Number.isNaN(iso.getTime())) return null;
  return dushanbeInputToIso(m[1], m[2]);
}

/** Момент → значение поля «ГГГГ-ММ-ДДTЧЧ:ММ» в часах Душанбе (UTC+5 круглый год). */
export function interviewIsoToInput(value: string | Date): string {
  const at = value instanceof Date ? value : new Date(value);
  return new Date(at.getTime() + DUSHANBE_OFFSET_MS).toISOString().slice(0, 16);
}

/**
 * Что сказать человеку, если робот звонок не поставил (02.10.2026).
 * Сервер отвечает на PATCH `inviteCallQueued` и, когда звонка не будет,
 * `inviteCallNote` — причину простыми словами. Поле новое и необязательное:
 * старый сервер его не пришлёт, тогда молчим, а не придумываем причину.
 */
export function inviteCallNoteToShow(response: unknown): string | null {
  if (!response || typeof response !== "object") return null;
  const r = response as { inviteCallQueued?: unknown; inviteCallNote?: unknown };
  if (r.inviteCallQueued !== false) return null;
  return typeof r.inviteCallNote === "string" && r.inviteCallNote.trim() ? r.inviteCallNote.trim() : null;
}

/**
 * Кнопка «Всё равно позвать» в корзине «Не подходят» (02.10.2026).
 * Только для тех, с кем работа ещё не началась или уже закончилась отказом:
 * на стадиях «Собеседование»/«Собеседовали»/«Принят» одно нажатие откатывало
 * стадию назад и гасило уже поставленный звонок робота.
 */
export function canOverrideRejected(item: Pick<JobApplication, "status">): boolean {
  return item.status === "NEW" || item.status === "REVIEWED" || item.status === "REJECTED";
}

/** Язык переписки словами (досье считает его по большинству сообщений).
 *  02.10.2026: было «Пишет по-русский» — неверный русский; теперь подпись
 *  «Язык переписки: русский», а незнакомый код — «другой», не сам код. */
const CHAT_LANGUAGE: Record<string, string> = {
  ru: "русский",
  tg: "таджикский",
  // ClientLanguage сервера: пишет вперемешку.
  mixed: "русский и таджикский",
  en: "английский",
  uz: "узбекский",
};

export function vacancyChatLanguageText(code: string): string {
  return CHAT_LANGUAGE[code.trim().toLowerCase()] ?? "другой";
}

/**
 * Пункт «Перевести в кандидаты» в карточке клиента (pages/ClientDetail.tsx).
 * По ПРАВАМ, а не по роли (02.10.2026): сервер пускает по праву clients.assign,
 * а кнопка показывалась по роли — менеджер без права видел пункт, который
 * отвечал отказом. Плюс clients.delete: карточка уходит из списка клиентов,
 * это по сути удаление.
 */
export function canTransferClientToCandidates(can: (permission: PermissionId) => boolean): boolean {
  // Как на сервере (POST /clients/:id/to-candidate): снять агента + доступ к «Вакансиям».
  // clients.delete не требуем — у руководителя (MANAGER) его нет, а кнопкой он пользуется.
  return can("clients.assign") && can("vacancies.view");
}

/** Поисковая строка: сервер принимает не длиннее 80 знаков (routes/vacancies.ts). */
export const VACANCY_SEARCH_MAX = 80;

/** Сколько анкет грузить за раз и сколько всего отдаёт сервер (limit ≤ 200,
 *  routes/vacancies.ts). Дальше — поиском и фильтрами. */
export const VACANCY_LIST_STEP = 100;
export const VACANCY_LIST_MAX = 200;

/**
 * «Показаны N из M» (02.10.2026). Список приходит страницей в `limit` строк, а
 * плитки считают всё — без этой строки кандидаты за пределами страницы молча
 * пропадали, и цифра на плитке не сходилась со списком. null — показаны все.
 * `canLoadMore` — есть ли смысл в кнопке «Показать ещё» (сервер отдаёт не
 * больше VACANCY_LIST_MAX за раз).
 */
export function vacancyShownNote(
  shown: number,
  total: number | undefined,
  limit: number
): { text: string; canLoadMore: boolean } | null {
  if (total === undefined || total <= shown) return null;
  const canLoadMore = limit < VACANCY_LIST_MAX;
  return {
    text: canLoadMore
      ? `Показаны ${shown} из ${total}.`
      : `Показаны ${shown} из ${total}. Остальных найдите поиском или выберите стадию и опыт.`,
    canLoadMore,
  };
}

/**
 * Собеседования на сегодня для блока «Сегодня». Новый сервер присылает их
 * отдельным списком — все, а не только попавшие в загруженную страницу
 * (02.10.2026: собеседование старого кандидата пропадало из блока, хотя плитка
 * «Собеседование» его считала). Старый сервер — запасной путь по странице.
 */
export function vacancyTodayInterviews(
  data: { items: JobApplication[]; todayInterviews?: JobApplication[] } | undefined
): JobApplication[] {
  if (!data) return [];
  if (data.todayInterviews) return data.todayInterviews;
  return data.items.filter(
    (i) => i.status === "INTERVIEW" && i.interviewAt && vacancyInterviewLabel(i.interviewAt).startsWith("сегодня")
  );
}

/**
 * Почему список не загрузился — словами, без текста ошибки сервера (02.10.2026:
 * поиск длиннее 80 знаков показывал «Неверные данные» или технический ответ
 * как есть).
 */
export function vacanciesLoadErrorText(error: unknown): string {
  const status = error instanceof ApiError ? error.status : null;
  if (status === 400) return "Анкеты не загрузились: поиск не понял запрос, сократите или измените его.";
  if (status === 403) return "Анкеты не загрузились: раздел вам закрыт.";
  return "Анкеты не загрузились: нет связи с сервером или он занят.";
}

/** «сегодня в 14:05» / «3 авг в 09:12» — время всегда душанбинское. */
export function vacancyReceivedLabel(createdAt: string): string {
  const day = dushanbeDate(createdAt);
  const today = dushanbeDate(new Date());
  if (day === today) return `сегодня в ${dushanbeTime(createdAt)}`;
  return `${dushanbeDate(createdAt, { day: "numeric", month: "short" })} в ${dushanbeTime(createdAt)}`;
}

/** «Собеседование сегодня в 15:00» / «...31 авг в 15:00» — тот же формат, что у
 *  vacancyReceivedLabel, но с явным словом «сегодня/завтра», потому что дата
 *  здесь в будущем, а не «когда пришло», и спутать их легко. */
export function vacancyInterviewLabel(interviewAt: string): string {
  const day = dushanbeDate(interviewAt);
  const today = dushanbeDate(new Date());
  const tomorrow = dushanbeDate(new Date(Date.now() + 24 * 60 * 60 * 1000));
  if (day === today) return `сегодня в ${dushanbeTime(interviewAt)}`;
  if (day === tomorrow) return `завтра в ${dushanbeTime(interviewAt)}`;
  return `${dushanbeDate(interviewAt, { day: "numeric", month: "short" })} в ${dushanbeTime(interviewAt)}`;
}

/** Прошло ли назначенное время собеседования — карточка «Собеседование» с
 *  просроченной датой теряется среди актуальных, если её не выделить отдельно. */
export function isPastInterview(interviewAt: string): boolean {
  return new Date(interviewAt).getTime() < Date.now();
}

/**
 * ПОЧЕМУ СПИСОК ПУСТ — ОДНИМИ СЛОВАМИ, НА ВСЮ КОРЗИНУ.
 *
 * Разбор 03.09.2026 (владелец: «вакансии так и не приходят в CRM, хотя люди
 * отправляют данные») породил правило: пустой экран обязан называть свою
 * причину словами, а не одной фразой на все случаи — иначе рабочая система
 * читается как сломанная.
 *
 * Переписано 25.09.2026 под три корзины отбора вместо признака
 * `includeFiltered`: «Подходят» пустая не потому, что «никто не писал», а
 * потому, что все ещё в «Дособрать» или все отсеяны в «Не подходят» — это
 * разные причины и разный следующий шаг у человека, поэтому текст называет
 * КУДА смотреть, а не просто «здесь пусто».
 */
export function vacancyEmptyReason(input: {
  /** Выбранная корзина отбора. */
  bucket: VacancyBucket;
  /** Выбранный фильтр по стадии — значим только в корзине «Подходят». */
  status?: JobApplication["status"];
  /** Собирает ли бот анкеты прямо сейчас (рубильник Настройки → Бот). */
  collecting: boolean;
  /** Сводка по корзинам — сколько ждёт в двух других, если в этой пусто.
   *  Опционально: старый сервер bucketCounts не присылает, тогда экран
   *  отвечает общей фразой, без числа. */
  bucketCounts?: Record<VacancyBucket, number>;
  /** Сколько анкет корзины «Дособрать» спрятано из-за отсутствия телефона. */
  noPhoneCount: number;
  /** Анкеты без телефона уже показаны. */
  includeNoPhone: boolean;
}): {
  title: string;
  hint: string;
  showNoPhoneAction: boolean;
  settingsLink: boolean;
} {
  const noPhoneHidden = input.includeNoPhone ? 0 : input.noPhoneCount;

  if (!input.collecting) {
    return {
      title: "Бот не собирает анкеты",
      hint:
        "Сбор выключен: Настройки → Бот → «Вакансии». Пока рубильник выключен, бот просит кандидата " +
        "прислать резюме на WhatsApp и анкету не заполняет: раздел останется пустым, сколько бы людей ни писало.",
      showNoPhoneAction: noPhoneHidden > 0,
      settingsLink: true,
    };
  }

  if (input.bucket === "incomplete" && noPhoneHidden > 0) {
    return {
      title: `Все анкеты (${noPhoneHidden}) без номера телефона`,
      hint:
        "Бот ещё спрашивает номер и переспрашивает, если не дали. Эти анкеты не удалены: их видно по кнопке " +
        "ниже, а ответить человеку можно прямо в переписке.",
      showNoPhoneAction: true,
      settingsLink: false,
    };
  }

  if (input.bucket === "fit" && input.status) {
    return {
      title: "С таким статусом анкет нет",
      hint: "Посмотрите вкладку «Все», анкеты могли уже разобрать.",
      showNoPhoneAction: false,
      settingsLink: false,
    };
  }

  const incomplete = input.bucketCounts?.incomplete ?? 0;
  const rejected = input.bucketCounts?.rejected ?? 0;
  const fit = input.bucketCounts?.fit ?? 0;

  if (input.bucket === "fit" && incomplete > 0) {
    return {
      title: "В «Подходят» пока никого",
      hint: `Бот ещё собирает ответы у ${incomplete} ${incomplete === 1 ? "человека" : "человек"} — они в «Дособрать».`,
      showNoPhoneAction: false,
      settingsLink: false,
    };
  }
  if (input.bucket === "fit" && rejected > 0) {
    return {
      title: "В «Подходят» пока никого",
      hint: `${rejected} ${rejected === 1 ? "анкета не подошла" : rejected < 5 ? "анкеты не подошли" : "анкет не подошли"} по возрасту, учёбе или занятости — они в «Не подходят».`,
      showNoPhoneAction: false,
      settingsLink: false,
    };
  }
  if (input.bucket === "incomplete" && (fit > 0 || rejected > 0)) {
    return {
      title: "В «Дособрать» никого нет",
      hint: "Бот уже получил ответы на все обязательные вопросы у всех, кто писал.",
      showNoPhoneAction: false,
      settingsLink: false,
    };
  }
  if (input.bucket === "rejected" && (fit > 0 || incomplete > 0)) {
    return {
      title: "В «Не подходят» никого нет",
      hint: "Никого пока не отсеял обязательный отбор.",
      showNoPhoneAction: false,
      settingsLink: false,
    };
  }
  return {
    title: "Пока никто не спрашивал про работу",
    hint: "Как только кандидат напишет боту про вакансию, его анкета появится здесь сама.",
    showNoPhoneAction: false,
    settingsLink: false,
  };
}

/**
 * Почему кандидат не прошёл обязательный отбор (критерии владельца 30.08.2026:
 * младше 24 · учится сейчас · работает сейчас). Решение принимает сервер
 * (jobEligibility), здесь только объяснение словами — иначе руководитель видит
 * анкету среди отсеянных и не понимает, за что.
 *
 * Живёт рядом с остальными словарями показа: тот же текст нужен и списку, и
 * раскрытой анкете, и мобильному экрану.
 */
export function vacancyFilterReason(item: JobApplication): string | null {
  if (item.eligible !== false) return null;
  // Сервер может прислать готовые причины (`rejectReasons`, 25.09.2026) —
  // это ровно его же решение jobEligibility словами, а не пересчёт с клиента.
  // Пока сервер это поле не отдаёт, считаем сами по тем же трём правилам.
  if (item.rejectReasons && item.rejectReasons.length > 0) return item.rejectReasons.join(", ");
  const reasons: string[] = [];
  if (item.employedNow === true) reasons.push("сейчас где-то работает");
  if (item.studyingNow === true) reasons.push("сейчас учится");
  if (item.studyingUniversity === true && item.studyingNow !== true) reasons.push("учится в вузе");
  if (item.age !== null && item.age < 24) reasons.push(`младше 24 (${item.age})`);
  return reasons.length > 0 ? reasons.join(", ") : "не проходит обязательный отбор";
}

/**
 * ЧЕТЫРЕ ПРОВЕРКИ ОТБОРА — ВСЕГДА ВИДНЫ В СТРОКЕ (25.09.2026, разбор жалобы
 * «мне приходят и 23-летние, и те, кто работает; в зелёных электрики»).
 *
 * До этого возраст/учёбу/работу было видно только после «Подробнее» — решение
 * «звонить или нет» человек принимал не глядя на ровно те три вопроса, по
 * которым сервер и решает jobEligibility. Раньше это же в виде текста делала
 * vacancyFilterReason, но только для отказанных (`eligible === false`) и одной
 * строкой — здесь три состояния на каждую анкету отдельно, включая «подошёл»
 * и «бот ещё не спросил», а не только «не подошёл».
 *
 * Считаем по сырым полям анкеты (age, studyingNow/studyingUniversity,
 * employedNow, phone), а НЕ по `missing`/`rejectReasons` с сервера: те поля
 * опциональны (старый сервер их не пришлёт), а свои четыре проверки экран
 * обязан показывать всегда, независимо от версии сервера.
 */
export type VacancyCheckState = "ok" | "bad" | "unknown";

export interface VacancyCheck {
  key: "age" | "study" | "work" | "phone";
  state: VacancyCheckState;
  label: string;
}

/** Класс чипа под состояние проверки: `.chip.dash` — «серый пунктир» из
 *  утверждённого макета, добавлен в theme-2026-proto.css рядом с `.chip.mute`
 *  (готового модификатора для пунктирной неизвестности в теме не было). */
export const VACANCY_CHECK_CHIP_CLASS: Record<VacancyCheckState, string> = {
  ok: "chip ok",
  bad: "chip crit",
  unknown: "chip dash",
};

/** «Учится сейчас» — тот же OR, что уже применяли для vacancyFilterReason:
 *  studyingUniversity — отдельный флаг «учится в вузе прямо сейчас», и бот
 *  мог заполнить только его, не тронув общий studyingNow. */
function vacancyStudyingValue(item: JobApplication): boolean | null {
  if (item.studyingNow === true || item.studyingUniversity === true) return true;
  if (item.studyingNow === null && item.studyingUniversity === null) return null;
  return false;
}

export function vacancyChecks(item: JobApplication): VacancyCheck[] {
  const studying = vacancyStudyingValue(item);
  return [
    item.age === null
      ? { key: "age", state: "unknown", label: "возраст ?" }
      : item.age >= 24
        ? { key: "age", state: "ok", label: "24+ ✓" }
        : { key: "age", state: "bad", label: "моложе 24 ✗" },
    studying === null
      ? { key: "study", state: "unknown", label: "учёба ?" }
      : studying
        ? { key: "study", state: "bad", label: "учится ✗" }
        : { key: "study", state: "ok", label: "не учится ✓" },
    item.employedNow === null
      ? { key: "work", state: "unknown", label: "работа ?" }
      : item.employedNow
        ? { key: "work", state: "bad", label: "работает сейчас ✗" }
        : { key: "work", state: "ok", label: "свободен ✓" },
    item.phone
      ? { key: "phone", state: "ok", label: item.phone }
      : { key: "phone", state: "unknown", label: "телефон ?" },
  ];
}

/**
 * ЧТО ИМЕННО СДЕЛАЕТ КНОПКА (владелец 03.09.2026: «что произойдёт, если нажать
 * „Собеседование“ и другие кнопки — админ не знает»).
 *
 * Подписи говорят и о том, что произойдёт, и о том, чего НЕ произойдёт.
 * С 25.09.2026 одно исключение: в форме собеседования есть галочка «Робот
 * позвонит и пригласит» — с ней робот звонит кандидату ОДИН раз (02.10.2026:
 * прежние слова «ни сообщение, ни звонок» и «позвоните ему сами» спорили с
 * этой галочкой на том же экране).
 */
export const VACANCY_ACTIONS_NOTE =
  "Кнопки только отмечают стадию в CRM, сообщений кандидату они не шлют. Позвонить может только робот, и только если при назначении собеседования стоит галочка.";

export const VACANCY_ACTION_HINT = {
  reviewed: "Отметить, что анкету посмотрели. Кандидат об этом не узнает.",
  interview: "Спросит дату и время, они сохранятся в карточке и будут подсвечены, когда срок пройдёт. С галочкой «Робот позвонит и пригласит» робот один раз позвонит кандидату сам, без галочки позвоните ему сами.",
  interviewMove: "Изменить дату и время уже назначенного собеседования.",
  /** Те же слова, но уже ВНУТРИ формы: там кнопку нажали, и «спросит» звучит
   *  как обещание чего-то ещё впереди. */
  interviewForm: "Дата и время сохранятся в карточке. С галочкой робот сам позвонит кандидату в рабочие часы, на языке его переписки, и пригласит; ответ появится в анкете.",
  rejectForm: "Заполнять необязательно, причина нужна только вам, чтобы вспомнить решение позже. Кандидату она не уходит.",
  interviewed: "Отметить, что собеседование состоялось, дальше решение: принять или отказать.",
  hired: "Отметить выход на работу. Дата ставится сегодняшняя и больше не меняется.",
  reject: "Отметит отказ сразу, одним нажатием. Кандидату ничего не уходит; анкета остаётся в разделе, отказ можно отменить.",
  rejectReason: "Причина по желанию и только для вас: текстом или голосовым. Кандидату она не уходит.",
  talentPool: "Пометка «вернуться к нему при следующем наборе». Ничего не отправляет.",
  undoReject: "Вернуть анкету в очередь на стадию «Просмотрена».",
  interviewNote: "Впечатление, сильные и слабые стороны, по желанию и только для вас. Кандидату не уходит.",
} as const;
