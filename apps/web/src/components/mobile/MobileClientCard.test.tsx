import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Client } from "../../types";
import { ClientStateBadge } from "../ClientStateBadge";
import { MobileClientCard, type MobileClientCardProps } from "./MobileClientCard";

vi.mock("../../hooks/useDuplicates", () => ({ useDismissSimilarClient: () => ({ mutate: vi.fn() }) }));
vi.mock("../rh2/ShellOwnHeader", () => ({ ShellOwnHeader: () => null }));
vi.mock("../ClientDesiredPlacesMap", () => ({ ClientDesiredPlacesMap: () => null }));
vi.mock("../ClientInsight", () => ({ ClientInsight: () => null }));

const base = { id: "mobile-state-test", fullName: "Клиент", status: "CONTACTED", workStatus: "ACTIVE",
  kind: "BUYER", pendingAcceptance: false, inactiveLevel: null, hiddenReason: null } as Client;
function render(client: Client) {
  const noop = () => {};
  const props: MobileClientCardProps = {
    client, locked: true, pending: !!client.pendingAcceptance, isSeller: false, canBuy: client.kind === "BUYER",
    isOther: client.kind === "OTHER", canCallTransferred: false, mainStatusChip: <ClientStateBadge client={client} />,
    propertyWorkspace: <span>Журнал объектов</span>, overviewProperties: <span>Объекты в обзоре</span>,
    intentConfirmation: null, overviewNextStep: null, commonMiddle: null, propertyCounts: null, similarWarning: null,
    editingName: false, nameDraft: "", savingName: false, onStartEditName: noop, onNameDraftChange: noop,
    onCancelEditName: noop, onSubmitName: noop, phoneOptions: [], conversations: [], interactions: [],
    lastPropertiesSent: null, onOpenMatch: noop, matchTotal: undefined, canMerge: false, similarNotes: [],
    onOpenChat: noop, onShowInteraction: noop, onMerge: noop, moreGroups: [], moreError: null,
    showMoreSheet: false, onShowMoreSheet: noop,
  };
  return renderToStaticMarkup(<MobileClientCard {...props} />);
}

describe("mobile client overview lifecycle integration", () => {
  it("renders acceptance once while keeping the unaccepted content gate", () => {
    const html = render({ ...base, pendingAcceptance: true });
    expect(html.match(/Ждёт принятия/g)).toHaveLength(1);
    expect(html).toContain("когда вы примете лид");
    expect(html).not.toContain("Объекты в обзоре");
  });
  it("renders other-inquiry identity once and retains the new overview and activity sections", () => {
    const html = render({ ...base, kind: "OTHER" });
    expect(html.match(/Прочее обращение/g)).toHaveLength(1);
    expect(html).toContain("Объекты в обзоре");
    expect(html).toContain("Журнал объектов");
  });
});
