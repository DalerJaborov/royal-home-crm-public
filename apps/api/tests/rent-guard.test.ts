import { describe, expect, it } from "vitest";

/**
 * Полный запрет на аренду (владелец 21.08.2026) — проверяем ИМЕННО КОД, а не промт.
 *
 * Повод: клиент №27 на проде. Человек назвал бюджет «3000–5000 сомонӣ», бот сам
 * ответил ему «иҷора надорем» — и той же репликой выставил intent=buy. Карточка
 * ушла живому агенту как обычный покупатель. Промт запрет содержал; модель его
 * нарушила. См. ai/rentGuard.ts.
 */

const rentGuard = await import("../src/ai/rentGuard.js");
const { looksLikeRentRequest } = rentGuard;
const { mergeDraft } = await import("../src/ai/leadQualifier.js");

const turn = (intent: "buy" | "sell" | "rent" | "other", ready = true) => ({
  reply: [],
  ready,
  intent,
});

describe("looksLikeRentRequest — аренда по словам клиента", () => {
  it.each([
    ["таджикский: хонаи иҷора", "Ассалом. Хонаи 2-хонагӣ барои иҷора доред?"],
    ["таджикский без диакритики", "салом, хонаи ижора мехохам"],
    ["таджикский: кироя", "Ака, кироя квартира ҳаст?"],
    ["русский: аренда", "Здравствуйте, интересует аренда квартиры"],
    ["русский: снять", "хочу снять квартиру в 46 мкр"],
    ["русский: сдать", "хочу сдать квартиру, поможете?"],
    ["посуточно", "есть посуточная аренда?"],
  ])("ловит %s", (_label, text) => {
    expect(looksLikeRentRequest(text)).toBe(true);
  });

  /**
   * ГЛАВНОЕ, ЧЕГО НЕЛЬЗЯ ЛОМАТЬ: покупка «под сдачу» — это ПОКУПАТЕЛЬ с деньгами.
   * Отсечка по одному слову «аренда» стоила бы нам живых сделок.
   */
  it.each([
    ["куплю, чтобы сдавать", "Хочу купить квартиру чтобы потом сдавать в аренду"],
    ["таджикский: харидан барои иҷора", "Мехоҳам хона харидан барои иҷора додан"],
    ["продаю сдаваемую квартиру", "У меня квартира в аренде сейчас, хочу продать"],
  ])("НЕ ловит %s", (_label, text) => {
    expect(looksLikeRentRequest(text)).toBe(false);
  });

  it.each([
    ["обычная покупка", "Салом, хонаи 3-хонага мехоҳам харам, буҷет 500 ҳазор"],
    ["продавец", "Ман хонаамро ба фурӯш мондан мехоҳам"],
    ["пустая строка", "   "],
  ])("НЕ ловит %s", (_label, text) => {
    expect(looksLikeRentRequest(text)).toBe(false);
  });
});

describe("mergeDraft — код сильнее модели", () => {
  it("модель сказала buy, клиент просил аренду — intent становится rent", () => {
    const merged = mergeDraft({ stage: "chatting" }, turn("buy"), "Хонаи иҷора доред?");
    expect(merged.intent).toBe("rent");
  });

  it("аренда не доводит до просьбы о телефоне, даже при ready=true", () => {
    const merged = mergeDraft({ stage: "chatting" }, turn("buy"), "интересует аренда квартиры");
    expect(merged.stage).toBe("chatting");
  });

  it("обычный покупатель не задет — intent и этап как решила модель", () => {
    const merged = mergeDraft({ stage: "chatting" }, turn("buy"), "хочу купить 2-комнатную, бюджет 400 тысяч");
    expect(merged.intent).toBe("buy");
    expect(merged.stage).toBe("awaiting_phone");
  });

  it("покупка под сдачу остаётся покупкой", () => {
    const merged = mergeDraft({ stage: "chatting" }, turn("buy"), "Куплю квартиру чтобы сдавать в аренду");
    expect(merged.intent).toBe("buy");
    expect(merged.stage).toBe("awaiting_phone");
  });

  /**
   * Отсечка не «липнет»: передумал и хочет купить — снова обычный клиент.
   * Иначе один вопрос про аренду в начале разговора хоронил бы покупателя.
   */
  it("клиент передумал и хочет купить — аренда больше не мешает", () => {
    const afterRent = mergeDraft({ stage: "chatting" }, turn("rent"), "хонаи иҷора доред?");
    expect(afterRent.intent).toBe("rent");

    const afterTurn = mergeDraft(afterRent, turn("buy"), "он гоҳ харидан мехоҳам, буҷет 600 ҳазор");
    expect(afterTurn.intent).toBe("buy");
    expect(afterTurn.stage).toBe("awaiting_phone");
  });

  it("без слов клиента (старый вызов) работает как раньше", () => {
    const merged = mergeDraft({ stage: "chatting" }, turn("buy"));
    expect(merged.intent).toBe("buy");
  });

  /**
   * ЖИВОЙ СЛУЧАЙ (владелец 21.08.2026): после верного отказа клиент пишет
   * нейтральное «Раҳмат», модель на этом ходе снова классифицирует диалог как
   * buy — а без sticky-логики draft.intent молча слетал с "rent", и бот следом
   * спрашивал арендатора про район и число комнат для покупки.
   */
  it("нейтральная реплика после отказа не снимает метку «аренда»", () => {
    const afterRent = mergeDraft({ stage: "chatting" }, turn("rent"), "хонаи иҷорави дорӣ?");
    expect(afterRent.intent).toBe("rent");

    const afterThanks = mergeDraft(afterRent, turn("buy"), "Раҳмат");
    expect(afterThanks.intent).toBe("rent");
    expect(afterThanks.stage).toBe("chatting");
  });
});

