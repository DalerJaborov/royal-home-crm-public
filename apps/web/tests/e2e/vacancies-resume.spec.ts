import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const source = { sourceEventKey: "a".repeat(64), quote: "Снимаю видео для местных компаний" };
const candidate = { id: "22222222-2222-4222-8222-222222222222", status: "NEW", name: "Тестовая Ситора с длинным именем", contactName: null,
  phone: "+992000000000", age: null, city: "Душанбе", education: null, experience: null, rawText: "Снимаю видео для местных компаний", languages: "Русский",
  startWhen: null, employedNow: null, studyingNow: null, studyingUniversity: null, priority: null, eligible: null, cvFile: null,
  channel: "INSTAGRAM", createdAt: "2026-10-21T10:00:00Z", interviewAt: null, interviewNote: null, rejectionReason: null, talentPool: false,
  positionTitle: "SMM-специалист / видеограф", positionKey: "smm", customerInquiryId: "test-inquiry",
  recruitmentResume: { version: 1, facts: { about: { value: "Снимаю видео для местных компаний", ...source }, skills: { value: "Видеосъёмка", ...source } } },
  recruitmentAssessment: { missing: ["startWhen"], warnings: [], readyForReview: false }, customerPortfolio: [] };
const options = { sms: { available: true }, assistantCall: { available: true }, clarification: { available: true },
  office: { address: "Тестовый офис, дом 1", mapUrl: null, preparation: null }, language: "ru", recentDeliveries: [] };

async function mockApi(page: Page) {
  const writes: Array<{ path: string; body: Record<string, unknown> }> = [];
  await page.route("**/api/v1/**", async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname.replace("/api/v1", "");
    const body = request.method() === "GET" ? null : request.postDataJSON();
    if (request.method() !== "GET") writes.push({ path, body });
    let response: unknown = {};
    if (path === "/me") response = { id: "11111111-1111-4111-8111-111111111111", role: "DIRECTOR", permissions: ["vacancies.view", "settings.manage"], readOnly: false };
    else if (path === "/me/active-call") response = null;
    else if (path === "/vacancies/positions") response = { items: [{ key: "smm", titleRu: "SMM-специалист / видеограф", isOpen: true }] };
    else if (path === "/vacancies") response = { items: url.searchParams.get("q") ? [] : [candidate], total: url.searchParams.get("q") ? 0 : 1,
      counts: { NEW: 1, REVIEWED: 0, INTERVIEW: 0, INTERVIEWED: 0, HIRED: 0, REJECTED: 0 }, collecting: true, todayInterviews: [], noPhoneCount: 0 };
    else if (path.endsWith("/conversation")) response = { messages: [], files: [], inboxId: null };
    else if (path.endsWith("/contact-options")) response = options;
    else if (path.endsWith("/invitations/preview")) response = { previewId: "33333333-3333-4333-8333-333333333333", text: "Тестовое приглашение. Дата и адрес согласованы.", callSummary: "Один тестовый звонок", expiresAt: new Date(Date.now() + 300_000).toISOString() };
    else if (path.endsWith("/invitations")) response = { interviewSaved: true, deliveries: [{ id: "test-sms", channel: "SMS", status: "QUEUED" }] };
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(response) });
  });
  return writes;
}

for (const width of [1440, 390]) test(`résumé, preview and filter safety at ${width}px`, async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  const writes = await mockApi(page);
  await page.setViewportSize({ width, height: 1000 });
  await page.goto("/tests/fixtures/vacancies-resume.html");
  if (width === 390) await page.getByRole("button", { name: "Открыть анкету: Тестовая Ситора с длинным именем" }).click();
  await expect(page.getByRole("heading", { name: candidate.name, exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Следующий шаг" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const axe = await new AxeBuilder({ page }).include(".vacancies-screen").withTags(["wcag2a", "wcag2aa"]).analyze();
  expect(axe.violations).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath(`resume-${width}.png`), fullPage: true });
  await page.getByRole("button", { name: "Пригласить на собеседование", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Приглашение на собеседование" });
  await expect(dialog).toBeVisible();
  const futureDay = new Date(Date.now() + 86400_000).toISOString().slice(0, 10);
  await dialog.getByLabel("Дата и время собеседования").fill(`${futureDay}T14:00`);
  await dialog.getByRole("button", { name: "Посмотреть приглашение" }).click();
  await expect(dialog.getByText("Тестовое приглашение. Дата и адрес согласованы.")).toBeVisible();
  expect(writes.filter(write => write.path.endsWith("/invitations"))).toHaveLength(0);
  const previewWrite = writes.find(write => write.path.endsWith("/invitations/preview"));
  expect(previewWrite?.body.channels).toEqual(["SMS"]);
  await page.screenshot({ path: testInfo.outputPath(`preview-${width}.png`), fullPage: false });
  await dialog.getByRole("button", { name: "Отправить SMS", exact: true }).click();
  await expect(dialog.getByRole("heading", { name: "Собеседование сохранено" })).toBeVisible();
  await expect(dialog.getByText("В очереди", { exact: true })).toBeVisible();
  expect(writes.filter(write => write.path.endsWith("/invitations"))).toHaveLength(1);
  await dialog.getByRole("button", { name: "Закрыть", exact: true }).last().click();
  if (width === 390) await page.getByRole("button", { name: "К кандидатам", exact: true }).click();
  await page.getByRole("searchbox", { name: "Поиск по анкетам" }).fill("Нет такого кандидата");
  await expect(page.getByRole("button", { name: "Пригласить на собеседование", exact: true })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Ничего не найдено" })).toBeVisible();
  await page.getByRole("button", { name: "Сбросить фильтры", exact: true }).first().click();
  await expect(page.getByRole("button", { name: `Открыть анкету: ${candidate.name}` })).toBeVisible();
  expect(errors).toEqual([]);
});
