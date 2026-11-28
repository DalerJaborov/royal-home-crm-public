import { describe, expect, it } from "vitest";
import { CLIENT_SOURCES, CLIENT_SOURCE_GROUPS, groupSourceRows, isAgentCreatedClientSource } from "@royal-home/shared";

describe("группы источников клиента", () => {
  it("каждый источник реестра входит ровно в одну группу", () => {
    const all = CLIENT_SOURCE_GROUPS.flatMap((g) => [...g.sources]);
    expect(new Set(all).size).toBe(all.length);
    expect([...all].sort()).toEqual([...CLIENT_SOURCES].sort());
  });

  it("сворачивает каналы в группы, пустые строки убирает, итог сходится", () => {
    const rows = [
      { source: "WHATSAPP", leads: 136, deals: 0, commission: 0 },
      { source: "INSTAGRAM", leads: 27, deals: 0, commission: 0 },
      { source: "FACEBOOK", leads: 17, deals: 0, commission: 0 },
      { source: "PHONE_CALL", leads: 37, deals: 0, commission: 0 },
      { source: "WALK_IN", leads: 13, deals: 0, commission: 0 },
      { source: "REFERRAL", leads: 2, deals: 1, commission: 10400 },
      { source: "WEBSITE", leads: 1, deals: 0, commission: 0 },
      { source: "OWN_CLIENT", leads: 0, deals: 0, commission: 0 },
    ];
    const g = groupSourceRows(rows);
    expect(g.map((x) => x.label)).toEqual(["Переписки", "Звонки", "Пришли в офис", "Рекомендации", "Сайт"]);
    expect(g[0]).toMatchObject({ leads: 180, deals: 0 });
    expect(g[0]!.parts.map((p) => p.label)).toEqual(["WhatsApp", "Instagram", "Facebook"]);
    expect(g.find((x) => x.key === "REFERRAL")).toMatchObject({ deals: 1, commission: 10400 });
    expect(g.reduce((s, x) => s + x.leads, 0)).toBe(rows.reduce((s, x) => s + x.leads, 0));
  });

  it("«Свой клиент» — отдельная группа, «Пришёл в офис» не смешивается с ним", () => {
    const g = groupSourceRows([
      { source: "OWN_CLIENT", leads: 3, deals: 1, commission: 500 },
      { source: "WALK_IN", leads: 2, deals: 0, commission: 0 },
    ]);
    expect(g.map((x) => x.key)).toEqual(["OWN", "OFFICE"]);
  });

  it("без права на деньги комиссия остаётся null; неизвестный источник не теряется", () => {
    const g = groupSourceRows([{ source: "VIBER", leads: 4, deals: 0, commission: null }]);
    expect(g).toEqual([expect.objectContaining({ key: "OTHER", label: "Другое", leads: 4, commission: null })]);
  });

  it("проверки «карточку завёл агент» видят и старый «офис», и новый «Свой клиент»", () => {
    expect(isAgentCreatedClientSource("WALK_IN")).toBe(true);
    expect(isAgentCreatedClientSource("OWN_CLIENT")).toBe(true);
    expect(isAgentCreatedClientSource("WHATSAPP")).toBe(false);
    expect(isAgentCreatedClientSource(null)).toBe(false);
  });
});
