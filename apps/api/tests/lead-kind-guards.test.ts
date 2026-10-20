import { describe, expect, it } from "vitest";

/**
 * НЕЦЕЛЕВЫЕ ЛИДЫ — ПРОВЕРЯЕМ ИМЕННО КОД, А НЕ ПРОМТ (разбор 30.08.2026).
 *
 * Повод: 181 боевая карточка за две недели дала 40 нецелевых лидов, ушедших живым
 * агентам. 29 из них — чужая география, остальные: услуги мастеров, участки и
 * коммерция, реклама конкурирующей площадки, арендные суммы. Каждый из этих
 * запретов стоял в промте — и каждый модель исполнила наполовину: отказ клиенту
 * произносила, а лид всё равно заводила (см. royal-home-prompt-is-not-a-guarantee).
 *
 * Здесь проверяется решение КОДА: тип карточки и отсечки, поверх которых ответ
 * модели уже ничего не решает.
 */

const { detectOutsideCoverage } = await import("../src/ai/coverageGuard.js");
const { detectServiceOffer } = await import("../src/ai/serviceOfferGuard.js");
const { detectOutOfScopeAsset } = await import("../src/ai/assetScopeGuard.js");
const { detectAgencyPitch } = await import("../src/ai/agencyPitchGuard.js");
const {
  detectIntentDirectionMismatch,
  clientStatedDirection,
  detectOneSidedDirectionQuestion,
  guardDirectionQuestion,
  NEUTRAL_FIRST_REPLY,
  NEUTRAL_DIRECTION_QUESTION,
} = await import("../src/ai/intentDirectionGuard.js");
const { decideLeadKind, DIRECTION_CONFLICT_NOTE } = await import("../src/ai/leadKind.js");
const { extractPostAcceptFacts } = await import("../src/ai/postAcceptFacts.js");
const { looksLikeNoContactComplaint } = await import("../src/ai/complaintGuard.js");
const { looksLikeMoneyRequest } = await import("../src/ai/moneyRequestGuard.js");
const { countPhoneAsks, dropRepeatedBubbles, countUnresolvedShareReplies, MAX_UNRESOLVED_SHARE_REPLIES } =
  await import("../src/ai/replyRepeatGuard.js");

describe("география: работаем только по Душанбе", () => {
  it.each([
    ["Вахдат", "Салом, дар Вахдат хона мефурушам"],
    ["Кулоб", "хонаи дар Кӯлоб доред?"],
    ["Курган-Тюбе", "продам дом в Курган-Тюбе"],
    // Покупатель в другом городе раньше не отсекался НИЧЕМ: поле модели
    // locationOutsideDushanbe заполняется только при intent=sell.
    ["Худжанд у покупателя", "хочу купить квартиру в Худжанде"],
  ])("ловит %s", (_label, text) => {
    expect(detectOutsideCoverage(text)).not.toBeNull();
  });

  it.each([
    ["упомянут Душанбе — клиент наш", "я из Худжанда, ищу квартиру в Душанбе"],
    ["район Душанбе", "Сино, 3 хона, то 700 хазор"],
    ["ориентир Варзоб ГЭС — это город", "хона назди Варзоб ГЭС"],
    ["обычный покупатель", "Салом, квартира даркор, 2 хона, 82 мкр"],
  ])("не трогает: %s", (_label, text) => {
    expect(detectOutsideCoverage(text)).toBeNull();
  });
});

