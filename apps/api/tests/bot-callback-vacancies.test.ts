import { describe, expect, it } from "vitest";
import {
  parseCallbackRequest,
  callbackPromptRule,
  callbackAsLeadPromptRule,
} from "../src/ai/callbackRequest.js";
import { callbackPromise } from "../src/ai/agencyFacts.js";

// Душанбе = UTC+5. 06.10.2026 — вторник, 11.10.2026 — воскресенье.
const HOURS = { start: "10:00", end: "22:30" };
const DAY = callbackPromise(new Date("2026-10-06T07:00:00Z"), HOURS); // вт 12:00
const NIGHT = callbackPromise(new Date("2026-10-06T18:30:00Z"), HOURS); // вт 23:30
const CALLBACK_AS_LEAD_PROMPT_RULE = callbackAsLeadPromptRule(DAY);
import { qualifySchema } from "../src/ai/leadQualifier.js";
import { jobEligibility, parseJobApplication } from "../src/ai/jobApplication.js";
import { languageInstruction } from "../src/ai/clientLanguage.js";
import {
  ASK_OWNER_DISABLED_RULE,
  CAUTIOUS_MODE_RULE,
  LINKS_DISABLED_RULE,
  SHOWINGS_DISABLED_RULE,
  VACANCIES_DISABLED_RULE,
  botAbilitiesOf,
  type BotCapabilities,
} from "../src/messengers/botCapabilities.js";
import { SCENARIO_JOB } from "../src/ai/leadQualifier.js";
import {
  jobPriority,
  jobPriorityReason,
  strongerPriority,
  jobMissingFacts,
  jobRejectReasons,
  jobApplicationIntakeBlock,
  NEVER_TARGET_WORDS,
} from "../src/ai/jobApplication.js";
import { botAlreadyAskedPhone } from "../src/lib/askCandidatePhone.js";
import { normalizeCandidatePhone } from "../src/lib/candidatePhone.js";

/**
 * Новые ползунки бота 16.08.2026: звонок оператора, вакансии, ссылки, режим
 * запуска, «уточню у собственника». Правило модуля прежнее: выключенная
 * возможность исчезает и из действий, и из промта, а включённая даёт модели
 * явную инструкцию, что делать вместо неё.
 */

