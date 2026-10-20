import { Prisma } from "../generated/prisma/client.js";
import type { TxClient } from "../db.js";

/** Match legacy UPDATE → inquiry-trigger order while both binaries coexist.
 * This is a local transaction lock on a server-selected ID, not authorization. */
export async function lockCustomerNative(tx: Pick<TxClient, "$queryRaw">,
  target: { kind: "bot" | "telegram" | "telegram_direct"; id: string }): Promise<boolean> {
  const table = target.kind === "bot" ? Prisma.sql`"BotConversation"`
    : target.kind === "telegram" ? Prisma.sql`"TelegramConversation"` : Prisma.sql`"TelegramDirectConversation"`;
  const rows = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`SELECT "id" FROM ${table} WHERE "id" = ${target.id} FOR UPDATE`);
  return rows.length === 1;
}