describe("предложение услуг и поиск работы", () => {
  it("ловит живой случай с электриком", () => {
    expect(detectServiceOffer("Шумода электрик лозим боша занг занен")).not.toBeNull();
  });
  it("ловит бригаду с ремонтом под ключ", () => {
    expect(detectServiceOffer("делаем ремонт под ключ, качественно")).not.toBeNull();
  });
  it("мастер, который САМ покупает квартиру, — обычный клиент", () => {
    expect(detectServiceOffer("я электрик, хочу купить квартиру")).toBeNull();
  });

  /**
   * ПРОФЕССИЯ САМА ПО СЕБЕ — НЕ ПРЕДЛОЖЕНИЕ УСЛУГ (найдено 20.09.2026,
   * docs/bot-razbor-20-09.md, класс 4 п. 7). До этого одно упоминание ремесла
   * уводило карточку покупателя в OTHER — агентам такое обращение не раздаётся,
   * то есть живой лид терялся молча. Слова «купить» в таком сообщении нет:
   * оно было десять реплик назад, и амнистия по одной реплике его не спасала.
   */
  it.each([
    ["покупатель планирует работы", "потом нужен будет электрик, после ремонта"],
    ["просто упомянул материал", "гипсокартон мне не нравится"],
    ["спрашивает про сантехнику", "а сантехник в этой квартире новый?"],
  ])("одна профессия без второго признака — не вердикт (%s)", (_label, text) => {
    expect(detectServiceOffer(text)).toBeNull();
  });

  it.each([
    ["звоните, если надо", "Шумода сантехник лозим боша занг занен"],
    ["мы делаем, недорого", "Кафелчи ҳастем, арзон"],
    ["если нужен вашим клиентам", "Если нужен сварщик вашим клиентам, пишите"],
  ])("профессия со вторым признаком — вердикт на месте (%s)", (_label, text) => {
    expect(detectServiceOffer(text)).not.toBeNull();
  });

  /**
   * ВЕБ/IT/МАРКЕТИНГ-УСЛУГИ (23.09.2026, живой случай: «Предложение
   * веб-разработки (вебсайт)» из Instagram осталось в очереди «просит звонок»
   * на дашборде — TRADE/OFFER ловят только физические ремёсла и глагольную
   * форму «предлагаем», а «Предложение веб-разработки» — существительное.
   */
  it.each([
    ["живой случай Instagram", "Предложение веб-разработки (вебсайт)"],
    ["продвижение соцсетей", "Делаем SMM и продвижение аккаунта в Инстаграм, недорого"],
    ["IT-услуги", "Предлагаем IT-услуги для вашей компании"],
    ["разработка сайта", "Здравствуйте, занимаемся разработкой сайтов под ключ"],
  ])("веб/IT-услуги ловятся тем же стражем (%s)", (_label, text) => {
    expect(detectServiceOffer(text)).not.toBeNull();
  });
  it("покупатель, упомянувший свой сайт-визитку, — не вердикт", () => {
    expect(detectServiceOffer("у нас есть свой сайт компании, хотим офис под него купить")).toBeNull();
  });
});

describe("земля и коммерция", () => {
  it.each([
    ["участок", "продам участок 6 соток"],
    ["цех", "нужен цех 2000 м2"],
  ])("ловит %s", (_label, text) => {
    expect(detectOutOfScopeAsset(text)).not.toBeNull();
  });

  it.each([
    ["дом с участком — это дом", "продам дом с участком"],
    ["магазин как ориентир", "квартира рядом с магазином, 3 хона"],
  ])("не трогает: %s", (_label, text) => {
    expect(detectOutOfScopeAsset(text)).toBeNull();
  });
});

describe("коммерческое предложение нашему агентству", () => {
  it("ловит рекламу чужой площадки объявлений", () => {
    expect(
      detectAgencyPitch(
        "Здравствуйте! Наша новая площадка объявлений: первым агентам даём бесплатный месяц PRO, пришлите 2-3 ваших объекта"
      )
    ).not.toBeNull();
  });
  it("обычный вопрос про квартиру не трогает", () => {
    expect(detectAgencyPitch("Здравствуйте, есть 2-комнатная в 82 мкр?")).toBeNull();
  });

  /**
   * ПРОДАВЕЦ, КОТОРЫЙ ПРОСИТ НАС О РАБОТЕ, — НЕ ЧУЖАЯ РЕКЛАМА (20.09.2026,
   * выгрузка 775 живых переписок, docs/bot-razbor-20-09.md).
   *
   * Голая основа «агентств» давала очко любому, кто называет нас агентством, а
   * «продвижение объявления» — второе. В сумме живой продавец получал полное
   * молчание и не получал карточки, то есть самая дорогая ошибка из возможных.
   */
  it.each([
    ["просит продвижение через нас", "Здравствуйте, хочу продвижение объявления через ваше агентство"],
    ["называет нас агентством", "Ваше агентство занимается продажей квартир?"],
    ["продавец со своей квартирой", "Продаю свою трёшку, хочу разместить объявление у вас"],
    ["покупатель про рекламу объявлений", "Я видел рекламу объявления, у меня квартира в Сино, поможете продать?"],
    ["по-таджикски: продаю свою квартиру", "Салом, хонаи ман дар Сино, мехоҳам фурӯшам, агентии шумо кор мекунад?"],
  ])("своего человека не отсекает: %s", (_label, text) => {
    expect(detectAgencyPitch(text)).toBeNull();
  });

  it.each([
    ["предложение цеху", "Предложение для агентств недвижимости: тариф PRO бесплатно первый месяц"],
    ["обращение к нашим агентам", "Вашим агентам дадим премиум-доступ, зарегистрируйтесь на платформе"],
    ["просят разместить наши объекты", "Разместите ваши объекты на нашей площадке — бесплатный месяц размещения"],
  ])("чужое предложение по-прежнему ловит: %s", (_label, text) => {
    expect(detectAgencyPitch(text)).not.toBeNull();
  });
});

