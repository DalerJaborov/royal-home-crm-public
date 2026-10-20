/**
 * Анкета кандидата на вакансию — поле инструмента и разбор ответа модели.
 *
 * Владелец 16.08.2026: «скоро запустим вакансии — бот либо берёт всю информацию
 * сам (текстом или файлом), либо просит прислать на WhatsApp, а потом передаёт
 * руководству и админу». Как бот разговаривает с кандидатом — в BOT_CORE_RULES
 * (сценарий JOB); здесь только структура данных, которую он собирает.
 *
 * Поле — ОБЪЕКТ с частичными данными: кандидат отвечает по одному вопросу за ход,
 * и анкета пополняется постепенно (upsert по диалогу в lib/jobApplications.ts),
 * а не ждёт, пока соберётся целиком. Оборвал разговор на середине — руководство
 * всё равно видит имя и телефон, а не пустоту.
 */

import { normalizeCandidatePhone } from "../lib/candidatePhone.js";
import { BW, EW, TAIL } from "./wordBoundary.js";

/** Поле инструмента submit_reply. Подключается при включённом рубильнике
 *  Настройки → Бот → «Вакансии». */
export const JOB_APPLICATION_SCHEMA_FIELD = {
  jobApplication: {
    type: "object",
    description:
      "Заполняй ТОЛЬКО в разговоре о работе/вакансии (intent=job). Клади сюда то, что кандидат сообщил " +
      "В ЭТОМ ходе (частично — нормально, анкета копится). Ничего не выдумывай и не переспрашивай уже сказанное.",
    properties: {
      name: { type: "string", description: "Имя кандидата, как он представился" },
      age: { type: "number", description: "Возраст, если назвал. Не угадывай по имени, фото или манере речи" },
      studyingUniversity: {
        type: "boolean",
        description:
          "Учится ли кандидат СЕЙЧАС в университете, вузе или другом высшем учебном заведении — true. " +
          "Курсы, профессиональные курсы, тренинги, повышение квалификации — это НЕ вуз, ставь false. " +
          "Пока не спросил — поле не заполняй вовсе.",
      },
      studyingNow: {
        type: "boolean",
        description:
          "Учится ли кандидат СЕЙЧАС хоть где-нибудь — школа, лицей, гимназия, колледж, техникум, " +
          "училище, университет, вуз, магистратура: любое из этого true. Курсы, профессиональные " +
          "курсы, тренинги, повышение квалификации — это НЕ учёба, ставь false. Закончил учёбу и " +
          "сейчас нигде не учится — false. Пока не спросил — поле не заполняй вовсе: " +
          "false наугад пропустит школьника в очередь к руководству.",
      },
      employedNow: {
        type: "boolean",
        description:
          "Работает ли кандидат СЕЙЧАС где-то ещё — есть текущее место работы, подработка, " +
          "своё дело: true. Уволился, между работами, сейчас без работы — false. Критерий " +
          "владельца: берём тех, кто может работать полный день без совмещения. " +
          "Пока не спросил — поле не заполняй вовсе: false наугад пропустит занятого человека. " +
          "Прошлый опыт работы в поле experience на это поле не влияет — здесь только «сейчас».",
      },
      city: { type: "string", description: "Город кандидата, если назвал" },
      education: { type: "string", description: "Образование словами кандидата (юрист, МО, дизайн, строительство и т.п.)" },
      experience: { type: "string", description: "Опыт работы словами кандидата. Нет опыта — так и запиши" },
      /**
       * СВЕТОФОР СЧИТАЕТ КОД, НЕ МОДЕЛЬ (владелец 25.09.2026: живые анкеты показали
       * GREEN с причиной «без опыта в продажах», YELLOW у электрика и учителя — модель
       * сама решала цвет и путала его с профессией вообще). `priority`/`priorityReason`
       * убраны из схемы: цвет и его причину теперь всегда считает jobPriority /
       * jobPriorityReason (ai/jobApplication.ts) по этим двум явным булевым полям и по
       * словам из experience/education — не по мнению модели.
       */
      salesExperience: {
        type: "boolean",
        description:
          "Был ли у кандидата РЕАЛЬНЫЙ опыт работы в продажах товара или услуги, или в недвижимости " +
          "(риелтор, менеджер по продажам) — true. «Интересно, но не работал», работа без продаж " +
          "(кассир, закупки, снабжение) — false. Пока не рассказал про опыт — поле не заполняй вовсе.",
      },
      targetEducation: {
        type: "boolean",
        description:
          "Есть ли у кандидата ВЫСШЕЕ ОБРАЗОВАНИЕ ИЛИ ДИПЛОМ по одной из целевых специальностей: юрист, " +
          "международные отношения, дизайнер интерьера, художник, графический дизайн, IT, ИЛИ он мастер-" +
          "строитель («усто»). Любое другое образование — false. Пока не рассказал про образование — " +
          "поле не заполняй вовсе.",
      },
      hasCar: { type: "boolean", description: "Есть ли машина и права" },
      /**
       * МАШИНА + СИЛЬНОЕ ЖЕЛАНИЕ = ЗЕЛЁНЫЙ (Нурмухаммад 28.09.2026, подтверждено Dan
       * 28.09): человек без опыта продаж и без профильного диплома, но с машиной и
       * ясным желанием работать, идёт в приоритет наравне с продажниками. Желание —
       * поле МОДЕЛИ, потому что регуляркой «хочу» не отличить от «не хочу»; цвет по
       * нему, как и по остальным, считает код (jobPriority).
       */
      strongMotivation: {
        type: "boolean",
        description:
          "Показал ли кандидат САМ сильное желание работать и зарабатывать: «готов ко всему», «уволюсь ради этого», " +
          "«хочу зарабатывать», просит взять поскорее — true. Вялое «посмотрим», «подумаю», интерес только к сумме — false. " +
          "Неясно — поле не заполняй вовсе.",
      },
      achievements: { type: "string", description: "Самое большое достижение в работе, словами кандидата" },
      languages: { type: "string", description: "Какими языками владеет" },
      startWhen: { type: "string", description: "Когда готов начать, словами кандидата" },
      phone: {
        type: "string",
        description:
          "Телефон кандидата, если дал — цифрами, как он их назвал. Не заполняй, если он не называл номер: " +
          "«оставлю позже», «напишу отдельно» и подобное — это НЕ номер, а поле phone не для таких слов.",
      },
      summary: { type: "string", description: "Всё рассказанное в этом ходе одним коротким текстом (включая присланное резюме)" },
    },
  },
} as const;

