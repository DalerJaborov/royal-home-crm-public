/**
 * Строка архива «Завершённые» (pages/Deals.tsx) — та же разметка одета и на
 * телефоне: `archive` собран один раз и прокинут в MobileDeals.tsx пропсом,
 * отдельной мобильной логики для этой строки нет.
 *
 * Ночная проверка 24.09.2026, находка №206: DealDocumentsModal (документы +
 * «Отметить выплаченной») открывался только из карточек трёх стадий доски —
 * из архивной строки завершённой сделки и с телефона до него было не
 * добраться никак. Кнопка, открывающая окно из архива, показывается ТОЛЬКО
 * тому, у кого есть право на выплату, — иначе она обещала бы действие,
 * которое сервер отклонит 403 (apps/api/src/routes/dealPayout.ts, POST
 * /:id/payout: `can(req, "finance.manage") || can(req, "deals.setCommission")`).
 *
 * Вынесено в чистую функцию, а не проверено рендером: в apps/web нет
 * testing-library/jsdom (environment "node" в vitest.config, см. соседние
 * тесты в этой папке — clientTransferAccess.ts и другие).
 */
export function showsArchivePayoutButton(perms: { financeManage: boolean; dealsSetCommission: boolean }): boolean {
  return perms.financeManage || perms.dealsSetCommission;
}
