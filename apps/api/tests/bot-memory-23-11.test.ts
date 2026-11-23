/**
 * ПРОД 23.11.2026, Facebook Messenger, 17:45 по Душанбе (клиент без личных данных; разбор — docs/journal/2026-11-23-bot-pamyat.md).
 * Первое сообщение клиента — одно «😍» (вебхук: текст, вложений нет, не история и не цитата: реакция на ролик). Дальше
 * «Ассалому алайкум», «Мехарам». Бот ответил:
 *   1. «Спасибо, получил. Вы хотите купить или продать недвижимость?» — эмодзи принят за ВЛОЖЕНИЕ («получил» — неправда), язык
 *      неизвестен — русский по умолчанию, и вопрос о роли потрачен на реакцию;
 *   2. «Ваалейкум ассалом! Подскажите, пожалуйста: вы покупаете или продаёте?» — приветствие не несёт языка, и язык разговора взят
 *      из СОБСТВЕННОГО прошлого ответа бота (русского по умолчанию); вопрос о роли повторён вторым и последним разом;
 *   3. «Мехарам» понят сразу и верно (покупатель, таджикский) — но до него клиента дважды спросили одно и то же.
 * Каждый тест ниже красный на origin/main 2edde4b5 и зелёный после правки. Модели нет: её ответ — подменой.
 */
import { describe, expect, it } from "vitest";
import { decide, initialOperatorState } from "../src/ai/operator/decide.js";
import { understandFallback } from "../src/ai/operator/understand.js";
import { renderOperatorReply } from "../src/ai/operator/phrases.js";
import { runOperatorTurn } from "../src/ai/operator/index.js";
import type { LeadOnlyIntentModel } from "../src/ai/leadOnlyIntent.js";
import type { OperatorContext, OperatorState } from "../src/ai/operator/types.js";

const ctx = (over: Partial<OperatorContext> = {}): OperatorContext => ({
  channel: "FACEBOOK", phoneKnown: false, leadExists: false, leadPending: false, cardAgentActive: true,
  noAgentWhen: { ru: "завтра с 09:30", tg: "пагоҳ аз соати 09:30" }, recruiterPath: true, ad: { topic: null, propertyId: null }, focus: null,
  callbackWhen: { ru: "завтра с 10:00", tg: "пагоҳ аз соати 10:00" }, maxPhoneAsks: 2, vacancies: { open: [], contactPhone: null },
  brandName: "Royal Home", officePhone: "+992 00 000 00 02", sellerCommissionPercent: 2, outOfArea: false, ...over,
});

/** Ответ модели понимания в схеме оператора: по умолчанию «ничего не понял». */
const answer = (over: Record<string, unknown> = {}) => ({
  role: "none", roleQuote: "", question: "none", aboutThisProperty: false, rooms: "", district: "", budget: "", area: "", floor: "",
  renovation: "", price: "", units: "", callbackWhen: "", callbackQuote: "", textOnly: false, noCall: false, language: "none",
  bargain: false, rude: false, botQuestion: false, offTopic: false, complaint: false, jobPosition: "", outsidePlace: "", ...over,
});

type Line = { role: "user" | "assistant"; text: string };
/** Разговор ходами через настоящую дверь хода (память — то, что ход вернул; история — что видел клиент). */
async function dialog(messages: Array<{ text: string; model?: unknown; attachments?: Record<string, unknown>; at?: string }>, c = ctx()) {
  let stored: unknown = null;
  const recent: Line[] = [];
  const turns = [];
  for (const message of messages) {
    const model: LeadOnlyIntentModel = async () => message.model ?? null;
    const turn = await runOperatorTurn({ storedState: stored, ctx: c, model, now: new Date(message.at ?? "2026-11-23T12:45:00Z"),
      input: { current: message.text, recent: [...recent], ...(message.attachments ? { attachments: message.attachments } : {}) } });
    stored = turn.stored;
    recent.push({ role: "user", text: message.text });
    if (turn.text) recent.push({ role: "assistant", text: turn.text });
    turns.push({ text: turn.text, keys: turn.steps.map(step => step.key), language: turn.language, state: turn.state, actions: turn.actions });
  }
  return turns;
}

const roleQuestions = (texts: Array<string | null>) => texts.filter(text => text && /[?]/u.test(text)).length;