/**
 * МЁРТВЫЕ ПРАВИЛА СТРАЖЕЙ: `\w` И `\b` СЧИТАЮТСЯ ПО ЛАТИНИЦЕ
 * (найдено 20.09.2026, docs/bot-razbor-20-09.md).
 *
 * В JS `\w` — это `[A-Za-z0-9_]` даже с флагом `u`, а `\b` — граница между таким
 * символом и любым другим. Поэтому `дом\b` не совпадал НИ С ОДНИМ сообщением, а
 * `офис\w*\s+харид` ловил только форму без окончания. Семь правил в стражах
 * выглядели написанными и молчали. Здесь проверяются именно живые формы слов.
 */
describe("кириллические окончания в стражах (не латиница)", () => {
  it("«дом» в разговоре о деньгах снова считается нашей темой", () => {
    // PROPERTY_CONTEXT — амнистия: просьба о деньгах внутри разговора про дом не
    // должна выключать бота насовсем. С `дом\b` эта амнистия не работала вовсе.
    // Слово «дом» здесь единственный признак нашей темы: «рассрочка» или
    // «ипотека» в этой же фразе прошли бы амнистию и без него.
    expect(looksLikeMoneyRequest("Нужен дом в Душанбе, дайте в долг 1000 сомони до сделки")).toBe(false);
  });

  it.each([
    ["офис с окончанием", "Офиси харид мекунам"],
    ["салон красоты", "Салони зебоӣ мефурӯшам"],
    ["готовый бизнес", "Бизнеси омода мехарам"],
  ])("коммерция ловится в живой форме слова: %s", (_label, text) => {
    expect(detectOutOfScopeAsset(text)).not.toBeNull();
  });

  it("предложение ремонта в живой форме слова — не покупатель", () => {
    expect(detectServiceOffer("Таъмирҳо мекунем, арзон")).not.toBeNull();
  });

  it("площадка с подпиской и продвижением объявлений ловится", () => {
    expect(
      detectAgencyPitch("Для агентств недвижимости: подписка на продвижение объявлений, первый месяц бесплатно")
    ).not.toBeNull();
  });
});

describe("просьба о помощи, не про недвижимость (ПК-000330)", () => {
  it("ловит «ёрдам… лечение ребёнка» без единого слова про деньги", () => {
    expect(looksLikeMoneyRequest("Ёрдами шумоҳо даркор… лечение ребёнка")).toBe(true);
  });

  /**
   * «БЕМОР» БЕЗ ОКОНЧАНИЯ НЕ ЛОВИЛСЯ ВОВСЕ (найдено 20.09.2026). В правиле
   * стояло `бемор\\b`, а `\\b` в JavaScript после кириллицы не срабатывает никогда —
   * решение владельца молчать на такую просьбу не выполнялось, и карточка уходила
   * агентам как покупатель.
   */
  it.each([
    ["без окончания", "Кӯмак кунед, модарам бемор"],
    ["причина перед просьбой", "Модарам бемор, ёрдам кунед"],
  ])("«бемор» без окончания тоже просьба о помощи (%s)", (_label, text) => {
    expect(looksLikeMoneyRequest(text)).toBe(true);
  });

  it("покупатель, которому надо помочь с квартирой, под правило не попадает", () => {
    expect(looksLikeMoneyRequest("Кӯмак кунед, хона харидан мехоҳам")).toBe(false);
  });
  it("не трогает обычную просьбу помочь подобрать квартиру", () => {
    expect(looksLikeMoneyRequest("Ёрдам кунед хона ёфтан, 2 хона лозим")).toBe(false);
  });
});