describe("просьба о звонке (callbackRequest)", () => {
  it("осмысленная просьба проходит, мусор отсекается", () => {
    expect(parseCallbackRequest("Хочет обсудить торг по двушке в Сино")).toBe(
      "Хочет обсудить торг по двушке в Сино"
    );
    expect(parseCallbackRequest("да")).toBeNull();
    expect(parseCallbackRequest("   ")).toBeNull();
    expect(parseCallbackRequest(42)).toBeNull();
  });

  it("длина ограничена — в push и очередь не влезает роман", () => {
    expect(parseCallbackRequest("а".repeat(600))!.length).toBe(500);
  });

  it("правило промта обещает звонок в том же сообщении", () => {
    // Заполнить поле и промолчать — значит оставить клиента ждать неизвестно чего.
    expect(callbackPromptRule(DAY)).toContain("в том же сообщении");
    expect(callbackPromptRule(DAY)).toContain("callbackRequest");
  });

  /**
   * Обещание зависит от часов (владелец 16.08.2026) и с 10.10.2026 решается одной
   * функцией с голосом (ai/agencyFacts.ts::callbackPromise): днём — «сегодня», ночью —
   * «завтра после …». «Прямо сейчас» не обещается: из переписки автодозвона нет (22.09).
   */
  it("днём обещается «сегодня», ночью — «завтра после начала окна», «сейчас» — никогда", () => {
    expect(callbackPromptRule(DAY)).toContain("КОГДА ПОЗВОНИТ АГЕНТ: сегодня");
    expect(callbackPromptRule(NIGHT)).toContain("завтра после 10:00");
    for (const rule of [callbackPromptRule(DAY), callbackPromptRule(NIGHT)]) {
      expect(rule).not.toContain("ПРЯМО СЕЙЧАС");
      expect(rule).toContain("«прямо сейчас» и минуты не обещай");
    }
  });

  /**
   * БЕЗ ДЕЖУРНОГО ОПЕРАТОРА просьба о звонке — обычная заявка (владелец 23.08.2026).
   * Проверяем ровно то, чем это правило отличается от «оператор есть»: не обещает
   * звонок сию минуту (набирать некому) и выясняет тему, без которой агент звонит
   * вслепую.
   */
  it("без оператора: правило берёт тему и не обещает звонок сию минуту", () => {
    expect(CALLBACK_AS_LEAD_PROMPT_RULE).toContain("callbackRequest");
    expect(CALLBACK_AS_LEAD_PROMPT_RULE).toContain("по какому вопросу");
    expect(CALLBACK_AS_LEAD_PROMPT_RULE).toContain("«прямо сейчас» и минуты не обещай");
    expect(CALLBACK_AS_LEAD_PROMPT_RULE).not.toContain("ПРЯМО СЕЙЧАС");
    // Номер всё так же обязателен: без него заявку не оформить и звонить некуда.
    expect(CALLBACK_AS_LEAD_PROMPT_RULE).toContain("номера клиента ещё нет");
  });

  /**
   * ТЕМА ВАЖНЕЕ ИМЕНИ, когда тема неизвестна (проверено живым прогоном на проде
   * 23.08.2026). Общее правило промта просит номер И имя одной фразой; вместе с
   * вопросом о теме это три просьбы в одном сообщении, и модель выкидывала именно
   * тему — в карточку уезжало бессодержательное «клиент хочет поговорить с живым
   * человеком». Имя не теряется: его переспросит acceptLead при приёме заявки.
   */
  it("без оператора: при неясной теме имя уступает место вопросу о теме", () => {
    expect(CALLBACK_AS_LEAD_PROMPT_RULE).toContain("имя НЕ спрашивай");
    expect(CALLBACK_AS_LEAD_PROMPT_RULE).toContain("Тема звонка важнее имени");
  });

  /**
   * Рубильник выбирает, КТО звонит, а не слышит ли бот просьбу. Поле в схеме есть в
   * обоих положениях — иначе при выключенном операторе просьба о звонке не доехала
   * бы до карточки вообще, и агент звонил бы, не зная, что человек ждал звонка.
   */
  it("поле callbackRequest остаётся в схеме и с выключенным оператором", () => {
    const caps: BotCapabilities = {
      photos: true,
      photosPerOffer: 3,
      showings: true,
      showingConfirmations: true,
      followUps: true,
      comments: true,
      callback: false,
      askOwner: true,
      vacancies: true,
      links: true,
      cautious: false,
    };
    const off = qualifySchema(false, false, botAbilitiesOf(caps), false);
    expect(off.properties).toHaveProperty("callbackRequest");
  });
});

describe("анкета кандидата (jobApplication)", () => {
  it("частичные данные принимаются — анкета копится по ходу разговора", () => {
    expect(parseJobApplication({ name: "Фируз" })).toEqual({ name: "Фируз" });
    expect(parseJobApplication({ hasCar: true, age: 27 })).toEqual({ hasCar: true, age: 27 });
  });

  it("пустой объект и пустые строки — это «ничего не рассказал», а не запись", () => {
    expect(parseJobApplication({})).toBeNull();
    expect(parseJobApplication({ name: "  ", experience: "" })).toBeNull();
    expect(parseJobApplication("резюме")).toBeNull();
  });

  it("возраст вне человеческого — ошибка модели, а не факт о кандидате", () => {
    expect(parseJobApplication({ age: 250 })).toBeNull();
    expect(parseJobApplication({ age: 5 })).toBeNull();
  });

  it("телефон проверяется, а не просто обрезается до 40 символов", () => {
    /**
     * НАЙДЕНО 04.09.2026 (полный обход раздела). До этой правки поле phone
     * бралось из ответа модели как есть — «оставлю попозже» проходило точно
     * так же, как настоящий номер, и такая анкета навсегда считалась «с
     * телефоном» (HAS_PHONE в routes/vacancies.ts), хотя позвонить по ней
     * нельзя. Обычным лидам номер из текста достаёт код (extractTypedPhone),
     * а не модель, — та же осторожность нужна и здесь.
     */
    expect(parseJobApplication({ phone: "оставлю попозже" })).toBeNull();
    expect(parseJobApplication({ phone: "напишу отдельно" })).toBeNull();
    // Нормализуется в международный формат — как у обычных лидов.
    expect(parseJobApplication({ phone: "900112233" })?.phone).toBe("+992900112233");
    expect(parseJobApplication({ phone: "0900112233" })?.phone).toBe("+992900112233");
    expect(parseJobApplication({ phone: "+992900112233" })?.phone).toBe("+992900112233");
  });

  it("normalizeCandidatePhone: те же форматы, что у обычных лидов", () => {
    // Местный, без кода страны.
    expect(normalizeCandidatePhone("910001044")).toBe("+992910001044");
    // Набран внутри страны через ноль.
    expect(normalizeCandidatePhone("0910001044")).toBe("+992910001044");
    // Полный номер с кодом страны, в любом написании.
    expect(normalizeCandidatePhone("+992 91 000 10 44")).toBe("+992910001044");
    expect(normalizeCandidatePhone("992910001044")).toBe("+992910001044");
    // Код страны + местный набор через ноль сразу — тот самый капкан из
    // «потерянных лидов» 03.09.2026, повторённый и здесь намеренно.
    expect(normalizeCandidatePhone("992 0 91 000 10 44")).toBe("+992910001044");
    // Россия/Казахстан через 8.
    expect(normalizeCandidatePhone("89261234567")).toBe("+79261234567");
    expect(normalizeCandidatePhone("+79261234567")).toBe("+79261234567");
    // Мусор — не число вовсе, число не той длины (цена, а не телефон).
    expect(normalizeCandidatePhone("оставлю попозже")).toBeUndefined();
    expect(normalizeCandidatePhone("")).toBeUndefined();
    expect(normalizeCandidatePhone("1050000")).toBeUndefined();
  });
});

