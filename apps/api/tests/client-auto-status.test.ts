import { describe, expect, it } from "vitest";

const { decideStatus } = await import("../src/lib/clientAutoStatus.js");
type Facts = Parameters<typeof decideStatus>[1];

/**
 * Автоматические статусы клиента (пороги согласованы владельцем 08.08.2026).
 *
 * Проверяется чистая функция решения: она не ходит в базу, поэтому здесь видно
 * ровно то, что важно, — какие факты к какому статусу приводят и, главное, чего
 * автоматика делать НЕ должна.
 */

const DAY = 86_400_000;
const now = new Date("2026-08-08T12:00:00Z");
const ago = (days: number) => new Date(now.getTime() - days * DAY);

const client = (over: Partial<Parameters<typeof decideStatus>[0]> = {}) => ({
  id: "c1",
  status: "NEW" as const,
  createdAt: ago(30),
  acceptedAt: ago(30),
  statusSetManuallyAt: null,
  hotSince: null,
  ...over,
});

const facts = (over: Partial<Facts> = {}): Facts => ({
  talked: false,
  clientReplied: false,
  showing: false,
  activeDeal: false,
  dealClosed: false,
  noAnswerStreak: 0,
  lastEventAt: ago(1),
  lastClientActivityAt: null,
  ...over,
});

describe("Автостатус: переходы вперёд", () => {
  it.each([30, 60, 90])("рабочий объект защищает продавца после %s дней ожидания", (days) => {
    expect(decideStatus(client({ status: "CONTACTED" }), facts({
      talked: true, lastEventAt: ago(days), lastClientActivityAt: ago(days),
      sellerPropertyInWork: true,
    }), now)).toBeNull();
  });
  it("поговорили — «На контакте»", () => {
    expect(decideStatus(client(), facts({ talked: true, lastClientActivityAt: ago(1) }), now)).toBe("CONTACTED");
  });

  it("клиент ответил в переписке — «На контакте»", () => {
    expect(decideStatus(client(), facts({ clientReplied: true, lastClientActivityAt: ago(2) }), now)).toBe("CONTACTED");
  });

  it("назначен показ — «Горячий»", () => {
    expect(decideStatus(client({ status: "CONTACTED" }), facts({ talked: true, showing: true }), now)).toBe("HOT");
  });

  it("есть незакрытая сделка — «Горячий»", () => {
    expect(decideStatus(client({ status: "NEW" }), facts({ activeDeal: true }), now)).toBe("HOT");
  });

  it("сделка завершена — «Сделка закрыта»", () => {
    expect(decideStatus(client({ status: "HOT" }), facts({ dealClosed: true, showing: true }), now)).toBe("DEAL_CLOSED");
  });
});

describe("Автостатус: переходы по времени", () => {
  it("неделя тишины после разговора — «Холодный»", () => {
    const f = facts({ talked: true, lastClientActivityAt: ago(8), lastEventAt: ago(8) });
    expect(decideStatus(client({ status: "CONTACTED" }), f, now)).toBe("COLD");
  });

  it("шесть дней тишины — ещё «На контакте», порог не наступил", () => {
    const f = facts({ talked: true, lastClientActivityAt: ago(6), lastEventAt: ago(6) });
    expect(decideStatus(client({ status: "COLD" }), f, now)).toBe("CONTACTED");
  });

  it("три недозвона подряд — «Не отвечает»", () => {
    expect(decideStatus(client({ status: "NEW" }), facts({ noAnswerStreak: 3 }), now)).toBe("UNRESPONSIVE");
  });

  it("два недозвона — ещё не «Не отвечает»", () => {
    expect(decideStatus(client({ status: "NEW" }), facts({ noAnswerStreak: 2 }), now)).toBeNull();
  });

  it("шестьдесят дней без единого события — «В архиве»", () => {
    const f = facts({ lastEventAt: ago(61), lastClientActivityAt: null });
    expect(decideStatus(client({ status: "NEW" }), f, now)).toBe("ARCHIVED");
  });
});

describe("Автостатус: чего он делать не должен", () => {
  it("не трогает «Потерянный» — это решение человека с причиной отказа", () => {
    expect(decideStatus(client({ status: "LOST" }), facts({ talked: true, showing: true }), now)).toBeNull();
  });

  it("не понижает «Сделка закрыта» — закрытая сделка не остывает", () => {
    const f = facts({ lastEventAt: ago(90), lastClientActivityAt: ago(90) });
    expect(decideStatus(client({ status: "DEAL_CLOSED" }), f, now)).toBeNull();
  });

  it("молчит неделю после ручной правки — человек знает больше правил", () => {
    const manual = client({ status: "HOT", statusSetManuallyAt: ago(2) });
    expect(decideStatus(manual, facts({ noAnswerStreak: 5 }), now)).toBeNull();
  });

  it("через неделю после ручной правки снова решает сам", () => {
    const manual = client({ status: "HOT", statusSetManuallyAt: ago(8) });
    expect(decideStatus(manual, facts({ noAnswerStreak: 5 }), now)).toBe("UNRESPONSIVE");
  });

  it("не пишет тот же статус повторно — иначе хронология забьётся мусором", () => {
    const f = facts({ talked: true, lastClientActivityAt: ago(1) });
    expect(decideStatus(client({ status: "CONTACTED" }), f, now)).toBeNull();
  });

  it("горячий остаётся горячим, пока стоит отметка hotSince", () => {
    const c = client({ status: "HOT", hotSince: ago(3) });
    const f = facts({ talked: true, lastClientActivityAt: ago(20), lastEventAt: ago(20) });
    expect(decideStatus(c, f, now)).toBeNull();
  });
});
