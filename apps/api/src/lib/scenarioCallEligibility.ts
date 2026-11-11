import { robotCallStopReason } from "./robotCallPolicy.js";

/**
 * КОМУ СЦЕНАРНЫЙ ЗВОНОК РОБОТА НАБИРАТЬ НЕЛЬЗЯ — ОБЁРТКА НАД ОДНОЙ ДВЕРЬЮ.
 *
 * С 02.10.2026 (аудит звонков робота, А4) здесь жили две проверки: «не беспокойте» в
 * переписке и чёрный список станции. С 11.11.2026 (П3) обе — и третья, отметка «Не
 * звонить роботом» (RobotCallStop), — живут в lib/robotCallPolicy.ts, и ту же проверку
 * мост живого голоса делает сам перед каждым набором. Этот файл остался, чтобы опрос
 * после показа и проверка продавца по-прежнему могли ЗАРАНЕЕ закрыть запись причиной
 * (`markPostShowingCallSkipped`), не дожидаясь отказа моста.
 *
 * Причины прежние: отметка «не звонить» отдаётся как `do_not_contact` — для записи
 * сценария это одно и то же «человек просил не беспокоить».
 */

export { BLACKLIST_CHECK_TIMEOUT_MS, hasOptedOutOfContact, isOnStationBlacklist } from "./robotCallPolicy.js";

export type ScenarioCallBlock = "do_not_contact" | "blacklisted";

/** Что известно о том, кому звоним: любое из полей сужает поиск отметки «не беспокойте». */
export interface ScenarioCallTarget {
  phone: string;
  /** Карточка клиента (покупатель, собственник). */
  clientId?: string | null;
  /** Диалог бота, из которого пришёл человек (у кандидата — `JobApplication.conversationId`). */
  conversationId?: string | null;
  /** Досье собеседника. */
  contactProfileId?: string | null;
}

/** Причина, по которой звонить нельзя, или `null`, если можно. */
export async function scenarioCallBlockReason(target: ScenarioCallTarget): Promise<ScenarioCallBlock | null> {
  const reason = await robotCallStopReason(target);
  if (reason === "blacklisted") return "blacklisted";
  return reason ? "do_not_contact" : null;
}
