/**
 * ЭКЗАМЕН РОЛИ «КУПИТЬ / ПРОДАТЬ» (владелец 20.11.2026: «Ещё проверь чтобы покупатели не путались с продавцами… Чтобы с
 * высокой вероятностью никогда не путаться»). Данные — tests/fixtures/bot-role-exam-21-11.ts (прод, без личных данных).
 *
 * Правило: слова клиента > тема рекламы > догадка модели. Экзамен идёт БЕЗ модели (код решает явные слова; модель — только
 * там, где код не решил, и её ответ здесь подменён отказом): так видно, что держит сам код.
 *  - совпадение не ниже 98 % на реальных строках;
 *  - НОЛЬ строк «уверенно не та роль»: покупатель стал продавцом (и наоборот) или роль назначена там, где её нет в словах;
 *  - тема рекламы роль не меняет (реклама «для собственников», реклама объекта без распознанного объекта);
 *  - тип карточки при приёме (services/leads/intakePolicy.ts::classifyInbound) совпадает с ролью оператора;
 *  - комиссию 2 % бот называет только продавцу по словам.
 */
import { describe, expect, it } from "vitest";
import { decide, initialOperatorState } from "../src/ai/operator/decide.js";
import { understandFallback } from "../src/ai/operator/understand.js";
import type { OperatorContext } from "../src/ai/operator/types.js";
import { classifyInbound } from "../src/services/leads/intakePolicy.js";
import { ROLE_EXAM, type RoleExamLabel, type RoleExamRow } from "./fixtures/bot-role-exam-21-11.js";

const ctx = (over: Partial<OperatorContext> = {}): OperatorContext => ({
  channel: "INSTAGRAM", phoneKnown: false, leadExists: false, leadPending: false, cardAgentActive: true,
  noAgentWhen: { ru: "завтра с 09:30", tg: "пагоҳ аз соати 09:30" }, recruiterPath: true, ad: { topic: null, propertyId: null }, focus: null,
  callbackWhen: { ru: "в ближайшее время", tg: "ба зудӣ" }, maxPhoneAsks: 2, vacancies: { open: [], contactPhone: null },
  brandName: "Royal Home", officePhone: "+992 00 000 00 02", sellerCommissionPercent: 2, outOfArea: false, ...over,
});

type Outcome = "buyer" | "seller" | "both" | "ask" | "none";
function outcome(row: RoleExamRow, c: OperatorContext) {
  const state = initialOperatorState();
  const u = understandFallback({ current: row.text }, state, c);
  const d = decide(state, u, c);
  const role = d.state.role;
  const got: Outcome = role === "seller" ? (d.state.flags.bothRoles ? "both" : "seller") : role === "buyer" || role === "buyer_property" ? "buyer"
    : role === "unknown" ? (d.steps.some(step => step.key === "ask_role") || d.silent ? "ask" : "none") : "none";
  return { got, d, u };
}
/** Совпадение: «ask» и «none» оба значат «роли купить/продать нет» — различие (вопрос или отказ) проверяется отдельно. */
const matches = (label: RoleExamLabel, got: Outcome) => label === got || ((label === "ask" || label === "none") && (got === "ask" || got === "none"));
/** Уверенно не та роль: назначен покупатель/продавец, а в словах другое (или ничего). */
const wrongRole = (label: RoleExamLabel, got: Outcome) => (got === "buyer" || got === "seller" || got === "both") && !matches(label, got) &&
  !(label === "both" && got === "seller");

describe("экзамен роли: слова клиента решают, тема рекламы — нет", () => {
  for (const [name, c] of [
    ["без рекламы", ctx()],
    ["реклама «для собственников»", ctx({ ad: { topic: "seller", propertyId: null } })],
    ["реклама объекта, объект не распознан", ctx({ ad: { topic: "property", propertyId: null } })],
    ["WhatsApp (номер известен), реклама «для собственников»", ctx({ channel: "WHATSAPP", phoneKnown: true, ad: { topic: "seller", propertyId: null } })],
  ] as const) {
    it(`${name}: ≥ 98 % совпадений на реальных строках и ноль «уверенно не та роль»`, () => {
      const real = ROLE_EXAM.filter(row => row.real);
      const results = ROLE_EXAM.map(row => ({ row, ...outcome(row, c) }));
      const wrong = results.filter(item => wrongRole(item.row.label, item.got)).map(item => `${item.row.label}→${item.got}: «${item.row.text}»`);
      expect(wrong).toEqual([]);
      const missed = results.filter(item => item.row.real && !matches(item.row.label, item.got));
      expect(1 - missed.length / real.length, missed.map(item => `${item.row.label}→${item.got}: «${item.row.text}»`).join("\n"))
        .toBeGreaterThanOrEqual(0.98);
      // Синтетические строки (аренда, работа, обе роли) — тоже без единого промаха.
      expect(results.filter(item => !item.row.real && !matches(item.row.label, item.got)).map(item => item.row.text)).toEqual([]);
    });
  }

  it("роли нет в словах — заявки нет даже в WhatsApp с известным номером (прод 20.11: «Салом» → заявка продавца)", () => {
    const c = ctx({ channel: "WHATSAPP", phoneKnown: true, ad: { topic: "seller", propertyId: null } });
    for (const row of ROLE_EXAM.filter(item => item.label === "ask")) {
      const { d } = outcome(row, c);
      expect(d.actions.filter(action => action.type === "accept_lead"), row.text).toEqual([]);
    }
  });

  it("тип карточки при приёме совпадает с ролью оператора; комиссия — только продавцу по словам", () => {
    const c = ctx({ channel: "WHATSAPP", phoneKnown: true, ad: { topic: "seller", propertyId: null } });
    for (const row of ROLE_EXAM.filter(item => item.label === "buyer" || item.label === "seller" || item.label === "both")) {
      const { d } = outcome(row, c);
      const lead = d.actions.find(action => action.type === "accept_lead");
      if (!lead || lead.type !== "accept_lead" || !lead.role) continue;
      const kind = classifyInbound({ intent: lead.role === "seller" ? "sell" : "buy", confident: true, clientText: row.text, fromAd: true, channel: "chat" }).kind;
      expect(kind, row.text).toBe(lead.role === "seller" ? "SELLER" : "BUYER");
      const commission = d.steps.some(step => step.key === "seller_intro" || step.key === "seller_commission");
      // Комиссию — никогда покупателю; продавцу по словам — сама (если в этом ходе не ответ на его вопрос, например о торге).
      if (commission) expect(lead.role, row.text).toBe("seller");
    }
  });
});
