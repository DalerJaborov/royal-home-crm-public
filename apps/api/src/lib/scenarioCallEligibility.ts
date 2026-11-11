import { robotCallStoredStopReason } from "./robotCallPolicy.js";

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

/**
 * Причина, по которой звонить нельзя, или `null`, если можно. Только записанные в базе
 * запреты: чёрный список станции спрашивает дверь перед набором (ревью П3 — без второго
 * похода в AMI), её окончательный отказ сценарий закрывает причиной по `policyCode`.
 */
export async function scenarioCallBlockReason(target: ScenarioCallTarget): Promise<ScenarioCallBlock | null> {
  return (await robotCallStoredStopReason(target)) ? "do_not_contact" : null;
}

/** Окончательный отказ двери → причина записи сценария; `null` — отказ не окончательный. */
export function scenarioBlockFromPolicy(result: { busy?: boolean; policyCode?: string }): ScenarioCallBlock | null {
  if (result.busy || !result.policyCode) return null;
  if (result.policyCode === "blacklisted") return "blacklisted";
  if (result.policyCode === "stopped" || result.policyCode === "opted_out") return "do_not_contact";
  return null;
}
