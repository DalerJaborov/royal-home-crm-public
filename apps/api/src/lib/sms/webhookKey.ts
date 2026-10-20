import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Секрет в адресе вебхука Payom. Подписи у их вебхуков нет, поэтому чужой
 * «доставлено» отсекается только тем, что адрес знает один Payom: мы сами
 * передаём его в каждой отправке.
 *
 * Выводится из SETTINGS_ENCRYPTION_KEY, а не хранится отдельно: без этого ключа
 * CRM всё равно не расшифрует токен и ни одного СМС не отправит, а новый секрет
 * в .env — лишняя строка, которую забудут на выкате. Смена ключа меняет адрес,
 * и старые СМС теряют только поздние статусы доставки — сами СМС не страдают.
 */
export function payomWebhookKey(): string {
  const secret = process.env.SETTINGS_ENCRYPTION_KEY ?? "";
  if (!secret) throw new Error("SETTINGS_ENCRYPTION_KEY не задан — адрес вебхука СМС не собрать");
  return createHmac("sha256", secret).update("payom-sms-webhook").digest("hex").slice(0, 40);
}

export function isPayomWebhookKey(candidate: string): boolean {
  let expected: string;
  try {
    expected = payomWebhookKey();
  } catch {
    return false;
  }
  const a = Buffer.from(candidate);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