export type JobPriority = "GREEN" | "YELLOW" | "RED";

export interface JobApplicationDraft {
  name?: string;
  age?: number;
  studyingUniversity?: boolean;
  studyingNow?: boolean;
  employedNow?: boolean;
  city?: string;
  education?: string;
  experience?: string;
  /** Был ли РЕАЛЬНЫЙ опыт в продажах/недвижимости — со слов кандидата, поле модели. */
  salesExperience?: boolean;
  /** Высшее/диплом по целевой специальности (юрист, МО, дизайн, IT, усто) — поле модели. */
  targetEducation?: boolean;
  hasCar?: boolean;
  /** Сильное желание работать — со слов кандидата, поле модели (28.09.2026). */
  strongMotivation?: boolean;
  achievements?: string;
  languages?: string;
  startWhen?: string;
  phone?: string;
  summary?: string;
}

/**
 * ОБЯЗАТЕЛЬНЫЙ ФИЛЬТР — В КОДЕ, А НЕ В ПРОМТЕ (правила отбора владельца 16.08.2026).
 *
 * «Не передавай кандидата, если ему меньше 24 или он учится в вузе» — просьба к
 * модели, а этот проект уже знает, чего стоят такие просьбы: правило живёт до
 * первого хода, на котором модель отвлеклась. Тем более что отбор идёт по живым
 * людям, и «иногда сработало» здесь означает, что руководство зовёт на собеседование
 * человека, которого звать не собиралось.
 *
 * Поэтому решение принимает код, по полям анкеты (список критериев расширен
 * владельцем 30.08.2026):
 *  - работает сейчас где-то ещё — не проходит (берём тех, кто может работать
 *    полный день без совмещения);
 *  - учится сейчас где угодно — не проходит: школа, лицей, колледж, техникум, вуз
 *    (курсы и тренинги учёбой не считаются, см. схему);
 *  - возраст меньше 24 — не проходит;
 *  - учится в вузе (studyingUniversity, старый критерий) — не проходит;
 *  - что-то из этого ещё не спрошено — решения НЕТ (null): анкета копится дальше,
 *    а бот обязан задать вопрос. Отказывать по незнанию нельзя, приглашать тоже —
 *    иначе кандидат попадёт в раздел до того, как у него спросили про работу.
 */
