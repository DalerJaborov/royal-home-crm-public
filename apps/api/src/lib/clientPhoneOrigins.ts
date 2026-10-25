import { createHash } from "node:crypto";
/** Mirrors the future-only DB trigger. Never expose this unsalted internal hash. */
export function clientPhoneHash(phone: string): string {
  return createHash("md5").update(phone.replace(/[^0-9]/g, "")).digest("hex");
}
export function presentExtraPhoneOrigins(phones: string[], rows: Array<{ phoneHash: string; addedAt: Date; source: string }>, canSeeOrigin: boolean) {
  const lookup = new Map(rows.map((row) => [row.phoneHash, row]));
  return phones.map((phone, index) => {
    const row = lookup.get(clientPhoneHash(phone));
    return { index, addedAt: row?.addedAt.toISOString() ?? null,
      ...(canSeeOrigin ? { source: row?.source === "MANUAL" ? "Добавлен сотрудником" : row?.source === "CONVERSATION" ? "Подтверждён в переписке" : row?.source === "CALL" ? "Подтверждён в разговоре" : "Источник не установлен" } : {}),
    };
  });
}