describe("прод 23.11.2026: «😍» → «Ассалому алайкум» → «Мехарам»", () => {
  it("весь диалог: реакция — короткое спасибо без «получил» и без вопроса; приветствие — таджикский и ОДИН вопрос; «Мехарам» — покупатель", async () => {
    const [reaction, greeting, buyer] = await dialog([
      { text: "😍" },
      { text: "Ассалому алайкум", model: answer({ language: "tg" }) },
      { text: "Мехарам", model: answer({ role: "buyer", roleQuote: "Мехарам", language: "tg" }) },
    ]);
    // 1. Реакция на ролик — не вложение и не заявка: спасибо и приглашение, без вопроса «купить или продать?».
    expect(reaction!.keys).toEqual(["reaction_thanks", "reaction_invite"]);
    expect(reaction!.text).toBe("Спасибо! Если ищете или продаёте недвижимость, напишите, поможем.");
    expect(reaction!.text).not.toMatch(/получил|гирифтам/iu);
    expect(reaction!.text).not.toMatch(/[?]/u);
    expect(reaction!.language).toBe("ru");
    expect(reaction!.state.asked.role).toBe(0);
    expect(reaction!.actions).toEqual([]);
    // 2. «Ассалому алайкум» — язык клиента таджикский; вопрос о роли звучит впервые и один раз.
    expect(greeting!.language).toBe("tg");
    expect(greeting!.keys).toEqual(["greet_assalom", "ask_role"]);
    expect(greeting!.text).toBe("Ваалайкум ассалом! Шумо хона мехаред ё мефурӯшед?");
    // 3. «Мехарам» — ответ на вопрос: покупатель, по-таджикски, дальше по делу.
    expect(buyer!.state.role).toBe("buyer");
    expect(buyer!.language).toBe("tg");
    expect(buyer!.keys).toEqual(["role_details_buyer"]);
    expect(roleQuestions([reaction!.text, greeting!.text, buyer!.text])).toBe(1);
  });

  it("память как на проде после первого хода (вопрос о роли уже задан по-русски): приветствие — по-таджикски и без повтора вопроса", () => {
    // Ровно то, что лежало в памяти диалога после «😍» (leadOnlyPending, прод): роль спрошена один раз, язык не известен.
    const prod: OperatorState = { ...initialOperatorState(), step: "role", asked: { role: 1, details: 0, phone: 0 },
      spoken: { media_received: 1, ask_role: 1 } };
    const recent: Line[] = [{ role: "user", text: "😍" }, { role: "assistant", text: "Спасибо, получил. Вы хотите купить или продать недвижимость?" }];
    const u = understandFallback({ current: "Ассалому алайкум", recent }, prod, ctx());
    const d = decide(prod, u, ctx());
    const text = renderOperatorReply(d.steps, d.language);
    expect(d.language).toBe("tg");
    expect(d.steps.map(step => step.key)).toEqual(["greet_assalom", "greet_continue"]);
    expect(text).not.toMatch(/[?]/u);
    expect(text).toMatch(/^Ваалайкум ассалом!/u);
    // Приветствие — не ответ «не понял»: попытка вопроса о роли не тратится (иначе следующий неясный ход — уже молчание).
    expect(d.state.asked.role).toBe(1);
    expect(d.actions).toEqual([]);
  });
});

