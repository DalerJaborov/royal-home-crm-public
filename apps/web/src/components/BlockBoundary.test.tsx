// @vitest-environment jsdom
/**
 * Граница блока главной: кусок сборки не загрузился — не «Повторить», а
 * «Обновить страницу»; «Повторить» перезапрашивает только упавшее и устаревшее
 * и заблокирована, пока запрос идёт (ревью #319, 20.11.2026).
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RoyalBlock } from "./look/RoyalBlock";
import { CleanBlock } from "./clean/CleanBlock";

function swallowJournal(event: ErrorEvent) {
  event.preventDefault();
  event.stopImmediatePropagation();
}
beforeEach(() => {
  window.addEventListener("error", swallowJournal, true);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  window.removeEventListener("error", swallowJournal, true);
  cleanup();
  vi.restoreAllMocks();
});

const chunkFailure = () => { throw new Error("Failed to fetch dynamically imported module: https://crm/assets/PultClean-Cbv4Qzsu.js"); };
const dataFailure = () => { throw new TypeError("Cannot read properties of undefined (reading 'count')"); };

describe("граница блока главной", () => {
  it("кусок сборки не загрузился — «Вышла новая версия» и «Обновить страницу», без бесполезного «Повторить»", () => {
    const client = new QueryClient();
    render(<QueryClientProvider client={client}>
      <RoyalBlock name="today.money" span="wide">{chunkFailure}</RoyalBlock>
      <CleanBlock name="pult.kpis" title="Показатели дня">{chunkFailure}</CleanBlock>
    </QueryClientProvider>);
    expect(screen.getAllByText(/Вышла новая версия/)).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: "Обновить страницу" })).toHaveLength(2);
    expect(screen.queryByRole("button", { name: "Повторить" })).toBeNull();
  });

  it("ошибка данных — «Не загрузилось» и «Повторить»; заглушка встаёт в клетку блока", () => {
    const client = new QueryClient();
    const { container } = render(<QueryClientProvider client={client}>
      <RoyalBlock name="today.money" span="wide">{dataFailure}</RoyalBlock>
      <RoyalBlock name="today.decisions" span="a">{dataFailure}</RoyalBlock>
    </QueryClientProvider>);
    expect(screen.getAllByText("Не загрузилось")).toHaveLength(2);
    const failed = container.querySelectorAll(".ry-block-failed");
    expect(failed[0].getAttribute("data-span")).toBe("wide");
    expect(failed[1].classList.contains("ry-col-a")).toBe(true);
  });

  it("«Повторить» перезапрашивает упавшее и устаревшее, но не свежее, и заблокирована, пока запрос идёт", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    let release: () => void = () => undefined;
    const staleFn = vi.fn(() => new Promise<string>((resolve) => { release = () => resolve("ok"); }));
    const freshFn = vi.fn(async () => "fresh");
    let broken = true;
    function Readers() {
      useQuery({ queryKey: ["stale"], queryFn: staleFn, staleTime: 0 });
      useQuery({ queryKey: ["fresh"], queryFn: freshFn, staleTime: Infinity });
      return null;
    }
    render(<QueryClientProvider client={client}>
      <Readers />
      <RoyalBlock name="today.money" span="wide">{() => { if (broken) dataFailure(); return <p>Комиссия</p>; }}</RoyalBlock>
    </QueryClientProvider>);
    await act(async () => { release(); });
    await waitFor(() => expect(client.getQueryState(["fresh"])?.status).toBe("success"));
    const staleCalls = staleFn.mock.calls.length;
    const freshCalls = freshFn.mock.calls.length;

    broken = false;
    fireEvent.click(screen.getByRole("button", { name: "Повторить" }));
    const button = screen.getByRole("button", { name: "Повторить" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button); // второй клик во время запроса ничего не добавляет
    expect(staleFn.mock.calls.length).toBe(staleCalls + 1);
    expect(freshFn.mock.calls.length).toBe(freshCalls);

    await act(async () => { release(); });
    await waitFor(() => expect(screen.getByText("Комиссия")).toBeTruthy());
    expect(screen.queryByText("Не загрузилось")).toBeNull();
  });
});