describe("decideLeadKind — тип карточки решает код", () => {
  it("намерения нет вовсе — это НЕ покупатель (корень всей истории)", () => {
    expect(decideLeadKind({ clientText: "918001122" }).kind).toBe("OTHER");
  });
  it("модель не уверена — «прочее обращение»", () => {
    expect(decideLeadKind({ intent: "buy", confident: false, clientText: "ммм" }).kind).toBe("OTHER");
  });
  it("обычный покупатель остаётся покупателем", () => {
    expect(decideLeadKind({ intent: "buy", confident: true, clientText: "2 хона дар Сино мехарам" }).kind).toBe("BUYER");
  });
  it("продавец остаётся продавцом", () => {
    expect(decideLeadKind({ intent: "sell", confident: true, clientText: "хонаамро мефурӯшам, Фирдавси" }).kind).toBe(
      "SELLER"
    );
  });
  it("покупатель в чужом городе — в «прочие», а не агенту", () => {
    expect(decideLeadKind({ intent: "buy", confident: true, clientText: "дар Бохтар хона мехарам" }).kind).toBe("OTHER");
  });
  it("бюджет ниже порога покупки — похоже на аренду (живой случай 98)", () => {
    expect(decideLeadKind({ intent: "buy", confident: true, clientText: "квартира лозим", budgetMax: 3500 }).kind).toBe(
      "OTHER"
    );
  });
  /**
   * ЖИВОЙ СЛУЧАЙ 03.09.2026, карточка ПК-000250: «2 хуҷрага бо нархи аз 3000 то
   * 4500». Правило выше существовало, но молчало: mergeDraft стирает нереальную
   * вилку из бюджета (по ней нельзя искать объекты), и сюда бюджет доезжал уже
   * пустым. Теперь стёртая сумма приходит отдельным полем — и решает тип.
   */
  it("стёртая из бюджета сумма всё равно делает обращение «прочим», а не покупателем", () => {
    const decision = decideLeadKind({
      intent: "buy",
      confident: true,
      clientText: "2 хуҷрага дар назди донишгоҳи Милли",
      budgetUnrealistic: 4500,
    });
    expect(decision.kind).toBe("OTHER");
    expect(decision.label).toContain("АРЕНДУ");
  });
  it("нормальный бюджет покупки по-прежнему покупатель", () => {
    expect(
      decideLeadKind({ intent: "buy", confident: true, clientText: "2 хона мехарам", budgetMax: 450_000 }).kind
    ).toBe("BUYER");
  });
  it("человек уточнил, что сумма в долларах — улика аренды снимается вместе с новым бюджетом", async () => {
    const { mergeDraft } = await import("../src/ai/leadQualifier.js");
    const rentish = mergeDraft({ stage: "chatting" }, { reply: [], ready: false, lead: { budgetMax: 4500 } } as never, "аз 3000 то 4500");
    expect(rentish.budgetUnrealistic).toBe(4500);
    const clarified = mergeDraft(rentish, { reply: [], ready: false, lead: { budgetMax: 450_000 } } as never, "ба доллар");
    expect(clarified.budgetUnrealistic).toBeUndefined();
    expect(decideLeadKind({ ...clarified, intent: "buy", confident: true, clientText: "ба доллар" }).kind).toBe("BUYER");
  });
  it("форма сайта без намерения остаётся покупателем (fallbackKind)", () => {
    expect(decideLeadKind({ clientText: "нужна 2-комнатная", fallbackKind: "BUYER" }).kind).toBe("BUYER");
  });

  /**
   * ЖИВОЙ СЛУЧАЙ 17.09.2026, карточка ПК-000330: «Ёрдами шумоҳо даркор… лечение
   * ребёнка» дошло до карточки (пре-скрин на входе её почему-то пропустил) и
   * ушло агентам с kind=BUYER, хотя aiScore потом честно посчитал 0 («клиент не
   * заинтересован в услугах агентства, обращение ошибочно»). Модель тут не при
   * чём: даже с intent="buy" и confident=true код обязан узнать просьбу о
   * помощи и не отдавать карточку агенту.
   */
  it("просьба о помощи (не по недвижимости) — «прочее», даже если модель решила иначе (ПК-000330)", () => {
    const decision = decideLeadKind({
      intent: "buy",
      confident: true,
      clientText: "Ёрдами шумоҳо даркор… лечение ребёнка",
    });
    expect(decision.kind).toBe("OTHER");
    expect(decision.reason).toBe("не по теме");
  });
});

/**
 * §10.4 плана (docs/contact-profile-and-bot-roles-20-09.md, 22.09.2026):
 * категория досье решает тип карточки, но ТОЛЬКО когда этот ход сам неуверен
 * (confident=false / намерения нет) — и только когда вызывающий код передал
 * `priorCategory` (что он делает лишь при включённом тумблере
 * `Settings.contactCategoryDrivesLeadKind`, см. lib/contactProfiles.ts::categoryForLeadKind).
 * decideLeadKind сам тумблер не читает: без `priorCategory` в input поведение
 * не меняется ни на байт — этим тестам ниже нужно только само поле.
 */
