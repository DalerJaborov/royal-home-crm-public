import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { CLIENT_STATUSES } from "@royal-home/shared";
import { clientPrimaryState } from "../clientPrimaryState";
import { ClientStateBadge } from "../../components/ClientStateBadge";

const base = { kind: "BUYER" as const, status: "CONTACTED" as const, hiddenReason: null, pendingAcceptance: false, deletedAt: null };

/**
 * Владелец 16.11.2026: «удалить все статусы, ничего лишнего». Отметка у клиента
 * появляется только по факту, от которого зависит действие (Корзина, прочее
 * обращение, закрытая сделка, ждёт принятия, причина с сервера). Цветных
 * статусов «Новый/Горячий/Холодный/Потерян/В архиве/Неактивный» нет нигде.
 */
describe("client state mark: facts only, no cosmetic statuses", () => {
  it.each(CLIENT_STATUSES.filter((s) => s !== "DEAL_CLOSED"))("status %s alone shows nothing", (status) => {
    expect(clientPrimaryState({ ...base, status })).toBeNull();
    expect(renderToStaticMarkup(<ClientStateBadge client={{ ...base, status }} />)).toBe("");
  });
  // 17.11.2026: client status labels are gone entirely, «Сделка закрыта» included.
  it("closed deal status is not shown as a mark", () => {
    expect(clientPrimaryState({ ...base, status: "DEAL_CLOSED" })).toBeNull();
  });
  it("pending, other and trash have their own marks", () => {
    expect(clientPrimaryState({ ...base, pendingAcceptance: true })?.id).toBe("pending");
    expect(clientPrimaryState({ ...base, kind: "OTHER", pendingAcceptance: true })?.id).toBe("other");
    expect(clientPrimaryState({ ...base, deletedAt: "2026-10-20T07:00:00Z" })?.id).toBe("trashed");
  });
  it("server reason is rendered once with its explanation", () => {
    const html = renderToStaticMarkup(<ClientStateBadge client={{ ...base, status: "HOT",
      hiddenReason: { kind: "escalated", label: "Эскалирован руководителю", detail: "Никто не принял вовремя" } }} />);
    expect(html.replace(/<[^>]*>/g, "")).toBe("Эскалирован руководителю");
    expect(html).not.toContain("Горячий");
    expect(html).toContain("title=");
  });
});
