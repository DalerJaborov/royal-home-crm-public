/**
 * ЖИВЫЕ ДИАЛОГИ ПОСЛЕ ВЫКАТА #333 (прод 20–21.11.2026; без личных данных: район заменён, номер выдуман).
 *  - «Салом алейкум, хони заминитон … кадом тараф?» → бот ответил голой просьбой номера (владелец 21.11: так нельзя);
 *  - иностранный номер (+7, 11 цифр) в словах клиента — заявка, номер не обрезается и не «не номер»;
 *  - пересланный чужой ролик без слов → ответ «Ин эълони мо нест…» и разбор моделью (владелец: спамерам не отвечать и не
 *    тратить ИИ); «…як лайк монед тамом» → «Мо дар Душанбе…» вместо тишины;
 *  - «Салом» на рекламе «для собственников» → заявка продавца; «Ершп» после заявки → «передал агенту»;
 *  - счётчик вопроса о роли «2» при одном отправленном вопросе; таджикская кнопка рекламы; модели Gemini.
 */
import { describe, expect, it } from "vitest";
import { isDialableTajikNumber } from "@royal-home/shared";
import { decide, initialOperatorState } from "../src/ai/operator/decide.js";
import { understandFallback } from "../src/ai/operator/understand.js";
import { reconcileAskedRole } from "../src/ai/operator/index.js";
import { renderOperatorReply } from "../src/ai/operator/phrases.js";
import type { OperatorContext, OperatorState, Understanding } from "../src/ai/operator/types.js";
import { extractVolunteeredPhone } from "../src/lib/shared/phoneText.js";
import { customerSpamInterest, customerSpamTurn } from "../src/ai/customerSpamMute.js";
import { customerForeignShareSettled } from "../src/lib/customerSharedPublication.js";
import { isAdTemplateOpener } from "../src/ai/adTemplatePhrase.js";
import { isKnownGeminiModel } from "../src/ai/geminiTransport.js";

const ctx = (over: Partial<OperatorContext> = {}): OperatorContext => ({
  channel: "INSTAGRAM", phoneKnown: false, leadExists: false, leadPending: false, cardAgentActive: true,
  noAgentWhen: { ru: "завтра с 09:30", tg: "пагоҳ аз соати 09:30" }, recruiterPath: true, ad: { topic: null, propertyId: null }, focus: null,
  callbackWhen: { ru: "завтра с 10:00", tg: "пагоҳ аз соати 10:00" }, maxPhoneAsks: 2, vacancies: { open: [], contactPhone: null },
  brandName: "Royal Home", officePhone: "+992 00 000 00 02", sellerCommissionPercent: 2, outOfArea: false, ...over,
});
const PROPERTY_ID = "7d0f1d7e-3c5b-4e4b-9e57-1d2c3b4a5f60";
/** Просьба номера (покупателю — «покажет», продавцу — «оценит и обсудит»). */
const PHONE_ASK = (key: string) => key === "ask_phone" || key === "ask_phone_seller";
function turn(text: string, c: OperatorContext, state: OperatorState = initialOperatorState()) {
  const u = understandFallback({ current: text }, state, c);
  const d = decide(state, u, c);
  return { u, d, keys: d.steps.map(step => step.key), text: renderOperatorReply(d.steps, d.language) };
}

