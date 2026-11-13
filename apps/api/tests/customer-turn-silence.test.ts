// «Молчание бота без причины = инцидент» (13.11.2026, прод: клиент J&N в Instagram, round_limit, ответа нет и сигнала нет).
// Ход ядра, закончившийся HELD без ответа, раньше только записывался в тикет. Теперь любой HELD, кроме намеренного молчания,
// доходит до человека (текст в чате CRM уже есть, добавляется пуш «ответьте вручную»).
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/db.js";
import * as held from "../src/lib/customerHeldMessage.js";
import { CUSTOMER_TURN_INTENDED_SILENCE, customerTurnSilenceIsIntended, reportUnansweredCustomerTurn } from "../src/lib/customerTurnSilence.js";
import { consumeCustomerInboxTicket } from "../src/lib/customerIngressProducer.js";
import * as turn from "../src/lib/customerDmAgentTurn.js";

const EK = "a".repeat(64);
const row = (over: Partial<{ answered: boolean; conversationId: string | null }> = {}) =>
  [{ conversationId: "chat-1", channel: "INSTAGRAM", peer: "p1", excerpt: "Есть варианты с ремонтом?", answered: false, ...over }];

afterEach(() => { vi.restoreAllMocks(); });

describe("customer turn silence guard", () => {
  it("classifies intended silences, and treats every other reason (also future ones) as a failure", () => {
    for (const ok of ["provider_echo", "bare_template", "spam_muted_no_reply", "own_account", "foreign_share_no_reply", "newer_input_pending"]) {
      expect(customerTurnSilenceIsIntended(ok), ok).toBe(true);
    }
    for (const bad of ["round_limit", "turn_unavailable", "unsupported_decision_evidence", "staff_or_supported_reply_required",
      "sender_read_unavailable", "original_context_changed", "own_identity_registry_incomplete", "some_future_reason"]) {
      expect(customerTurnSilenceIsIntended(bad), bad).toBe(false);
    }
  });

  it("every intended silence is a real code of the turn code (no dead entries), so the list cannot drift", () => {
    const files = ["lib", "ai"].flatMap(dir => readdirSync(path.join(__dirname, "../src", dir)).filter(f => f.endsWith(".ts"))
      .filter(f => f !== "customerTurnSilence.ts").map(f => readFileSync(path.join(__dirname, "../src", dir, f), "utf8")));
    for (const code of CUSTOMER_TURN_INTENDED_SILENCE) {
      expect(files.some(text => text.includes(`"${code}"`) || text.includes(`= "${code}"`)), code).toBe(true);
    }
  });

  it("a failed turn reaches a person; an intended silence and an already answered customer do not", async () => {
    const notify = vi.spyOn(held, "notifyUnansweredCustomerTurn").mockResolvedValue();
    const query = vi.spyOn(prisma, "$queryRaw").mockResolvedValue(row() as never);
    await reportUnansweredCustomerTurn(EK, "round_limit");
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0]).toMatchObject({ reason: "round_limit", conversationId: "chat-1", excerpt: "Есть варианты с ремонтом?" });
    await reportUnansweredCustomerTurn(EK, "spam_muted_no_reply");
    expect(notify).toHaveBeenCalledTimes(1); // intended: no call, not even a query
    expect(query).toHaveBeenCalledTimes(1);
    query.mockResolvedValue(row({ answered: true }) as never);
    await reportUnansweredCustomerTurn(EK, "turn_unavailable");
    expect(notify).toHaveBeenCalledTimes(1); // a newer input was answered or is in flight
  });

  it("the consumer wires it: a core turn that ends HELD(round_limit) is reported, a held spam turn is not", async () => {
    vi.spyOn(prisma.customerPropertyIngressTicket, "findUnique").mockResolvedValue({ intakeAgentRevisionId: "rev", payloadVersion: 1 } as never);
    vi.spyOn(prisma, "$executeRaw").mockResolvedValue(1 as never);
    vi.spyOn(prisma, "$queryRaw").mockResolvedValue(row() as never);
    const notify = vi.spyOn(held, "notifyUnansweredCustomerTurn").mockResolvedValue();
    const run = vi.spyOn(turn, "runCustomerDmAgentTurn");
    run.mockResolvedValue({ status: "held", reason: "round_limit" });
    await consumeCustomerInboxTicket(EK);
    expect(notify).toHaveBeenCalledTimes(1);
    run.mockResolvedValue({ status: "held", reason: "spam_muted_no_reply" });
    await consumeCustomerInboxTicket(EK);
    expect(notify).toHaveBeenCalledTimes(1);
  });
});
