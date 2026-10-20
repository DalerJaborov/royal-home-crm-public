import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { renderToStaticMarkup } from "react-dom/server";
import type { ComponentProps } from "react";
import { LegacyAgentPropertyView } from "./LegacyAgentPropertyView";
vi.mock("./PropertyMobileBlocks", () => ({ MobileLinkButtons: () => <span>MobileLinkButtons</span>, MobileParamTiles: () => <span>MobileParamTiles</span>, MobilePriceCard: () => <span>MobilePriceCard</span>, MobilePropertyHeader: () => <span>MobilePropertyHeader</span>, MobilePropertyHero: () => <span>MobilePropertyHero</span> }));
vi.mock("../rh2/ShellOwnHeader", () => ({ ShellOwnHeader: () => <span>ShellOwnHeader</span> }));
vi.mock("../MutationError", () => ({ MutationError: () => <span>MutationError</span> }));
vi.mock("../ads/PropertyAdBadge", () => ({ PropertyAdBadge: () => <span>PropertyAdBadge</span> }));
vi.mock("../ads/PropertyPromoteLink", () => ({ PropertyPromoteLink: () => <span>PropertyPromoteLink</span> }));
vi.mock("../PropertyPhotoManager", () => ({ PropertyPhotoManager: () => <span>PropertyPhotoManager</span> }));
vi.mock("../PropertyClipVideoCard", () => ({ PropertyClipVideoCard: () => <span>PropertyClipVideoCard</span> }));
vi.mock("../PropertyShareOpensCard", () => ({ PropertyShareOpensCard: () => <span>PropertyShareOpensCard</span> }));
vi.mock("../match/MatchPanel", () => ({ MatchPanel: () => <span>MatchPanel</span> }));
vi.mock("../PropertyHistoryCard", () => ({ PropertyHistoryCard: () => <span>PropertyHistoryCard</span> }));
vi.mock("../RequestDeletePropertyModal", () => ({ RequestDeletePropertyModal: () => <span>RequestDeletePropertyModal</span> }));
vi.mock("../PropertyVideoFixCard", () => ({ AgentVideoStatus: () => <span>AgentVideoStatus</span>, PropertyVideoFixCard: () => <span>PropertyVideoFixCard</span>, FacebookGroupShareBlock: () => <span>FacebookGroupShareBlock</span>, RepostBlock: () => <span>RepostBlock</span>, SocialExtrasBlock: () => <span>SocialExtrasBlock</span> }));
vi.mock("../PropertyCoverStatus", () => ({ PropertyCoverStatus: () => <span>PropertyCoverStatus</span> }));
vi.mock("../PropertyStatsCard", () => ({ PropertyStatsCard: () => <span>PropertyStatsCard</span> }));
vi.mock("../PropertyVoiceCard", () => ({ PropertyVoiceDisclosure: () => <span>PropertyVoiceDisclosure</span> }));
vi.mock("../PropertyPriceDemandCard", () => ({ PropertyPriceDemandCard: () => <span>PropertyPriceDemandCard</span> }));

