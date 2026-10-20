import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ComponentProps, ReactElement, ReactNode } from "react";
import { LegacyAgentTopbar } from "./LegacyAgentTopbar";
vi.mock("../ProfileMenu", () => ({ ProfileMenu: () => <span>profile-menu</span> }));
type Props = ComponentProps<typeof LegacyAgentTopbar>;
function fixture(): Props {
  return { title: "Клиент", back: "/clients", onNavigate: vi.fn(), actions: <span>page-actions</span>, onSearch: vi.fn(), bellRef: { current: null }, unreadCount: 12, notificationsOpen: true, onToggleNotifications: vi.fn(), notificationsPanel: <span>notification-panel</span>, searchPanel: <span>search-panel</span> };
}
function findButton(node: ReactNode, label: string): ReactElement<{ onClick: () => void }> | undefined {
  if (!node || typeof node !== "object") return undefined;
  if (Array.isArray(node)) return node.map((child) => findButton(child, label)).find(Boolean);
  const element = node as ReactElement<{ "aria-label"?: string; children?: ReactNode; onClick: () => void }>;
  if (element.type === "button" && element.props["aria-label"] === label) return element;
  return findButton(element.props.children, label);
}
describe("preserved agent phone topbar", () => {
  it("keeps the existing geometry, separate entries, badge and overlay slots", () => {
    const html = renderToStaticMarkup(<LegacyAgentTopbar {...fixture()} />);
    expect(html).toContain("h-14 bg-card border-b border-line items-center px-3.5 gap-3.5 flex");
    for (const marker of ["page-actions", "profile-menu", "notification-panel", "search-panel", "9+", 'aria-label="Поиск клиентов и объектов"', 'aria-label="Уведомления"']) expect(html).toContain(marker);
    expect(html).not.toContain("Ещё: разделы и профиль");
  });
  it("uses the current navigation, search and notification handlers", () => {
    const props = fixture();
    const tree = LegacyAgentTopbar(props);
    findButton(tree, "Назад")?.props.onClick();
    findButton(tree, "Поиск клиентов и объектов")?.props.onClick();
    findButton(tree, "Уведомления")?.props.onClick();
    expect(props.onNavigate).toHaveBeenCalledWith("/clients");
    expect(props.onSearch).toHaveBeenCalledOnce();
    expect(props.onToggleNotifications).toHaveBeenCalledOnce();
  });
  it("does not show a zero-count badge or a missing back target", () => {
    const html = renderToStaticMarkup(<LegacyAgentTopbar {...fixture()} unreadCount={0} back={null} />);
    expect(html).not.toContain("data-unread-badge");
    expect(html).not.toContain('aria-label="Назад"');
  });
});