describe("fc9996a9: на вопрос клиента — ответ, потом номер; никогда голая просьба номера", () => {
  const QUESTION = "Салом алейкум хони заминитон нохияй Фирдавси кадом тараф боша ака";
  it("объект не определён: «Ваалайкум ассалом!», честно «место скажет агент», потом номер — по-таджикски, на «шумо»", () => {
    const t = turn(QUESTION, ctx({ ad: { topic: "property", propertyId: null } }));
    expect(t.u.placeQuestion).toBe(true);
    // Вопрос о месте — интерес к объекту, но ещё не согласие на звонок: ответ и предложение звонка, номер не просим (21.11.2026).
    expect(t.keys).toEqual(["greet_assalom", "place_by_agent", "offer_call"]);
    expect(t.text).not.toMatch(/рақам/u);
    expect(t.d.language).toBe("tg");
    expect(t.text).toMatch(/^Ваалайкум ассалом!/u);
    expect(t.text).toMatch(/агент/u);
    expect(t.d.actions).toEqual([]);
  });
  it("объект известен: район и город с сайта и цена, без улицы и дома; потом номер", () => {
    const focus = { propertyId: PROPERTY_ID, shortId: 205, priceText: { ru: "900 000 сомони", tg: "900 000 сомонӣ" }, sold: false, place: "Фирдавси, Душанбе" };
    const t = turn(QUESTION, ctx({ ad: { topic: "property", propertyId: PROPERTY_ID }, focus }));
    expect(t.keys).toEqual(["greet_assalom", "property_place_price", "offer_call"]);
    expect(t.text).toContain("Объекти №205 дар ноҳияи Фирдавси, Душанбе");
    expect(t.text).toContain("900 000 сомонӣ");
    // Места в карточке нет — «место скажет агент» и строка объекта, а не выдумка.
    const noPlace = turn(QUESTION, ctx({ ad: { topic: "property", propertyId: PROPERTY_ID }, focus: { ...focus, place: null } }));
    expect(noPlace.keys).toContain("place_by_agent");
    expect(noPlace.keys).toContain("offer_call");
  });
  it("ИНВАРИАНТ: до заявки на вопрос по делу ответ не бывает одной просьбой номера (все роли и каналы, первый и второй ход)", () => {
    const questions: Understanding["question"][] = ["other", "property_other", "property_price"];
    // Второй ход: предложение звонка и вопрос о деталях уже звучали — здесь бот и просит номер (слепое ревью #345).
    const second: OperatorState = { ...initialOperatorState(), spoken: { offer_call: 1 }, asked: { role: 0, details: 1, phone: 0 }, flags: { ...initialOperatorState().flags, clientTurns: 1 } };
    let checked = 0;
    for (const start of [initialOperatorState(), second]) for (const role of [null, "buyer", "seller"] as const) for (const question of questions)
      for (const about of [false, true]) for (const place of [false, true]) for (const topic of [null, "property", "seller"] as const)
        for (const greeting of [null, "salom"] as const) {
          const c = ctx({ ad: { topic, propertyId: null } });
          const base = understandFallback({ current: "вопрос" }, start, c);
          const u: Understanding = { ...base, role, question, aboutThisProperty: about, placeQuestion: place, greeting, hasText: true, quote: "вопрос" };
          const d = decide(start, u, c);
          const keys = d.steps.map(step => step.key).filter(key => key !== "greet" && key !== "greet_assalom");
          if (keys.some(PHONE_ASK)) { checked++; expect(keys.length, JSON.stringify({ role, question, about, place, topic })).toBe(2); }
        }
    expect(checked).toBeGreaterThan(20);
  });
});

describe("номер не берём слишком быстро (владелец 21.11.2026: «почему то слишком быстро он номер берет»)", () => {
  const focus = { propertyId: PROPERTY_ID, shortId: 164, priceText: { ru: "520 000 сомони", tg: "520 000 сомонӣ" }, sold: false, place: "Сино, Душанбе" };
  it("«Салом, сколько стоит?» про известный объект — приветствие, цена и предложение звонка, без «напишите номер»", () => {
    for (const c of [ctx({ ad: { topic: "property", propertyId: PROPERTY_ID }, focus }),
      ctx({ channel: "WHATSAPP", phoneKnown: true, ad: { topic: "property", propertyId: PROPERTY_ID }, focus })]) {
      const t = turn("Салом, сколько стоит?", c);
      expect(t.keys).toEqual(["greet", "property_price", "offer_call"]);
      expect(t.text).not.toMatch(/номер|рақам/iu);
      expect(t.d.actions).toEqual([]);
    }
  });
  it("«Салом» — приветствие и вопрос о роли, без номера; «хочу посмотреть» — теперь номер с объяснением", () => {
    expect(turn("Салом", ctx()).keys).toEqual(["greet", "ask_role"]);
    const c = ctx({ ad: { topic: "property", propertyId: PROPERTY_ID }, focus });
    const first = turn("Сколько стоит?", c);
    const show = turn("Хочу посмотреть квартиру", c, first.d.state);
    expect(show.keys).toEqual(["ask_phone"]);
    expect(show.text).toMatch(/расскажет подробно и покажет|подробно расскажет и покажет/u);
  });
  it("ИНВАРИАНТ: не больше двух просьб номера за разговор и никогда в соседних содержательных ходах", () => {
    const texts = ["Хочу купить квартиру", "Сколько стоит?", "А где это?", "Хочу посмотреть", "ок", "Какой этаж?", "Дорого", "Салом",
      "Можно в субботу посмотреть?", "Хочу продать дом", "Документы готовы?", "да"];
    let conversations = 0, totalAsks = 0, twice = 0;
    for (let n = 0; n < 300; n++) {
      let state = initialOperatorState();
      let lastAskTurn = -10, asks = 0, substantive = 0;
      const c = ctx({ ad: { topic: n % 2 ? "property" : null, propertyId: n % 2 ? PROPERTY_ID : null }, focus: n % 2 ? focus : null });
      for (let i = 0; i < 10; i++) {
        const text = texts[(n * 7 + i * 5) % texts.length]!;
        const t = turn(text, c, state);
        state = t.d.state;
        if (!["ок", "да", "Салом"].includes(text)) substantive++;
        if (t.keys.some(PHONE_ASK)) {
          asks++;
          expect(asks, `${n}`).toBeLessThanOrEqual(2);
          if (asks > 1) expect(substantive - lastAskTurn, `${n}: «${text}»`).toBeGreaterThanOrEqual(2);
          lastAskTurn = substantive; totalAsks++; if (asks === 2) twice++;
        }
      }
      conversations++;
    }
    expect(conversations).toBe(300);
    // Перебор правда доходит до просьб номера и до второй просьбы (иначе инвариант зелёный впустую).
    expect(totalAsks).toBeGreaterThan(150);
    expect(twice).toBeGreaterThan(20);
  });
});

