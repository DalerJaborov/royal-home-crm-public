import { describe, expect, it, vi } from "vitest";

/**
 * ПРОВЕРКА «ОБЪЯСНИЛ ЛИ КЛИЕНТ ПАУЗУ» ПРИ БЛОКИРОВКЕ GOOGLE (аудит ботов 10.10.2026,
 * P1-8). Каждый день одни и те же клиенты упирались в PROHIBITED_CONTENT, а тревога
 * звучала так, будто переписку прочли и объяснения не нашли. Теперь: «не проверено»
 * отдельно от «не объяснено», и в вызов уходит id клиента — для журнала блокировки.
 */

const { callAiText } = vi.hoisted(() => ({ callAiText: vi.fn() }));
vi.mock("../src/ai/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ai/client.js")>()),
  callAiText,
}));
// База не нужна: переписка и заметки — заготовка, чтобы дойти до вызова ИИ.
vi.mock("../src/db.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/db.js")>()),
  prisma: {
    botConversation: {
      findMany: () => Promise.resolve([{ messages: [{ role: "user", content: "Салом, хона" }], lastMessageAt: new Date() }]),
    },
    telegramConversation: { findUnique: () => Promise.resolve(null) },
    interaction: { findMany: () => Promise.resolve([{ type: "CALL", notes: "Позвонил, клиент думает", createdAt: new Date() }]) },
    $disconnect: () => Promise.resolve(),
  },
}));

const { checkClientExplainedPause } = await import("../src/ai/offCrmPauseCheck.js");

describe("off-crm-pause-check: блокировка Google — «не проверено»", () => {
  it("Google заблокировал текст — explained=false и unchecked=true, id клиента ушёл в вызов", async () => {
    callAiText.mockImplementation(async (params: { onBlocked?: (r: string) => void }) => {
      params.onBlocked?.("PROHIBITED_CONTENT");
      return null;
    });
    const result = await checkClientExplainedPause("client-blocked-1");
    expect(result).toEqual({ explained: false, unchecked: true });
    expect(callAiText.mock.calls[0][0]).toMatchObject({ endpoint: "off-crm-pause-check", clientId: "client-blocked-1" });
  });

  it("обычный отказ ИИ — прежнее «не объяснено», без пометки «не проверено»", async () => {
    callAiText.mockReset();
    callAiText.mockResolvedValue(null);
    expect(await checkClientExplainedPause("client-plain-2")).toEqual({ explained: false });
  });
});
