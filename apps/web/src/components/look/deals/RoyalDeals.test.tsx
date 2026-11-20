import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import type { Deal } from "../../../types";
import { formatMoney } from "../../../lib/format";
import { RoyalDealsHead, RoyalDealsSummary } from "./RoyalDealsHead";
import { RoyalApprovalRow, RoyalArchiveRow } from "./RoyalDealRows";
import { RoyalDealColumnHead, RoyalDealTileBody } from "./RoyalDealTile";

/**
 * «Новый вид», раздел «Сделки»: те же данные и действия, что у чистой оболочки,
 * — деньги в том же формате (formatMoney) и целиком, условия и причины текстом,
 * действия по тем же правам. Меняется только разметка.
 */
const deal = {
  id: "deal-1", clientId: "c1", client: { id: "c1", shortId: 7, fullName: "Ситора Назарова", phone: "+992900000099" },
  propertyId: "p1", property: { id: "p1", shortId: 42, title: "Квартира у парка", price: "1250000", currency: "USD", photos: [{ id: "ph", url: "/full.jpg", thumbUrl: "/thumb.jpg", order: 0 }] },
  agentId: "a1", agent: { id: "a1", fullName: "Ноза Каримова" }, stage: "PENDING_APPROVAL",
  commissionAmount: "37500.5", commissionPercent: null, soldPrice: "1200000", commissionIntakeAmount: null,
  commissionRealtorAmount: "20000", commissionCompanyAmount: "17500.5", currency: "USD",
  startedAt: new Date(Date.now() - 3 * 86400000).toISOString(), closedAt: null, notes: null,
} as unknown as Deal;

const noop = () => {};
const approval = (extra: Partial<Parameters<typeof RoyalApprovalRow>[0]> = {}) => renderToStaticMarkup(
  <RoyalApprovalRow deal={deal} showMoney canDecide canEdit busy={false} onOpen={noop} onApprove={noop} onEdit={noop} onReturn={noop} {...extra} />,
);

describe("royal deals: approval row", () => {
  it("shows sold price and commission in full, in the old format", () => {
    const html = approval();
    expect(html).toContain(formatMoney("1200000", "USD"));
    expect(html).toContain(formatMoney("37500.5", "USD"));
    expect(html).toContain("Ситора Назарова");
    expect(html).toContain("Квартира у парка");
    for (const label of ["Одобрить", "Изменить", "Вернуть"]) expect(html).toContain(`>${label}</button>`);
  });
  it("keeps the rights of the old row: no edit without deals.setCommission, no decisions without deals.complete", () => {
    expect(approval({ canEdit: false })).not.toContain(">Изменить<");
    const viewer = approval({ canDecide: false });
    expect(viewer).not.toContain(">Одобрить<");
    expect(viewer).toContain("ждёт руководителя");
  });
  it("hides money text entirely when the viewer may not see it, and says «не указана» for a missing sum", () => {
    expect(approval({ showMoney: false })).not.toContain("комиссия");
    expect(renderToStaticMarkup(<RoyalApprovalRow deal={{ ...deal, soldPrice: null }} showMoney canDecide={false} canEdit={false} busy={false} onOpen={noop} onApprove={noop} onEdit={noop} onReturn={noop} />))
      .toContain("не указана");
  });
  it("«Одобрить» is disabled while a stage change is pending", () => {
    expect(approval({ busy: true })).toMatch(/<button[^>]*disabled=""[^>]*>Одобрить</);
  });
});

describe("royal deals: archive rows", () => {
  it("a completed row shows price, commission, the 70/30 condition in words and the row actions", () => {
    const html = renderToStaticMarkup(<RoyalArchiveRow deal={{ ...deal, stage: "COMPLETED", refusedLeadSplit: true }} kind="completed" onOpen={noop} actions={<button type="button">Аннулировать</button>} />);
    expect(html).toContain(formatMoney("1250000", "USD"));
    expect(html).toContain(`+${formatMoney("37500.5", "USD")}`);
    expect(html).toContain("Отказная заявка: 70% продавшему, 30% приведшему");
    expect(html).toMatch(/class="ry-deal-note"><svg/); // строка со значком, не таблетка
    expect(html).not.toMatch(/class="ry-deal-tag">Отказной/);
    expect(html).toContain("Аннулировать");
  });
  it("an annulled row shows the reason as text, not only in a tooltip", () => {
    const html = renderToStaticMarkup(<RoyalArchiveRow deal={{ ...deal, stage: "CANCELLED", annulledAt: "2026-11-01", annulReason: "Покупатель передумал" }} kind="cancelled" onOpen={noop} />);
    expect(html).toContain("аннулирована");
    expect(html).toContain("Причина: Покупатель передумал");
    expect(html).not.toContain("title=");
  });
});

