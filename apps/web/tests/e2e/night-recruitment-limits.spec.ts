import { expect, test } from "@playwright/test";

for (const width of [1440, 390]) {
  test.describe(`actual recruitment fields ${width}px`, () => {
    test.use({ viewport: { width, height: 1000 } });
    for (const mode of ["create", "note", "reject"] as const) {
      test(`${mode}: keeps rejected draft, validates limit and submits corrected value unchanged`, async ({ page }) => {
        const writes: unknown[] = [];
        await page.route("**/api/v1/**", async route => {
          const path = new URL(route.request().url()).pathname;
          if (route.request().method() !== "GET") {
            if (path !== "/api/v1/vacancies" && path !== "/api/v1/vacancies/test-candidate") throw new Error(`Unexpected write ${path}`);
            writes.push(route.request().postDataJSON());
            await route.fulfill({ status: writes.length === 1 ? 400 : 200, json: writes.length === 1 ? { error: "Тестовый отказ" } : { id: "test-created", ok: true } });
          } else await route.fulfill({ json: path === "/api/v1/me" ? { id: "test-director", role: "DIRECTOR", readOnly: false, permissions: ["vacancies.view"] } : path.endsWith("contact-options") ? { recentDeliveries: [], sms: { available: false }, assistantCall: { available: false }, clarification: { available: false } } : null });
        });
        const limit = mode === "reject" ? 500 : 2000;
        await page.goto(`/tests/fixtures/night-recruitment-limits.html?mode=${mode}&length=${limit + 1}`);
        if (mode !== "create") {
          await page.getByRole("button", { name: "Ещё", exact: true }).click();
          await page.getByRole("button", { name: mode === "note" ? "Заметка руководителя" : "Изменить причину отказа" }).click();
        }
        const dialog = page.getByRole("dialog");
        const field = dialog.getByRole("textbox", { name: mode === "create" ? /^Заметка/ : mode === "note" ? /^Внутренняя заметка/ : /^Причина отказа/ });
        await expect(field).toHaveAttribute("maxlength", String(limit));
        if (mode === "create") {
          await dialog.getByLabel("Имя и фамилия *", { exact: true }).fill("Test candidate");
          // Exercise the local guard too: browser input normally blocks new over-limit text.
          await field.evaluate(element => element.removeAttribute("maxlength"));
          await field.fill("x".repeat(limit + 1));
        } else await expect(field).toHaveValue("x".repeat(limit + 1)); // legacy data must never be sliced
        const submit = dialog.getByRole("button", { name: mode === "create" ? "Добавить кандидата" : "Сохранить", exact: true });
        await submit.click();
        await expect(dialog.getByRole("alert")).toContainText(`не больше ${limit}`);
        expect(writes).toEqual([]);
        await expect(field).toHaveValue("x".repeat(limit + 1));
        const corrected = "y".repeat(limit);
        await field.fill(corrected);
        await submit.click();
        await expect(dialog.getByRole("alert")).toContainText("Тестовый отказ");
        await expect(field).toHaveValue(corrected);
        await submit.click();
        await expect(dialog).toHaveCount(0);
        expect(writes).toHaveLength(2);
        const key = mode === "create" ? "note" : mode === "note" ? "interviewNote" : "rejectionReason";
        expect(writes).toEqual([expect.objectContaining({ [key]: corrected }), expect.objectContaining({ [key]: corrected })]);
      });
    }
  });
}
