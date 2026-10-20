import { PROPERTY_TYPES } from "@royal-home/shared";
import { z } from "zod";
import { prisma } from "../db.js";
import { logSystemError } from "../lib/systemError.js";
import { describeError } from "../lib/describeError.js";
import { loadMoneyContext } from "../lib/money.js";
import { callAiText } from "./client.js";
import { normalizeClientName } from "./replyGuards.js";
import { detectOutsideCoverage } from "./coverageGuard.js";
import { detectServiceOffer } from "./serviceOfferGuard.js";
import { detectOutOfScopeAsset } from "./assetScopeGuard.js";
import { looksLikeRentBudget, looksLikeRentRequest } from "./rentGuard.js";
import { detectIntentDirectionMismatch } from "./intentDirectionGuard.js";
import { isJobSeekerCall } from "./jobSeekerCall.js";

/**
 * Кем оказался позвонивший в офис и чего он хочет — из расшифровки его разговора
 * с оператором.
 *
 * ЗАЧЕМ ОТДЕЛЬНЫЙ РАЗБОР, ЕСЛИ РАЗБОР ЗВОНКА УЖЕ ЕСТЬ. `ai/callAnalysis.ts` отвечает
 * на другой вопрос — КАК прошёл разговор: оценка, возражения, договорённости, совет
 * агенту. Он разбирает работу СОТРУДНИКА и заполняет `CallAnalysis`, который читают
 * сводки и рейтинги. Здесь вопрос обратный — КТО ЗВОНИЛ: покупатель или продавец,
 * как его зовут, что ищет. Смешивать это в одну схему нельзя: поля «кто звонил»
 * бессмысленны у исходящего звонка агента (там и так известно, кому звонят), и
 * модель начала бы выдумывать их на каждом разговоре из ста в день.
 *
 * ПОЧЕМУ НЕ `ai/cardFill.ts`. Тот собирает ПРЕДЛОЖЕНИЕ агенту по УЖЕ ЗАВЕДЁННОЙ
 * карточке: читает всю переписку клиента и его прежние разговоры, требует agentId и
 * упирается в окно подтверждения. Здесь карточки ещё нет вовсе, агента тоже нет, а
 * материал ровно один — эта расшифровка.
 *
 * РАСШИФРОВКА И ПЕРЕВОД БЕРУТСЯ ГОТОВЫМИ, второго конвейера нет: разговор проходит
 * тот же путь `ingestCallRecording → transcribeAndEnrich`, что и звонок агента.
 */

/** Короче — не разговор, а «алло, ошибся»: разбирать нечего, платить не за что.
 *  Порог тот же, что у разбора качества (см. ai/callAnalysis.ts). */
const MIN_TRANSCRIPT_CHARS = 80;
/** Потолок расшифровки в запросе: кто звонил и что ищет, звучит в начале разговора. */
const MAX_TRANSCRIPT_CHARS = 6000;

/**
 * Ответ модели. Валидируется Zod на границе, как любые внешние данные: модель может
 * вернуть строку вместо числа, район, которого у агентства нет, или тип обращения
 * не из перечня — и всё это не должно попадать в карточку клиента.
 *
 * `.catch(undefined)` на каждом поле намеренно: одно испорченное поле не должно
 * терять весь разбор. Клиент, у которого модель переврала бюджет, всё равно
 * покупатель, и карточку по нему заводить надо.
 */