describe("royal deals: board card", () => {
  const tile = (extra: Partial<Parameters<typeof RoyalDealTileBody>[0]> = {}) => renderToStaticMarkup(
    <RoyalDealTileBody deal={{ ...deal, stage: "CONTRACT_SIGNED" }} showAgent canWrite prev={{ key: "AGREEMENT_PENDING", label: "Согласование" }} next={null}
      closeLabel="Отправить на закрытие" onDocs={noop} onPrev={noop} onCancel={noop} onNext={noop} onClose={noop} {...extra} />,
  );
  it("keeps price, age, commission, documents, cancel, back and close — close now in words", () => {
    const html = tile();
    expect(html).toContain(formatMoney("1250000", "USD"));
    expect(html).toContain("3 дн");
    expect(html).toContain(formatMoney("37500.5", "USD"));
    expect(html).toContain("Документы");
    expect(html).toContain(">Отменить</button>");
    expect(html).toContain('aria-label="Вернуть на «Согласование»"');
    expect(html).toContain(">Отправить на закрытие</button>");
    expect(html).toContain("Ведёт: Ноза Каримова");
  });
  it("without write access there is no cancel and no stage buttons (A3), documents stay", () => {
    const html = tile({ canWrite: false });
    expect(html).not.toContain("Отменить");
    expect(html).not.toContain("ry-deal-steps");
    expect(html).toContain("Документы");
  });
  it("the middle stage moves forward with a labelled button", () => {
    const html = tile({ next: { key: "CONTRACT_SIGNED", label: "Договор подписан" } });
    expect(html).toContain('aria-label="Перевести на этап «Договор подписан»"');
    // Подпись «Дальше: …», чтобы название этапа не читалось как текущий статус.
    expect(html).toContain("Дальше: Договор подписан");
  });
  it("column head sums commission in somoni with the shared formatter, only when above zero", () => {
    expect(renderToStaticMarkup(<RoyalDealColumnHead label="Переговоры" count={2} commissionTjs={1234.5} />)).toContain(formatMoney(1234.5, "TJS"));
    expect(renderToStaticMarkup(<RoyalDealColumnHead label="Переговоры" count={0} commissionTjs={0} />)).not.toContain("комиссии");
  });
});

describe("royal deals: head and summary", () => {
  it("one primary button; filter only when allowed", () => {
    const html = renderToStaticMarkup(<RoyalDealsHead scope="Сделки всей команды" filterCount={1} onFilter={noop} onCreate={noop} />);
    expect(html.match(/data-variant="primary"/g)).toHaveLength(1);
    // «Фильтры» открывает шторку, это не переключатель: без aria-pressed, выбранное — точкой и словами.
    expect(html).not.toContain("aria-pressed");
    expect(html).toContain('aria-label="Фильтры, выбрано 1"');
    expect(html).toContain("ry-deals-dot");
    const plain = renderToStaticMarkup(<RoyalDealsHead scope="Сделки всей команды" filterCount={0} onFilter={noop} onCreate={null} />);
    expect(plain).not.toContain("ry-deals-dot");
    expect(plain).not.toContain("выбрано");
    expect(renderToStaticMarkup(<RoyalDealsHead scope="Ваши сделки" filterCount={0} onFilter={null} onCreate={null} />)).not.toContain("Фильтры");
  });
  it("month commission in full TJS format, hidden without finance.view", () => {
    const html = renderToStaticMarkup(<RoyalDealsSummary ready activeCount={4} approvalCount={1} closedCount={2} commissionTjs={123456.78} seesMoney />);
    expect(html).toContain(formatMoney(123456.78, "TJS"));
    expect(renderToStaticMarkup(<RoyalDealsSummary ready activeCount={4} approvalCount={1} closedCount={2} commissionTjs={5} seesMoney={false} />)).not.toContain("Комиссия за месяц");
    expect(renderToStaticMarkup(<RoyalDealsSummary ready={false} activeCount={0} approvalCount={0} closedCount={0} commissionTjs={0} seesMoney />)).toContain("—");
  });
});

describe("Deals.tsx: new look only on top of the clean shell, section mark only when on", () => {
  const src = readFileSync(new URL("../../../pages/Deals.tsx", import.meta.url), "utf8");
  it("gates the look and the section mark", () => {
    expect(src).toContain("const royal = useRoyalLook() && clean;");
    expect(src).toContain('<RoyalSection name={royal ? "deals" : undefined}>');
    expect(src).toContain('data-ry-section={royal ? "deals" : undefined}');
  });
});
