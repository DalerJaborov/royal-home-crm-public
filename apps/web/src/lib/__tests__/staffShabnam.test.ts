import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { canManageStaffShabnam, samePersonAccounts } from "../staffShabnam";

const ROLES = ["AGENT", "MARKETING", "EDITOR", "SECURITY", "HEAD_OF_SALES", "SHAREHOLDER", "MANAGER", "ADMIN", "DIRECTOR"] as const;
const here = path.dirname(fileURLToPath(import.meta.url));

describe("Шабнам: кто видит привязку Telegram (живой случай 25.11.2026: РОП не видела блок)", () => {
  it("в Profile.tsx блок не спрятан за отдельным условием роли ни в одной из вёрсток (класс: три копии условия)", () => {
    const src = fs.readFileSync(path.resolve(here, "../../pages/Profile.tsx"), "utf8");
    const renders = [...src.matchAll(/([^\n]{0,160})<TelegramLinkSection \/>/g)].map((m) => m[1]!);
    expect(renders.length).toBeGreaterThanOrEqual(3);
    for (const before of renders) {
      expect(before).toContain("canSeeTelegramLink(profile)");
      expect(before).not.toMatch(/role\s*===|isVideoMontajer|properties\.moderate/);
    }
  });

  it("ссылку подключения выдают только директор и администратор", () => {
    expect(ROLES.filter((r) => canManageStaffShabnam(r))).toEqual(["ADMIN", "DIRECTOR"]);
    expect(canManageStaffShabnam(undefined)).toBe(false);
  });
});

describe("«Это тот же человек» видно с обеих сторон", () => {
  const all = [
    { id: "agent", samePersonAgentId: null },
    { id: "rop", samePersonAgentId: "agent" },
    { id: "other", samePersonAgentId: null },
    { id: "self", samePersonAgentId: "self" },
  ];
  it("связь, записанная на одной учётке, показывается и на второй", () => {
    expect(samePersonAccounts(all[1]!, all).map((a) => a.id)).toEqual(["agent"]);
    expect(samePersonAccounts(all[0]!, all).map((a) => a.id)).toEqual(["rop"]);
    expect(samePersonAccounts(all[2]!, all)).toEqual([]);
  });
  it("учётка не бывает «тем же человеком» сама себе", () => {
    expect(samePersonAccounts(all[3]!, all)).toEqual([]);
  });
});