describe("правила выключенных возможностей дают замену, а не молчание", () => {
  it("вопросы собственнику выключены → отвечает агент по звонку", () => {
    // Решение владельца 16.08.2026: «пусть по таким вопросам агенты сами отвечают
    // по звонку». Модель обязана знать, ЧТО обещать вместо «уточню и вернусь».
    expect(ASK_OWNER_DISABLED_RULE).toContain("агент");
    expect(ASK_OWNER_DISABLED_RULE).toContain("Рақаматонро нависед");
    expect(ASK_OWNER_DISABLED_RULE).toContain("Выдумывать ответ запрещено");
  });

  it("вакансии выключены → фото/текст в текущем чате, анкету не собирать", () => {
    expect(VACANCIES_DISABLED_RULE).toContain("фото страниц резюме или текст");
    expect(VACANCIES_DISABLED_RULE).not.toContain("+992 777 77 60 01");
    expect(VACANCIES_DISABLED_RULE).toContain("НЕ собирай");
  });

  it("светофор считается по словам кандидата, а не только моделью", () => {
    /**
     * Владелец 03.09.2026: «нет логики по поводу цветов типа светофор — было
     * расписано, кандидаты должны были цвет менять от этого». Цвет ставила одна
     * модель и один раз; теперь он считается кодом на каждой записи анкеты.
     */
    expect(jobPriority({ experience: "работал риелтором два года" })).toBe("GREEN");
    expect(jobPriority({ experience: "дар савдо кор кардам" })).toBe("GREEN");
    expect(jobPriority({ experience: "опыта нет", education: "юрист" })).toBe("YELLOW");
    expect(jobPriority({ education: "дизайнер интерьера" })).toBe("YELLOW");
    // Профессия названа, но не по теме — это RED, а не отсутствие цвета.
    expect(jobPriority({ experience: "таксист" })).toBe("RED");
    /**
     * ОТРИЦАНИЕ СИЛЬНЕЕ КЛЮЧЕВОГО СЛОВА. «Опыта продаж нет» содержит слово
     * «продаж» — первая версия расчёта ставила такому кандидату GREEN и
     * поднимала его в начало очереди как опытного продавца.
     */
    expect(jobPriority({ experience: "Опыта продаж нет", education: "юрист" })).toBe("YELLOW");
    expect(jobPriority({ experience: "опыта продаж нет" })).toBe("RED");
    expect(jobPriority({ experience: "таҷрибаи фурӯш надорам" })).toBe("RED");
    // Рассказывать пока нечего — цвет не выдумываем.
    expect(jobPriority({ experience: null, education: null })).toBe(null);
    expect(jobPriority({ experience: "   " })).toBe(null);
  });

  it("живые анкеты 25.09.2026 — электрик/фармацевт/учитель/закупщик никогда не YELLOW или GREEN", () => {
    // Жалоба сотрудника, отбирающего кандидатов: «в зелёных стоят электрики и
    // женщины-домоседки». Разбор прод-базы после починки — ровно эти случаи.
    expect(jobPriority({ experience: "Электрик", education: "Оли" })).toBe("RED");
    expect(jobPriority({ experience: "Фармацевт" })).toBe("RED");
    expect(jobPriority({ experience: "омузгор" })).toBe("RED");
    expect(jobPriority({ experience: "10 сол муҳандиси пешбар дар шуъбаи хариди КВД" })).toBe("RED");
    expect(jobPriority({ experience: "Без опыта" })).toBe("RED");
    for (const word of NEVER_TARGET_WORDS) {
      expect(jobPriority({ experience: word })).toBe("RED");
      expect(jobPriority({ education: word })).toBe("RED");
    }
  });

  it("устроился на работу — не мастер стройки (регулярка стро[ий] чинена 25.09.2026)", () => {
    // `стро[ий]` ловило подстроку «строи» внутри «устроился» и уходило в YELLOW.
    expect(jobPriority({ experience: "устроился грузчиком" })).toBe("RED");
    // А настоящий мастер-строитель по-прежнему целевой.
    expect(jobPriority({ education: "мастер-строитель, усто" })).toBe("YELLOW");
    expect(jobPriority({ education: "усто" })).toBe("YELLOW");
  });

  it("живые примеры GREEN/YELLOW 25.09.2026", () => {
    expect(jobPriority({ experience: "риелтор 2 года" })).toBe("GREEN");
    expect(jobPriority({ experience: "Есть опыт в продажах" })).toBe("GREEN");
    expect(jobPriority({ education: "юрист, диплом" })).toBe("YELLOW");
    expect(jobPriority({ experience: "Опыта продаж нет", education: "юрист" })).toBe("YELLOW");
  });

  it("явное булево поле модели решает сильнее регулярки (не понижает и не поднимает вслепую)", () => {
    // Кандидат сам объяснил, что «продавец-консультант» по факту не был продажами —
    // явное salesExperience=false запрещает GREEN, даже когда в тексте есть слово
    // «продавец». Решает явное поле, а не гадание по подстроке.
    expect(jobPriority({ experience: "продавец-консультант", salesExperience: false })).not.toBe("GREEN");
    // И наоборот: модель прямо подтвердила продажи полем, даже когда слов в тексте нет.
    expect(jobPriority({ experience: "работал в Бинкор", salesExperience: true })).toBe("GREEN");
    expect(jobPriority({ education: "непрофильное", targetEducation: true })).toBe("YELLOW");
    expect(jobPriority({ education: "юрист", targetEducation: false })).not.toBe("YELLOW");
  });

  it("расчёт цвета — теперь единственный источник, старое сравнение цветов осталось чистой утилитой", () => {
    // strongerPriority больше не участвует в записи анкеты (см. lib/jobApplications.ts,
    // 25.09.2026) — цвет пересчитывается целиком по jobPriority на каждой записи.
    // Сама функция сравнения осталась: тест защищает её как отдельную утилиту.
    expect(strongerPriority("GREEN", "RED")).toBe("GREEN");
    expect(strongerPriority("RED", "YELLOW")).toBe("YELLOW");
    expect(strongerPriority(null, "RED")).toBe("RED");
    expect(strongerPriority("YELLOW", null)).toBe("YELLOW");
    expect(strongerPriority(null, null)).toBe(null);
  });

  it("причину цвета формирует код, согласованно с самим цветом", () => {
    expect(jobPriorityReason({ priority: "GREEN", experience: "риелтор 2 года" })).toContain("Опыт продаж");
    expect(jobPriorityReason({ priority: "YELLOW", education: "юрист" })).toContain("Целевое образование");
    expect(jobPriorityReason({ priority: "RED" })).toBe("Нет опыта продаж и целевого образования");
    expect(jobPriorityReason({ priority: null })).toBeNull();
  });

  it("jobMissingFacts называет ровно то, чего не хватает jobEligibility", () => {
    expect(jobMissingFacts({})).toEqual(["возраст", "учёба сейчас", "работа сейчас", "телефон"]);
    expect(jobMissingFacts({ age: 27, studyingNow: false, employedNow: false, phone: "+992900112233" })).toEqual([]);
    expect(jobMissingFacts({ age: 27 })).toEqual(["учёба сейчас", "работа сейчас", "телефон"]);
  });

  it("jobRejectReasons объясняет отказ словами", () => {
    expect(jobRejectReasons({ age: 20 })).toEqual(["моложе 24"]);
    expect(jobRejectReasons({ age: 30, studyingNow: true, employedNow: true })).toEqual([
      "учится",
      "работает сейчас",
    ]);
    expect(jobRejectReasons({ age: 30, studyingUniversity: false, studyingNow: false, employedNow: false })).toEqual(
      []
    );
  });

  it("jobApplicationIntakeBlock печатает то, что не хватает, посчитанное кодом", () => {
    expect(jobApplicationIntakeBlock([])).toBe("");
    const block = jobApplicationIntakeBlock(["возраст", "телефон"]);
    expect(block).toContain("ЕЩЁ НЕ ВЫЯСНЕНО (посчитано кодом)");
    expect(block).toContain("возраст, телефон");
  });

  it("догоняющая просьба о номере не дублирует самого бота", () => {
    /**
     * Регулярный проход (cron «candidate-phone-ask») просыпается каждые 15 минут
     * и ловит момент, когда откроется 24-часовое окно Meta. К этому моменту бот
     * уже ответил кандидату сам — и по своим правилам номер попросил. Второе
     * сообщение про тот же номер выглядит как неисправный автомат, поэтому
     * просьба в последних репликах бота считается выполненной задачей.
     */
    expect(
      botAlreadyAskedPhone([
        { role: "user", content: "Салом, кор доред?" },
        { role: "assistant", content: "Салом! Рақами телефонатонро фиристед, лутфан." },
      ])
    ).toBe(true);
    expect(
      botAlreadyAskedPhone([
        { role: "user", content: "Салом, кор доред?" },
        { role: "assistant", content: "Салом! Чандсолаед ва дар куҷо зиндагӣ мекунед?" },
      ])
    ).toBe(false);
    // Слова кандидата не в счёт: спрашивать должен бот.
    expect(botAlreadyAskedPhone([{ role: "user", content: "мой номер потерялся" }])).toBe(false);
  });

  it("сценарий вакансии требует телефон обязательно и разрешает переспросить", () => {
    /**
     * Решение владельца 03.09.2026: «надо всегда спрашивать телефон, это
     * обязательно — без телефона мы не знаем, как с ними связываться». Анкета без
     * номера в очередь CRM не попадает (routes/vacancies.ts), поэтому просьба о
     * номере обязана звучать в самом разговоре — иначе кандидат просто исчезает.
     *
     * Проверяется и разрешение переспросить: общий запрет «номер просят ОДИН раз»
     * живёт в тех же правилах строкой ниже, и без явного исключения модель молча
     * подчинится ему, а не этому.
     */
    // 20.09.2026: «HR перезвонит» владелец запретил; просьба о номере осталась,
    // причина теперь про заявку, а не про звонок (см. tests/no-hr-wording.test.ts).
    expect(SCENARIO_JOB).toContain("без него заявку не принять");
    expect(SCENARIO_JOB).toContain("ТЕЛЕФОН — ОБЯЗАТЕЛЕН");
    expect(SCENARIO_JOB).toContain("попроси ещё раз");
    // 17.09.2026: номер просится у ВСЕХ, включая тех, кого прежний отбор
    // отшивал первой же репликой. См. следующий тест.
    expect(SCENARIO_JOB).toContain("для ВСЕХ кандидатов без исключения");
  });

  it("сценарий вакансии: сначала резюме, потом ОДНА просьба рассказать о себе", () => {
    /**
     * Владелец 17.09.2026 вечером, по живой проверке на проде: «Сначала можно
     * убедиться, что у него есть резюме или нет, анкета, и так далее; если нет,
     * тогда попросить его рассказать о себе, о работе, опыте и так далее, а не по
     * одному сообщению за раз».
     *
     * Это отмена утренней редакции того же дня (знакомство «как зовут и откуда
     * узнали», дальше по одному вопросу за ход): владелец увидел её в работе и
     * назвал лишним опросом.
     */
    expect(SCENARIO_JOB).toContain("ШАГ 1 — ПОДТВЕРДИ ВАКАНСИЮ И СПРОСИ ПРО РЕЗЮМЕ");
    expect(SCENARIO_JOB).toContain("ШАГ 2а — РЕЗЮМЕ ЕСТЬ");
    expect(SCENARIO_JOB).toContain("ШАГ 2б — РЕЗЮМЕ НЕТ");
    expect(SCENARIO_JOB).toContain("ШАГ 3 — ТЕЛЕФОН");
    // Просьба рассказать о себе — ОДНИМ сообщением, со списком нужного внутри.
    expect(SCENARIO_JOB).toContain("ОДНИМ сообщением попроси рассказать о себе");
    expect(SCENARIO_JOB).toContain("Одним сообщением, а НЕ цепочкой отдельных вопросов");
    for (const q of ["сколько вам лет", "из какого города", "опыт в продажах", "работа или учёба", "почему вас заинтересовала недвижимость"]) {
      expect(SCENARIO_JOB).toContain(q);
    }
  });

  it("лишние вопросы владелец запретил дословно", () => {
    /**
     * Владелец процитировал ровно ту реплику бота, которую увидел на проде:
     * «Бале, мо агенти фурӯшро меҷӯем. Аз куҷо дар бораи мо шунидед». Запрет
     * должен стоять в промте буквально, иначе модель вернётся к нему как к
     * самому естественному способу начать разговор.
     */
    expect(SCENARIO_JOB).toContain("ЗАПРЕЩЕНЫ КАК ОТДЕЛЬНЫЕ ВОПРОСЫ");
    expect(SCENARIO_JOB).toContain("откуда вы о нас узнали");
    expect(SCENARIO_JOB).toContain("как к вам обращаться");
    // Утренняя редакция ушла целиком — двух разных первых шагов в промте быть не должно.
    expect(SCENARIO_JOB).not.toContain("ШАГ 1 — ПЕРВОЕ СООБЩЕНИЕ: ЗНАКОМСТВО");
    expect(SCENARIO_JOB).not.toContain("ПО ОДНОМУ ВОПРОСУ ЗА ХОД");
    expect(SCENARIO_JOB).not.toContain("ШАГ 1 — ПЕРВОЕ ЖЕ СООБЩЕНИЕ, ТОЛЬКО ПРО РЕЗЮМЕ");
  });

  it("студента и занятого бот больше НЕ отшивает — решает человек", () => {
    /**
     * Владелец 17.09.2026, прямая отмена правила от 16.08.2026. Прежний текст
     * велел модели вежливо отказать кандидату моложе 24 или учащемуся и НЕ просить
     * у него номер: живого человека отсеивал автомат, до того как что-либо о нём
     * узнал. Светофор (jobEligibility) остаётся пометкой на карточке, но разговор
     * он больше не останавливает.
     */
    expect(SCENARIO_JOB).toContain("ЭТО НЕ ОТКАЗ");
    expect(SCENARIO_JOB).toContain("Не отшивай");
    expect(SCENARIO_JOB).toContain("В ЛЮБОМ СЛУЧАЕ доведи разговор до номера телефона");
    expect(SCENARIO_JOB).toContain("решение принимает руководство, а не ты");
    // Прежней формулировки отказа в промте быть не должно вовсе.
    expect(SCENARIO_JOB).not.toContain("КОМУ ВАКАНСИЯ СЕЙЧАС НЕ ПОДХОДИТ");
    expect(SCENARIO_JOB).not.toContain("Номер в этом случае не проси");
  });

  it("факты о вакансии — из общего блока, цифры разрешены как ориентир, трудоустройство не обещается", () => {
    // Запрет на цифры снят владельцем 28.09.2026 (2% / 1% / 0,5%, $500 / $1000 /
    // до $10 тыс.); прежний «НИЧЕГО НЕ ОБЕЩАЙ про зарплату» ушёл. Остались запрет
    // на выдуманные числа и на обещание самого трудоустройства.
    expect(SCENARIO_JOB).toContain("наставник и обучение с первого дня");
    expect(SCENARIO_JOB).toContain("Запрет на цифры снят владельцем 28.09.2026");
    expect(SCENARIO_JOB).not.toContain("НИЧЕГО НЕ ОБЕЩАЙ про зарплату");
    expect(SCENARIO_JOB).toContain("не приукрашивай числами, которых там нет");
    expect(SCENARIO_JOB).toContain("Само трудоустройство, дату выхода и «вы приняты» НЕ обещай");
    // Две воронки Нурмухаммада: «подходит ли нам» и «подходим ли мы ему».
    expect(SCENARIO_JOB).toContain("ДВЕ ВОРОНКИ ДО СОБЕСЕДОВАНИЯ");
    expect(SCENARIO_JOB).toContain("оклада нет");
  });

  it("машина + сильное желание = зелёный (Нурмухаммад 28.09.2026, подтверждено Dan)", () => {
    // Без опыта продаж и без диплома, но с машиной и желанием — GREEN, и причина
    // называет именно этот путь, а не «подтверждён опыт в продажах».
    const drive = { experience: "таксист", hasCar: true, strongMotivation: true };
    expect(jobPriority(drive)).toBe("GREEN");
    expect(jobPriorityReason({ priority: "GREEN", ...drive })).toBe("Есть машина и сильное желание работать");
    // Одного из двух не хватает — правило не срабатывает.
    expect(jobPriority({ experience: "таксист", hasCar: true })).toBe("RED");
    expect(jobPriority({ experience: "таксист", strongMotivation: true })).toBe("RED");
    expect(jobPriority({ experience: "таксист", hasCar: true, strongMotivation: false })).toBe("RED");
    // Ничего, кроме машины и желания, ещё не известно — этого уже достаточно для цвета.
    expect(jobPriority({ hasCar: true, strongMotivation: true })).toBe("GREEN");
    expect(jobPriority({ hasCar: true })).toBeNull();
    // Опыт продаж главнее: причина остаётся про продажи.
    expect(jobPriorityReason({ priority: "GREEN", experience: "риелтор", hasCar: true, strongMotivation: true })).toContain(
      "Опыт продаж"
    );
    // Поле доезжает из ответа модели.
    expect(parseJobApplication({ strongMotivation: true, achievements: "лучший продавец года" })).toEqual({
      strongMotivation: true,
      achievements: "лучший продавец года",
    });
  });

  it("ссылки выключены → запрет явный, с заменой словами", () => {
    // Просто убрать ссылку из данных мало: модель её выдумает или пообещает.
    expect(LINKS_DISABLED_RULE).toContain("не обещай прислать ссылку");
    expect(LINKS_DISABLED_RULE).toContain("Фото и ссылку пришлёт агент");
  });

  it("режим запуска — правила с числами, а не «будь скромнее»", () => {
    // На Flash-моделях держатся только измеримые правила (ресёрч 16.08.2026).
    expect(CAUTIOUS_MODE_RULE).toContain("ОДНОГО уточняющего вопроса");
    expect(CAUTIOUS_MODE_RULE).toContain("не чаще одного раза");
    expect(CAUTIOUS_MODE_RULE).toContain("сильнее правил тона");
  });
});

