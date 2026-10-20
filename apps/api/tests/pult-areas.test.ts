import { describe, expect, it } from "vitest";
import { buildPultView, plural, type PultSnapshot } from "@royal-home/shared";

/** Главный экран пульта (раздел 1): 9 областей, тона и доклад собираются из ответа
 *  агрегатора детерминированно. Логика живёт в shared — здесь её единственные тесты. */

function snapshot(over: Partial<PultSnapshot> = {}): PultSnapshot {
  return {
    seesMoney: true,
    modulesOff: [],
    hero: {
      commission: { fact: 46_800, plan: 120_000, forecastPercent: 90 },
      leadsToday: { count: 9, deltaVsYesterday: 3 },
      firstResponse: { noneCountYesterday: 0 },
      missedCallsToday: 0,
      dealsInPipeline: { count: 23 },
    },
    team: { agents: [{ pendingAccept: 0 }, { pendingAccept: 2 }] },
    calls: { live: { incoming: [1], outgoing: [] }, today: { incoming: 27, missed: 0, unqualified: 0 } },
    bot: { ai: { requestsToday: 312, errorRatePercent: 1 }, unresolvedFindings: 0 },
    marketing: { instagramCommentsWaiting: 0, funnel: [{ label: "Instagram", leadsToday: 6, anomalyLeadsDown: false }] },
    video: { pipeline: { overdue: 0 } },
    properties: { available: 212, newThisWeek: 5, reserved: 3 },
    system: { crons: [{ healthy: true }, { healthy: true }], jobsGivenUp: 0, errorsToday: 0 },
    ...over,
  };
}

describe("plural", () => {
  it("склоняет по-русски", () => {
    expect(plural(1, "дело", "дела", "дел")).toBe("дело");
    expect(plural(3, "дело", "дела", "дел")).toBe("дела");
    expect(plural(11, "дело", "дела", "дел")).toBe("дел");
    expect(plural(21, "дело", "дела", "дел")).toBe("дело");
  });
});

describe("buildPultView", () => {
  it("хороший день: 9 областей, всё зелёное, срочных нет", () => {
    const v = buildPultView(snapshot(), 13);
    expect(v.areas.map((a) => a.id)).toEqual(["clients", "team", "money", "properties", "calls", "ads", "bot", "deals", "system"]);
    expect(v.urgentCount).toBe(0);
    expect(v.areas.find((a) => a.id === "team")?.tone).toBe("warn"); // 2 лида ждут принятия
    expect(v.areas.find((a) => a.id === "system")?.big).toBe("Без сбоев");
    expect(v.report.title).toBe("Вот темп дня.");
    expect(v.report.text).toContain("9 новых клиентов, на 3 больше, чем вчера");
    expect(v.report.text).toContain("Срочного ничего нет");
    expect(v.report.text).toContain("на 90 % плана");
  });

  it("срочное красным: пропущенные звонки и клиенты без ответа считаются в кольце и в докладе", () => {
    const v = buildPultView(
      snapshot({
        hero: {
          commission: null,
          leadsToday: { count: 1, deltaVsYesterday: -2 },
          firstResponse: { noneCountYesterday: 4 },
          missedCallsToday: 2,
          dealsInPipeline: { count: 5 },
        },
        calls: { live: { incoming: [], outgoing: [] }, today: { incoming: 10, missed: 2, unqualified: 1 } },
      }),
      9
    );
    expect(v.areas.find((a) => a.id === "clients")?.tone).toBe("crit");
    expect(v.areas.find((a) => a.id === "calls")?.line).toBe("2 пропущенных сегодня");
    expect(v.urgentCount).toBe(2);
    expect(v.areas.some((a) => a.id === "money")).toBe(false); // комиссии нет
    expect(v.report.title).toBe("Вот что было вчера и ночью.");
    expect(v.report.text).toContain("1 новый клиент, на 2 меньше, чем вчера");
    expect(v.report.text).toContain("2 дела ждут вас");
    expect(v.report.text).toContain("Пропущенных звонков сегодня: 2");
  });

  it("выключенный модуль и секция с ошибкой не дают плитки; деньги скрыты без права", () => {
    const v = buildPultView(
      snapshot({ seesMoney: false, modulesOff: ["calls", "system"], bot: { error: true } }),
      19
    );
    const ids = v.areas.map((a) => a.id);
    expect(ids).not.toContain("calls");
    expect(ids).not.toContain("system");
    expect(ids).not.toContain("bot");
    expect(ids).not.toContain("money");
    expect(v.report.title).toBe("Вот итог дня.");
    expect(v.report.text).not.toContain("плана");
  });

  it("реклама: канал с просадкой — жёлтым, объекты с просрочкой в конвейере — красным", () => {
    const v = buildPultView(
      snapshot({
        marketing: { instagramCommentsWaiting: 0, funnel: [{ label: "Facebook", leadsToday: 0, anomalyLeadsDown: true }] },
        video: { pipeline: { overdue: 3 } },
      }),
      12
    );
    expect(v.areas.find((a) => a.id === "ads")).toMatchObject({ tone: "warn", line: "Facebook даёт меньше обычного" });
    expect(v.areas.find((a) => a.id === "properties")).toMatchObject({ tone: "crit", line: "3 объекта застряли в подготовке" });
  });
});
