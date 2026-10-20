import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const BASE = "http://localhost:4172";
const OUT_DIR = path.resolve("docs/ai-greeting-08-09/reports/img");
fs.mkdirSync(OUT_DIR, { recursive: true });

const DIALOG_SEL = '[role="dialog"][aria-label="Приветствие"]';

const devices = [
  { name: "pc", viewport: { width: 1440, height: 900 } },
  { name: "phone", viewport: { width: 390, height: 844 } },
];

async function login(page) {
  await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
  // Step "Рабочий телефон"
  const phoneInput = page.locator("#login-phone");
  await phoneInput.click();
  await phoneInput.fill("992900000003");
  await page.getByRole("button", { name: "Далее" }).click();
  await page.waitForSelector("#login-password", { timeout: 5000 });
  // Step "Пароль"
  const passInput = page.locator("#login-password");
  await passInput.fill("password123");
  await page.getByRole("button", { name: /Войти|Проверяем/ }).click();
  await page.waitForURL((u) => !u.pathname.includes("/login"), { timeout: 15000 });
}

async function clearGreetingKeys(page) {
  await page.evaluate(() => {
    const keys = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith("rh:greeting:")) keys.push(k);
    }
    keys.forEach((k) => localStorage.removeItem(k));
  });
}

async function run() {
  const results = {};
  for (const device of devices) {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: device.viewport });
    await context.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => false });
    });
    const page = await context.newPage();
    await login(page);
    await clearGreetingKeys(page);
    await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });

    // wait for dialog to appear
    await page.waitForSelector(DIALOG_SEL, { state: "attached", timeout: 15000 });
    const appearedAt = Date.now();

    const shots = [300, 1000, 2000, 2800, 3300];
    for (const ms of shots) {
      const wait = appearedAt + ms - Date.now();
      if (wait > 0) await page.waitForTimeout(wait);
      const file = path.join(OUT_DIR, `N2a-${device.name}-${ms}.png`);
      await page.screenshot({ path: file });
    }

    // measure total visible duration
    await page.waitForSelector(DIALOG_SEL, { state: "detached", timeout: 15000 });
    const disappearedAt = Date.now();
    const durationMs = disappearedAt - appearedAt;
    results[device.name] = { durationMs };

    // reload -> confirm splash does not reappear
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1500);
    const reappeared = await page.locator(DIALOG_SEL).count();
    results[device.name].reappearedAfterReload = reappeared > 0;

    // clear key again, reload, press Escape at 800ms, screenshot at +150ms after Escape
    await clearGreetingKeys(page);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector(DIALOG_SEL, { state: "attached", timeout: 15000 });
    const appeared2 = Date.now();
    const escWait = appeared2 + 800 - Date.now();
    if (escWait > 0) await page.waitForTimeout(escWait);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(150);
    const escFile = path.join(OUT_DIR, `N2a-${device.name}-esc150.png`);
    await page.screenshot({ path: escFile });
    // confirm it eventually closes
    await page.waitForSelector(DIALOG_SEL, { state: "detached", timeout: 15000 }).catch(() => {});
    const closedAfterEsc = (await page.locator(DIALOG_SEL).count()) === 0;
    results[device.name].closedAfterEsc = closedAfterEsc;

    await browser.close();
  }
  fs.writeFileSync(
    path.resolve("docs/ai-greeting-08-09/reports/N2a-results.json"),
    JSON.stringify(results, null, 2)
  );
  console.log(JSON.stringify(results, null, 2));
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
