import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CustomerTransportReference } from "../src/lib/customerConversationScope.js";

const fixture = vi.hoisted(() => ({
  readTransport: vi.fn(), sendText: vi.fn(), sendAudio: vi.fn(), sendImage: vi.fn(), sendVideo: vi.fn(),
  append: vi.fn(), update: vi.fn(), transcribe: vi.fn(), upload: vi.fn(),
}));
vi.mock("../src/loadEnv.js", () => ({}));
vi.mock("../src/db.js", async importOriginal => {
  const original = await importOriginal<typeof import("../src/db.js")>();
  return { ...original, prisma: {
  $disconnect: () => original.prisma.$disconnect(),
  botConversation: { findUnique: vi.fn(async () => ({ pausedUntil: null, clientId: null })), update: fixture.update },
} }; });
vi.mock("../src/lib/customerConversationScope.js", async importOriginal => ({
  ...(await importOriginal<typeof import("../src/lib/customerConversationScope.js")>()),
  loadCustomerTransportForConversation: fixture.readTransport,
  customerTransportInput: vi.fn(), findScopedBotConversation: vi.fn(),
}));
vi.mock("../src/messengers/meta.js", async importOriginal => ({
  ...(await importOriginal<typeof import("../src/messengers/meta.js")>()),
  asMetaChannel: (channel: string) => channel,
  isMetaChannelEnabled: async () => true,
  sendMessage: fixture.sendText, sendAudio: fixture.sendAudio, sendImage: fixture.sendImage, sendVideo: fixture.sendVideo,
}));
vi.mock("../src/messengers/appendMessages.js", async importOriginal => ({
  ...(await importOriginal<typeof import("../src/messengers/appendMessages.js")>()),
  appendConversationMessages: fixture.append, appendTelegramConversationMessages: fixture.append,
}));
vi.mock("../src/ai/transcribe.js", async importOriginal => ({
  ...(await importOriginal<typeof import("../src/ai/transcribe.js")>()), transcribeAudio: fixture.transcribe,
}));
vi.mock("../src/lib/outgoingMedia.js", async importOriginal => ({
  ...(await importOriginal<typeof import("../src/lib/outgoingMedia.js")>()), uploadOutgoingMedia: fixture.upload,
}));

import { deliverToConversation, deliverVoiceToConversation, deliverMediaToConversation } from "../src/lib/conversationDelivery.js";

const reference: CustomerTransportReference = { channel: "WHATSAPP", accountId: null,
  endpointScopeId: "fixture-settings-scope", transportKey: "settings:WHATSAPP:fixture-resource",
  accountExternalId: "fixture-resource", scopeRevision: "4" };
const target = { kind: "bot" as const, id: "fixture-native", channel: "WHATSAPP", subscriberId: "fixture-peer", transport: reference };

beforeEach(() => {
  vi.clearAllMocks(); fixture.readTransport.mockResolvedValue(reference);
  fixture.sendText.mockResolvedValue("fixture-mid"); fixture.append.mockResolvedValue(undefined);
});

describe("delivery captures authorized native transport before expensive work", () => {
  it("passes the captured Settings resource to the actual text transport boundary", async () => {
    expect(await deliverToConversation(target, "Здравствуйте")).toMatchObject({ ok: true });
    expect(fixture.readTransport).toHaveBeenCalledWith(target.id);
    expect(fixture.sendText).toHaveBeenCalledWith("WHATSAPP", target.subscriberId, "Здравствуйте", undefined,
      { origin: "bot", transport: reference });
    expect(fixture.append).toHaveBeenCalledTimes(1);
  });

  it("holds a reference revoked by a same-resource credential revision before pause or ASR/upload", async () => {
    fixture.readTransport.mockResolvedValue({ ...reference, scopeRevision: "6" });
    const results = await Promise.all([
      deliverToConversation(target, "Здравствуйте", undefined, { sender: { kind: "agent", agentId: "fixture-agent" } }),
      deliverVoiceToConversation(target, { buffer: Buffer.from("fixture") },
        { sender: { kind: "agent", agentId: "fixture-agent" }, clientId: null, clientName: null }),
      deliverMediaToConversation(target, { buffer: Buffer.from("fixture"), mimetype: "image/jpeg" },
        { sender: { kind: "agent", agentId: "fixture-agent" } }),
    ]);
    for (const result of results) expect(result).toMatchObject({ ok: false, status: 409 });
    for (const effect of [fixture.update, fixture.transcribe, fixture.upload, fixture.sendText, fixture.sendAudio,
      fixture.sendImage, fixture.sendVideo, fixture.append]) expect(effect).not.toHaveBeenCalled();
  });

  it("does not substitute the current default for an unmapped native conversation", async () => {
    fixture.readTransport.mockResolvedValue(null);
    expect(await deliverToConversation({ ...target, transport: undefined }, "Здравствуйте")).toMatchObject({ ok: false, status: 409 });
    expect(fixture.sendText).not.toHaveBeenCalled(); expect(fixture.append).not.toHaveBeenCalled();
  });

  it("rejects a stored scope rebind even if the new resource has the same revision number", async () => {
    fixture.readTransport.mockResolvedValue({ ...reference, endpointScopeId: "another-scope", transportKey: "settings:WHATSAPP:other-resource" });
    expect(await deliverToConversation(target, "Здравствуйте")).toMatchObject({ ok: false, status: 409 });
    expect(fixture.sendText).not.toHaveBeenCalled();
  });
});
