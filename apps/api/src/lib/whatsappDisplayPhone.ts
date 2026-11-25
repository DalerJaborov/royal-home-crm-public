/**
 * НОМЕР WHATSAPP АГЕНТСТВА — ЗАПОМИНАЕТСЯ САМ (25.11.2026). Нужен ссылке wa.me, которую бот даёт в Instagram и Facebook
 * (ai/operator/contactButton.ts): номер не зашит в код и владельцу не нужно его вписывать. Каждый вебхук WhatsApp несёт
 * `metadata.display_phone_number` номера, на который пришло событие; берём только основной номер из Настроек (или
 * единственный наш), пишем в `Settings.metaWaDisplayPhone` при изменении. Дальше — память процесса, база не трогается.
 */
import { prisma } from "../db.js";
import { loadCredentials } from "../messengers/meta.js";
import { describeError } from "./describeError.js";

let known: string | null = null;

/** Для тестов: забыть запомненное. */
export function resetWhatsappDisplayPhoneCache(): void { known = null; }

export async function rememberWhatsappDisplayPhoneFromWebhook(body: unknown, ourPhoneIds: string[] | undefined): Promise<void> {
  try {
    const payload = body as { object?: string; entry?: { changes?: { value?: { metadata?: { phone_number_id?: unknown; display_phone_number?: unknown } } }[] }[] } | null;
    if (payload?.object !== "whatsapp_business_account" || !ourPhoneIds?.length) return;
    // Один номер у приложения (как сейчас на проде) — он и есть основной, лишнего чтения Настроек на каждый вебхук нет.
    const main = ourPhoneIds.length === 1 ? ourPhoneIds[0] : (await loadCredentials()).waPhoneId;
    if (!main) return;
    for (const entry of payload.entry ?? []) {
      for (const change of entry.changes ?? []) {
        const meta = change.value?.metadata;
        if (String(meta?.phone_number_id ?? "") !== main || typeof meta?.display_phone_number !== "string") continue;
        const digits = meta.display_phone_number.replace(/\D/gu, "");
        if (!/^\d{9,15}$/u.test(digits) || digits === known) return;
        // Пустое поле или другой номер (номер у Meta сменили) — записать; тот же — строка не трогается.
        await prisma.settings.updateMany({ where: { id: "singleton", OR: [{ metaWaDisplayPhone: null }, { metaWaDisplayPhone: { not: digits } }] },
          data: { metaWaDisplayPhone: digits } });
        known = digits;
        return;
      }
    }
  } catch (err) {
    console.error("[whatsapp] номер агентства из вебхука не записан:", describeError(err));
  }
}