describe("botAbilitiesOf — все ползунки доезжают до мозга бота", () => {
  it("каждое поле среза берётся из своей настройки", () => {
    // Ровно от этого дефекта функция и заведена: литерал `{ showings }` в пяти
    // местах молча оставлял новые возможности включёнными навсегда.
    const caps: BotCapabilities = {
      photos: true,
      photosPerOffer: 3,
      showings: false,
      showingConfirmations: false,
      followUps: true,
      comments: true,
      callback: false,
      askOwner: false,
      vacancies: false,
      links: false,
      cautious: true,
      promptEconomy: true,
    };
    expect(botAbilitiesOf(caps)).toEqual({
      showings: false,
      callback: false,
      askOwner: false,
      vacancies: false,
      links: false,
      cautious: true,
      promptEconomy: true,
    });
  });
});

/**
 * Разбор первого дня живого трафика (16.08.2026). Три случая из настоящих
 * переписок — каждый стоил клиенту либо ответа, либо доверия.
 */
describe("уроки первого дня живого трафика", () => {
  it("предлагать просмотр запрещено, когда показы выключены", () => {
    // Бот написал «Хотите посмотреть эту квартиру?» при выключенном рубильнике.
    // Формально правило соблюдено — времени не называл; по сути пообещал встречу,
    // которую назначает не он.
    expect(SHOWINGS_DISABLED_RULE).toContain("САМ ПРО ПРОСМОТР НЕ ЗАГОВАРИВАЙ");
    expect(SHOWINGS_DISABLED_RULE).toContain("Хотите посмотреть?");
  });

  it("язык вложения не решает язык ответа, и ответ не смешивает языки", () => {
    // Клиент прислал русский скриншот и спросил по-таджикски — бот ответил двумя
    // сообщениями на двух языках. Определитель отработал верно: дело было в том,
    // что модель взяла язык картинки.
    for (const lang of ["tg", "ru", "mixed"] as const) {
      expect(languageInstruction(lang)).toContain("на ОДНОМ языке");
      expect(languageInstruction(lang)).toContain("Язык КАРТИНКИ");
    }
  });

  it("неизвестный язык по-прежнему не получает никаких указаний", () => {
    // Принцип модуля: придуманное указание хуже отсутствующего.
    expect(languageInstruction("unknown")).toBe("");
  });
});

