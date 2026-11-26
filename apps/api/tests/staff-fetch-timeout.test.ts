import { describe, expect, it, vi } from "vitest";

/** Срок скачивания файла клиента для сотрудника (ревью #465): тело на 60–100 МБ по плохому каналу не укладывается в
 *  минуту модельного профиля, поэтому профиль «staff» получает три минуты на всю загрузку. */
const seen = vi.hoisted(() => ({ timeouts: [] as Array<number | undefined> }));
vi.mock("../src/lib/safeFetch.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/safeFetch.js")>();
  return {
    ...actual,
    safeOpen: vi.fn(async (_url: string, options: { timeoutMs?: number } = {}) => {
      seen.timeouts.push(options.timeoutMs);
      return { res: new Response(new Uint8Array(10), { headers: { "content-type": "image/jpeg" } }) } as never;
    }),
  };
});
const { fetchAttachments, STAFF_FETCH_TIMEOUT_MS } = await import("../src/messengers/attachments.js");

describe("срок скачивания по профилю", () => {
  it("модель — прежняя минута, сотрудник — три минуты", async () => {
    seen.timeouts = [];
    await fetchAttachments([{ url: "https://cdn.example/a.jpg" }]);
    await fetchAttachments([{ url: "https://cdn.example/b.jpg" }], undefined, 10, "staff");
    expect(seen.timeouts[0]).toBe(60_000);
    expect(seen.timeouts[1]).toBe(STAFF_FETCH_TIMEOUT_MS);
    expect(STAFF_FETCH_TIMEOUT_MS).toBe(180_000);
  });
});
