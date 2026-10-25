import { beforeEach, describe, expect, it, vi } from "vitest";
import { clientPhoneSelectionTokens, resolveClientPhoneSelection } from "../src/lib/clientPhoneSelection.js";
import { maskClientPhone } from "../src/lib/clientPhone.js";
describe("opaque phone selection", () => {
  beforeEach(() => vi.stubEnv("JWT_ACCESS_SECRET", "isolated-phone-selection-test-secret"));
  const client = { id: "client-one", phone: "+992900000001", extraPhones: ["+992911111157", "+992922222257"] };
  it("selects the intended number despite identical masks without exposing digits", () => {
    expect(maskClientPhone(client.extraPhones[0])).toBe(maskClientPhone(client.extraPhones[1]));
    const keys = clientPhoneSelectionTokens(client);
    expect(resolveClientPhoneSelection(client, { phoneKey: keys["extra-1"] })).toEqual({ phone: client.extraPhones[1] });
    expect(JSON.stringify(keys)).not.toContain("922222257");
    expect(resolveClientPhoneSelection(client, { phone: maskClientPhone(client.extraPhones[0]) })).toEqual({ conflict: true });
  });
  it("rejects reorder with the same mask and cross-client replay", () => {
    const keys = clientPhoneSelectionTokens(client);
    expect(resolveClientPhoneSelection({ ...client, extraPhones: [...client.extraPhones].reverse() }, { phoneKey: keys["extra-1"] })).toEqual({ conflict: true });
    expect(resolveClientPhoneSelection({ ...client, id: "other" }, { phoneKey: keys["extra-1"] })).toEqual({ conflict: true });
  });
  it("never falls back from invalid supplied token to a phone", () => {
    expect(resolveClientPhoneSelection(client, { phoneKey: "tampered", phone: client.phone })).toEqual({ conflict: true });
    expect(resolveClientPhoneSelection(client, {})).toEqual({ phone: undefined });
  });
  it("keeps legacy selection working when two slots contain the same complete number", () => {
    const same = { ...client, whatsappPhone: "+992 900 000 001", extraPhones: [] };
    const result = resolveClientPhoneSelection(same, { phone: maskClientPhone(same.phone) });
    expect("conflict" in result).toBe(false);
    expect(result.phone?.replace(/\D/g, "")).toBe("992900000001");
  });
});
