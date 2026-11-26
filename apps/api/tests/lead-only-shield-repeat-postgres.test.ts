import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCustomerMessengerFixture, type CustomerMessengerFixture } from "./helpers/customerMessengerFixture.js";

/**
 * CRM-36, поведенческий тест на настоящем щите (ревью #448, п.3): два раза за сутки бот уже сказал «Ваша заявка у агента,
 * он с вами свяжется.» (записано щитом при отправке, как в жизни). Третий такой ответ оператора щит вырезал бы на
 * транспорте; дверь оператора спрашивает щит заранее и отправляет второй вариант той же фразы. Когда звучали оба варианта,
 * ответа нет, а сотруднику идёт сигнал `repeat_shield`. Тот же счёт щита, что у customerReplyRepeatBlocked (coreReplyRepeatBlocked).
 */
const { admitOutbound, noteRealInbound, coreReplyRepeatBlocked, resetOutboundShieldCache } = await import("../src/lib/outboundShield.js");
const { leadOnlyPlanAvoidingShieldRepeat } = await import("../src/lib/leadOnlyShieldRepeat.js");
const { renderOperatorReply } = await import("../src/ai/operator/index.js");
const { prisma } = await import("../src/db.js");

const CHANNEL = "INSTAGRAM";
const runId = Date.now().toString(36);
let fixture: CustomerMessengerFixture;
beforeAll(async () => { fixture = await createCustomerMessengerFixture(CHANNEL); });
afterAll(async () => { await fixture.dispose(); await prisma.$disconnect(); });

const steps = [{ key: "lead_reminder" as const, vars: {}, variant: 0 }];
const first = "Ваша заявка у агента, он с вами свяжется.";
const second = "Заявка у агента, он свяжется с вами.";
function plan() {
  const text = renderOperatorReply(steps, "ru");
  return { text, intakes: [], baseUpdatedAt: null,
    operator: { text, parts: [text], language: "ru" as const, steps, facts: {}, actions: [], state: {} as never, stored: {} as never, understanding: {} as never } };
}

async function said(subscriberId: string, text: string, at: Date) {
  await noteRealInbound({ transport: fixture.transport, channel: CHANNEL, subscriberId, providerId: `mid.${runId}.${at.getTime()}`, now: at });
  const verdict = await admitOutbound({ transport: fixture.transport, channel: CHANNEL, subscriberId, text, now: at, answersInbound: true });
  expect(verdict.allowed).toBe(true);
}

describe("ответ оператора и настоящий щит повторов", () => {
  it("первый вариант звучал дважды за сутки — уходит второй вариант; оба звучали — тишина и сигнал repeat_shield", async () => {
    resetOutboundShieldCache();
    const subscriberId = `shieldrep-${runId}`;
    await fixture.ensureConversation(subscriberId);
    const t0 = new Date(Date.now() - 6 * 3600_000);
    await said(subscriberId, first, t0);
    await said(subscriberId, first, new Date(t0.getTime() + 3600_000));
    const blocked = (texts: string[]) => coreReplyRepeatBlocked(CHANNEL, subscriberId, texts, fixture.transport).then(list => new Set(list));
    const out = await leadOnlyPlanAvoidingShieldRepeat(plan(), blocked);
    expect(out.text).toBe(second);

    await said(subscriberId, second, new Date(t0.getTime() + 2 * 3600_000));
    await said(subscriberId, second, new Date(t0.getTime() + 3 * 3600_000));
    const silent = await leadOnlyPlanAvoidingShieldRepeat(plan(), blocked);
    expect(silent.text).toBeNull();
    expect(silent.signal).toEqual({ kind: "follow_up", reason: "repeat_shield" });
  });
});
