/**
 * Деление комиссии сделки — ОДНО место для сервера и сайта.
 *
 * Владелец 25.11.2026: клиент платит 2% от цены объекта; 1% берёт компания,
 * 1% целиком достаётся агенту. Доли «за приём объекта» (0,5%) нет — её отменили
 * ещё 11.09.2026, но она осталась в расчётах: к доле компании прибавлялись
 * 0,5% из Settings.commissionIntakePercent, и прогнозы, отчёты и деление при
 * закрытии считали 1,5% компании вместо 1%.
 *
 * Проценты больше не живут в Настройках: поля commissionRealtorPercent /
 * commissionCompanyPercent / commissionIntakePercent остаются в схеме БД только
 * как история, нигде не читаются. У закрытых сделок деньги — в снапшоте
 * (Deal.commission*Amount): при закрытии агент указывает, кто сколько получил.
 */
export const COMMISSION_REALTOR_PERCENT = 1;
export const COMMISSION_COMPANY_PERCENT = 1;
export const COMMISSION_TOTAL_PERCENT = COMMISSION_REALTOR_PERCENT + COMMISSION_COMPANY_PERCENT;