export const JOB_MIN_AGE = 24;

/**
 * СВЕТОФОР СЧИТАЕТСЯ В КОДЕ, А НЕ МОДЕЛЬЮ (владелец 03.09.2026, ужесточено
 * 25.09.2026: «мне приходят и те, кому 23-24... в зелёных стоят электрики и
 * женщины-домоседки»).
 *
 * История в двух шагах. Сначала (03.09) цвет ставила модель полем `priority`
 * ровно один раз — в том ходе, где кандидат рассказал про опыт, и код только
 * ПОДНИМАЛ его по ключевым словам, никогда не понижая. Разбор живых анкет
 * 25.09.2026 показал, что этого мало: модель сама путала «продажи» с «есть
 * какой-то опыт вообще» (GREEN с причиной «без опыта в продажах») и «целевое»
 * с «образование вообще» (YELLOW у электрика). Раз ошибалась сама модель,
 * «код может цвет только поднять» лечило симптом не с той стороны.
 *
 * Теперь `priority`/`priorityReason` ушли из схемы инструмента совсем. Модель
 * отвечает на два прямых да/нет вопроса (salesExperience, targetEducation —
 * см. схему выше), а цвет и его причину при каждой записи анкеты считает
 * ТОЛЬКО код: jobPriority по этим двум полям (и, пока они не заполнены, — по
 * ключевым словам в experience/education, ниже) и jobPriorityReason по
 * результату. Слова ищем и по-русски, и по-таджикски: кандидаты пишут
 * вперемешку.
 */
/**
 * «фурӯшгоҳ» — МАГАЗИН, А НЕ ПРОДАЖИ (02.10.2026): «дар фурӯшгоҳ кор мекардам»
 * подстрокой «фурӯш» давало зелёный любому, кто работал в магазине, — кассиру и
 * грузчику тоже. Продавца магазина модель отметит сама (salesExperience), а
 * «фурӯшанда»/«фурӯш» по-прежнему засчитываются.
 */
const GREEN_WORDS =
  /(продаж|продавец|продавал|риелт|риэлт|недвижим|брокер|агент\s*по\s*недвиж|савдо|фур[ӯу]ш(?!го[ҳх]))/iu;
/**
 * `стро[ий]` ЛОВИЛО «УСТРОИЛСЯ» (найдено 25.09.2026 живым прогоном: «устроился
 * грузчиком» уходил в YELLOW как «мастер стройки»). `.test()` ищет подстроку где
 * угодно в тексте, а «устроился» содержит ровно подстроку «строи» без всякой
 * границы слова. Заменено на `строител` + `EW`/`TAIL` (строитель, строителя,
 * строительство) — граница слова спереди (`BW`) не пускает совпадение внутрь
 * «у-строил-ся», а `TAIL` вместо голого `\w*` донабирает кириллическое окончание
 * (см. шапку ai/wordBoundary.ts). «усто» — короткое слово, границы обязательны
 * с обеих сторон, иначе «усто» нашлось бы внутри случайной кириллической строки.
 */
const YELLOW_WORDS = new RegExp(
  [
    "юрист",
    "юридич",
    "ҳуқуқ",
    "хукук",
    "правовед",
    "международн",
    "халқаро",
    "дизайн",
    "интерьер",
    "художник",
    "рассом",
    // С границей спереди (02.10.2026): голое «айти» сидит внутри «найти», и
    // «не могу найти работу» в поле образования давало жёлтый.
    `${BW}график${TAIL}`,
    `${BW}айти${EW}`,
    `${BW}it${EW}`,
    "программист",
    "дастурсоз",
    "архитект",
    `${BW}строител${TAIL}`,
    "сохтмон",
    `${BW}усто${EW}`,
  ].join("|"),
  "iu"
);
/**
 * НИКОГДА НЕ YELLOW/GREEN (владелец 25.09.2026, живые жалобы: электрики и
 * домохозяйки в зелёных). Профессии, которых нет ни в одном списке выше и не
 * должно быть — здесь не регулярка-фильтр, а справочная проверка для тестов:
 * ни одно из этих слов не пересекается по подстроке с GREEN_WORDS/YELLOW_WORDS,
 * и так должно оставаться при любой будущей правке списков (см. тест
 * `никогда не считает целевыми` в bot-callback-vacancies.test.ts).
 */