describe("decideLeadKind — категория досье для неуверенного хода (§10.4)", () => {
  it("тумблер выключен (priorCategory не передан) — поведение прежнее: «не уверена» остаётся «прочим»", () => {
    expect(decideLeadKind({ intent: "buy", confident: false, clientText: "ммм" }).kind).toBe("OTHER");
  });
  it("тумблер выключен — «намерения нет» остаётся «прочим»", () => {
    expect(decideLeadKind({ clientText: "918001122" }).kind).toBe("OTHER");
  });
  it("модель не уверена, но досье знает продавца — карточка продавца, а не «прочее»", () => {
    const decision = decideLeadKind({
      intent: "buy",
      confident: false,
      clientText: "ммм",
      priorCategory: "SELLER",
    });
    expect(decision.kind).toBe("SELLER");
    expect(decision.reason).toContain("категория из досье");
  });
  it("намерения нет вовсе, но досье знает покупателя — карточка покупателя", () => {
    const decision = decideLeadKind({ clientText: "918001122", priorCategory: "BUYER" });
    expect(decision.kind).toBe("BUYER");
  });
  it("категория JOB/PARTNER/OTHER/UNKNOWN подсказки не даёт — остаётся «прочим», как раньше", () => {
    for (const category of ["JOB", "PARTNER", "CLIENT_CARE", "VENDOR", "SPAM", "OTHER", "UNKNOWN"]) {
      expect(decideLeadKind({ clientText: "918001122", priorCategory: category }).kind).toBe("OTHER");
    }
  });
  it("код-отсечка (чужой город) сильнее категории из досье, даже включённой", () => {
    const decision = decideLeadKind({
      intent: "buy",
      confident: true,
      clientText: "дар Бохтар хона мехарам",
      priorCategory: "BUYER",
    });
    expect(decision.kind).toBe("OTHER");
    expect(decision.reason).toContain("другой город");
  });
  it("уверенное решение модели сильнее категории из досье (продавец из истории пишет как покупатель сегодня)", () => {
    const decision = decideLeadKind({
      intent: "buy",
      confident: true,
      clientText: "2 хона дар Сино мехарам",
      priorCategory: "SELLER",
    });
    expect(decision.kind).toBe("BUYER");
  });
  it("intent=other (модель явно сказала «прочее») категория не перебивает — это не тот же случай, что «не уверена»", () => {
    const decision = decideLeadKind({ intent: "other", clientText: "не по теме", priorCategory: "BUYER" });
    expect(decision.kind).toBe("OTHER");
    expect(decision.reason).toBe("прочее");
  });
});

/**
 * Разбор 18.09.2026 (жалоба агента Нозы): модель может перепутать НАПРАВЛЕНИЕ,
 * а не только сорваться на постороннюю тему — старые отсечки выше это не ловили.
 */
describe("направление покупки/продажи — модель тоже может перепутать", () => {
  it("клиент явно про покупку — SELLER от модели считается противоречием", () => {
    const mismatch = detectIntentDirectionMismatch("2 хона дар Сино мехарам", "SELLER");
    expect(mismatch).not.toBeNull();
  });
  it("клиент явно про продажу своего — BUYER от модели считается противоречием", () => {
    const mismatch = detectIntentDirectionMismatch("хонаамро мефурӯшам, Фирдавси", "BUYER");
    expect(mismatch).not.toBeNull();
  });
  it("прозвучали оба направления — решение оставляем модели", () => {
    expect(detectIntentDirectionMismatch("куплю квартиру, а старую заодно продам", "SELLER")).toBeNull();
    expect(detectIntentDirectionMismatch("куплю квартиру, а старую заодно продам", "BUYER")).toBeNull();
  });
  it("ни одного сигнала — решение оставляем модели", () => {
    expect(detectIntentDirectionMismatch("салом, хона", "BUYER")).toBeNull();
  });
  // Владелец 13.10.2026: противоречие — не повод терять лид в «Прочих» (за 30 дней
  // так осталось без агента и без звонка 28 живых клиентов). Агенту с пометкой.
  it("decideLeadKind: сказал «мехарам» (куплю), модель поставила intent=sell — агенту с пометкой «уточнить»", () => {
    const decision = decideLeadKind({ intent: "sell", confident: true, clientText: "2 хона дар Сино мехарам" });
    expect(decision.kind).toBe("SELLER");
    expect(decision.label).toContain(DIRECTION_CONFLICT_NOTE);
  });
  it("decideLeadKind: сказал «мефурӯшам» (продаю), модель поставила intent=buy — агенту с пометкой «уточнить»", () => {
    const decision = decideLeadKind({ intent: "buy", confident: true, clientText: "хонаамро мефурӯшам, Фирдавси" });
    expect(decision.kind).toBe("BUYER");
    expect(decision.label).toContain(DIRECTION_CONFLICT_NOTE);
  });
  it("кнопка рекламы WhatsApp с текстом объявления «…фурӯхта мешавад» — покупатель остаётся покупателем", () => {
    const decision = decideLeadKind({
      intent: "buy",
      confident: true,
      clientText: "Привет! Можно узнать об этом подробнее? Квартираи 3-ҳуҷрагии нав фурӯхта мешавад",
    });
    expect(decision.kind).toBe("BUYER");
  });
});

