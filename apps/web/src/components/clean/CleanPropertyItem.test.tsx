import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import type { ComponentProps, ReactElement, ReactNode } from "react";
import type { Property } from "../../types";
import { PropertyRow } from "../PropertyRow";
import { CleanPropertyItem } from "./CleanPropertyItem";
import { CButton } from "./ui";

const property = {
  id: "property-1", shortId: 42, title: "Квартира у парка", type: "APARTMENT", status: "AVAILABLE",
  price: "120000", currency: "USD", areaSqm: 80, floor: 4, totalFloors: 9, address: "Рудаки, 10",
  district: { name: "Сино" }, photos: [{ thumbUrl: "/test-photo.jpg" }], publishedOnSite: true,
  intakeAgent: { id: "agent-1", fullName: "Ноза" }, assignedAgent: { id: "agent-2", fullName: "Фаррух" },
  handoverPendingSince: "2026-10-09", viewsCount: 17, demandCount: 3,
  videoHandoffBrief: { state: "editing", hours: 5, deliveredOf: [12, 15] },
  pipeline: { overdue: true, owner: "EDITOR", daysInStage: 5, limitDays: 2 },
} as unknown as Property;

const render = (extra: Partial<ComponentProps<typeof PropertyRow>> = {}) => renderToStaticMarkup(<MemoryRouter><PropertyRow property={property} myId="agent-1" clean {...extra} /></MemoryRouter>);

function findElement(node: ReactNode, type: unknown): ReactElement<Record<string, unknown>> | undefined {
  if (!node || typeof node !== "object") return undefined;
  if (Array.isArray(node)) return node.map((child) => findElement(child, type)).find(Boolean);
  const element = node as ReactElement<{ children?: ReactNode }>;
  return element.type === type ? element as ReactElement<Record<string, unknown>> : findElement(element.props.children, type);
}

describe("clean property catalog", () => {
  it.each(["row", "card"] as const)("preserves pipeline captions and real queue controls in %s view", (cleanVariant) => {
    const html = render({ cleanVariant, hideHandoffBrief: true, subline: <span>На монтаже · 3 дня</span>, band: <button type="button">Снять с очереди</button> });
    expect(html).toContain("На монтаже · 3 дня");
    expect(html).toContain("Снять с очереди");
    expect(html).toContain("clean-property-band");
    expect(html).not.toContain("задерживает объект");
    expect(html).not.toContain("У монтажёра 5 ч");
  });
  it("formats decimal area identically in rows and cards without precision tails", () => {
    for (const cleanVariant of ["row", "card"] as const) {
      const html = render({ property: { ...property, areaSqm: "94.59999999999999" }, cleanVariant });
      expect(html).toContain("94,6 м²");
      expect(html).not.toContain("94.59999999999999");
    }
  });
  it.each(["row", "card"] as const)("keeps real property facts and operational states in %s view", (cleanVariant) => {
    const html = render({ cleanVariant });
    for (const marker of ["Квартира у парка", "Сино", "Рудаки, 10", "120", "Ноза", "Передан вам", "У монтажёра 5 ч", "Дошло 12/15", "задерживает объект", "На сайте"]) expect(html).toContain(marker);
    expect(html).toContain('src="/test-photo.jpg"');
    expect(html).toContain('href="/properties/42"');
    expect(html).toContain("Принял объект: Ноза");
    expect(html).toContain("сделку ведёт Фаррух");
  });
  it.each([["AVAILABLE", "ok"], ["EDITING", "warn"], ["PENDING_REVIEW", "hot"], ["SOLD", "mute"]] as const)("preserves canonical %s status tone", (status, tone) => {
    expect(render({ property: { ...property, status, pipeline: undefined } })).toContain(`class="chip ${tone}"`);
  });
  it("keeps an overdue status critical and provides a 44px selection hit area", () => {
    const html = render({ onToggleSelect: () => {} });
    expect(html).toContain('class="chip crit"');
    expect(html).toMatch(/<label class="[^"]*size-11/);
    expect(html).not.toContain("border-line-soft");
  });
  it("does not introduce publication or selection access without supplied callbacks", () => {
    const html = render();
    expect(html).not.toContain('type="checkbox"');
    expect(html).not.toContain("Снять с сайта");
  });
  it("retains the selected state and the existing callbacks", () => {
    const onToggleSelect = vi.fn(), onTogglePublish = vi.fn();
    const props: ComponentProps<typeof CleanPropertyItem> = { property, agentTitle: "Ноза", floors: "", awaitingAcceptance: false, handoff: [], selected: true, onToggleSelect, onTogglePublish };
    const tree = CleanPropertyItem(props);
    const check = findElement(tree, "input");
    expect(check?.props.checked).toBe(true);
    (check?.props.onChange as () => void)();
    (findElement(tree, CButton)?.props.onClick as () => void)();
    expect(onToggleSelect).toHaveBeenCalledWith("property-1");
    expect(onTogglePublish).toHaveBeenCalledWith("property-1", "unpublish");
  });
  it("uses an honest placeholder when there is no photograph", () => {
    const html = render({ property: { ...property, photos: [] } });
    expect(html).toContain("Нет фото");
    expect(html).not.toContain('src="/test-photo.jpg"');
  });
  it.each(["SOLD", "WITHDRAWN"])("does not offer publication of an archived %s property", (status) => {
    expect(render({ property: { ...property, status, publishedOnSite: false } as Property, onTogglePublish: () => {} })).not.toContain("Опубликовать");
  });
  it("uses the original photograph when its thumbnail is unavailable", () => {
    const html = render({ property: { ...property, photos: [{ url: "/original-photo.jpg" }] } as unknown as Property });
    expect(html).toContain('src="/original-photo.jpg"');
    expect(html).not.toContain("Нет фото");
  });
  it("does not opt legacy rows into the new presentation", () => {
    expect(render({ clean: false })).toContain('class="prow row wrapt relative"');
  });
});
