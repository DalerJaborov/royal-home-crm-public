import { createHash } from "node:crypto";

/**
 * КЛЮЧ РЕПЛИКИ КЛИЕНТА, НА КОТОРУЮ ОТВЕЧАЕТ ХОД (вынесено из customerChannelCore.ts 25.11.2026).
 *
 * Чистая функция без импортов: ею считают и прогоны ядра на одну реплику (customerChannelCore.ts, счёт
 * `channel-core-run`), и потолок фонового повтора ответа (jobs/aiReplyRetryCap.ts). Задание повтора не
 * должно тянуть за собой граф ядра ради одной строки.
 *
 * Последняя реплика клиента — её время (или место в истории, если времени нет) и отпечаток слов; null — реплики клиента нет.
 */
export function channelCoreMessageKey(messages: unknown): string | null {
  if (!Array.isArray(messages)) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const item = messages[i] as { role?: unknown; content?: unknown; at?: unknown } | null;
    if (!item || item.role !== "user") continue;
    const digest = createHash("sha256").update(typeof item.content === "string" ? item.content : "").digest("hex").slice(0, 16);
    return typeof item.at === "string" && item.at ? `a${item.at}:${digest}` : `i${i}:${digest}`;
  }
  return null;
}