/**
 * КАРТОЧКА №104, INSTAGRAM, 21.08.2026 (разбор 21.09.2026). Клиент прислал ТОЛЬКО
 * описание квартиры («Гардиш Ленинград, 1 этаж, 51 кв.м, 2-хонага») — не сказал ни
 * «покупаю», ни «продаю». Бот сам спросил наводящим вопросом «Шумо ин хонаро
 * мефурӯшед?», клиент ответил ценой (не подтверждая направление, просто отвечая на
 * заданный вопрос) — карточка стала SELLER, а человек оказался покупателем.
 *
 * Уточнение владельца 21.09.2026: на первое сообщение, где направление не ясно, бот
 * не спрашивает даже «покупаете или продаёте?» — только здоровается и спрашивает,
 * чем помочь; нейтральный вопрос с обоими вариантами — только если разговор уже
 * идёт, а направление всё ещё не ясно.
 */
describe("направление не угадываем — карточка №104 (Instagram, 21.09.2026)", () => {
  const propertyDescriptionOnly = "Гардиши Ленинград, ошиёнаи якум, 51 метр, 2-хонагӣ";
  const leadingSellQuestion = "Шумо ин хонаро мефурӯшед? Нархаш чанд аст?";

  describe("clientStatedDirection — направление, названное СЛОВАМИ клиента", () => {
    it("«хонаи фуруши дорам» — продавец", () => {
      expect(clientStatedDirection("Салом, хонаи фуруши дорам, 3-хонагӣ")).toBe("sell");
    });
    it("«хона мехарам» — покупатель", () => {
      expect(clientStatedDirection("Хона мехарам, 2-хонагӣ")).toBe("buy");
    });
    it("«ищу квартиру» — покупатель", () => {
      expect(clientStatedDirection("Здравствуйте, ищу квартиру в центре")).toBe("buy");
    });

    // 28.09.2026, WhatsApp: «есть дома на продажу?» — вопрос покупателя, отсечка
    // уводила его в «Прочие», хотя модель верно назвала покупателем.
    it.each([
      ["Салом Да 112 мкр хонаи фуруши дорен . Чихеле боша да 112 боша суратоша партое", "buy"],
      ["хонаи фуруши доред?", "buy"],
      ["У вас есть квартиры на продажу в Сино?", "buy"],
      ["Есть ли в продаже двушки?", "buy"],
      ["хонаи фурӯшӣ дорам, 3 хона", "sell"],
      ["у меня есть квартира на продажу", "sell"],
    ])("вопрос «что у вас на продажу» — покупатель: %s", (text, expected) => {
      expect(clientStatedDirection(text)).toBe(expected);
    });
    it("голое описание объекта (карточка №104) — направление НЕ названо", () => {
      expect(clientStatedDirection(propertyDescriptionOnly)).toBeNull();
    });
    it("ответ на наводящий вопрос бота ценой — направление всё ещё НЕ названо", () => {
      // Тот же случай №104: клиент ответил суммой на вопрос бота, а не заявил
      // направление сам. Сумма сама по себе не содержит ни BUY_SIGNAL, ни SELL_SIGNAL.
      expect(clientStatedDirection(`${propertyDescriptionOnly} 310 ҳазор сомонӣ`)).toBeNull();
    });
  });

  describe("detectOneSidedDirectionQuestion — наводящий вопрос бота", () => {
    it("«Шумо ин хонаро мефурӯшед?» — предполагает продавца, без второго варианта", () => {
      expect(detectOneSidedDirectionQuestion(leadingSellQuestion)?.assumedSide).toBe("SELLER");
    });
    it("по-русски «Вы продаёте?» — тоже предполагает продавца", () => {
      expect(detectOneSidedDirectionQuestion("Здравствуйте! Вы продаёте эту квартиру?")?.assumedSide).toBe("SELLER");
    });
    it("«мехаред?»/«покупаете?» — предполагает покупателя", () => {
      expect(detectOneSidedDirectionQuestion("Шумо мехаред?")?.assumedSide).toBe("BUYER");
      expect(detectOneSidedDirectionQuestion("Вы покупаете эту квартиру?")?.assumedSide).toBe("BUYER");
    });
    it("оба варианта сразу — уже нейтральный вопрос, подменять нечего", () => {
      expect(detectOneSidedDirectionQuestion("Шумо хона мехаред ё мефурӯшед?")).toBeNull();
      expect(detectOneSidedDirectionQuestion("Вы хотите купить или продать?")).toBeNull();
    });
    it("вопрос без направления (цена, район и т.п.) не ловится", () => {
      expect(detectOneSidedDirectionQuestion("Нархаш чанд аст?")).toBeNull();
    });
    it("не вопрос вовсе (нет «?») — не ловится, даже если слово встретилось", () => {
      expect(detectOneSidedDirectionQuestion("Шумо мефурӯшед гуфтед")).toBeNull();
    });
  });

  describe("guardDirectionQuestion — подмена в исходящей реплике", () => {
    it("самый первый ответ бота: наводящий вопрос заменяется на приветствие+«чем помочь», без направления", () => {
      const out = guardDirectionQuestion({
        bubbles: [leadingSellQuestion],
        clientText: propertyDescriptionOnly,
        botSpokeBefore: false,
        language: "tg",
      });
      expect(out).toEqual([NEUTRAL_FIRST_REPLY.tg]);
    });
    it("первый ответ бота по-русски — русское приветствие", () => {
      const out = guardDirectionQuestion({
        bubbles: ["Вы продаёте эту квартиру?"],
        clientText: "Ленинград, 1 этаж, 51 кв.м, 2 комнаты",
        botSpokeBefore: false,
        language: "ru",
      });
      expect(out).toEqual([NEUTRAL_FIRST_REPLY.ru]);
    });
    it("разговор уже идёт: наводящий вопрос заменяется на нейтральный «покупаете или продаёте?»", () => {
      const out = guardDirectionQuestion({
        bubbles: [leadingSellQuestion],
        clientText: propertyDescriptionOnly,
        botSpokeBefore: true,
        language: "tg",
      });
      expect(out).toEqual([NEUTRAL_DIRECTION_QUESTION.tg]);
    });
    it("направление уже названо клиентом — подмены нет, реплика уходит как есть", () => {
      const bubbles = [leadingSellQuestion];
      const out = guardDirectionQuestion({
        bubbles,
        clientText: "Хона мехарам, лозим аст дар Сино",
        botSpokeBefore: true,
        language: "tg",
      });
      expect(out).toEqual(bubbles);
    });
    it("в реплике нет наводящего вопроса — подмены нет", () => {
      const bubbles = ["Нархаш 45 000 доллар, ошиёнаи 3."];
      const out = guardDirectionQuestion({
        bubbles,
        clientText: propertyDescriptionOnly,
        botSpokeBefore: true,
        language: "tg",
      });
      expect(out).toEqual(bubbles);
    });
  });

  describe("живые опечатки продавца и покупателя (прод 21-22.09.2026)", () => {
    it.each(["Хачу продат сваю квартиру", "Прадат", "дар хона Мефрушум", "фурӯхтан мехоҳам"])(
      "«%s» — продажа",
      (phrase) => {
        expect(clientStatedDirection(phrase)).toBe("sell");
        expect(decideLeadKind({ intent: "sell", confident: true, clientText: phrase }).label).not.toContain("❓");
      }
    );
    it.each(["хочу купит квартиру", "кпить хочу 2-комнатную", "пакупаю квартиру"])("«%s» — покупка", (phrase) => {
      expect(clientStatedDirection(phrase)).toBe("buy");
    });
    it("«ищу покупателя» — не покупка", () => {
      expect(clientStatedDirection("ищу покупателя на свою квартиру")).not.toBe("buy");
    });
  });

  describe("decideLeadKind: направление модели без слов клиента — продавец с пометкой «уточнить», не «прочее»", () => {
    it("intent=sell, но клиент ни разу не сказал «продаю» — SELLER с пометкой агенту", () => {
      const decision = decideLeadKind({ intent: "sell", confident: true, clientText: propertyDescriptionOnly });
      expect(decision.kind).toBe("SELLER");
      expect(decision.label).toContain("направление не подтверждено словами клиента — уточнить");
      expect(decision.reason).toBe("направление не подтверждено словами клиента");
    });
    it("intent=sell и клиент сам сказал «фурӯш» — остаётся SELLER", () => {
      expect(
        decideLeadKind({ intent: "sell", confident: true, clientText: `${propertyDescriptionOnly}, мефурӯшам` }).kind
      ).toBe("SELLER");
    });
    /**
     * АСИММЕТРИЯ С BUYER — СОЗНАТЕЛЬНОЕ РЕШЕНИЕ (см. комментарий в ai/leadKind.ts).
     * Самый частый сценарий покупателя (SCENARIO_BUY) — вопрос о конкретном
     * объекте, где слов «куплю»/«ищу» может не быть вовсе, хотя направление верно.
     * Та же проверка на BUYER увела бы в «Прочие» много настоящих покупателей —
     * поэтому здесь эта отсечка НЕ стоит, а дыру для BUYER закрывает
     * guardDirectionQuestion (не даёт боту задать сам наводящий вопрос).
     */
    it("intent=buy без явных слов клиента — покупателем остаётся (асимметрично SELLER)", () => {
      expect(decideLeadKind({ intent: "buy", confident: true, clientText: propertyDescriptionOnly }).kind).toBe(
        "BUYER"
      );
    });
  });
});