describe("иностранный номер в словах клиента — заявка с полным номером", () => {
  // Номер выдуманный (+7 900 000-00-01), не номер клиента с прода.
  it("«8900 000 00 01» → +7 и 11 цифр, не таджикский (агенту — кнопка «Позвонить» с причиной, #306), заявка заводится", () => {
    const phone = extractVolunteeredPhone("8900 000 00 01");
    expect(phone).toBe("+79000000001");
    expect(isDialableTajikNumber(phone!)).toBe(false);
    const state = { ...initialOperatorState(), role: "buyer_property" as const, language: "tg" as const, asked: { role: 0, details: 0, phone: 1 } };
    const t = turn("8900 000 00 01", ctx(), state);
    expect(t.d.actions).toMatchObject([{ type: "accept_lead", role: "buyer", phone: "+79000000001" }]);
    expect(t.keys).toEqual(["phone_received"]);
  });
});

describe("1d15821e / 54fef009: чужой ролик и просьба лайка — тишина без модели", () => {
  it("таджикские «лайк монед / гузоред», «коммент нависед», «обуна шавед» — спам; слова о жилье, цене, номер — никогда", () => {
    for (const text of ["Да хамин видео як лайк монед тамом", "лайк гузоред", "коммент нависед", "обуна шавед илтимос", "Лайк камент паделится"]) {
      expect(customerSpamTurn({ inputText: text }), text).toBe(true);
    }
    for (const text of ["Хона мефурӯшам, лайк монед", "Ин хона чанд пул? лайк монед", "лайк монед +992 90 000 00 01", "Квартира нужна, коммент нависед"]) {
      expect(customerSpamInterest(text), text).toBe(true);
      expect(customerSpamTurn({ inputText: text }), text).toBe(false);
    }
  });
  const EVENT = "a".repeat(64);
  const cdn = "https://scontent.cdninstagram.fbcdn.net/v/t51/reel.mp4";
  const missing = { eventKey: EVENT, status: "missing", evidence: [{ kind: "media" as const, origin: "shared_media" as const, reference: "reel-1" }] };
  const base = { candidate: true, media: [{ url: cdn }], focus: missing, eventKey: EVENT, text: "", captions: [""] };
  it("пересланный чужой ролик без слов известен до скачивания и модели", () => {
    expect(customerForeignShareSettled(base)).toBe(true);
    expect(customerForeignShareSettled({ ...base, text: "😂" })).toBe(true);
  });
  it("предохранитель: свои слова, наш объект, сбой поиска, ссылка на публикацию, подпись о жилье — прежний путь", () => {
    expect(customerForeignShareSettled({ ...base, text: "Сколько стоит такая квартира?" })).toBe(false);
    expect(customerForeignShareSettled({ ...base, focus: { ...missing, status: "resolved" } })).toBe(false);
    expect(customerForeignShareSettled({ ...base, focus: { ...missing, lookupAttempts: 1 } })).toBe(false);
    expect(customerForeignShareSettled({ ...base, focus: { ...missing, eventKey: "b".repeat(64) } })).toBe(false);
    expect(customerForeignShareSettled({ ...base, media: [{ url: "https://www.instagram.com/reel/AbC123/" }] })).toBe(false);
    expect(customerForeignShareSettled({ ...base, captions: ["Объект №164, Royal Home"] })).toBe(false);
    expect(customerForeignShareSettled({ ...base, candidate: false })).toBe(false);
  });
  it("оператор: чужой пост без слов — тишина и без сигнала; своё фото без слов — «Ташаккур, гирифтам» и вопрос о роли", () => {
    const state = { ...initialOperatorState(), language: "tg" as const };
    // Чужой шум доказан сервером (customerForeignShareSettled); без приговора — см. bot-first-shared-post-21-11.test.ts.
    const foreign = decide(state, { ...understandFallback({ current: "", attachments: { foreignPost: true, foreignQuiet: true, media: true } }, state, ctx()) }, ctx());
    expect(foreign.silent).toBe(true);
    expect(foreign.actions).toEqual([]);
    const own = decide(state, understandFallback({ current: "", attachments: { media: true } }, state, ctx()), ctx());
    expect(renderOperatorReply(own.steps, own.language)).toBe("Ташаккур, гирифтам. Шумо хона мехаред ё мефурӯшед?");
  });
});

