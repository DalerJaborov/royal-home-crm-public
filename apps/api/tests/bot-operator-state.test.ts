import { describe, expect, it } from "vitest";
import { initialOperatorState } from "../src/ai/operator/decide.js";
import { OPERATOR_HANDOFF_RESET_MS, OPERATOR_STATE_TTL_MS, readOperatorState, saveOperatorStateIsolatedTx,
  serializeOperatorState } from "../src/ai/operator/state.js";
import { prisma } from "../src/db.js";
import { randomUUID } from "node:crypto";
import { parseLeadOnlyPending } from "../src/lib/leadOnlyPending.js";

/**
 * ПАМЯТЬ ОПЕРАТОРА В BotConversation.leadOnlyPending: версия 1 (старый режим «о чём просили номер») читается без падения
 * и переводится в версию 2; битое и просроченное — новое состояние; запись проверяется той же схемой.
 */
const NOW = new Date("2026-11-19T10:00:00.000Z");
const PROPERTY_ID = "6f1c2d3e-0000-4000-8000-000000000164";
const v1 = (scenario: string, propertyId: string | null, askedAt = "2026-11-19T09:00:00.000Z") => ({ version: 1, scenario, propertyId, askedAt });

describe("память оператора: версия 1 → 2", () => {
  it("продавец: роль, номер уже просили, вопрос о деталях и комиссия не повторяются", () => {
    const state = readOperatorState(v1("seller", null), NOW);
    expect(state).toMatchObject({ version: 2, role: "seller", step: "contact", asked: { role: 0, details: 1, phone: 1 }, propertyId: null });
    expect(state.spoken.seller_intro).toBe(1);
    expect(state.spoken.ask_phone).toBe(1);
  });

  it("объект и горячий с объектом — покупатель объекта, объект уже назван; горячий без объекта и покупатель — общий покупатель", () => {
    expect(readOperatorState(v1("property", PROPERTY_ID), NOW)).toMatchObject({ role: "buyer_property", propertyId: PROPERTY_ID,
      flags: { propertyLineFor: PROPERTY_ID } });
    expect(readOperatorState(v1("hot", PROPERTY_ID), NOW)).toMatchObject({ role: "buyer_property", propertyId: PROPERTY_ID });
    expect(readOperatorState(v1("hot", null), NOW)).toMatchObject({ role: "buyer", propertyId: null });
    expect(readOperatorState(v1("buyer", null), NOW)).toMatchObject({ role: "buyer", propertyId: null, asked: { details: 1 } });
  });

  it("просроченная версия 1, битое, чужое, пустое — новое состояние, без исключения", () => {
    const fresh = initialOperatorState();
    expect(readOperatorState(v1("seller", null, "2026-11-10T09:00:00.000Z"), NOW)).toEqual(fresh);
    for (const raw of [null, undefined, "", 42, [], {}, { version: 1 }, { version: 3 }, { version: 2, role: "boss" }, v1("seller", "not-a-uuid")]) {
      expect(readOperatorState(raw, NOW)).toEqual(fresh);
    }
  });

  it("версия 2 переживает запись и чтение; просроченная — новое состояние", () => {
    const state = initialOperatorState();
    state.role = "seller"; state.step = "details"; state.language = "tg"; state.asked.details = 1; state.spoken.seller_intro = 1;
    state.details.district = "Сино"; state.callback.when = "с 11:00 до 14:30"; state.outOfArea = true; state.place = "Ромит";
    const stored = serializeOperatorState(state, NOW);
    expect(stored.updatedAt).toBe(NOW.toISOString());
    expect(readOperatorState(JSON.parse(JSON.stringify(stored)), NOW)).toEqual(state);
    expect(readOperatorState(stored, new Date(NOW.getTime() + OPERATOR_STATE_TTL_MS + 1))).toEqual(initialOperatorState());
  });

  it("«бот замолчал» не навсегда: через сутки закрытый разговор и тишина снимаются, роль и язык остаются", () => {
    const state = initialOperatorState();
    state.role = "seller"; state.language = "tg"; state.closed = true; state.staffCalled = true; state.step = "handoff";
    state.asked = { role: 2, details: 1, phone: 2 }; state.spoken.office_phone = 1;
    const stored = serializeOperatorState(state, NOW);
    expect(readOperatorState(stored, new Date(NOW.getTime() + OPERATOR_HANDOFF_RESET_MS - 60_000))).toMatchObject({ closed: true, step: "handoff" });
    const later = readOperatorState(stored, new Date(NOW.getTime() + OPERATOR_HANDOFF_RESET_MS + 60_000));
    expect(later).toMatchObject({ closed: false, staffCalled: false, step: "start", role: "seller", language: "tg",
      asked: { role: 0, details: 1, phone: 0 } });
    expect(later.spoken.office_phone).toBeUndefined();
    // Принятая заявка остаётся принятой: вопросов после неё нет и через сутки.
    const done = { ...state, leadAccepted: true };
    expect(readOperatorState(serializeOperatorState(done, NOW), new Date(NOW.getTime() + 2 * OPERATOR_HANDOFF_RESET_MS)))
      .toMatchObject({ leadAccepted: true, step: "done", closed: false });
  });

  it("«Передал агенту» снова можно сказать через сутки (ревью 19.11, Р5); внутри суток — нет", () => {
    const state = initialOperatorState();
    state.leadAccepted = true; state.step = "done"; state.spoken.note_added = 1;
    const stored = serializeOperatorState(state, NOW);
    expect(readOperatorState(stored, new Date(NOW.getTime() + 60_000)).spoken.note_added).toBe(1);
    expect(readOperatorState(stored, new Date(NOW.getTime() + OPERATOR_HANDOFF_RESET_MS + 60_000)).spoken.note_added).toBeUndefined();
  });

  // Т6 (память оператора переживает приём заявки) — на настоящем acceptLead: bot-operator-core-postgres (случай 3) и
  // bot-operator-legacy-postgres (случай 3): после приёма в колонке версия 2 с «заявка принята», версия 1 стирается.

  it("Т5: сбой записи памяти за точкой сохранения не валит транзакцию ответа", async () => {
    const id = (await prisma.botConversation.create({ data: { channel: "INSTAGRAM", subscriberId: `operator-state-${randomUUID()}`, messages: [] } })).id;
    try {
      const broken = { ...initialOperatorState(), propertyId: "не-uuid" };
      const error = await prisma.$transaction(async tx => {
        await tx.botConversation.update({ where: { id }, data: { name: "ответ хода записан" } });
        return saveOperatorStateIsolatedTx(tx, id, broken, NOW);
      });
      expect(error).toBeTruthy();
      const row = await prisma.botConversation.findUniqueOrThrow({ where: { id }, select: { name: true, leadOnlyPending: true } });
      expect(row.name).toBe("ответ хода записан");
      expect(row.leadOnlyPending).toBeNull();
      expect(await prisma.$transaction(tx => saveOperatorStateIsolatedTx(tx, id, initialOperatorState(), NOW))).toBeNull();
      expect((await prisma.botConversation.findUniqueOrThrow({ where: { id }, select: { leadOnlyPending: true } })).leadOnlyPending).toMatchObject({ version: 2 });
    } finally { await prisma.botConversation.delete({ where: { id } }); }
  });

  it("запись обрезает длинные слова клиента и не пишет номер телефона", () => {
    const state = initialOperatorState();
    state.details.district = "Сино ".repeat(60);
    const stored = serializeOperatorState(state, NOW);
    expect(stored.details.district!.length).toBeLessThanOrEqual(120);
    expect(JSON.stringify(stored)).not.toMatch(/\d{7,}/u);
  });

  it("старый путь (lib/leadOnlyPending.ts) версию 2 не принимает за свою и не падает на ней", () => {
    const stored = serializeOperatorState(initialOperatorState(), NOW);
    expect(parseLeadOnlyPending(stored, NOW)).toBeNull();
  });
});