const extractSchema = z.object({
  kind: z.enum(["BUYER", "SELLER", "OTHER", "IRRELEVANT"]).catch("OTHER"),
  confident: z.boolean().catch(false),
  fullName: z.string().trim().min(2).max(120).nullish().catch(null),
  summary: z.string().trim().max(2000).nullish().catch(null),
  districtName: z.string().trim().max(120).nullish().catch(null),
  rooms: z.number().int().min(1).max(20).nullish().catch(null),
  propertyType: z.enum(PROPERTY_TYPES).nullish().catch(null),
  budgetMin: z.number().int().min(0).max(100_000_000).nullish().catch(null),
  budgetMax: z.number().int().min(0).max(100_000_000).nullish().catch(null),
  namedAgent: z.string().trim().min(2).max(120).nullish().catch(null),
  /**
   * ОБЪЕКТ, О КОТОРОМ ИДЁТ РЕЧЬ (Пачка 1 п.4, 11.09.2026) — адрес, название ЖК,
   * номер объекта («квартира три четыреста двадцать один») или ссылка, если
   * человек назвал что-то из этого прямо в разговоре. Строка как услышал, без
   * попытки самому найти объект — сопоставление со справочником делает код
   * (lib/telephony/resolveCallProperty.ts), не модель.
   */
  propertyHint: z.string().trim().min(2).max(200).nullish().catch(null),
  /**
   * ОРИЕНТИР, ВОЗЛЕ КОТОРОГО ОБЪЕКТ («у фабрики Гулдаст», «напротив Ашана») —
   * когда человек звонит по объявлению и описывает объект ценой и местом, а не
   * адресом (ПК-000475, 24.09.2026). Вместе с budgetMax его сопоставляет код
   * (resolveCallPropertyByDescription), не модель.
   */
  propertyLandmark: z.string().trim().min(2).max(120).nullish().catch(null),
  /** Этаж, этажность и площадь объекта из объявления — те же приметы для
   *  узнавания объекта (identifyProperty в lib/propertyMatch.ts, решение владельца 24.09.2026). */
  propertyFloor: z.number().int().min(-2).max(120).nullish().catch(null),
  propertyTotalFloors: z.number().int().min(1).max(120).nullish().catch(null),
  propertyAreaSqm: z.number().min(5).max(100_000).nullish().catch(null),
  /**
   * ПРИМЕТЫ ОБЪЯВЛЕНИЯ ОТДЕЛЬНО ОТ ЗАПРОСА (24.09.2026, проход по классам после
   * ОБ-000118). `rooms` и `budgetMax` — это «сколько нужно» и «сколько готов
   * платить», а узнаванию объекта нужно «сколько в объявлении»: «ищу двушку до
   * 400, видел вашу однушку за 300» раньше вычёркивало нужный объект дважды.
   * Цена объявления — числом и валютой как прозвучала; в сомони переводит код по
   * курсу справочника (как у робозвонка), а не модель.
   */
  propertyRooms: z.number().int().min(1).max(20).nullish().catch(null),
  propertyPrice: z.number().min(1).max(100_000_000).nullish().catch(null),
  propertyPriceCurrency: z.enum(["TJS", "USD"]).nullish().catch(null),
  propertyLandSotka: z.number().min(0.5).max(10_000).nullish().catch(null),
  /** Звонивший ищет работу у нас (Dan 02.10.2026) — итог решает код, см. ai/jobSeekerCall.ts. */
  jobSeeker: z.boolean().nullish().catch(null),
});

export interface IncomingCallLead {
  /** IRRELEVANT — курьер, реклама, ошиблись номером: карточка такому не нужна. */
  kind: "BUYER" | "SELLER" | "OTHER" | "IRRELEVANT";
  /** Модель уверена, что поняла разговор. false — разбираем руками (см. autoLeadFromCall). */
  confident: boolean;
  fullName: string | null;
  /** Что человек хочет — своими словами, одной-двумя строками. */
  requirementsNotes: string | null;
  desiredDistrictId: string | null;
  desiredRooms: number | null;
  desiredType: (typeof PROPERTY_TYPES)[number] | null;
  budgetMin: number | null;
  budgetMax: number | null;
  /**
   * Имя НАШЕГО сотрудника, которого человек назвал сам («мне нужен Умед»,
   * «я работаю с Нозой») — решение владельца 18.08.2026. Здесь это всего лишь
   * СТРОКА ИЗ РАЗГОВОРА: сверяет её со списком сотрудников и решает, кому отдать
   * клиента, код (lib/requestedAgent.ts). Модель может назвать кого угодно, в том
   * числе несуществующего, и доверять ей выбор ответственного нельзя.
   */
  namedAgent: string | null;
  /** Адрес/ЖК/номер объекта/ссылка, если человек назвал что-то из этого — строка
   *  как услышал, сопоставление со справочником делает resolveCallPropertyHint. */
  propertyHint: string | null;
  /** Ориентир объекта, как услышал («фабрика Гулдаст»); сопоставляет код. */
  propertyLandmark: string | null;
  propertyFloor: number | null;
  propertyTotalFloors: number | null;
  propertyAreaSqm: number | null;
  /** Комнат в объявлении (не «сколько нужно» — то desiredRooms). */
  propertyRooms: number | null;
  /** Цена объявления как прозвучала и её валюта; перевод в сомони — в коде. */
  propertyPrice: number | null;
  propertyPriceCurrency: "TJS" | "USD" | null;
  /** Площадь участка в сотках, если прозвучала. */
  propertyLandSotka: number | null;
  /**
   * Звонивший — соискатель: хочет работать у нас (Dan 02.10.2026). Не голое слово
   * модели: признак модели ИЛИ фраза соискателя в расшифровке, и только если нет
   * явной сделки с жильём (ai/jobSeekerCall.ts). true — kind всегда OTHER.
   */
  jobSeeker: boolean;
}

