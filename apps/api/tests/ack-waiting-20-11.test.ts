import { describe, expect, it } from "vitest";
import { isAckOnlyMessage } from "../src/ai/ackOnly.js";
import { looksLikeNoContactComplaint } from "../src/ai/complaintGuard.js";
import { echoIsAutomatic, META_PAGE_INBOX_APP_ID } from "../src/routes/webhooks.js";
import { lastStaffWriterId } from "../src/lib/clientWaitingAlert.js";

/** Ревью #333 (20.11.2026): «ок» с хвостом ожидания — не новая деталь и не жалоба; эхо автоответа — не сотрудник. */
describe("согласие с ожиданием", () => {
  it("«Хорошо, жду», «Ок, договорились», «Ладно, буду ждать», «Хоп, интизор мешавам», «Спасибо, жду звонка» — это «ок»", () => {
    for (const text of ["Хорошо, жду", "Ок, договорились", "Ладно, буду ждать", "Хоп, интизор мешавам", "Спасибо, жду звонка", "Рахмат, мунтазирам"]) {
      expect(isAckOnlyMessage(text), text).toBe(true);
    }
    expect(isAckOnlyMessage("жду звонка")).toBe(false);
    expect(isAckOnlyMessage("Хорошо, 5 этаж")).toBe(false);
  });
  it("благодарность и спокойное ожидание — не жалоба; нетерпение и «никто не звонит» — жалоба", () => {
    expect(looksLikeNoContactComplaint("Спасибо, жду звонка")).toBe(false);
    expect(looksLikeNoContactComplaint("Хоп, интизор мешавам")).toBe(false);
    expect(looksLikeNoContactComplaint("Сколько можно ждать, никто не звонит")).toBe(true);
    expect(looksLikeNoContactComplaint("Ок, уже жду звонка второй день")).toBe(true);
  });
});

describe("эхо Messenger: автоответ не считается ответом сотрудника", () => {
  it("безопасное умолчание: неизвестное приложение, входящие Страницы и эхо без app_id — человек (автомат только по явному списку)", () => {
    const now = Date.now();
    expect(echoIsAutomatic({ appId: "1234567890", at: now, lastClientAt: now - 60_000 })).toBe(false);
    expect(echoIsAutomatic({ appId: META_PAGE_INBOX_APP_ID, at: now, lastClientAt: now - 60_000 })).toBe(false);
    expect(echoIsAutomatic({ at: now, lastClientAt: now - 2_000 })).toBe(false);
  });
});

describe("лесенка сигналов: «клиент пишет в вашу переписку» — тому, кто её ведёт", () => {
  it("последний писавший из CRM сотрудник; ответ из приложения Meta (без имени) — нет адресата, решает агент карточки", () => {
    expect(lastStaffWriterId([{ role: "assistant", by: { kind: "agent", agentId: "a1" } }, { role: "user" },
      { role: "assistant", by: { kind: "agent", agentId: "a2" } }, { role: "user" }])).toBe("a2");
    expect(lastStaffWriterId([{ role: "assistant", by: { kind: "manual" } }])).toBeNull();
  });
});
