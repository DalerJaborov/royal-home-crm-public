import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readKindParam } from "../clientsKindParam";

/** Аудит 04.10.2026, WEB-PAGES06: «Новые» в воронке показывали 3, а список открывал одного покупателя. */
const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

describe("?kind= на странице клиентов", () => {
  it("BUYER и SELLER сужают, all снимает срез, остальное игнорируется", () => {
    expect(readKindParam("SELLER")).toEqual({ sectionKind: "SELLER", allKinds: false });
    expect(readKindParam("BUYER")).toEqual({ sectionKind: "BUYER", allKinds: false });
    expect(readKindParam("all")).toEqual({ sectionKind: null, allKinds: true });
    expect(readKindParam(null)).toEqual({ sectionKind: null, allKinds: false });
    expect(readKindParam("junk")).toEqual({ sectionKind: null, allKinds: false });
  });
});

describe("воронка лидов и список клиентов", () => {
  it("ссылка «Новые» ведёт на оба вида", () => {
    expect(read("../../pages/LeadFunnel.tsx")).toContain("/clients?status=${stage.status}&kind=all");
  });

  it("список клиентов не передаёт kind серверу при ?kind=all (запрос, ключ накопления, подпись вида)", () => {
    const src = read("../../pages/Clients.tsx");
    expect(src).toContain("readKindParam(");
    expect(src.match(/\|\| allKinds/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
  });
});
