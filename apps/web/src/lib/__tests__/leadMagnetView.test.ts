import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { journalTotals, resolveEditingCampaign } from "../leadMagnetView";

const camp = (id: string, failed: number, extra: Record<string, unknown> = {}) => ({
  id,
  fileName: null as string | null,
  stats: { invited: 5, awaitingFollow: 1, delivered: 4, failed },
  ...extra,
});

describe("WEB-PAGES15: счётчики журнала одной кампании", () => {
  const campaigns = [camp("A", 0), camp("B", 10)];

  it("журнал кампании A: «Не дошло» = 0, а не 10", () => {
    expect(journalTotals(campaigns, "A").failed).toBe(0);
    expect(journalTotals(campaigns, "A").invited).toBe(5);
  });

  it("журнал «Все» и закрытый считают по всем кампаниям", () => {
    expect(journalTotals(campaigns, "all").failed).toBe(10);
    expect(journalTotals(campaigns, null).failed).toBe(10);
    expect(journalTotals(campaigns, "all").invited).toBe(10);
  });

  it("кампании уже нет в списке: нули", () => {
    expect(journalTotals(campaigns, "Z")).toEqual({ invited: 0, awaitingFollow: 0, delivered: 0, failed: 0 });
  });
});

describe("WEB-PAGES14: свежая кампания в открытом редакторе", () => {
  it("после загрузки PDF редактор видит новое имя файла из перечитанного списка", () => {
    const opened = camp("A", 0);
    const refreshed = [camp("A", 0, { fileName: "new.pdf" })];
    expect(resolveEditingCampaign({ campaign: opened }, refreshed)?.fileName).toBe("new.pdf");
  });

  it("после удаления PDF файла в редакторе больше нет", () => {
    const opened = camp("A", 0, { fileName: "old.pdf" });
    expect(resolveEditingCampaign({ campaign: opened }, [camp("A", 0)])?.fileName).toBeNull();
  });

  it("свежей копии ещё нет в списке или список не загружен: остаётся снимок", () => {
    const copy = camp("N", 0);
    expect(resolveEditingCampaign({ campaign: copy }, [camp("A", 0)])).toBe(copy);
    expect(resolveEditingCampaign({ campaign: copy }, undefined)).toBe(copy);
  });

  it("новая кампания и закрытый редактор: null", () => {
    expect(resolveEditingCampaign({ campaign: null }, [camp("A", 0)])).toBeNull();
    expect(resolveEditingCampaign(null, [camp("A", 0)])).toBeNull();
  });
});

describe("WEB-PAGES13/14/15: оба экрана, десктоп и телефон, используют общую логику", () => {
  const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
  it.each([["../../pages/settings/FunnelTab.tsx"], ["../../components/mobile/MobileFunnel.tsx"]])("%s", (rel) => {
    const src = read(rel);
    expect(src).toContain("journalTotals(");
    expect(src).toContain("resolveEditingCampaign(");
    expect(src).toContain("useToggleLeadMagnetEnabled");
    // тумблер больше не шлёт весь снимок кампании
    expect(src).not.toContain("...input, enabled: !campaign.enabled");
  });
});