describe("сбой 2: приветствие после заданного вопроса не повторяет вопрос", () => {
  it("пересланный пост → вопрос о роли → «Ассалому алайкум» → ответ на приветствие и приглашение, вопрос не повторён; «Мехарам» — покупатель", async () => {
    const [post, greeting, buyer] = await dialog([
      { text: "", attachments: { foreignPost: true } },
      { text: "Ассалому алайкум", model: answer({ language: "tg" }) },
      { text: "Мехарам", model: answer({ role: "buyer", roleQuote: "Мехарам", language: "tg" }) },
    ]);
    expect(post!.keys).toEqual(["ask_role"]);
    expect(greeting!.keys).toEqual(["greet_assalom", "greet_continue"]);
    expect(greeting!.text).not.toMatch(/[?]/u);
    expect(greeting!.state.asked.role).toBe(1);
    expect(buyer!.keys).toEqual(["role_details_buyer"]);
    expect(buyer!.language).toBe("tg");
  });

  it("русский клиент: «Здравствуйте» дважды — второй раз без того же вопроса; третий в тот же день — вопрос другими словами, не тишина навсегда", async () => {
    const turns = await dialog([{ text: "Здравствуйте" }, { text: "Здравствуйте" }, { text: "Здравствуйте" }]);
    expect(turns[0]!.keys).toEqual(["greet", "ask_role"]);
    expect(turns[1]!.keys).toEqual(["greet_continue"]);
    expect(turns[1]!.language).toBe("ru");
    expect(turns[1]!.text).not.toMatch(/[?]/u);
    expect(turns[2]!.keys).toEqual(["ask_role"]);
    expect(turns[2]!.text).toBe("Подскажите, пожалуйста: вы покупаете или продаёте?");
    expect(turns.map(turn => turn.state.asked.role)).toEqual([1, 1, 2]);
  });

  it("повторное приветствие через сутки — снова ответ на приветствие и приглашение (суточный сброс), а не вечная тишина", async () => {
    const turns = await dialog([
      { text: "Ассалому алайкум", at: "2026-11-23T10:00:00Z" },
      { text: "Ассалому алайкум", at: "2026-11-23T10:05:00Z" },
      { text: "Ассалому алайкум", at: "2026-11-24T12:00:00Z" },
    ]);
    expect(turns[0]!.keys).toEqual(["greet_assalom", "ask_role"]);
    expect(turns[1]!.keys).toEqual(["greet_continue"]);
    expect(turns[2]!.keys).toEqual(["greet_assalom", "greet_continue"]);
    expect(turns[2]!.text).toBe("Ваалайкум ассалом! Нависед, чӣ хизмат кунем.");
    expect(turns[2]!.state.asked.role).toBe(1);
  });

  it("приветствия с вариантами написания и обращением — тоже только приветствие: вопрос не повторяется", async () => {
    for (const hello of ["Ассаламу алейкум", "Ассалам алейкум", "Ассаламу алейкум!", "Салом ака", "Салом, хубед?", "Ассалому алейкум апа."]) {
      const [, greeting] = await dialog([{ text: "", attachments: { foreignPost: true } }, { text: hello, model: answer({ language: "tg" }) }]);
      expect(greeting!.keys, hello).toEqual(hello.startsWith("Салом") ? ["greet", "greet_continue"] : ["greet_assalom", "greet_continue"]);
      expect(greeting!.state.asked.role, hello).toBe(1);
      expect(greeting!.language, hello).toBe("tg");
    }
  });

  it("содержательный, но неясный ответ после вопроса — как прежде: вопрос другими словами (второй и последний раз)", async () => {
    const [first, second] = await dialog([{ text: "Салом" }, { text: "Хона" }]);
    expect(first!.keys).toEqual(["greet", "ask_role"]);
    expect(second!.keys).toEqual(["ask_role"]);
    expect(second!.text).toBe("Бигӯед, шумо мехаред ё мефурӯшед?");
  });
});

describe("сбой 1: язык клиента — по его словам, а не по прошлому ответу бота", () => {
  it("«Салом» / «Ассалому алайкум» первым словом клиента — таджикский, даже если бот до этого ответил по-русски по умолчанию", async () => {
    for (const hello of ["Салом", "Ассалому алайкум", "Ассалом алейкум", "Ассаламу алейкум"]) {
      const [, greeting] = await dialog([{ text: "😍" }, { text: hello, model: answer({ language: "tg" }) }]);
      expect(greeting!.language, hello).toBe("tg");
      expect(greeting!.state.language, hello).toBe("tg");
    }
  });

  it("язык липкий: русский клиент написал «Салом» — ответ остаётся русским; таджик прислал «ок» — остаётся таджикским", async () => {
    const ru = await dialog([{ text: "Здравствуйте, хочу купить квартиру" }, { text: "Салом" }]);
    expect(ru[1]!.language).toBe("ru");
    const tg = await dialog([{ text: "Ассалому алайкум" }, { text: "ок" }, { text: "Мехарам" }]);
    expect(tg.map(turn => turn.language)).toEqual(["tg", "tg", "tg"]);
  });

  it("голое «Салам» таджикским не считается (его пишут и русскоязычные): ответ русский, как на main", async () => {
    const [first] = await dialog([{ text: "Салам" }]);
    expect(first!.language).toBe("ru");
    expect(first!.state.language).not.toBe("tg");
    const [, afterReaction] = await dialog([{ text: "😍" }, { text: "Салам" }]);
    expect(afterReaction!.language).toBe("ru");
  });

  it("свой ответ бота по умолчанию язык разговора не закрепляет: «😍», «ок», потом «Салом» — таджикский", async () => {
    const turns = await dialog([{ text: "😍" }, { text: "ок" }, { text: "Салом" }]);
    expect(turns[2]!.language).toBe("tg");
  });
});

