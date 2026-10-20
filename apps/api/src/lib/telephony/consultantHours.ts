import { isDayOff } from "@royal-home/shared";
import { CLIENT_HOURS, isClientWorkingTime } from "../../ai/agencyFacts.js";
import { loadCompanyDaysOff } from "../daysOffCalendar.js";
import { isWithinWorkingHours } from "../workingHours.js";

/**
 * РАБОЧЕЕ ВРЕМЯ КОНСУЛЬТАНТА — С УЧЁТОМ ВЫХОДНЫХ ИЗ НАСТРОЕК (владелец 11.10.2026).
 *
 * `isWithinWorkingHours` знает только окно «ЧЧ:ММ–ЧЧ:ММ» из Настроек. До 11.10 здесь
 * сверху стояло зашитое воскресенье (третий аудит робота 02.10.2026, п.4); теперь
 * выходные — данные: общие (Settings.companyDaysOff) и, если передан, личные агента
 * (Agent.weeklyDaysOff). Пустые списки — выходных нет, окно часов действует каждый день.
 *
 * Агент в СВОЙ выходной недоступен, даже если компания работает: робот не обещает
 * «соединяю», не ставит на этот день показ и перезвон (liveVoiceClientTools.ts,
 * liveVoiceTransfer.ts).
 */
export async function isWithinConsultantHours(at: Date = new Date(), agentDaysOff?: readonly number[] | null): Promise<boolean> {
  const companyDaysOff = await loadCompanyDaysOff();
  if (isDayOff(at, { companyDaysOff, agentDaysOff })) return false;
  // Часы для клиентов — один флаг на оба бота (ai/agencyFacts.ts::CLIENT_HOURS, 10.10.2026).
  // По умолчанию это окно раздачи — то же, что isWithinWorkingHours.
  if (CLIENT_HOURS !== "leadWindow") return isClientWorkingTime(at, CLIENT_HOURS, agentDaysOff);
  return isWithinWorkingHours(at);
}
