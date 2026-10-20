import React, { Children, isValidElement, type ReactElement, type ReactNode, type SelectHTMLAttributes } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { CleanInboxFilters } from "./CleanInboxFilters";

const accounts = [
  { id: "ig-one", title: "Royal Home", channel: "INSTAGRAM" },
  { id: "ig-two", title: "Royal Home Info", channel: "INSTAGRAM" },
  { id: "fb", title: "Royal Home", channel: "FACEBOOK" },
];
function fixture(overrides: Partial<Parameters<typeof CleanInboxFilters>[0]> = {}) {
  return { channels: ["INSTAGRAM", "WHATSAPP", "NEW_CHANNEL"], accounts, channel: undefined, accountId: undefined,
    onChannelChange: vi.fn(), onAccountChange: vi.fn(), ...overrides };
}
function selects(tree: ReactNode): ReactElement<SelectHTMLAttributes<HTMLSelectElement>>[] {
  const result: ReactElement<SelectHTMLAttributes<HTMLSelectElement>>[] = [];
  Children.forEach(tree, (child) => {
    if (!isValidElement<{ children?: ReactNode }>(child)) return;
    if (child.type === "select") result.push(child as ReactElement<SelectHTMLAttributes<HTMLSelectElement>>);
    result.push(...selects(child.props.children));
  });
  return result;
}

describe("Clean native inbox filters", () => {
  it("distinguishes two Instagram accounts and a same-name Facebook account using real channel metadata", () => {
    const html = renderToStaticMarkup(<CleanInboxFilters {...fixture()} />);
    expect(html).toContain("Instagram · Royal Home Info");
    expect(html).toContain("Instagram · Royal Home");
    expect(html).toContain("Facebook · Royal Home");
    expect(html).toContain("New channel");
    expect(html).toContain("Канал переписки");
    expect(html).toContain("Аккаунт компании");
  });

  it("choosing a channel clears the mutually exclusive account filter", () => {
    const props = fixture({ accountId: "ig-one" });
    const select = selects(CleanInboxFilters(props))[0];
    select.props.onChange?.({ target: { value: "WHATSAPP" } } as React.ChangeEvent<HTMLSelectElement>);
    expect(props.onChannelChange).toHaveBeenCalledExactlyOnceWith("WHATSAPP");
    expect(props.onAccountChange).toHaveBeenCalledExactlyOnceWith(undefined);
  });

  it("all accounts resets the account and channel together without a fabricated account ID", () => {
    const props = fixture({ accountId: "ig-one", channel: "INSTAGRAM" });
    const select = selects(CleanInboxFilters(props))[1];
    select.props.onChange?.({ target: { value: "" } } as React.ChangeEvent<HTMLSelectElement>);
    expect(props.onAccountChange).toHaveBeenCalledExactlyOnceWith(undefined);
    expect(props.onChannelChange).toHaveBeenCalledExactlyOnceWith(undefined);
  });

  it("preserves a selected account missing from refreshed metadata and offers a way to clear it", () => {
    const html = renderToStaticMarkup(<CleanInboxFilters {...fixture({ accounts: [], accountId: "previous-account" })} />);
    expect(html).toContain('value="previous-account" selected=""');
    expect(html).toContain("Выбранный аккаунт");
    expect(html).toContain("Все аккаунты");
  });

  it("does not add an unnecessary account selector when only one account exists", () => {
    const html = renderToStaticMarkup(<CleanInboxFilters {...fixture({ accounts: [accounts[0]] })} />);
    expect(html).not.toContain("Аккаунт компании");
  });
});
