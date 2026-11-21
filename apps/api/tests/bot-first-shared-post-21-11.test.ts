/**
 * ПРОД 21.11.2026 (Instagram, без личных данных): новый клиент первым и единственным сообщением переслал публикацию без слов.
 * Сервер её не опознал, но и чужим шумом не признал (фильтр спама промолчал), а оператор всё равно промолчал по «кандидату в
 * чужие» — ни ответа, ни сигнала, клиент ушёл без ответа. Теперь:
 *  - чужой шум, доказанный сервером (`foreignQuiet`, lib/customerSharedPublication.ts::customerForeignShareSettled) — тишина
 *    без сигнала, как решил владелец 21.11 («спамерам не отвечать»);
 *  - пересланный пост без приговора, бот в разговоре ещё ничего не спрашивал — один вопрос «купить или продать?», без
 *    «Спасибо, получил» (это только на своё вложение) и без просьбы номера; повтор подряд — тишина без сигнала, как прежде.
 */
import { describe, expect, it } from "vitest";
import { decide, initialOperatorState } from "../src/ai/operator/decide.js";
import { understandFallback } from "../src/ai/operator/understand.js";
import { renderOperatorReply } from "../src/ai/operator/phrases.js";
import { reconcileAskedRole } from "../src/ai/operator/index.js";
import type { OperatorContext, OperatorState } from "../src/ai/operator/types.js";

const ctx = (over: Partial<OperatorContext> = {}): OperatorContext => ({
  channel: "INSTAGRAM", phoneKnown: false, leadExists: false, leadPending: false, cardAgentActive: true,
  noAgentWhen: { ru: "завтра с 09:30", tg: "пагоҳ аз соати 09:30" }, recruiterPath: true, ad: { topic: null, propertyId: null }, focus: null,
  callbackWhen: { ru: "завтра с 10:00", tg: "пагоҳ аз соати 10:00" }, maxPhoneAsks: 2, vacancies: { open: [], contactPhone: null },
  brandName: "Royal Home", officePhone: "+992 00 000 00 02", sellerCommissionPercent: 2, outOfArea: false, ...over,
});
type Share = { foreignQuiet?: boolean; ownPost?: boolean };
function share(state: OperatorState, c: OperatorContext, att: Share = {}) {
  const u = understandFallback({ current: "", attachments: { foreignPost: true, ...att } }, state, c);
  const d = decide(state, u, c);
  return { u, d, keys: d.steps.map(step => step.key), text: renderOperatorReply(d.steps, d.language) };
}

describe("пересланный пост без слов первым сообщением (прод 21.11.2026)", () => {
  it("сервер чужим шумом не признал: вопрос «купить или продать?» — на таджикском при неизвестном языке, без «получил» и без номера", () => {
    const first = share(initialOperatorState(), ctx());
    expect(first.d.silent).toBe(false);
    expect(first.keys).toEqual(["ask_role"]);
    expect(first.text).toBe("Шумо хона мехаред ё мефурӯшед?");
    expect(first.d.actions).toEqual([]);
    expect(first.d.state).toMatchObject({ role: "unknown", step: "role", asked: { role: 1, phone: 0 } });
    // Язык разговора известен — на нём.
    const ru = share({ ...initialOperatorState(), language: "ru" }, ctx());
    expect(ru.text).toBe("Вы хотите купить или продать недвижимость?");
  });

  it("повтор подряд — тишина без сигнала людям (по замыслу), второй вопрос о роли не звучит", () => {
    const first = share(initialOperatorState(), ctx());
    const second = share(first.d.state, ctx());
    expect(second.d.silent).toBe(true);
    expect(second.d.actions).toEqual([]);
    expect(second.d.state.asked.role).toBe(1);
  });

  it("бот уже спрашивал о роли (клиент сначала поздоровался) — пост без слов тишина, как прежде", () => {
    const greeted = decide(initialOperatorState(), understandFallback({ current: "Салом" }, initialOperatorState(), ctx()), ctx());
    expect(greeted.steps.map(step => step.key)).toEqual(["greet", "ask_role"]);
    const after = share(greeted.state, ctx());
    expect(after.d.silent).toBe(true);
    expect(after.d.actions).toEqual([]);
  });

  it("чужой шум, доказанный сервером (foreignQuiet) — тишина и на первый пост, без сигнала (владелец 21.11: «спамерам не отвечать»)", () => {
    const quiet = share(initialOperatorState(), ctx(), { foreignQuiet: true });
    expect(quiet.d.silent).toBe(true);
    expect(quiet.d.actions).toEqual([]);
    expect(quiet.d.state.asked.role).toBe(0);
  });

  it("приговор без самого чужого поста или вместе со своим постом не глушит ответ (защита по умолчанию — ответ)", () => {
    const state = initialOperatorState();
    expect(understandFallback({ current: "", attachments: { foreignQuiet: true, media: true } }, state, ctx()).attachments.foreignQuiet).toBe(false);
    expect(understandFallback({ current: "", attachments: { foreignPost: true, foreignQuiet: true, ownPost: true } }, state, ctx()).attachments.foreignQuiet).toBe(false);
    // Своё фото без слов — прежнее «Спасибо, получил» и вопрос о роли.
    const own = decide(state, understandFallback({ current: "", attachments: { media: true } }, state, ctx()), ctx());
    expect(own.steps.map(step => step.key)).toEqual(["media_received", "ask_role"]);
  });

  it("сверка счётчика вопроса о роли видит и очередь отправки: недоставленный вопрос не обнуляет счётчик (гонка, ревью #371)", () => {
    const asked = (): OperatorState => ({ ...initialOperatorState(), asked: { role: 1, details: 0, phone: 0 }, step: "role" });
    const recent = [{ role: "user" as const, text: "{\"incomingAttachments\":[\"share\"]}" }];
    // Прежнее поведение (ea3fecb5): вопроса нет ни в памяти, ни в очереди — счётчик падает до того, что клиент видел.
    const lost = asked(); reconcileAskedRole(lost, recent); expect(lost.asked.role).toBe(0);
    const lostToo = asked(); reconcileAskedRole(lostToo, recent, []); expect(lostToo.asked.role).toBe(0);
    // Вопрос в очереди (READY / IN_FLIGHT) — счётчик остаётся, и следующий пост серии не получит второй вопрос.
    const queued = asked(); reconcileAskedRole(queued, recent, ["Шумо хона мехаред ё мефурӯшед?"]); expect(queued.asked.role).toBe(1);
    expect(share(queued, ctx()).d.silent).toBe(true);
  });

  it("после заявки пересланный пост без слов — как прежде: без вопроса о роли", () => {
    const state: OperatorState = { ...initialOperatorState(), role: "buyer", leadAccepted: true, step: "done" };
    const after = share(state, ctx({ leadExists: true }));
    expect(after.keys).toEqual([]);
  });
});