export const NEVER_TARGET_WORDS = [
  "электрик",
  "учитель",
  "омузгор",
  "фармацевт",
  "водитель",
  "такси",
  "домохозяйка",
] as const;

/**
 * ОТРИЦАНИЕ ОТМЕНЯЕТ КЛЮЧЕВОЕ СЛОВО (поймано пробным прогоном 03.09.2026).
 *
 * Первая версия ставила GREEN человеку, у которого в анкете написано «Опыта
 * продаж НЕТ»: слово «продаж» в строке есть, а смысл ровно обратный. Такой
 * кандидат попадал бы в начало очереди как опытный продавец — то есть цвет
 * начинал бы врать ровно там, где он и нужен.
 *
 * Поэтому поле, в котором стоит отрицание, для положительного вывода не годится:
 * ищем подтверждение в другом поле (образование), а иначе оставляем RED — «без
 * опыта, обучим», что в разделе отказом и не считается.
 */
/**
 * ГРАНИЦЫ СЛОВ — ЧЕРЕЗ \p{L}, А НЕ \b (пробный прогон 03.09.2026).
 *
 * `\bнет\b` с кириллицей ведёт себя не так, как выглядит: \b в JavaScript
 * опирается на ASCII-класс \w, в который русские буквы не входят. Отрицание
 * из-за этого не находилось вовсе, и кандидат с анкетой «Опыта продаж НЕТ»
 * получал зелёный — то есть попадал в начало очереди как опытный продавец.
 * Тот же капкан репозиторий уже проходил в разборе заметок про номера.
 */
const NEGATION = /(?<!\p{L})(не|нет|нету|без|надорам|надорад|надорем|нест|йӯқ)(?!\p{L})/iu;

/**
 * ОТРИЦАНИЕ ДЕЙСТВУЕТ ТОЛЬКО В СВОЁМ КУСКЕ ФРАЗЫ (02.10.2026). Раньше любое «не»/
 * «без» в поле гасило ВСЁ поле: «Продавец 3 года, без опыта в недвижимости»
 * получал красный, хотя продажи названы прямо, а «без» относится к недвижимости.
 * Теперь поле режется на куски по знакам препинания и союзам «но/а/лекин/вале», и
 * ключевое слово засчитывается, если хотя бы в одном куске оно есть, а отрицания
 * в том же куске нет. «Опыта продаж нет» — по-прежнему не в счёт: отрицание стоит
 * в том же куске, что и слово.
 */
// «:» и «?» НЕ режут (доразбор 02.10.2026): «Опыт продаж: нет» и «Работал в
// продажах? Нет» — это вопрос и ответ на него, и отрицание относится к слову.
const CLAUSE_SPLIT = /[,.;!\n()]|\s(?:но|а|однако|лекин|вале|аммо)\s/iu;
/** Кусок, в котором нет ничего, кроме отрицания: «Нет.», «не было», «йӯқ». */
const NEGATION_ONLY = /^\s*(?:не\s+было|нет|нету|не|надорам|надорад|надорем|нест|йӯқ)\s*$/iu;

function saysYes(text: string | null | undefined, words: RegExp): boolean {
  const t = (text ?? "").trim();
  if (!t) return false;
  const clauses = t.split(CLAUSE_SPLIT).filter((c) => !!c && c.trim());
  // Голое «нет» следующим куском отрицает предыдущий: «Работал в продажах. Нет».
  return clauses.some(
    (clause, i) => words.test(clause) && !NEGATION.test(clause) && !NEGATION_ONLY.test(clauses[i + 1] ?? "x")
  );
}

