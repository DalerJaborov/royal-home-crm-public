import { beforeEach, describe, expect, it, vi } from "vitest";
import { useShellStore } from "../shell";

beforeEach(() => useShellStore.setState({ owner: null, title: null, back: null, onBack: null, actions: null, ownHeader: false }));

describe("shared header back controller", () => {
  it("does not carry a previous screen's custom navigation into the next screen", () => {
    useShellStore.getState().setShell("channel", { title: "Канал", back: "/integrations", onBack: vi.fn() });
    useShellStore.getState().setShell("client", { title: "Клиент", back: "/clients" });
    expect(useShellStore.getState().onBack).toBeNull();
    expect(useShellStore.getState().back).toBe("/clients");
  });
  it("keeps the new screen's history controller when an older screen releases its claim", () => {
    const oldBack = vi.fn(); const currentBack = vi.fn();
    useShellStore.getState().setShell("old", { back: "/", onBack: oldBack });
    useShellStore.getState().setShell("current", { back: "/integrations", onBack: currentBack });
    useShellStore.getState().release("old");
    useShellStore.getState().onBack?.();
    expect(currentBack).toHaveBeenCalledOnce();
    expect(oldBack).not.toHaveBeenCalled();
    useShellStore.getState().release("current");
    expect(useShellStore.getState().onBack).toBeNull();
  });
});
