import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import type { ComponentProps, ReactElement, ReactNode } from "react";
import type { Property, PropertyPhoto } from "../../../types";
import { PropertyRow } from "../../PropertyRow";
import { PropertyGallery } from "../../property/PropertyGallery";
import { RoyalPropertySummary, royalPropertyFacts } from "./RoyalPropertySummary";
import { RoyalObjectsHead } from "./RoyalObjectsHead";
import { toneFromChipClass, toneFromChipTone } from "./objectTone";
import { Rh2Screen } from "../../rh2/Rh2Screen";
import { RoyalSection } from "../clients/RoyalSection";

/**
 * «Новый вид», раздел «Объекты»: та же строка каталога и тот же главный блок
 * карточки, что у чистой оболочки, — ничего из данных и действий не теряется,
 * меняется только раскладка. Без признака (`royal` не передан) — прежний вид.
 */
const property = {
  id: "property-1", shortId: 42, title: "Квартира у парка", type: "APARTMENT", status: "AVAILABLE", condition: "GOOD",
  price: "120000", currency: "USD", areaSqm: 80, rooms: 3, floor: 4, totalFloors: 9, address: "Рудаки, 10",
  district: { name: "Сино" }, photos: [{ thumbUrl: "/test-photo.jpg", url: "/full.jpg" }], publishedOnSite: true,
  intakeAgent: { id: "agent-1", fullName: "Ноза Каримова" }, assignedAgent: { id: "agent-2", fullName: "Фаррух" },
  handoverPendingSince: "2026-10-09", demandCount: 3,
  videoHandoffBrief: { state: "editing", hours: 5, deliveredOf: [12, 15] },
  pipeline: { inPipeline: true, overdue: true, owner: "EDITOR", daysInStage: 5, limitDays: 2 },
} as unknown as Property;

const row = (extra: Partial<ComponentProps<typeof PropertyRow>> = {}) =>
  renderToStaticMarkup(<MemoryRouter><PropertyRow property={property} myId="agent-1" clean royal cleanVariant="card" {...extra} /></MemoryRouter>);

function findAll(node: ReactNode, test: (el: ReactElement<Record<string, unknown>>) => boolean, out: ReactElement<Record<string, unknown>>[] = []) {
  if (!node || typeof node !== "object") return out;
  if (Array.isArray(node)) { node.forEach((child) => findAll(child, test, out)); return out; }
  const el = node as ReactElement<Record<string, unknown>>;
  if (test(el)) out.push(el);
  findAll(el.props?.children as ReactNode, test, out);
  return out;
}

describe("royal property catalog item", () => {
  it.each(["row", "card"] as const)("keeps every fact and state of the clean item in %s layout", (cleanVariant) => {
    const html = row({ cleanVariant });
    for (const marker of ["Квартира у парка", "Сино", "Рудаки, 10", "120", "Ноза", "Передан вам", "У монтажёра 5 ч", "Дошло 12/15", "задерживает объект", "На сайте", "ОБ-000042"]) {
      expect(html).toContain(marker);
    }
    expect(html).toContain('src="/test-photo.jpg"');
    expect(html).toContain('href="/properties/42"');
    expect(html).toContain("Принял объект: Ноза Каримова");
    expect(html).toContain("ry-obj-card");
    expect(html).not.toContain("clean-property-thumbnail");
  });
  it("without the royal flag the catalog row stays the clean one", () => {
    const html = renderToStaticMarkup(<MemoryRouter><PropertyRow property={property} myId="agent-1" clean cleanVariant="card" /></MemoryRouter>);
    expect(html).toContain("clean-property-thumbnail");
    expect(html).not.toContain("ry-obj-");
  });
  it("просроченный этап — жёлтая плашка со значком и словами; красная без огня — только при тройном превышении срока", () => {
    const html = row();
    expect(html).toMatch(/class="ry-obj-pill" data-tone="warn"><svg/);
    expect(html).toContain("срок прошёл на 3 дн.");
    expect(html).toContain("ry-obj-overdue");
    const worse = renderToStaticMarkup(<MemoryRouter><PropertyRow property={{ ...property, pipeline: { ...property.pipeline!, daysInStage: 20 } }} myId="agent-1" clean royal cleanVariant="card" /></MemoryRouter>);
    expect(worse).toMatch(/class="ry-obj-pill" data-tone="crit"><svg/);
    expect(worse).toContain("просрочено на 18 дн.");
    expect(worse).not.toContain("flame");
  });
  it("selection and publish call the same callbacks the catalog passes", () => {
    const onToggleSelect = vi.fn();
    const onTogglePublish = vi.fn();
    const html = row({ onToggleSelect, onTogglePublish, selected: true });
    expect(html).toContain('aria-label="Выбрать объект: Квартира у парка"');
    expect(html).toContain('data-selected="true"');
    expect(html).toContain("Снять с сайта");
    expect(row()).not.toContain("Снять с сайта");
    expect(row()).not.toContain("ry-obj-pick");
  });
  it("pipeline subline replaces the overdue line and band stays clickable", () => {
    const html = row({ hideHandoffBrief: true, subline: <span>На монтаже · 3 дня</span>, band: <button type="button">Снять с очереди</button> });
    expect(html).toContain("На монтаже · 3 дня");
    expect(html).toContain("Снять с очереди");
    expect(html).not.toContain("задерживает объект");
    expect(html).not.toContain("У монтажёра 5 ч");
  });
  it("missing photo says so instead of an empty frame", () => {
    expect(row({ property: { ...property, photos: [] } })).toContain("Нет фото");
  });
});

