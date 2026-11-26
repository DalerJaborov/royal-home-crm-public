import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { leadOnlyPlanAvoidingShieldRepeat } from "../src/lib/leadOnlyShieldRepeat.js";
import { renderOperatorReply } from "../src/ai/operator/index.js";
import type { CustomerLeadOnlyTurnPlan } from "../src/lib/customerLeadOnlyCore.js";
import type { OperatorStepOut } from "../src/ai/operator/index.js";

/**
 * CRM-36 (26.11.2026): ответ оператора, который щит исходящих вырежет как третий дословный повтор за сутки, раньше
 * уходил в очередь и молча пропадал на транспорте. Теперь до очереди: другая формулировка того же шага, а если все
 * формулировки уже звучали — тишина с сигналом человеку (как у собственного сторожа повтора оператора).
 *
 * Живой сценарий: после заявки клиент трижды за день пишет «ну что там?» с разговором между ними; оператор каждый раз
 * отвечает напоминанием «Ваша заявка у агента, он с вами свяжется.» (сторож оператора видит только два последних ответа).
 */

function plan(steps: OperatorStepOut[], language: "ru" | "tg" = "ru", extra: Partial<CustomerLeadOnlyTurnPlan> = {}): CustomerLeadOnlyTurnPlan {
  const text = renderOperatorReply(steps, language);
  return {
    text, intakes: [], baseUpdatedAt: null,
    operator: { text, parts: [text], language, steps, facts: {}, actions: [], state: {} as never, stored: {} as never, understanding: {} as never },
    ...extra,
  };
}
const reminder: OperatorStepOut = { key: "lead_reminder", vars: {}, variant: 0 };
const blockedSet = (...texts: string[]) => async (asked: string[]) => new Set(asked.filter(text => texts.includes(text)));

describe("ответ оператора и щит повторов", () => {
  it("щит не вырежет — ответ без изменений", async () => {
    const p = plan([reminder]);
    expect(await leadOnlyPlanAvoidingShieldRepeat(p, blockedSet())).toBe(p);
  });

  it("щит вырежет первый вариант — уходит второй вариант той же фразы, смысл тот же", async () => {
    const p = plan([reminder]);
    const out = await leadOnlyPlanAvoidingShieldRepeat(p, blockedSet("Ваша заявка у агента, он с вами свяжется."));
    expect(out.text).toBe("Заявка у агента, он свяжется с вами.");
    expect(out.signal).toBeUndefined();
  });

  it("таджикский — так же", async () => {
    const p = plan([reminder], "tg");
    const out = await leadOnlyPlanAvoidingShieldRepeat(p, blockedSet(p.text!));
    expect(out.text).toBe("Дархостатон ба агент расидааст, ӯ бо шумо тамос мегирад.");
  });

  it("все варианты уже звучали — тишина и сигнал человеку, а не невидимый отказ на транспорте; заявка хода не теряется", async () => {
    const intake = { eventKey: "e1" } as never;
    const p = plan([reminder], "ru", { intakes: [intake] });
    const out = await leadOnlyPlanAvoidingShieldRepeat(p, blockedSet("Ваша заявка у агента, он с вами свяжется.", "Заявка у агента, он свяжется с вами."));
    expect(out.text).toBeNull();
    expect(out.signal).toEqual({ kind: "follow_up", reason: "repeat_shield" });
    expect(out.intakes).toEqual([intake]);
  });

  it("сигнал оператора без причины заменяется на repeat_shield: бот молчит, «бот ответил, что уточнит агент» было бы неправдой", async () => {
    const p = plan([reminder], "ru", { signal: { kind: "follow_up" } });
    const out = await leadOnlyPlanAvoidingShieldRepeat(p, blockedSet("Ваша заявка у агента, он с вами свяжется.", "Заявка у агента, он свяжется с вами."));
    expect(out.signal).toEqual({ kind: "follow_up", reason: "repeat_shield" });
  });

  it("уже назначенный сигнал (грубость, жалоба) не перетирается", async () => {
    const p = plan([reminder], "ru", { signal: { kind: "follow_up", reason: "complaint" } });
    const out = await leadOnlyPlanAvoidingShieldRepeat(p, blockedSet("Ваша заявка у агента, он с вами свяжется.", "Заявка у агента, он свяжется с вами."));
    expect(out.signal).toEqual({ kind: "follow_up", reason: "complaint" });
  });

  it("сторож: живой путь ядра спрашивает щит до записи ответа оператора в очередь", () => {
    // Дверь записи ответа оператора одна (planLeadOnly в lib/customerDmAgentTurn.ts). Если кто-то уберёт проверку
    // или запишет текст оператора в очередь мимо неё, класс CRM-36 вернётся молча — этот тест краснеет.
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../src/lib/customerDmAgentTurn.ts"), "utf8");
    const start = source.indexOf("const planLeadOnly = async");
    const body = source.slice(start, start + 1500);
    expect(start).toBeGreaterThan(0);
    expect(body).toMatch(/leadOnlyPlanAvoidingShieldRepeat\(decided,[^)]*customerReplyRepeatBlocked/u);
    expect(body.indexOf("leadOnlyPlanAvoidingShieldRepeat")).toBeLessThan(body.indexOf("createCustomerOutboxPartsTx"));
    expect(source.match(/plan\.text \? await createCustomerOutboxPartsTx/gu)?.length).toBe(1);
  });

  it("тишина оператора остаётся тишиной, щит не спрашиваем", async () => {
    const p = { ...plan([reminder]), text: null };
    let asked = false;
    const out = await leadOnlyPlanAvoidingShieldRepeat(p, async () => { asked = true; return new Set(); });
    expect(out).toBe(p);
    expect(asked).toBe(false);
  });
});
