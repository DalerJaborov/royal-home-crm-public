// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";

const answers = vi.hoisted(() => ({ queue: [] as (Record<string, unknown> | Error)[] }));
vi.mock("../../lib/api", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../lib/api")>(),
  api: async () => {
    const next = answers.queue.shift();
    if (!next || next instanceof Error) throw next ?? new Error("no answer");
    return next;
  },
}));
vi.mock("../useMobileUx", async (importOriginal) => ({ ...await importOriginal<typeof import("../useMobileUx")>(), useMobileUx: () => false }));

import { useAuthStore } from "../../store/auth";
import { useCleanShellSelection } from "../useCleanShell";

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}><MemoryRouter>{children}</MemoryRouter></QueryClientProvider>;
  const hook = renderHook(() => useCleanShellSelection(), { wrapper });
  const recheck = () => act(async () => { await client.refetchQueries({ queryKey: ["ui-shell"] }); });
  return { hook, recheck };
}

beforeEach(() => {
  answers.queue = [];
  window.localStorage.clear();
  useAuthStore.setState({ agent: { id: "owner", fullName: "Тест", role: "ADMIN" } as never });
});

describe("признак «Нового вида» в выборе оболочки", () => {
  it("не мигает при сбое очередной проверки и гаснет по удачному ответу без look", async () => {
    answers.queue.push({ enabled: true, look: "royal" });
    const { hook, recheck } = setup();
    await waitFor(() => expect(hook.result.current.look).toBe("royal"));
    answers.queue.push(new Error("network"));
    await recheck();
    expect(hook.result.current.clean).toBe(true);
    expect(hook.result.current.look).toBe("royal");
    answers.queue.push({ enabled: true });
    await recheck();
    // Перерисовка после удачного ответа может прийти тиком позже: ждём её, а не
    // читаем состояние сразу (в облаке тест падал через раз, 18.11.2026).
    await waitFor(() => expect(hook.result.current.look).toBeUndefined());
  });

  it("без удачного ответа признака нет", async () => {
    answers.queue.push(new Error("network"));
    const { hook } = setup();
    await waitFor(() => expect(hook.result.current.pending).toBe(false));
    expect(hook.result.current.look).toBeUndefined();
    expect(hook.result.current.clean).toBe(false);
  });
});