function toolSchema(districtNames: string[]): Record<string, unknown> {
  return {
    type: "object",
    required: ["kind", "confident"],
    properties: {
      kind: {
        type: "string",
        enum: ["BUYER", "SELLER", "OTHER", "IRRELEVANT"],
        description:
          "Кем оказался звонивший: BUYER — хочет купить или снять жильё; " +
          "SELLER — собственник, хочет продать или сдать свой объект; " +
          "OTHER — обращение по делу, но не купля-продажа (работа, вопрос по документам, партнёрство); " +
          "соискатель работы — всегда OTHER (и jobSeeker=true); " +
          "IRRELEVANT — к недвижимости отношения не имеет вовсе: курьер, реклама, ошиблись номером, " +
          "звонит сам сотрудник агентства, пустой разговор.",
      },
      confident: {
        type: "boolean",
        description:
          "true — из разговора ПОНЯТНО, кто звонил и зачем. false — расшифровка обрывочная, " +
          "разговор оборван на первых словах, смысл неясен. Сомневаешься — ставь false: " +
          "такой звонок разберёт человек, и это лучше выдуманной карточки.",
      },
      fullName: {
        type: "string",
        description:
          "Имя звонившего, если он назвал его САМ — в любом месте разговора: «меня зовут Далер», «ман Фозилшо», " +
          "«номам Гулру», в ответ на вопрос оператора. Пиши ТОЛЬКО САМО ИМЯ, без приставок и без номера телефона. " +
          "Не представился — оставь пусто; целая фраза, слово «тел», название города, района или адреса именем не являются.",
      },
      summary: {
        type: "string",
        description:
          "Что человек хочет — своими словами, 1-2 предложения по-русски: " +
          "«Ищет 2-комнатную в Сино до 400 тысяч сомони, готов смотреть на выходных»",
      },
      ...(districtNames.length > 0
        ? { districtName: { type: "string", enum: districtNames, description: "Район из списка. Не называли — пусто" } }
        : {}),
      rooms: { type: "number", description: "Сколько комнат нужно (или сколько в продаваемом объекте)" },
      propertyType: { type: "string", enum: [...PROPERTY_TYPES], description: "Тип объекта, если он прозвучал" },
      budgetMin: {
        type: "number",
        description:
          "Нижняя граница бюджета/цены в сомони, если названы ДВЕ цифры. Цена ЗА КВАДРАТНЫЙ МЕТР — не бюджет, " +
          "см. описание budgetMax.",
      },
      namedAgent: {
        type: "string",
        description:
          "Если человек назвал сотрудника НАШЕГО агентства, к которому хочет попасть " +
          "(«мне нужен Умед», «я работаю с Нозой», «мне посоветовали Баходура») — напиши это имя " +
          "как услышал, вместе с фамилией, если она прозвучала. Не называли — оставь пусто. " +
          "Имя самого звонящего сюда НЕ пиши, для него есть поле fullName.",
      },
      budgetMax: {
        type: "number",
        description:
          "Бюджет покупателя или цена продавца в сомони — ОБЩАЯ сумма покупки. Одна названная сумма " +
          "(«до 400 тысяч», «тысяч пятьдесят долларов») — это ВСЕГДА budgetMax. ИСКЛЮЧЕНИЕ: цена ЗА КВАДРАТНЫЙ " +
          "МЕТР («650 доллар за метр», расчёт для котлована/стадии строительства) — это цена единицы площади, " +
          "а не сумма всей покупки; сюда её не пиши.",
      },
      propertyHint: {
        type: "string",
        description:
          "Если человек называет КОНКРЕТНЫЙ объект — адрес («Рудаки 45, квартира 12»), " +
          "название ЖК, номер объекта или ссылку на объявление, — напиши это как услышал. " +
          "Не путай с общим запросом («ищу двушку в Сино») — это НЕ конкретный объект, оставь пусто.",
      },
      propertyLandmark: {
        type: "string",
        description:
          "Если человек спрашивает про конкретный объект и называет место или ориентир, возле " +
          "которого он стоит («квартира за 35 тысяч долларов у фабрики Гулдаст», «дом напротив " +
          "Ашана»), — напиши сам ориентир как услышал: «фабрика Гулдаст». Цену объявления при этом " +
          "пиши в propertyPrice. Ориентира не было — оставь пусто.",
      },
      propertyFloor: {
        type: "number",
        description: "Если человек спрашивает про конкретный объект и назвал его этаж («на пятом этаже») — число. Иначе пусто.",
      },
      propertyTotalFloors: {
        type: "number",
        description: "Этажность дома того объекта («девятиэтажка», «из двенадцати») — число. Иначе пусто.",
      },
      propertyAreaSqm: {
        type: "number",
        description: "Площадь того объекта в квадратных метрах, если прозвучала. Иначе пусто.",
      },
      propertyRooms: {
        type: "number",
        description:
          "Сколько комнат в том объекте, про который человек спрашивает («видел вашу однушку») — число. " +
          "Это НЕ то, сколько ему нужно (для этого поле rooms). Иначе пусто.",
      },
      propertyPrice: {
        type: "number",
        description:
          "Цена того объекта из объявления, если человек её назвал («видел квартиру за 35 тысяч долларов») — " +
          "числом, КАК ПРОЗВУЧАЛА, без перевода в сомони. Свой бюджет сюда не пиши. Иначе пусто.",
      },
      propertyPriceCurrency: {
        type: "string",
        enum: ["TJS", "USD"],
        description: "В чём названа propertyPrice: USD — доллары, TJS — сомони. Не уточнил — TJS.",
      },
      propertyLandSotka: {
        type: "number",
        description: "Площадь участка того объекта в сотках («шесть соток»), если прозвучала. Иначе пусто.",
      },
      jobSeeker: {
        type: "boolean",
        description:
          "true — человек звонит НАСЧЁТ РАБОТЫ У НАС: ищет работу, спрашивает про вакансию, хочет стать " +
          "агентом, предлагает резюме («кор мехоҳам», «насчёт вакансии»). Покупатель или продавец, который " +
          "между делом упомянул работу («звоните после работы»), — false. Не уверен — false.",
      },
    },
  };
}