describe("что сказано после номера — доезжает в карточку", () => {
  it("комнаты", () => {
    expect(extractPostAcceptFacts("3 хона мехоҳам").rooms).toBe(3);
  });
  it("бюджет в тысячах", () => {
    expect(extractPostAcceptFacts("бюджет то 700 хазор").budgetMax).toBe(700_000);
  });
  it("арендная сумма бюджетом не становится", () => {
    expect(extractPostAcceptFacts("то 3.000-3.500").budgetMax).toBeUndefined();
  });
  it("номер телефона бюджетом не становится", () => {
    expect(extractPostAcceptFacts("мой номер 918001122").budgetMax).toBeUndefined();
  });
  it("доллары не кладём в поле сомони", () => {
    expect(extractPostAcceptFacts("до 60 000 долларов").budgetMax).toBeUndefined();
  });
});

describe("повторы бота и предел просьб о номере", () => {
  it("дословный повтор недавней реплики не уходит клиенту", () => {
    expect(
      dropRepeatedBubbles(["Рақами телефонатонро нависед, лутфан"], ["Салом", "Рақами телефонатонро нависед, лутфан!"])
    ).toHaveLength(0);
  });
  it("новая реплика остаётся", () => {
    expect(dropRepeatedBubbles(["Дар кадом район ҷустуҷӯ доред?"], ["Рақами телефонатонро нависед"])).toHaveLength(1);
  });
  it("считает просьбы о номере", () => {
    expect(countPhoneAsks(["Рақами телефонатонро нависед?", "Хуб", "Номератонро нависед, лутфан"])).toBe(2);
  });
});

