import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { clientPhoneHash, presentExtraPhoneOrigins } from "../src/lib/clientPhoneOrigins.js";
const ids: string[] = [];
afterAll(async () => { await prisma.client.deleteMany({ where: { id: { in: ids } } }); });
describe("future-only extra phone origins", () => {
  it("uses full digits and never exposes internal hashes or hidden origin", () => {
    expect(clientPhoneHash("+1 123456789")).not.toBe(clientPhoneHash("+992 123456789"));
    const phones = ["+992 123456789", "+1 123456789"];
    const result = presentExtraPhoneOrigins(phones, [{ phoneHash: clientPhoneHash(phones[0]), addedAt: new Date("2026-10-25T01:00:00Z"), source: "MANUAL" }], false);
    expect(result).toEqual([{ index: 0, addedAt: "2026-10-25T01:00:00.000Z" }, { index: 1, addedAt: null }]);
    expect(JSON.stringify(result)).not.toContain("phoneHash"); expect(JSON.stringify(result)).not.toContain("source");
  });
  it("captures insertion, skips formatting and legacy unchanged values, resets re-addition", async () => {
    const oldPhone = "+992911111111", newPhone = "+1911111111";
    const client = await prisma.client.create({ data: { fullName: "Synthetic phone provenance", phone: `origin-${crypto.randomUUID()}`, source: "WALK_IN", extraPhones: [oldPhone] } }); ids.push(client.id);
    expect(await prisma.clientPhoneOrigin.count({ where: { clientId: client.id } })).toBe(1);
    // Simulates a row that existed before this forward-only migration.
    await prisma.clientPhoneOrigin.deleteMany({ where: { clientId: client.id } });
    await prisma.client.update({ where: { id: client.id }, data: { extraPhones: ["+992 91 111 11 11", newPhone] } });
    const rows = await prisma.clientPhoneOrigin.findMany({ where: { clientId: client.id } });
    expect(rows).toHaveLength(1); expect(rows[0].phoneHash).toBe(clientPhoneHash(newPhone)); expect(rows[0].source).toBe("UNKNOWN");
    await prisma.clientPhoneOrigin.update({ where: { id: rows[0].id }, data: { addedAt: new Date("2020-01-01"), source: "MANUAL" } });
    await prisma.client.update({ where: { id: client.id }, data: { extraPhones: [oldPhone] } });
    await prisma.client.update({ where: { id: client.id }, data: { extraPhones: [oldPhone, newPhone] } });
    const renewed = await prisma.clientPhoneOrigin.findUniqueOrThrow({ where: { id: rows[0].id } });
    expect(renewed.addedAt.getFullYear()).toBeGreaterThan(2020); expect(renewed.source).toBe("UNKNOWN");
  });
});