/**
 * ОБЯЗАТЕЛЬНЫЙ ФИЛЬТР КАНДИДАТОВ (правила отбора владельца 16.08.2026).
 *
 * «Моложе 24 или учится в вузе — не передавать» пришло текстом промта, а промт в
 * этом проекте гарантией не считается: правило живёт до первого хода, на котором
 * модель отвлеклась. Здесь проверяется то, что отвлечься не может, — решение в коде.
 */
describe("допуск кандидата считается кодом", () => {
  it("моложе 24 — не проходит, даже с опытом продаж", () => {
    expect(jobEligibility({ age: 22, studyingUniversity: false })).toBe(false);
    expect(jobEligibility({ age: 23 })).toBe(false);
  });

  it("учится в вузе — не проходит, даже если возраст подходит", () => {
    expect(jobEligibility({ age: 28, studyingUniversity: true })).toBe(false);
  });

  it("работает сейчас где-то ещё — не проходит (критерий владельца 30.08.2026)", () => {
    // Берём тех, кто может работать полный день без совмещения. Отказ действует
    // сразу, даже когда остальное про кандидата ещё не выяснено.
    expect(jobEligibility({ age: 30, studyingUniversity: false, studyingNow: false, employedNow: true })).toBe(false);
    expect(jobEligibility({ employedNow: true })).toBe(false);
  });

  it("учится сейчас где угодно — не проходит, даже если это не вуз", () => {
    // Колледж, техникум, лицей, школа: studyingUniversity про них ничего не знает
    // (он только про вуз), и раньше такой кандидат проходил насквозь.
    expect(jobEligibility({ age: 26, studyingUniversity: false, employedNow: false, studyingNow: true })).toBe(false);
    expect(jobEligibility({ studyingNow: true })).toBe(false);
  });

  it("всё выяснено и препятствий нет — проходит", () => {
    expect(
      jobEligibility({ age: 24, studyingUniversity: false, studyingNow: false, employedNow: false })
    ).toBe(true);
    expect(
      jobEligibility({ age: 35, studyingUniversity: false, studyingNow: false, employedNow: false })
    ).toBe(true);
  });

  it("пока возраст или учёба неизвестны — решения НЕТ, а не отказ", () => {
    // Отказывать по незнанию нельзя: человек просто ещё не ответил.
    expect(jobEligibility({})).toBeNull();
    expect(jobEligibility({ studyingUniversity: false })).toBeNull();
    expect(jobEligibility({ age: 30 })).toBeNull();
  });

  it("про работу и учёбу сейчас ещё не спрашивали — решения НЕТ, а не допуск", () => {
    // Главная ловушка новых критериев: молчание не «нет». Иначе кандидат попадёт
    // в раздел раньше, чем бот успеет спросить, работает ли он сейчас.
    expect(jobEligibility({ age: 30, studyingUniversity: false })).toBeNull();
    expect(jobEligibility({ age: 30, studyingUniversity: false, employedNow: false })).toBeNull();
    expect(jobEligibility({ age: 30, studyingUniversity: false, studyingNow: false })).toBeNull();
  });

  it("новые поля разбираются из ответа модели только как логические", () => {
    const draft = parseJobApplication({ age: 27, studyingNow: false, employedNow: true });
    expect(draft?.studyingNow).toBe(false);
    expect(draft?.employedNow).toBe(true);
    // «да»/«нет» строкой — это не ответ модели по схеме: поле остаётся неспрошенным.
    const junk = parseJobApplication({ age: 27, studyingNow: "нет", employedNow: 1 });
    expect(junk?.studyingNow).toBeUndefined();
    expect(junk?.employedNow).toBeUndefined();
  });

  it("курсы вузом не считаются — это забота модели, но поле принимаем как есть", () => {
    const draft = parseJobApplication({ age: 25, studyingUniversity: false });
    expect(draft?.studyingUniversity).toBe(false);
  });

  it("priority/priorityReason больше не приходят от модели — их разбор убран 25.09.2026", () => {
    // Цвет и причину теперь ставит только код (jobPriority/jobPriorityReason);
    // поля исчезли из схемы, и даже если модель что-то в них пришлёт, разбор
    // их молча игнорирует, а не приводит к своему виду.
    expect(parseJobApplication({ priority: "green", priorityReason: "test" })).toBeNull();
    expect(parseJobApplication({ age: 25, priority: "green" })?.priority).toBeUndefined();
  });

  it("salesExperience/targetEducation разбираются только как логические", () => {
    expect(parseJobApplication({ salesExperience: true })?.salesExperience).toBe(true);
    expect(parseJobApplication({ targetEducation: false })?.targetEducation).toBe(false);
    // Строка вместо булева — это не ответ модели по схеме, поле остаётся неспрошенным.
    expect(parseJobApplication({ age: 27, salesExperience: "да" })?.salesExperience).toBeUndefined();
  });
});
