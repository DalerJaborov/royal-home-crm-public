/**
 * ЦЕНА НАБРАНА В КАДР ГОТОВОГО РОЛИКА? (26.11.2026, ревью #445).
 *
 * До 25.11.2026 задание монтажёру (lib/videoHandoff.ts::propertyFactsForMontajer) несло строку «Цена: …», и
 * монтажёр набирал её в кадр; новые задания её не несут (владелец 25.11.2026: «все наши ролики будут без цены»).
 * Признак — факты, ушедшие монтажёру последними (`videoHandoffLastFactsText`): есть строка «Цена:» — цена в кадре.
 * Тогда правка цены ролик старит (монтажёру и модератору сообщаем, lib/propertyEditNotify.ts), а история
 * «цена снижена» на таком ролике показала бы старую сумму под плашкой новой (lib/instagramStories.ts — фото-карточка).
 *
 * Фактов нет вовсе — ролик передан до того, как их начали хранить (20.09.2026), и цена в нём была: считаем «да».
 *
 * Отдельный модуль без импортов: его зовут и videoHandoff-соседи, и instagramStories, а videoHandoff сам
 * импортирует instagramStories — признак, положенный туда, дал бы цикл импортов. Одно место для всех.
 */
export function clipHasPriceInFrame(p: { videoHandoffLastFactsText: string | null }): boolean {
  if (p.videoHandoffLastFactsText == null) return true;
  return /^Цена:/m.test(p.videoHandoffLastFactsText);
}

/** Строка «Цена: …» из сохранённых фактов — чтобы обновление фактов не стёрло признак «цена в кадре». */
export function priceLineInFrame(factsText: string | null): string | null {
  return factsText?.match(/^Цена:.*$/m)?.[0] ?? null;
}