function systemPrompt(districtNames: string[], usdToTjs: number): string {
  return (
    "Ты разбираешь запись телефонного разговора: человек сам позвонил в агентство недвижимости " +
    "Royal Home (Душанбе), трубку снял оператор. Твоя задача — понять, КТО звонил и ЧЕГО он хочет, " +
    "чтобы CRM завела карточку клиента без участия человека. " +
    "Разговор может идти на таджикском, русском или их смеси; расшифровка автоматическая, " +
    "в ней есть оговорки и ошибки распознавания — понимай смысл, а не буквальные слова. " +
    "Отвечай всегда по-русски. " +
    // Выдуманное поле здесь дороже пустого: пустое агент спросит у клиента сам, а
    // выдуманный бюджет он примет за факт и будет по нему подбирать.
    "НИЧЕГО НЕ ВЫДУМЫВАЙ. Не прозвучало — оставляй поле пустым: агент переспросит, " +
    "а придуманную цифру он примет за услышанную и будет по ней искать объекты. " +
    `Суммы приводи в сомони (1 доллар ≈ ${usdToTjs} сомони). ` +
    (districtNames.length > 0 ? `Районы агентства: ${districtNames.join(", ")}. Других названий не пиши. ` : "") +
    "Ответ передавай через инструмент submit_reply."
  );
}

