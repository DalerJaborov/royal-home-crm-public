import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * «Бот отвечает сам» в двери старого бота (сайт, Telegram; ai/legacyQualifyDoor.ts), 18.11.2026: ядро канала решило
 * «нужен сотрудник», сигнал по настройке не ушёл (`self`) — клиент слышит не «передал сотруднику», а шаг к номеру;
 * вложение не открылось — «напишите текстом или оставьте номер». Без базы: ядро канала и сигнал подменены.
 */
const mocks = vi.hoisted(() => ({ core: vi.fn(), staff: vi.fn() }));
vi.mock("../src/lib/customerChannelCore.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/lib/customerChannelCore.js")>()),
  runChannelCoreTurn: mocks.core }));
vi.mock("../src/lib/channelStaffAlert.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/lib/channelStaffAlert.js")>()),
  alertChannelStaff: mocks.staff }));

import { runLegacyQualifyTurn } from "../src/ai/legacyQualifyDoor.js";
import { ATTACHMENT_UNREADABLE, SELF_ASK_PHONE, SELF_OFFICE } from "../src/ai/botSelfAnswerText.js";
import { customerAgentHandoverLine } from "../src/ai/customerAgentRenderer.js";

const saved = process.env.CUSTOMER_AGENT_CHANNEL_CORE;
beforeEach(() => { vi.clearAllMocks(); process.env.CUSTOMER_AGENT_CHANNEL_CORE = "telegram"; });
afterEach(() => { if (saved === undefined) delete process.env.CUSTOMER_AGENT_CHANNEL_CORE; else process.env.CUSTOMER_AGENT_CHANNEL_CORE = saved; });

const staffOutcome = (reason: string) => ({ status: "staff", reason, language: "tg", intake: { role: "unknown" } });
const turn = (history: Array<{ role: "user" | "assistant"; content: string }>) =>
  runLegacyQualifyTurn(history as never, {} as never, { channel: "TELEGRAM", conversationId: "tg-1" } as never, { channel: "TELEGRAM" });

describe("дверь старого бота: «бот отвечает сам»", () => {
  it("сигнал не ушёл по настройке — шаг к номеру вместо «передал сотруднику»", async () => {
    mocks.core.mockResolvedValue(staffOutcome("escalate"));
    mocks.staff.mockResolvedValue("self");
    const result = await turn([{ role: "user", content: "Ҳуҷҷатҳо дурустанд?" }]);
    expect(result?.reply).toEqual([SELF_ASK_PHONE.tg]);
    expect(result?.reply).not.toContain(customerAgentHandoverLine("tg"));
  });

  it("номер уже просили — второй раз не просим, телефон офиса", async () => {
    mocks.core.mockResolvedValue(staffOutcome("core_refused"));
    mocks.staff.mockResolvedValue("self");
    const result = await turn([{ role: "assistant", content: SELF_ASK_PHONE.tg }, { role: "user", content: "Не, дар ин ҷо гӯед" }]);
    expect(result?.reply).toEqual([SELF_OFFICE.tg]);
  });

  it("вложение не открылось — «напишите текстом или оставьте номер»", async () => {
    mocks.core.mockResolvedValue(staffOutcome("unreadable_input"));
    mocks.staff.mockResolvedValue("self");
    expect((await turn([{ role: "user", content: "[голосовое]" }]))?.reply).toEqual([ATTACHMENT_UNREADABLE.tg]);
  });

  it("настройка выключена (сигнал ушёл) — как раньше, строка передачи", async () => {
    mocks.core.mockResolvedValue(staffOutcome("escalate"));
    mocks.staff.mockResolvedValue("sent");
    expect((await turn([{ role: "user", content: "Ҳуҷҷатҳо дурустанд?" }]))?.reply).toEqual([customerAgentHandoverLine("tg")]);
  });
});