type Props = ComponentProps<typeof LegacyAgentPropertyView>;
const noop = () => {};
const blank = () => null;
function fixture(overrides: Partial<Props> & { canEdit?: boolean; editLocked?: boolean; matchOpen?: boolean; deleteOpen?: boolean; requestDeleteOpen?: boolean } = {}): Props {
  const { canEdit = false, editLocked = false, matchOpen = false, deleteOpen = false, requestDeleteOpen = false, ...viewOverrides } = overrides;
  const props: Props = {
    property: { id: "property-1", shortId: 42, title: "Квартира", type: "APARTMENT", status: "AVAILABLE", areaSqm: 64, description: "Описание", district: { name: "Сино" }, address: "Адрес", photos: [], reelsCaption: null } as unknown as Props["property"],
    can: () => false, updateProperty: {} as Props["updateProperty"],
    isTrashed: false, canEnterEdit: false, canInlineEdit: false,
    editingPhotos: false, setEditingPhotos: noop, onEditParams: noop, onInlineDone: noop,
    showSolve: true, viewSolve: <span>solve-once</span>, dealSlot: <span>deal-once</span>, fieldsBlock: <span>people-once</span>,
    role: "AGENT", canMarkGroupShare: false, changeRequestBlock: <span>change-requests-once</span>, sourcesBlock: <span>sources-once</span>,
    isResponsibleForProperty: true, docsBlock: <span>docs-once</span>,
    deleteMode: null, pendingDeleteRequest: null, setRequestDeleteOpen: noop, setDeleteOpen: noop,
    setMatchOpen: noop, placeLine: () => "Сино",
    parts: { InlineDoneButton: blank, InlineEditLink: () => <span>edit-photo-link</span>, DemandLine: blank, DescriptionBlock: () => <span>description-once</span> },
    slots: { trashedNotice: null, addressNotice: null, lockedNotice: null, reelsBlock: null, promotionBlock: null, shareOpensBlock: null, matchDialog: null, deleteDialog: null, requestDeleteDialog: null },
    ...viewOverrides,
  };
  props.slots = {
    trashedNotice: null, addressNotice: null, lockedNotice: null,
    reelsBlock: props.can("properties.aiListing") && !props.isTrashed && !editLocked ? <div className="card tight" /> : null,
    promotionBlock: <><span>PropertyAdBadge</span><span>PropertyPromoteLink</span>{!props.isTrashed && props.property.status === "AVAILABLE" && <span>PropertyPriceDemandCard</span>}</>,
    shareOpensBlock: canEdit && !props.isTrashed ? <span>PropertyShareOpensCard</span> : null,
    matchDialog: matchOpen ? <span>MatchPanel</span> : null,
    deleteDialog: deleteOpen ? <span>delete-dialog</span> : null,
    requestDeleteDialog: requestDeleteOpen ? <span>RequestDeletePropertyModal</span> : null,
    ...viewOverrides.slots,
  };
  return props;
}
const render = (props: Props) => renderToStaticMarkup(<LegacyAgentPropertyView {...props} />);
describe("legacy agent property acceptance", () => {
  it("uses controller-owned leaves once at their original phone positions", () => {
    const props = fixture();
    props.slots = {
      trashedNotice: <span>shared-trash</span>, addressNotice: <span>shared-address</span>, lockedNotice: <span>shared-lock</span>,
      reelsBlock: <div className="card tight">shared-reels</div>, promotionBlock: <span>shared-promotion</span>, shareOpensBlock: <span>shared-opens</span>,
      matchDialog: <span>shared-match</span>, deleteDialog: <span>shared-delete</span>, requestDeleteDialog: <span>shared-request</span>,
    };
    // The view accepts the controller's leaves without deriving a second permission policy.
    const html = render(props);
    const markers = ["shared-trash", "MobilePropertyHeader", "shared-address", "shared-lock", "MobilePropertyHero", "PropertyVoiceDisclosure", "shared-reels", "shared-promotion", "sources-once", "shared-opens", "PropertyHistoryCard", "docs-once", "shared-match", "shared-delete", "shared-request"];
    const indices = markers.map((marker) => html.indexOf(marker));
    expect(indices.every((index) => index >= 0)).toBe(true);
    expect(indices).toEqual([...indices].sort((a, b) => a - b));
    for (const marker of markers) expect(html.split(marker)).toHaveLength(2);
  });
  it("preserves pre-extraction markup for shared blocks and overlays", () => {
    const html = render(fixture({ can: () => true, canEdit: true, matchOpen: true, deleteOpen: true, requestDeleteOpen: true }));
    // Captured from the original phone renderer before moving these leaves.
    expect(createHash("sha256").update(html).digest("hex")).toBe("2c64c3be9ec585c5da02e39421346429a02f03838c24e22ba291a7420331749c");
    expect(html).toContain("PropertyShareOpensCard");
  });
  it("preserves the phone block order and includes every shared working block once", () => {
    const html = render(fixture());
    const markers = ["MobilePropertyHero", "MobilePriceCard", "MobileParamTiles", "solve-once", "deal-once", "people-once", "description-once", "AgentVideoStatus", "change-requests-once", "PropertyStatsCard", "sources-once", "PropertyHistoryCard", "docs-once"];
    const indices = markers.map((marker) => html.indexOf(marker));
    expect(indices.every((index) => index >= 0)).toBe(true);
    expect(indices).toEqual([...indices].sort((a, b) => a - b));
    for (const marker of markers) expect(html.split(marker)).toHaveLength(2);
  });
  it("does not invent edit/delete controls for a read-only card", () => {
    const html = render(fixture());
    expect(html).not.toContain("edit-photo-link");
    expect(html).not.toContain("PropertyPhotoManager");
    expect(html).not.toContain("Направить на удаление");
    expect(html).not.toContain("Удалить объект");
    expect(html).not.toContain("delete-dialog");
  });
  it("retains existing pending-delete semantics rather than submitting again", () => {
    const ready = render(fixture({ deleteMode: "request" }));
    expect(ready).toContain("Направить на удаление");
    const pending = render(fixture({ deleteMode: "request", pendingDeleteRequest: { id: "request-1" } as Props["pendingDeleteRequest"] }));
    expect(pending).toContain("ждёт решения директора");
    expect(pending).not.toContain("Направить на удаление");
  });
  it("mounts the existing editor and dialogs only when their state is open", () => {
    const html = render(fixture({ canInlineEdit: true, editingPhotos: true, matchOpen: true, requestDeleteOpen: true }));
    expect(html).toContain("PropertyPhotoManager");
    expect(html).toContain("MatchPanel");
    expect(html).toContain("RequestDeletePropertyModal");
  });
});