describe("royal property summary", () => {
  it("shows price, title, place and facts with icons; no unfilled facts", () => {
    const facts = royalPropertyFacts({ ...property, rooms: null } as never);
    expect(facts.map((f) => f.label)).not.toContain("Комнаты");
    expect(facts.map((f) => f.label)).not.toContain("Район");
    const html = renderToStaticMarkup(<MemoryRouter><RoyalPropertySummary property={property} place="Сино, Рудаки, 10" onSchedule={() => {}} onEdit={() => {}} onMore={() => {}} /></MemoryRouter>);
    for (const marker of ["Квартира у парка", "Сино, Рудаки, 10", "80 м²", "Площадь", "Комнаты", "4 из 9", "data-testid=\"property-params\"", "data-testid=\"property-stage\"", "data-testid=\"property-price\""]) {
      expect(html).toContain(marker);
    }
  });
  it("buttons follow the permissions the card passes: no handler, no button", () => {
    const onMore = vi.fn();
    const tree = RoyalPropertySummary({ property, onSchedule: null, onEdit: null, onMore });
    const buttons = findAll(tree, (el) => el.type === "button");
    expect(buttons).toHaveLength(1);
    (buttons[0].props.onClick as () => void)();
    expect(onMore).toHaveBeenCalledOnce();
    const html = renderToStaticMarkup(<MemoryRouter>{RoyalPropertySummary({ property, onSchedule: null, onEdit: () => {}, onMore })}</MemoryRouter>);
    expect(html).toContain('data-variant="primary"');
    expect(html).not.toContain("Назначить показ");
  });
});

describe("royal catalog head", () => {
  it("one primary action, pending review only for a moderator", () => {
    const onShowPending = vi.fn();
    const html = renderToStaticMarkup(<MemoryRouter><RoyalObjectsHead total={19} pendingReview={2} onShowPending={onShowPending} canCreate onCreate={() => {}} /></MemoryRouter>);
    expect(html).toContain("Ждут вашей проверки: 2");
    expect(html.match(/data-variant="primary"/g)).toHaveLength(1);
    const plain = renderToStaticMarkup(<MemoryRouter><RoyalObjectsHead total={19} onShowPending={onShowPending} canCreate={false} onCreate={() => {}} /></MemoryRouter>);
    expect(plain).not.toContain("Ждут вашей проверки");
    expect(plain).not.toContain("Добавить объект");
  });
});

describe("royal gallery thumbnails", () => {
  const photos = Array.from({ length: 4 }, (_, i) => ({ id: `p${i}`, url: `/u/${i}.jpg`, thumbUrl: `/t/${i}.jpg`, order: i }) as PropertyPhoto);
  it("adds a thumbnail strip only when asked and only for two or more photos", () => {
    expect(renderToStaticMarkup(<PropertyGallery photos={photos} />)).not.toContain("ry-gal-thumbs");
    const html = renderToStaticMarkup(<PropertyGallery photos={photos} thumbs />);
    expect(html.match(/aria-label="Фото \d из 4"/g)).toHaveLength(4);
    expect(html.match(/data-testid="gallery"/g)).toHaveLength(1);
    expect(renderToStaticMarkup(<PropertyGallery photos={photos.slice(0, 1)} thumbs />)).not.toContain("ry-gal-thumbs");
  });
});

describe("royal tone mapping", () => {
  it.each([["chip crit", "crit"], ["chip warn", "warn"], ["chip hot", "warn"], ["chip ok", "ok"], ["chip mute", "neutral"], ["chip", "neutral"]] as const)("%s → %s", (cls, tone) => {
    expect(toneFromChipClass(cls)).toBe(tone);
  });
  it.each([["crit", "crit"], ["ok", "ok"], ["sky", "warn"], ["lav", "warn"], ["neutral", "neutral"]] as const)("stage tone %s → %s", (from, tone) => {
    expect(toneFromChipTone(from)).toBe(tone);
  });
});

describe("section marker", () => {
  it("Rh2Screen carries data-ry-section only inside RoyalSection named objects", () => {
    expect(renderToStaticMarkup(<MemoryRouter><RoyalSection name="objects"><Rh2Screen><p>x</p></Rh2Screen></RoyalSection></MemoryRouter>)).toContain('data-ry-section="objects"');
    expect(renderToStaticMarkup(<MemoryRouter><RoyalSection name={undefined}><Rh2Screen><p>x</p></Rh2Screen></RoyalSection></MemoryRouter>)).not.toContain("data-ry-section");
  });
});