describe("роль только по словам; после заявки «Ершп» — не дело для агента", () => {
  it("«Салом» на рекламе «для собственников» в WhatsApp: приветствие и вопрос о роли, заявки нет", () => {
    const t = turn("Салом", ctx({ channel: "WHATSAPP", phoneKnown: true, ad: { topic: "seller", propertyId: null } }));
    expect(t.keys).toEqual(["greet", "ask_role"]);
    expect(t.d.actions).toEqual([]);
  });
  it("таджикская кнопка рекламы — не слова клиента", () => {
    for (const text of ["Маълумоти бештар", "Маълумоти бештар гирифтан мумкин аст?", "Метавонам маълумоти бештар гирам?"]) expect(isAdTemplateOpener(text), text).toBe(true);
    const t = turn("Маълумоти бештар", ctx({ channel: "WHATSAPP", phoneKnown: true, ad: { topic: "seller", propertyId: null } }));
    expect(t.d.actions).toEqual([]);
    expect(t.keys).toEqual(["ask_role"]);
  });
  it("после заявки одно слово без вопроса («Ершп») — ни «передал агенту», ни заметки; слова по делу — заметка", () => {
    const lead = { ...initialOperatorState(), role: "seller" as const, leadAccepted: true, step: "done" as const, language: "tg" as const };
    const c = ctx({ channel: "WHATSAPP", phoneKnown: true, leadExists: true });
    const gibberish = turn("Ершп", c, lead);
    expect(gibberish.d.actions.filter(action => action.type === "append_note")).toEqual([]);
    expect(gibberish.text).not.toMatch(/агент/u);
    const words = turn("Хонаам дар таъмир аст", c, lead);
    expect(words.d.actions.some(action => action.type === "append_note")).toBe(true);
  });
  it("«И продать, и купить» — заявка продавца с обеими целями в заметке; роль сменилась — заметка «роль изменилась»", () => {
    const wa = ctx({ channel: "WHATSAPP", phoneKnown: true });
    const both = turn("Хочу продать свою квартиру и купить побольше", wa);
    // Голая роль (владелец 22.11.2026): сначала вопрос по сути, заявка — на ответ.
    expect(both.d.actions.find(action => action.type === "accept_lead")).toBeUndefined();
    const answered = turn("Сино, 3 комнаты", wa, both.d.state);
    const lead = answered.d.actions.find(action => action.type === "accept_lead");
    expect(lead).toMatchObject({ role: "seller" });
    expect(lead && "note" in lead ? lead.note : "").toMatch(/и продать своё, и купить/u);
    const first = turn("Хочу купить квартиру", ctx());
    const second = turn("Нет, я продаю свою квартиру, +992 90 000 00 01", ctx(), first.d.state);
    const changed = second.d.actions.find(action => action.type === "accept_lead");
    expect(changed).toMatchObject({ role: "seller" });
    expect(changed && "note" in changed ? changed.note : "").toMatch(/Роль изменилась: сначала покупал, теперь продаёт/u);
  });
});

describe("ea3fecb5: счётчик вопроса о роли — по тому, что клиент видел", () => {
  it("в памяти «спросили дважды», в переписке один вопрос — счётчик 1 (второй вопрос будет); длинная история не трогается", () => {
    const state = { ...initialOperatorState(), asked: { role: 2, details: 0, phone: 0 }, step: "handoff" as const };
    reconcileAskedRole(state, [{ role: "user", text: "Оае" }, { role: "assistant", text: "Вы хотите купить или продать недвижимость?" }, { role: "user", text: "Ттк" }]);
    expect(state.asked.role).toBe(1);
    const long = { ...initialOperatorState(), asked: { role: 2, details: 0, phone: 0 } };
    reconcileAskedRole(long, Array.from({ length: 10 }, (_, i) => ({ role: i % 2 ? "assistant" as const : "user" as const, text: "ок" })));
    expect(long.asked.role).toBe(2);
  });
});

describe("Gemini: резервная модель прода в списке проверенных (134 ложные тревоги с 03.11)", () => {
  it("gemini-3.5-flash-lite и gemini-3.8-flash — известны; рабочая основная gemini-3.7-flash не убрана", () => {
    for (const model of ["gemini-3.5-flash-lite", "gemini-3.8-flash", "gemini-3.7-flash"]) expect(isKnownGeminiModel(model), model).toBe(true);
    expect(isKnownGeminiModel("gemini-9.9-imaginary")).toBe(false);
  });
});
