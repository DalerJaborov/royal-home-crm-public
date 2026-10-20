import { afterEach, expect, it, vi } from "vitest";
import { withCustomerOutboxDeliveryTrace, withCustomerPublicDeliveryTrace } from "../src/lib/customerAgentDeliveryTrace.js";
import * as outbox from "../src/lib/customerOutbox.js";
import { prisma } from "../src/db.js";
import type { PublicCommentPrincipal } from "../src/lib/publicCommentSourceIssuer.js";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
it("trace OFF adds no metadata queries and preserves the exact single dispatcher result", async () => {
  vi.stubEnv("BOT_TURN_TRACE_ENABLED", "0");
  const read = vi.spyOn(outbox, "readCustomerOutboxPart"), ticket = vi.spyOn(prisma.customerPropertyIngressTicket, "findUnique");
  const result = { status: "unknown" as const }, dispatch = vi.fn(async () => result);
  expect(await withCustomerOutboxDeliveryTrace("synthetic-part", dispatch)).toBe(result);
  expect(dispatch).toHaveBeenCalledTimes(1); expect(read).not.toHaveBeenCalled(); expect(ticket).not.toHaveBeenCalled();
});
it("diagnostic read failure omits correlation and never retries a throwing business dispatcher", async () => {
  vi.stubEnv("BOT_TURN_TRACE_ENABLED", "1"); vi.stubEnv("BOT_TURN_TRACE_HMAC_KEY", "synthetic-original-delivery-trace-key-0000000");
  const read = vi.spyOn(outbox, "readCustomerOutboxPart").mockRejectedValueOnce(new Error("PRIVATE_METADATA_ERROR"));
  const diagnostic = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const failure = new Error("Actual business delivery failure"), dispatch = vi.fn(async () => { throw failure; });
  await expect(withCustomerOutboxDeliveryTrace("synthetic-part", dispatch)).rejects.toBe(failure);
  expect(read).toHaveBeenCalledTimes(1); expect(dispatch).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(diagnostic.mock.calls)).not.toContain("PRIVATE_METADATA_ERROR");
});
it("trace OFF public wrapper does not inspect a principal or reinterpret a real provider error", async () => {
  vi.stubEnv("BOT_TURN_TRACE_ENABLED", "0");
  const failure = new Error("Actual public provider timeout"), send = vi.fn(async () => { throw failure; });
  await expect(withCustomerPublicDeliveryTrace({} as PublicCommentPrincipal, send)).rejects.toBe(failure);
  expect(send).toHaveBeenCalledTimes(1);
});
