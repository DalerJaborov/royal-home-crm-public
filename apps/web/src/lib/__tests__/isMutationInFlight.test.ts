import { QueryClient, MutationObserver } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { isMutationInFlight } from "../isMutationInFlight";

/**
 * См. комментарий в isMutationInFlight.ts: второй сигнал «занят» для
 * принудительного обновления PWA, рядом с isUserActivelyTyping.test.ts.
 *
 * MutationObserver — тот же публичный механизм, что использует useMutation
 * внутри; тест не тянет React/рендер, только query-core.
 */
describe("isMutationInFlight", () => {
  it("нет мутаций — не занят", () => {
    const client = new QueryClient();
    expect(isMutationInFlight(client)).toBe(false);
  });

  it("мутация выполняется — занят, после завершения — снова свободен", async () => {
    const client = new QueryClient();
    let resolveMutation: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => {
      resolveMutation = resolve;
    });

    const observer = new MutationObserver(client, {
      mutationFn: () => pending,
    });
    const result = observer.mutate();

    // Дать очереди микрозадач применить onMutate/переход в pending, прежде чем проверять.
    await Promise.resolve();
    expect(isMutationInFlight(client)).toBe(true);

    resolveMutation?.();
    await result;
    expect(isMutationInFlight(client)).toBe(false);
  });

  it("упавшая мутация не остаётся висеть в счётчике", async () => {
    const client = new QueryClient();
    const observer = new MutationObserver(client, {
      mutationFn: () => Promise.reject(new Error("boom")),
    });
    await observer.mutate().catch(() => {});
    expect(isMutationInFlight(client)).toBe(false);
  });
});
