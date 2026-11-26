import { automationSwitchOn } from "./automationSwitches.js";
import { loadLeadOnlyConfig } from "./leadOnlyConfig.js";
import { staffWroteRecently } from "./operatorTurn.js";
import { WEBSITE_CHANNEL } from "../messengers/channels.js";

/**
 * БОТ УСТУПАЕТ ЖИВОМУ СОТРУДНИКУ В ЧАТЕ САЙТА И В TELEGRAM (владелец 27.11.2026, после снятия автопаузы при ответе).
 *
 * Раньше ответ сотрудника ставил бота на паузу, и бот не отвечал поверх человека. Рубильник
 * `botPauseOnStaffReplyEnabled` (по умолчанию выкл) пауза снимает, и в WhatsApp, Instagram и Facebook бот уступает сам:
 * режим «только заявки» молчит, пока сотрудник писал за последние `staffQuietMinutes` (ai/operator/decide.ts, staffActive).
 * Сайт и Telegram этот режим не ведёт, поэтому то же правило — здесь, одной проверкой на входе хода: сотрудник
 * (агент из CRM или ручной ответ) писал в этой переписке в пределах того же срока из Настроек — бот молчит, слова клиента
 * копятся в CRM, сотруднику идёт штатный пуш. Срок, источник «писал сотрудник» и запрос — общие с оператором
 * (lib/operatorTurn.ts::staffWroteRecently), копии логики нет.
 *
 * Рубильник включён (прежняя автопауза) — правило не действует: бота уже держит пауза. Сбой чтения — «нет»:
 * промолчать без причины хуже короткого ответа.
 */
export async function staffQuietActive(
  target: { kind: "bot" | "telegram"; id: string; channel?: string | null },
  now: Date = new Date()
): Promise<boolean> {
  if (target.kind === "bot" && target.channel !== WEBSITE_CHANNEL) return false;
  try {
    if (await automationSwitchOn("botPauseOnStaffReplyEnabled")) return false;
    const minutes = (await loadLeadOnlyConfig()).staffQuietMinutes ?? 180;
    return await staffWroteRecently(target.id, minutes, now, target.kind);
  } catch {
    return false;
  }
}
