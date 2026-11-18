import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Client } from "../../types";
import { ClientStateBadge } from "../ClientStateBadge";
import { MobileClientCard, type MobileClientCardProps } from "./MobileClientCard";

vi.mock("../../hooks/useDuplicates", () => ({ useDismissSimilarClient: () => ({ mutate: vi.fn() }) }));
vi.mock("../rh2/ShellOwnHeader", () => ({ ShellOwnHeader: () => null }));
vi.mock("../ClientDesiredPlacesMap", () => ({ ClientDesiredPlacesMap: () => null }));
vi.mock("../ClientInsight", () => ({ ClientInsight: () => null }));
// «С площадок» у покупателя (17.11.2026) — свой запрос к серверу; здесь проверяется раскладка карточки, не блок.
vi.mock("../MarketBuyerListings", () => ({ MarketBuyerListings: () => <span>С площадок</span> }));
// «Написать в WhatsApp первыми» (аудит F1-1, 17.11.2026): статус «готово к отправке».
vi.mock("../../hooks/useWhatsAppFirstContact", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../hooks/useWhatsAppFirstContact")>()),
  useWaFirstContactStatus: () => ({ data: { state: "ready", hint: "Клиент сам ещё не писал", agentName: "Агент", propertyTextReady: false, last: null } }),
  useSendWaFirstContact: () => ({ isPending: false, error: null, mutate: vi.fn() }),
}));

// workStatus и inactiveLevel убраны из клиента правкой #220 — их здесь больше нет.
const base = { id: "mobile-state-test", fullName: "Клиент", status: "CONTACTED",
  kind: "BUYER", pendingAcceptance: false, hiddenReason: null } as Client;
function render(client: Client, overrides: Partial<MobileClientCardProps> = {}) {
  const noop = () => {};
  const props: MobileClientCardProps = {
    client, locked: true, pending: !!client.pendingAcceptance, isSeller: false, canBuy: client.kind === "BUYER",
    isOther: client.kind === "OTHER", canCallTransferred: false, mainStatusChip: <ClientStateBadge client={client} />,
    propertyWorkspace: <span>Журнал объектов</span>, overviewProperties: <span>Объекты в обзоре</span>,
    intentConfirmation: null, overviewNextStep: null, commonMiddle: null, similarWarning: null,
    editingName: false, nameDraft: "", savingName: false, onStartEditName: noop, onNameDraftChange: noop,
    onCancelEditName: noop, onSubmitName: noop, phoneOptions: [], conversations: [], interactions: [],
    lastPropertiesSent: null, onOpenMatch: noop, matchTotal: undefined, canMerge: false, similarNotes: [],
    onOpenChat: noop, onShowInteraction: noop, onMerge: noop, moreGroups: [], moreError: null,
    showMoreSheet: false, onShowMoreSheet: noop, ...overrides,
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

describe("mobile client card: «Написать в WhatsApp первыми» как на ПК", () => {
  it("показывает кнопку агенту, который ведёт клиента", () => {
    const html = render(base, { locked: false });
    expect(html).toContain("Написать в WhatsApp первыми");
    expect(html).toContain("Написать в WhatsApp");
  });
  it("не показывает чужому (карточка закрыта)", () => {
    expect(render(base, { locked: true })).not.toContain("Написать в WhatsApp первыми");
  });
});
