import type { PropertyDraftView } from "@royal-home/shared";

/** Queue tests start with the GET/START handshake already completed. */
export async function adoptTestDraftSession(id = "00000000-0000-4000-8000-000000000001") {
  const { adoptPropertyDraftSession } = await import("../propertyDraftSession");
  const draft: PropertyDraftView = { id, revision: 1, values: {}, step: 0, media: [], updatedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 86400000).toISOString() };
  adoptPropertyDraftSession({ draft, revision: draft.revision });
}
