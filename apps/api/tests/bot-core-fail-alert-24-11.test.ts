import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AUTOMATION_SWITCH_LABELS, isAutomationSwitchOn } from "@royal-home/shared";

/**
 * Ход бота клиента упал (`customer_core_unavailable`, прод 24.11.2026 около 06:40): клиенту тишина, раньше человек узнавал
 * только через 30 минут. Теперь сразу, за рубильником `botCoreFailAlertEnabled` (ВКЛ). Клиенту текст не уходит.
 */
describe("сигнал агенту при падении хода бота", () => {
  it("рубильник есть, подписан и по умолчанию включён", () => {
    expect(AUTOMATION_SWITCH_LABELS.botCoreFailAlertEnabled.title).toBeTruthy();
    expect(isAutomationSwitchOn(null, "botCoreFailAlertEnabled")).toBe(true);
    expect(isAutomationSwitchOn({ botCoreFailAlertEnabled: false }, "botCoreFailAlertEnabled")).toBe(false);
  });

  it("ядро зовёт сигнал «escalate» при customer_core_unavailable только через рубильник", () => {
    const src = readFileSync(new URL("../src/lib/customerDmAgentTurn.ts", import.meta.url), "utf8");
    expect(src).toMatch(/reason === "customer_core_unavailable" && !staleRace && await automationSwitchOn\("botCoreFailAlertEnabled"\)/u);
  });

  it("причина падения идёт в журнал ошибок с местом в коде, даже без своего кадра", () => {
    const src = readFileSync(new URL("../src/lib/customerDmAgentTurn.ts", import.meta.url), "utf8");
    expect(src).toMatch(/\?\? stackLines\[0\]/u);
    expect(src).toMatch(/logSystemError\("ai", `Ход бота клиента: \$\{heldCause\} в /u);
  });

  it("гонка «principal/fence stale» (прод 24.11, WhatsApp, ответ ушёл через 27 с) агента не будит", () => {
    const src = readFileSync(new URL("../src/lib/customerDmAgentTurn.ts", import.meta.url), "utf8");
    expect(src).toMatch(/Customer delivery \(\?:principal\|fence\) stale/u);
    expect(src).toMatch(/!staleRace && await automationSwitchOn\("botCoreFailAlertEnabled"\)/u);
  });
});
