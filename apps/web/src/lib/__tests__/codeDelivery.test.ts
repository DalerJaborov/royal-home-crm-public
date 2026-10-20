import { describe, expect, it } from "vitest";
import { deliveryText, effectiveChannel, fallbackDeadline, resendChannel } from "../codeDelivery";

describe("куда ушёл код", () => {
  const t0 = 1_000_000;

  it("пуш: обратный отсчёт до СМС", () => {
    const at = fallbackDeadline("push", 10, t0);
    expect(at).toBe(t0 + 10_000);
    expect(deliveryText("push", at, t0, "•• ••• 06 61")).toBe(
      "Отправили код уведомлением на ваш телефон, он действует 5 минут. Если уведомление не придёт — через 10 с пришлём СМС сами.",
    );
    expect(deliveryText("push", at, t0 + 4_200, null)).toContain("через 6 с");
  });

  it("после отсчёта — «Отправили СМС на номер», сервер повторно не спрашиваем", () => {
    const at = fallbackDeadline("push", 10, t0);
    expect(effectiveChannel("push", at, at)).toBe("sms");
    expect(deliveryText("push", at, at + 1, "•• ••• 06 61")).toBe("Отправили СМС на •• ••• 06 61.");
  });

  it("без fallbackAfterSec берётся 30 с; не-пуш отсчёта не имеет", () => {
    expect(fallbackDeadline("push", undefined, t0)).toBe(t0 + 30_000);
    expect(fallbackDeadline("sms", 10, t0)).toBe(0);
    expect(deliveryText("sms", 0, t0, "+992 •• 06 61")).toBe("Код отправлен в СМС на +992 •• 06 61.");
    expect(deliveryText("telegram", 0, t0, null)).toBe("Код отправлен в Telegram.");
  });

  it("повтор после пуша уходит СМС", () => {
    expect(resendChannel("push")).toBe("sms");
    expect(resendChannel("telegram")).toBe("telegram");
  });
});