/**
 * Разбирает расшифровку одного входящего звонка. Наружу не бросает — это фоновая
 * работа после разговора, и падать из-за неё конвейер записи не должен. `null`
 * означает «разобрать не удалось»: звонок останется человеку (см. autoLeadFromCall).
 */
export async function extractIncomingCallLead(transcript: string): Promise<IncomingCallLead | null> {
  const text = transcript.trim();
  if (text.length < MIN_TRANSCRIPT_CHARS) return null;

  try {
    const [districts, money] = await Promise.all([
      prisma.district.findMany({ select: { id: true, name: true }, orderBy: { name: "asc" }, take: 200 }),
      loadUsdRate(),
    ]);
    const districtNames = districts.map((d) => d.name);

    const raw = await callAiText<unknown>({
      endpoint: "incoming-call-lead",
      // Извлечение полей из текста — простая задача: у Claude это Haiku, разница в
      // цене на порядок, а входящих в день десятки.
      simple: true,
      system: systemPrompt(districtNames, money),
      user: `Расшифровка разговора:\n${text.slice(0, MAX_TRANSCRIPT_CHARS)}`,
      maxTokens: 600,
      schema: toolSchema(districtNames),
    });
    if (raw === null || typeof raw !== "object") return null;

    const parsed = extractSchema.safeParse(raw);
    if (!parsed.success) {
      // До этого места доходят только ответы, которые не спас даже `.catch` на полях,
      // — то есть модель вернула не тот объект вовсе. Молчать нельзя: иначе поломка
      // разбора выглядела бы как «клиенты перестали звонить».
      void logSystemError("ai", `Разбор входящего звонка вернул неожиданный ответ: ${parsed.error.message.slice(0, 300)}`);
      return null;
    }
    const extract = parsed.data;

    // Район — только из справочника: имя от модели ничего не значит, пока оно не
    // сошлось с настоящей записью (тот же приём, что в ai/cardFill.ts).
    const byName = new Map(districts.map((d) => [d.name.trim().toLowerCase(), d]));
    const district = extract.districtName ? byName.get(extract.districtName.trim().toLowerCase()) ?? null : null;

    let budgetMin = extract.budgetMin ?? null;
    let budgetMax = extract.budgetMax ?? null;
    // Перевёрнутый диапазон — обычная оговорка модели, а не повод терять обе цифры.
    if (budgetMin !== null && budgetMax !== null && budgetMin > budgetMax) [budgetMin, budgetMax] = [budgetMax, budgetMin];
    // Одна и та же сумма с двух сторон — это не «от и до», а названный потолок.
    if (budgetMin !== null && budgetMin === budgetMax) budgetMin = null;

    /**
     * ТЕ ЖЕ КОДОВЫЕ ОТСЕЧКИ, ЧТО У ПЕРЕПИСКИ — ТЕПЕРЬ И У ЗВОНКОВ (разбор 18.09.2026).
     *
     * До этой правки `kind` для звонка был решением ОДНОЙ модели, ничем не
     * перепроверенным: ровно то нарушение принципа «промт — просьба, а не
     * гарантия» (см. заголовок ai/leadKind.ts), ради которого для переписки уже
     * написаны detectOutsideCoverage/detectServiceOffer/detectOutOfScopeAsset/
     * looksLikeRentBudget. Разбор жалобы «покупателя и продавца путает» показал,
     * что звонки эти же отсечки не проходили вовсе — модель могла назвать BUYER
     * продавца участка или SELLER — арендодателя, и код это никак не проверял.
     *
     * Смотрим на `summary` (пересказ модели, что хочет человек) — это единственный
     * текст про самого звонившего, который здесь есть; сырых слов клиента отдельно
     * от оператора расшифровка не различает.
     */
    let kind = extract.kind;
    let summary = extract.summary ?? null;
    if (kind === "BUYER" || kind === "SELLER") {
      const text = summary ?? "";
      const coverage = detectOutsideCoverage(text);
      const service = !coverage ? detectServiceOffer(text) : null;
      const asset = !coverage && !service ? detectOutOfScopeAsset(text) : null;
      const rentBudget =
        !coverage && !service && !asset
          ? looksLikeRentBudget(budgetMax ?? budgetMin ?? undefined, text) || looksLikeRentRequest(text)
          : false;
      const direction = !coverage && !service && !asset && !rentBudget ? detectIntentDirectionMismatch(text, kind) : null;
      const guard =
        coverage != null
          ? `другой город (${coverage.place})`
          : service != null
            ? service.reason
            : asset != null
              ? asset.reason
              : rentBudget
                ? "похоже на аренду, а не покупку/продажу"
                : direction != null
                  ? direction.reason
                  : null;
      if (guard) {
        kind = "OTHER";
        summary = `⚠️ Код переопределил тип со слов модели (${guard}).${summary ? ` ${summary}` : ""}`;
      }
    }

    /**
     * СОИСКАТЕЛЬ (Dan 02.10.2026): признак модели или фраза соискателя в самих
     * словах разговора, но не при явной сделке с жильём — ai/jobSeekerCall.ts.
     * Тип при этом «Другое»: агенту по продажам соискатель не нужен.
     */
    const jobSeeker = isJobSeekerCall({ modelSaysJobSeeker: extract.jobSeeker === true, modelKind: kind, transcript: text });
    if (jobSeeker) kind = "OTHER";

    return {
      kind,
      jobSeeker,
      confident: extract.confident,
      /**
       * ИМЯ — ТОЛЬКО НАСТОЯЩЕЕ (30.08.2026). Схема выше требует от строки лишь двух
       * знаков, и в карточки с прода отсюда попадали «Тел», «Ака», «Варзоб», «Адрес
       * курган» — модель писала в поле имени первое, что услышала. Не распознали —
       * `null`, и карточка остаётся на заглушке, которую CRM заменит, когда человек
       * действительно назовётся (lib/placeholderName.ts).
       */
      fullName: normalizeClientName(extract.fullName),
      requirementsNotes: summary,
      desiredDistrictId: district?.id ?? null,
      desiredRooms: extract.rooms ?? null,
      desiredType: extract.propertyType ?? null,
      budgetMin,
      budgetMax,
      namedAgent: extract.namedAgent ?? null,
      propertyHint: extract.propertyHint ?? null,
      propertyLandmark: extract.propertyLandmark ?? null,
      propertyFloor: extract.propertyFloor ?? null,
      propertyTotalFloors: extract.propertyTotalFloors ?? null,
      propertyAreaSqm: extract.propertyAreaSqm ?? null,
      propertyRooms: extract.propertyRooms ?? null,
      propertyPrice: extract.propertyPrice ?? null,
      propertyPriceCurrency: extract.propertyPrice ? (extract.propertyPriceCurrency ?? "TJS") : null,
      propertyLandSotka: extract.propertyLandSotka ?? null,
    };
  } catch (err) {
    // Отказ ИИ не глотаем: он должен быть виден в «Здоровье системы», иначе
    // автоматика тихо перестанет заводить карточки и никто об этом не узнает.
    void logSystemError("ai", `Разбор входящего звонка не выполнен: ${describeError(err)}`);
    return null;
  }
}

/** Курс доллара — тем же источником, что и подбор объектов (lib/money.ts). */
async function loadUsdRate(): Promise<number> {
  try {
    const { usdToTjs } = await loadMoneyContext();
    return usdToTjs;
  } catch {
    // Курс — уточнение, а не условие разбора: без него модель просто оставит
    // долларовую сумму долларовой, и агент поправит одну цифру.
    return 11;
  }
}
