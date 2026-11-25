import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/** Номер WhatsApp агентства для ссылки wa.me запоминается сам из вебхука нашего номера (25.11.2026, lib/whatsappDisplayPhone.ts). */
vi.mock("../src/messengers/meta.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/messengers/meta.js")>()),
  loadCredentials: vi.fn(async () => ({ waPhoneId: "our-phone-id" })),
}));
const { prisma } = await import("../src/db.js");
const { rememberWhatsappDisplayPhoneFromWebhook, resetWhatsappDisplayPhoneCache } = await import("../src/lib/whatsappDisplayPhone.js");

const hook = (phoneId: string, display: string) => ({ object: "whatsapp_business_account",
  entry: [{ id: "waba", changes: [{ value: { metadata: { phone_number_id: phoneId, display_phone_number: display } } }] }] });
const stored = async () => (await prisma.settings.findUniqueOrThrow({ where: { id: "singleton" }, select: { metaWaDisplayPhone: true } })).metaWaDisplayPhone;
let before: string | null = null;

beforeEach(async () => {
  before ??= await stored();
  resetWhatsappDisplayPhoneCache();
  await prisma.settings.update({ where: { id: "singleton" }, data: { metaWaDisplayPhone: null } });
});
afterAll(async () => { await prisma.settings.update({ where: { id: "singleton" }, data: { metaWaDisplayPhone: before } }); });

describe("номер WhatsApp агентства из вебхука", () => {
  it("наш номер — записывается цифрами; сменили у Meta — перезаписывается", async () => {
    await rememberWhatsappDisplayPhoneFromWebhook(hook("our-phone-id", "+992 44 650 1414"), ["our-phone-id"]);
    expect(await stored()).toBe("992446501414");
    resetWhatsappDisplayPhoneCache();
    await rememberWhatsappDisplayPhoneFromWebhook(hook("our-phone-id", "+992 90 000 0000"), ["our-phone-id"]);
    expect(await stored()).toBe("992900000000");
  });
  it("чужой номер приложения (песочница), не WhatsApp, мусор вместо номера — не трогаем", async () => {
    await rememberWhatsappDisplayPhoneFromWebhook(hook("sandbox-id", "+1 555 000 0000"), ["our-phone-id", "sandbox-id"]);
    await rememberWhatsappDisplayPhoneFromWebhook({ object: "instagram", entry: [] }, ["our-phone-id"]);
    await rememberWhatsappDisplayPhoneFromWebhook(hook("our-phone-id", "test"), ["our-phone-id"]);
    expect(await stored()).toBeNull();
  });
});
