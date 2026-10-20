/**
 * Мелкие константы, общие для incomingCalls.ts и autoLeadFromCall.ts.
 *
 * Вынесены в отдельный лист БЕЗ импортов (аудит циклов 03.09.2026): раньше
 * autoLeadFromCall.ts брал SERVICE_NUMBER_IRRELEVANT_MARKS прямо из
 * incomingCalls.ts, а сам incomingCalls.ts (через dutyRosterRouting →
 * callTracker → callRecordings → autoLeadFromCall) в конце концов приходил
 * обратно к себе — цикл импортов, из-за которого CI годами не может пройти
 * "Dependency rules". Поведение не меняется: incomingCalls.ts продолжает
 * реэкспортировать константу под тем же именем, чтобы ничего стороннего не
 * задеть.
 */

/**
 * Сколько раз номер должен быть помечен «не по делу», чтобы считаться служебным
 * (курьер, реклама, автообзвон) и больше не получать карточку.
 *
 * Двойка, а не единица: одна пометка — это про ОДИН звонок, а не про номер
 * навсегда. См. createCardForUnknownCaller в incomingCalls.ts.
 */
export const SERVICE_NUMBER_IRRELEVANT_MARKS = 2;