/**
 * ПОВТОР «ВИДЕО НЕ ОТКРЫЛОСЬ» — лид «Муродали», четыре чужих рилса подряд без
 * единого слова (замок, певец, стоматолог, борьба), и бот на каждый отвечал
 * заново. Порог (MAX_UNRESOLVED_SHARE_REPLIES) тот же, что и у просьб телефона.
 */
describe("повтор «видео не открылось» на пересланные ролики", () => {
  it("считает извинения по-русски и по-таджикски", () => {
    expect(
      countUnresolvedShareReplies([
        "Ин видео дар ман кушода нашуд. Шумо чунин хона мекобед? Чандхонага?",
        "Хуб, режалик",
        "Видео у меня не открылось. Вы такую квартиру ищете? Сколько комнат нужно?",
      ])
    ).toBe(2);
  });

  it("обычные ответы бота не считаются", () => {
    expect(countUnresolvedShareReplies(["Салом! Кадом район лозим аст?", "Нархаш 62 000$"])).toBe(0);
  });

  it("порог ниже, чем у просьб телефона: спамер должен замолчать быстрее", () => {
    expect(MAX_UNRESOLVED_SHARE_REPLIES).toBe(2);
  });
});

describe("жалоба «со мной никто не связался»", () => {
  it.each([
    ["таджикский", "чаро ҳеҷ кас занг назад?"],
    ["русский", "мне так и не позвонили"],
  ])("ловит %s", (_label, text) => {
    expect(looksLikeNoContactComplaint(text)).toBe(true);
  });
  it("просьба позвонить — не жалоба", () => {
    expect(looksLikeNoContactComplaint("позвоните мне пожалуйста")).toBe(false);
  });

  /**
   * ОТРИЦАНИЕ В ТАДЖИКСКОМ ПРАВИЛЕ БЫЛО НЕОБЯЗАТЕЛЬНЫМ (найдено 20.09.2026,
   * docs/bot-razbor-20-09.md, класс 4 п. 3). Поэтому утвердительное «вы мне звонили»
   * читалось как жалоба «мне не позвонили», и второе такое сообщение будило руководителя
   * пушем на ровном месте.
   */
  it.each([
    ["вы мне звонили", "бале, шумо занг зада будед"],
    ["можете позвонить?", "занг зада метавонед?"],
  ])("утвердительное «%s» жалобой не считается", (_label, text) => {
    expect(looksLikeNoContactComplaint(text)).toBe(false);
  });

  it.each([
    ["не позвонили (слитно)", "чаро занг назаданд?"],
    ["не звонят", "чаро занг намезананд"],
    ["отрицание раздельно", "занг на заданд"],
    ["звонка нет", "то бегоҳ занг нест"],
  ])("отрицание на месте — жалоба ловится (%s)", (_label, text) => {
    expect(looksLikeNoContactComplaint(text)).toBe(true);
  });
});