describe("сбой 3: короткий ответ на вопрос «купить или продать?» понят как ответ", () => {
  const cases: Array<[string, "buyer" | "seller", "ru" | "tg"]> = [
    ["Купить", "buyer", "ru"], ["покупаю", "buyer", "ru"], ["Мехарам", "buyer", "tg"], ["харидорам", "buyer", "tg"],
    ["Харид", "buyer", "tg"], ["Продать", "seller", "ru"], ["продаю", "seller", "ru"], ["фурўш", "seller", "tg"],
    ["мефурўшам", "seller", "tg"], ["Фурӯш", "seller", "tg"],
  ];
  for (const [text, role, language] of cases) {
    it(`«${text}» после вопроса о роли — ${role}, ${language} (и без модели, и когда модель промолчала)`, async () => {
      for (const model of [undefined, answer()]) {
        const [, reply] = await dialog([{ text: "Здравствуйте" }, { text, ...(model ? { model } : {}) }]);
        expect(reply!.state.role, `${text} / ${model ? "модель" : "без модели"}`).toBe(role);
        expect(reply!.language, text).toBe(language);
        // Продавцу, назвавшемуся самому, — условия и вопрос «что и где» (прежнее правило, SPEC п. 8); покупателю — вопрос о деталях.
        expect(reply!.keys, text).toEqual(role === "buyer" ? ["role_details_buyer"] : ["seller_intro", "role_details_seller"]);
      }
    });
  }

  it("без заданного вопроса голое «купить» роль не назначает (это не ответ, а обрывок): вопрос о роли", async () => {
    const [first] = await dialog([{ text: "купить" }]);
    expect(first!.keys).toEqual(["ask_role"]);
  });
});

describe("реакция-эмодзи: не вложение, не заявка, не повод звать человека", () => {
  it("реакция посреди разговора (бот уже спросил о роли) — тишина без сигнала; повторная реакция в начале — тоже", async () => {
    const mid = await dialog([{ text: "Салом" }, { text: "👍" }]);
    expect(mid[1]!.keys).toEqual([]);
    expect(mid[1]!.actions).toEqual([]);
    expect(mid[1]!.state.asked.role).toBe(1);
    const twice = await dialog([{ text: "🔥" }, { text: "❤️" }]);
    expect(twice[0]!.keys).toEqual(["reaction_thanks", "reaction_invite"]);
    expect(twice[1]!.keys).toEqual([]);
    expect(twice[1]!.actions).toEqual([]);
  });

  it("настоящее вложение без слов — как прежде: «Спасибо, получил» и вопрос о роли", async () => {
    const [media] = await dialog([{ text: "", attachments: { media: true } }]);
    expect(media!.keys).toEqual(["media_received", "ask_role"]);
    const [captioned] = await dialog([{ text: "😍", attachments: { media: true } }]);
    expect(captioned!.keys).toEqual(["media_received", "ask_role"]);
  });

  it("реакция на ролик по-таджикски известным языком — таджикская фраза на «шумо»", () => {
    const state: OperatorState = { ...initialOperatorState(), language: "tg" };
    const d = decide(state, understandFallback({ current: "😍" }, state, ctx()), ctx());
    expect(d.steps.map(step => step.key)).toEqual(["reaction_thanks", "reaction_invite"]);
    expect(renderOperatorReply(d.steps, d.language)).toMatch(/нависед/u);
  });
});

describe("от обратного (слепое ревью): знаки без эмодзи — не реакция, «+» и «👍» на просьбу номера — согласие", () => {
  const notLost = (turn: { keys: string[]; actions: unknown[] }) => turn.keys.length > 0 || turn.actions.length > 0;

  for (const sign of ["+", "?", "...", "."]) {
    it(`«${sign}» — не реакция: прежний путь, клиент не теряется молча`, async () => {
      const [first] = await dialog([{ text: sign }]);
      expect(first!.keys, sign).not.toContain("reaction_thanks");
      expect(notLost(first!), sign).toBe(true);
      // После вопроса по делу («Хочу купить квартиру» → вопрос о районе): «?» — не тишина без сигнала.
      const [, mid] = await dialog([{ text: "Хочу купить квартиру" }, { text: sign }]);
      if (sign !== "+") expect(notLost(mid!), `${sign} после вопроса`).toBe(true);
    });
  }

  for (const sign of ["+", "👍", "👍🏻", "👌"]) {
    it(`«${sign}» сразу после просьбы номера — согласие: «куда позвонить», а не тишина`, async () => {
      const turns = await dialog([{ text: "Хочу купить квартиру" }, { text: "Сино, 2 комнаты, до 500 тысяч" }, { text: sign }]);
      expect(turns[1]!.keys).toContain("ask_phone");
      expect(turns[2]!.keys, sign).toEqual(["phone_where"]);
    });
  }
});
