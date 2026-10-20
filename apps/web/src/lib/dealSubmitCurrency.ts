import type { Currency } from "@royal-home/shared";

/**
 * Окно «На закрытие» подписывается валютой СДЕЛКИ, а не объекта (находка №210).
 *
 * Сумма комиссии и цена продажи хранятся и считаются в валюте сделки — снапшоте на
 * момент создания. Валюту объекта потом могли сменить, и тогда форма просила
 * «сомони», а сервер принимал и считал «доллары».
 * Цена объявления подсказывается только когда валюты совпадают: число в чужой
 * валюте под подписью «своей» вводит в заблуждение сильнее, чем отсутствие подсказки.
 */
export function dealSubmitCurrencyProps(deal: {
  currency?: Currency | null;
  property: { price: string; currency: Currency };
}): { currency: Currency; listedPrice: string } {
  const currency = deal.currency ?? deal.property.currency;
  return { currency, listedPrice: currency === deal.property.currency ? deal.property.price : "0" };
}