/**
 * Цвет по накопленной анкете (владелец 25.09.2026: «светофор считает код, а не
 * модель» — живые анкеты показали GREEN с причиной «без опыта в продажах» и
 * YELLOW у электрика: раньше цвет ставила сама модель полем priority, и её
 * представление о «продажах» и «целевом» плыло от анкеты к анкете).
 *
 * ПОРЯДОК РЕШЕНИЯ:
 *  1. Явное булево поле МОДЕЛИ (salesExperience/targetEducation) старше
 *     регулярки: модель прочитала весь рассказ целиком, а регулярка — только
 *     слово. `salesExperience: false` («продавец-консультант, но по факту это
 *     был кассир») запрещает зелёный, даже если в experience есть слово
 *     «продавец» — это НЕ понижение цвета (стоящего в базе цвета ещё нет, это
 *     первый расчёт), а отказ поднимать его по слову, которое сам кандидат
 *     объяснил иначе.
 *  2. Поля не заполнены (не спросили) — доверяем регулярке по словам
 *     кандидата, как и раньше.
 *  3. Ничего не подошло, но хоть что-то об опыте/образовании известно
 *     (включая явное «нет» в булевом поле) — RED, «без опыта, обучим», это не
 *     отказ в разделе.
 *  4. Совсем ничего не известно — null: серая пометка честнее зелёной наугад.
 *
 * ЗАВИСИМОСТЬ ОТ ПОЛЯ, А НЕ ОТ СТАРОГО ЦВЕТА В БАЗЕ. Вызывающий (jobApplications.ts)
 * передаёт сюда НАКОПЛЕННУЮ анкету (то, что пришло сейчас, поверх того, что уже
 * записано) и просто ПЕРЕЗАПИСЫВАЕТ цвет результатом — то самое «пересчитывается
 * каждый раз», а не «код может цвет только поднять» (это правило снято 25.09.2026:
 * раз код теперь знает salesExperience/targetEducation, а не только черновой
 * приоритет модели, пересчёт достаточно надёжен, чтобы не хранить историю).
 */
export interface JobPriorityInput {
  experience?: string | null;
  education?: string | null;
  salesExperience?: boolean | null;
  targetEducation?: boolean | null;
  hasCar?: boolean | null;
  strongMotivation?: boolean | null;
}

/** Опыт продаж подтверждён — явным полем модели или словами кандидата. */
export function salesExperienceConfirmed(draft: Pick<JobPriorityInput, "experience" | "salesExperience">): boolean {
  const salesExperience = draft.salesExperience ?? null;
  if (salesExperience === true) return true;
  // Явное false — регулярку по experience не спрашиваем вовсе (кандидат САМ
  // объяснил, что это были не продажи); не заполнено — решает регулярка.
  return salesExperience !== false && saysYes(draft.experience?.trim() || null, GREEN_WORDS);
}

/**
 * Машина + сильное желание (Нурмухаммад 28.09.2026, подтверждено Dan 28.09):
 * «даже если он красный — не работал в продажах и не учился на МЭО, — но у него
 * есть машина и он сильно хочет работать, добавь его в зелёный». Оба факта —
 * явные true; молчание или одно из двух — не хватает.
 */
export function carAndDriveConfirmed(draft: Pick<JobPriorityInput, "hasCar" | "strongMotivation">): boolean {
  return draft.hasCar === true && draft.strongMotivation === true;
}

export function jobPriority(draft: JobPriorityInput): JobPriority | null {
  const experience = draft.experience?.trim() || null;
  const education = draft.education?.trim() || null;
  const salesExperience = draft.salesExperience ?? null;
  const targetEducation = draft.targetEducation ?? null;

  const somethingKnown =
    !!experience || !!education || salesExperience !== null || targetEducation !== null || carAndDriveConfirmed(draft);
  if (!somethingKnown) return null;

  // GREEN: опыт продаж (явное поле или слова кандидата) — либо машина и желание.
  if (salesExperienceConfirmed(draft)) return "GREEN";
  if (carAndDriveConfirmed(draft)) return "GREEN";

  // YELLOW: та же логика полем targetEducation, регулярка — по education.
  if (targetEducation === true) return "YELLOW";
  if (targetEducation !== false && saysYes(education, YELLOW_WORDS)) return "YELLOW";

  // Что-то известно, но не по теме (или прямо сказано «нет») — RED, не отказ.
  return "RED";
}