/**
 * КОРОТКИЙ ПУТЬ: клиент с первого сообщения прислал номер.
 *
 * Тогда заявка принимается СРАЗУ, минуя ход модели, и черновик ещё пуст —
 * intent проставить некому. Одного `draft.intent === "rent"` в acceptLead для
 * этого случая мало, поэтому там проверяются ещё и слова клиента. Здесь
 * проверяется само условие отсечки на текстах такого вида: телефон в строке не
 * должен мешать распознать аренду («номера таких лидов не брать» — владелец
 * 21.08.2026).
 */
describe("аренда и телефон в одном сообщении", () => {
  it.each([
    ["таджикский", "Ассалом, хонаи иҷора доред? Рақамам 900123456"],
    ["русский", "Здравствуйте, нужна аренда квартиры, мой номер +992 90 123 45 67"],
    ["кироя", "кироя квартира ҳаст? 918776655"],
  ])("%s — отсечка срабатывает, несмотря на номер в тексте", (_label, text) => {
    expect(looksLikeRentRequest(text)).toBe(true);
  });

  it("покупатель с номером в том же сообщении не задет", () => {
    expect(looksLikeRentRequest("Хочу купить 2-комнатную, мой номер 900123456")).toBe(false);
  });
});

/**
 * АРЕНДА, НАЗВАННАЯ СУММОЙ, А НЕ СЛОВОМ (владелец 03.09.2026, карточка ПК-000250).
 *
 * «2 хуҷрага бо нархи аз 3000 то 4500» — слова «иҷора» нет ни разу, а это
 * месячная плата. Решение владельца: тот же полный отказ, что по слову.
 */
describe("аренда по сумме", () => {
  const { looksLikeRentBudget } = rentGuard;

  it("месячная плата без слова «аренда» — это аренда", () => {
    expect(looksLikeRentBudget(4500, "2 хуҷрага дар назди донишгоҳи Милли")).toBe(true);
    const merged = mergeDraft({ stage: "chatting" }, { reply: [], ready: true, intent: "buy", lead: { budgetMax: 4500 } } as never, "2 хуҷрага бо нархи аз 3000 то 4500");
    expect(merged.intent).toBe("rent");
    // Номер у такого клиента не просим вовсе.
    expect(merged.stage).toBe("chatting");
  });

  it("слово о покупке отсечку снимает: «куплю, чтобы сдавать» — покупатель", () => {
    expect(looksLikeRentBudget(4500, "хона мехарам, то 4500 доллар")).toBe(false);
  });

  it("реальный бюджет покупки и описка ниже порога аренды отсечку не поднимают", () => {
    expect(looksLikeRentBudget(450_000, "хона даркор")).toBe(false);
    expect(looksLikeRentBudget(300, "хона даркор")).toBe(false);
    expect(looksLikeRentBudget(undefined, "хона даркор")).toBe(false);
  });

  it("человек уточнил валюту — метка аренды слетает, разговор продолжается как покупка", () => {
    const rentish = mergeDraft({ stage: "chatting" }, { reply: [], ready: false, intent: "buy", lead: { budgetMax: 4500 } } as never, "аз 3000 то 4500");
    expect(rentish.intent).toBe("rent");
    const clarified = mergeDraft(rentish, { reply: [], ready: false, intent: "buy", lead: { budgetMax: 450_000 } } as never, "ин ба доллар");
    expect(clarified.intent).toBe("buy");
  });
});
