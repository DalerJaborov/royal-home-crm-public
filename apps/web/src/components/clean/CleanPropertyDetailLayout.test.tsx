import { Children, isValidElement, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import type { Property } from "../../types";
import { CButton } from "./ui";
import { CleanPropertyDetailHeader, CleanPropertyDetailLayout, CleanPropertyDetailSkeleton, CleanPropertySlot, CleanPropertySummary } from "./CleanPropertyDetailLayout";

const property = {
  id: "actual-property", shortId: 42, title: "Квартира у парка", price: 150000, currency: "USD",
  areaSqm: 75, rooms: 3, floor: 4, totalFloors: 9, type: "APARTMENT", condition: "GOOD",
  district: { id: "district", name: "Сино" }, status: "AVAILABLE", pipeline: null,
  videoHandoffFinalPath: null, scheduledPublishAt: null, videoHandoffStatus: null, publishedChannels: [],
} as unknown as Property;

function actionCallbacks(node: ReactNode): (() => void)[] {
  return Children.toArray(node).flatMap((child) => {
    if (!isValidElement<{ children?: ReactNode; onClick?: () => void }>(child)) return [];
    if (child.type === CButton && child.props.onClick) return [child.props.onClick];
    return actionCallbacks(child.props.children);
  });
}

describe("clean property card", () => {
  it("uses real stage, price, district and parameter helpers without repeated values", () => {
    const html = renderToStaticMarkup(<CleanPropertySummary property={property} onSchedule={null} onEdit={null} onMore={() => {}} />);
    expect(html).toContain("В продаже");
    expect(html).toContain("Квартира у парка");
    expect(html).toContain("Сино");
    expect(html).toContain("75 м²");
    expect(html).toContain("3 комнаты");
    expect(html).toContain("4 из 9");
    expect(html.match(/data-testid="property-stage"/g)).toHaveLength(1);
    expect(html).not.toContain("Назначить показ");
    expect(html).not.toContain("Изменить");
  });

  it("preserves every allowed real callback and one primary action", () => {
    const onSchedule = vi.fn(), onEdit = vi.fn(), onMore = vi.fn();
    const tree = CleanPropertySummary({ property, onSchedule, onEdit, onMore });
    const actions = actionCallbacks(tree);
    expect(actions).toHaveLength(3);
    actions.forEach((callback) => callback());
    expect(onSchedule).toHaveBeenCalledOnce();
    expect(onEdit).toHaveBeenCalledOnce();
    expect(onMore).toHaveBeenCalledOnce();
    const html = renderToStaticMarkup(tree);
    const buttons = html.match(/<button[^>]*>/g) ?? [];
    expect(buttons.filter((button) => /\bbg-blue\b/.test(button))).toHaveLength(1);
    const editOnly = renderToStaticMarkup(<CleanPropertySummary property={property} onSchedule={null} onEdit={onEdit} onMore={onMore} />);
    expect(editOnly).not.toContain("Назначить показ");
    expect((editOnly.match(/<button[^>]*>/g) ?? []).filter((button) => /\bbg-blue\b/.test(button))).toHaveLength(1);
  });

  it("keeps legacy layout/slots unchanged and avoids blank work panels", () => {
    expect(renderToStaticMarkup(<CleanPropertyDetailLayout enabled={false}><CleanPropertySlot enabled={false} area="people"><span>Existing owner</span></CleanPropertySlot></CleanPropertyDetailLayout>))
      .toBe('<div class="rh-pcard" data-testid="property-card"><span>Existing owner</span></div>');
    expect(renderToStaticMarkup(<CleanPropertySlot enabled area="work">{null}</CleanPropertySlot>)).toBe("");
  });

  it("offers a labelled whole back link and announces loading without dummy data", () => {
    const html = renderToStaticMarkup(<MemoryRouter><CleanPropertyDetailHeader code="ОБ-000042" place="Сино" /></MemoryRouter>);
    expect(html).toContain('href="/properties"');
    expect(html).toContain("Объекты</a>");
    const loading = renderToStaticMarkup(<CleanPropertyDetailSkeleton />);
    expect(loading).toContain('aria-busy="true"');
    expect(loading).toContain("Загружаем карточку объекта");
    expect(loading).not.toContain("Назначить показ");
  });
});