/**
 * Причину цвета формирует КОД, короткой фразой, согласованной с самим цветом
 * (владелец 25.09.2026: модель писала «Без опыта в продажах» рядом с GREEN —
 * причина и цвет расходились, потому что оба поля были её собственным мнением).
 * null — цвета ещё нет, объяснять нечего.
 */
export function jobPriorityReason(
  input: {
    priority: JobPriority | null;
  } & JobPriorityInput
): string | null {
  if (!input.priority) return null;
  const experience = input.experience?.trim();
  const education = input.education?.trim();
  if (input.priority === "GREEN") {
    // Зелёный бывает двумя путями (см. jobPriority): причина называет тот, что
    // сработал, — иначе у человека без единого слова о продажах стояло бы
    // «Подтверждён опыт в продажах».
    if (!salesExperienceConfirmed(input) && carAndDriveConfirmed(input)) {
      return "Есть машина и сильное желание работать";
    }
    return experience ? `Опыт продаж: ${experience.slice(0, 120)}` : "Подтверждён опыт в продажах";
  }
  if (input.priority === "YELLOW") {
    return education
      ? `Целевое образование: ${education.slice(0, 120)}, опыта продаж нет`
      : "Целевое образование, опыта продаж нет";
  }
  return "Нет опыта продаж и целевого образования";
}

/**
 * Какой цвет сильнее — оставлен как чистая сравнивающая функция (используется
 * только тестами и на будущее): «повышение цвета моделью поверх кода» убрано
 * 25.09.2026 из самого расчёта (см. jobPriority выше), но сравнение цветов само
 * по себе полезная и безопасная утилита, ломать которую незачем.
 */
const PRIORITY_RANK: Record<JobPriority, number> = { GREEN: 2, YELLOW: 1, RED: 0 };

export function strongerPriority(a: JobPriority | null, b: JobPriority | null): JobPriority | null {
  if (!a) return b;
  if (!b) return a;
  return PRIORITY_RANK[a] >= PRIORITY_RANK[b] ? a : b;
}

export function jobEligibility(draft: {
  age?: number | null;
  studyingUniversity?: boolean | null;
  studyingNow?: boolean | null;
  employedNow?: boolean | null;
}): boolean | null {
  // Сначала отказы: любой подтверждённый стоп-критерий закрывает вопрос сразу,
  // даже если остальное ещё не выяснено.
  if (draft.employedNow === true) return false;
  if (draft.studyingNow === true) return false;
  if (draft.studyingUniversity === true) return false;
  if (typeof draft.age === "number" && draft.age < JOB_MIN_AGE) return false;
  if (typeof draft.age !== "number") return null;
  // Возраст подходит, а про учёбу ещё не спрашивали — вопрос открыт.
  if (draft.studyingUniversity !== false) return null;
  // Про занятость и учёбу «сейчас» должен быть явный ответ: молчание — не «нет».
  if (draft.employedNow !== false || draft.studyingNow !== false) return null;
  return true;
}

/**
 * ЧЕГО НЕ ХВАТАЕТ ДЛЯ РЕШЕНИЯ (владелец 25.09.2026) — те же четыре факта, по
 * которым jobEligibility решает допуск, плюс телефон (без него анкеты нет,
 * см. SCENARIO_JOB). Печатается коду бота, чтобы модель спрашивала РОВНО
 * недостающее одним сообщением, а не изобретала свой список вопросов заново
 * каждый ход (см. jobApplicationIntakeBlock ниже). Правила самого допуска эта
 * функция не меняет — она только называет словами, что jobEligibility ещё не
 * увидел.
 */
export function jobMissingFacts(draft: {
  age?: number | null;
  studyingNow?: boolean | null;
  employedNow?: boolean | null;
  phone?: string | null;
}): string[] {
  const missing: string[] = [];
  if (typeof draft.age !== "number") missing.push("возраст");
  if (draft.studyingNow !== true && draft.studyingNow !== false) missing.push("учёба сейчас");
  if (draft.employedNow !== true && draft.employedNow !== false) missing.push("работа сейчас");
  if (!draft.phone || !draft.phone.trim()) missing.push("телефон");
  return missing;
}

/**
 * ПОЧЕМУ ОТКАЗ — словами, для той же причины, что и jobMissingFacts: экран
 * руководства и разбор живых анкет объясняют решение кода человеку, а не
 * заставляют его перечитывать jobEligibility. Список причин, а не одна строка:
 * кандидат может быть одновременно моложе 24 и ещё учиться.
 */
