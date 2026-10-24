import { test, expect, type Page, type TestInfo } from "@playwright/test";
import { clientCreateSchema, clientUpdateSchema } from "@royal-home/shared";

type ClientWrite = { method: string; body: Record<string, unknown> & { desiredPlaces: { radiusM: number }[] } };
type NativeEvent = { type: "submit" | "invalid"; value?: string };

async function prepare(page: Page, mode: "create" | "edit", radius: number) {
  const calls: ClientWrite[] = [];
  await page.route("**/*", async route => {
    const url = new URL(route.request().url());
    // Map tiles/fonts are deliberately unavailable in every control and regression.
    if (url.origin !== "http://127.0.0.1:5211") return route.abort();
    if (!url.pathname.startsWith("/api/v1/")) return route.continue();
    expect(route.request().method()).toBe(url.pathname.startsWith("/api/v1/clients") ? (mode === "edit" ? "PATCH" : "POST") : "GET");
    if (url.pathname.endsWith("/me")) return route.fulfill({ json: { permissions: [], readOnly: false } });
    if (url.pathname.endsWith("/ui-shell")) return route.fulfill({ json: { enabled: false } });
    if (url.pathname.endsWith("/settings")) return route.fulfill({ json: { matchDefaultRadiusM: radius } });
    if (url.pathname.endsWith("/districts")) return route.fulfill({ json: [] });
    if (url.pathname.startsWith("/api/v1/clients")) {
      const body = route.request().postDataJSON();
      const parsed = (mode === "edit" ? clientUpdateSchema : clientCreateSchema).safeParse(body);
      expect(parsed.success).toBe(true);
      calls.push({ method: route.request().method(), body });
      return route.fulfill({ status: mode === "edit" ? 200 : 201, json: { ...body, id: "synthetic-client" } });
    }
    throw new Error(`Unexpected synthetic fixture request: ${url.pathname}`);
  });
  await page.goto(`/tests/fixtures/night-client-radius.html?mode=${mode}&radius=${radius}`);
  if (mode === "create") await page.getByLabel("Имя *", { exact: true }).fill("Synthetic buyer");
  await page.getByRole("button", { name: "Дальше", exact: true }).click();
  if (mode === "create") await page.getByRole("button", { name: "+ Добавить место", exact: true }).click();
  await expect(page.getByLabel("Радиус поиска, м", { exact: true })).toHaveValue(String(radius));
  await page.evaluate(() => {
    const form = document.querySelector<HTMLFormElement>("form[role=dialog]")!;
    const events: NativeEvent[] = [];
    Object.assign(window, { radiusNativeEvents: events });
    form.addEventListener("invalid", event => events.push({ type: "invalid", value: (event.target as HTMLInputElement).value }), true);
    form.addEventListener("submit", () => events.push({ type: "submit" }));
  });
  return calls;
}

function events(page: Page): Promise<NativeEvent[]> {
  return page.evaluate(() => (window as unknown as { radiusNativeEvents: NativeEvent[] }).radiusNativeEvents);
}

async function submitReview(page: Page, mode: "create" | "edit", calls: ClientWrite[], radius: number, info: TestInfo) {
  await page.getByRole("group", { name: "Шаги формы", exact: true }).getByRole("button", { name: "Проверьте", exact: true }).click();
  await page.getByRole("button", { name: mode === "edit" ? "Сохранить" : "Создать клиента", exact: true }).click();
  await expect.poll(() => calls.length).toBe(1);
  expect(calls[0].body.desiredPlaces).toHaveLength(1);
  expect(calls[0].body.desiredPlaces[0].radiusM).toBe(radius);
  await expect(page.getByText("Fixture closed", { exact: true })).toBeVisible();
  await info.attach("actual-client-write.json", { body: JSON.stringify({ radius, calls, events: await events(page) }, null, 2), contentType: "application/json" });
}

for (const width of [1440, 390]) {
  for (const radius of [1250, 1200, 100, 10000]) {
    test(`${width} new configured radius ${radius}: native Next advances without invalid and preserves value`, async ({ page }, info) => {
      await page.setViewportSize({ width, height: 1000 });
      const calls = await prepare(page, "create", radius);
      expect(await page.getByRole("dialog").evaluate(form => (form as HTMLFormElement).noValidate)).toBe(false);
      await page.getByRole("button", { name: "Дальше", exact: true }).click();
      await expect(page.getByLabel("Бюджет от", { exact: true })).toBeVisible();
      expect(await events(page)).toEqual([{ type: "submit" }]);
      await submitReview(page, "create", calls, radius, info);
    });
  }

  test(`${width} stored radius 1250: native Next advances without invalid and preserves value`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 1000 });
    const calls = await prepare(page, "edit", 1250);
    expect(await page.getByRole("dialog").evaluate(form => (form as HTMLFormElement).noValidate)).toBe(false);
    await page.getByRole("button", { name: "Дальше", exact: true }).click();
    await expect(page.getByLabel("Бюджет от", { exact: true })).toBeVisible();
    expect(await events(page)).toEqual([{ type: "submit" }]);
    await submitReview(page, "edit", calls, 1250, info);
  });

  test(`${width} fractional radius is rejected without submit or rounding`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    const calls = await prepare(page, "create", 1250);
    const radius = page.getByLabel("Радиус поиска, м", { exact: true });
    await radius.fill("1250.5");
    expect(clientUpdateSchema.safeParse({ desiredPlaces: [{ lat: 38.57, lng: 68.78, radiusM: 1250.5 }] }).success).toBe(false);
    await page.getByRole("button", { name: "Дальше", exact: true }).click();
    await expect(radius).toHaveValue("1250.5");
    await expect(page.getByLabel("Бюджет от", { exact: true })).not.toBeVisible();
    expect(await events(page)).toEqual([{ type: "invalid", value: "1250.5" }]);
    expect(calls).toHaveLength(0);
  });

  test(`${width} normal review stepbar preserves accepted radius 1250`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 1000 });
    const calls = await prepare(page, "create", 1250);
    expect(await events(page)).toEqual([]);
    await submitReview(page, "create", calls, 1250, info);
    expect(await events(page)).toEqual([{ type: "submit" }]);
  });
}