export function jobRejectReasons(draft: {
  age?: number | null;
  studyingUniversity?: boolean | null;
  studyingNow?: boolean | null;
  employedNow?: boolean | null;
}): string[] {
  const reasons: string[] = [];
  if (typeof draft.age === "number" && draft.age < JOB_MIN_AGE) reasons.push(`моложе ${JOB_MIN_AGE}`);
  if (draft.studyingNow === true || draft.studyingUniversity === true) reasons.push("учится");
  if (draft.employedNow === true) reasons.push("работает сейчас");
  return reasons;
}

/**
 * ЧТО ДОПЕЧАТАТЬ БОТУ В ПРОМТ — готовая строка из jobMissingFacts, тем же
 * приёмом, что sellerIntakeBlock в ai/sellerIntake.ts: код называет недостающее
 * словами, модель формулирует вопрос по-человечески на языке кандидата. Пустой
 * список — пустая строка, печатать нечего.
 *
 * Место вызова — ai/leadQualifier.ts, в ИЗМЕНЯЕМОЙ части промта (не в
 * buildStableSystem): список зависит от анкеты ЭТОГО разговора и внутри
 * кэшируемого префикса сломал бы побайтовое совпадение между разными
 * кандидатами.
 */
export function jobApplicationIntakeBlock(missing: string[]): string {
  if (missing.length === 0) return "";
  return (
    `\n\nЕЩЁ НЕ ВЫЯСНЕНО (посчитано кодом): ${missing.join(", ")}. ` +
    "Спроси недостающее ОДНИМ сообщением, мягко, без цепочки отдельных вопросов — не тем же " +
    "сообщением, что уже занято другим шагом сценария."
  );
}

/** Отсечка мусора: модель иногда возвращает пустой объект или строки из пробелов.
 *  Анкета без единого содержательного поля не записывается вовсе. */
export function parseJobApplication(value: unknown): JobApplicationDraft | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const str = (v: unknown, max: number): string | undefined => {
    if (typeof v !== "string") return undefined;
    const t = v.trim();
    return t.length > 0 ? t.slice(0, max) : undefined;
  };
  const draft: JobApplicationDraft = {
    name: str(raw.name, 120),
    // Возраст за пределами человеческого — это ошибка модели, а не факт о кандидате.
    age: typeof raw.age === "number" && raw.age >= 14 && raw.age <= 90 ? Math.round(raw.age) : undefined,
    studyingUniversity: typeof raw.studyingUniversity === "boolean" ? raw.studyingUniversity : undefined,
    studyingNow: typeof raw.studyingNow === "boolean" ? raw.studyingNow : undefined,
    employedNow: typeof raw.employedNow === "boolean" ? raw.employedNow : undefined,
    city: str(raw.city, 120),
    education: str(raw.education, 500),
    // Цвет и его причина больше не приходят от модели (см. шапку jobPriority) —
    // priority/priorityReason ушли из схемы и из этого разбора 25.09.2026.
    salesExperience: typeof raw.salesExperience === "boolean" ? raw.salesExperience : undefined,
    targetEducation: typeof raw.targetEducation === "boolean" ? raw.targetEducation : undefined,
    experience: str(raw.experience, 1000),
    hasCar: typeof raw.hasCar === "boolean" ? raw.hasCar : undefined,
    strongMotivation: typeof raw.strongMotivation === "boolean" ? raw.strongMotivation : undefined,
    achievements: str(raw.achievements, 500),
    languages: str(raw.languages, 300),
    startWhen: str(raw.startWhen, 300),
    // Телефон — прогоняем через тот же уровень строгости, что и обычные лиды
    // (см. lib/candidatePhone.ts): просто обрезать строку до 40 символов было
    // достаточно для имени, но НЕ для поля, от которого зависит, попадёт ли
    // анкета в очередь вообще (HAS_PHONE в routes/vacancies.ts).
    phone: typeof raw.phone === "string" ? normalizeCandidatePhone(raw.phone) : undefined,
    summary: str(raw.summary, 2000),
  };
  const hasContent = Object.values(draft).some((v) => v !== undefined);
  return hasContent ? draft : null;
}
