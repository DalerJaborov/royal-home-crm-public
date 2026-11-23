import { test as setup, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { authFileFor } from "./pages/crm.page";
import { sessionStillValid } from "./pages/sessionProbe";

/**
 * Вход в CRM один раз на прогон — состояние сессии сохраняется и переиспользуется.
 *
 * У каждого проекта (десктоп/мобильный) СВОЙ файл состояния. Одна сессия на двоих
 * не работает: access-токен живёт в памяти, при загрузке страницы браузер идёт за
 * обновлением по refresh-cookie, и два параллельных проекта наперегонки обновляют
 * один и тот же токен — проигравший получает 401 и улетает на экран входа.
 *
 * Вход по коду (пароли удалены 19.10.2026): API стенда запущен с LOGIN_CODE_DEV_ECHO=1
 * и отдаёт `devCode`, экран подставляет его сам. Учётка берётся из окружения. По умолчанию — та, что создаёт `prisma:seed` для
 * локальной разработки; это не секрет, она лежит в самом сиде. Для прода задайте
 * E2E_PHONE в окружении (и код входа, если стенд не отдаёт devCode).
 */
const phone = process.env.E2E_PHONE ?? "+992900000000";

setup("вход в CRM", async ({ page, browser }, testInfo) => {
  // Проба сохранённой сессии (до 15 с) + вход + возможное ожидание отсчёта кода:
  // на холодном dev-сервере, где Vite собирает модули по первому заходу, 30 с
  // по умолчанию не хватало — setup падал, а с ним весь проект (20.11.2026).
  setup.setTimeout(150_000);
  // Имя проекта у setup-задачи своё, поэтому берём его из зависимостей: файл
  // должен совпасть с тем, что ждёт целевой проект.
  const target = testInfo.project.name.replace(/^setup-/, "");
  const authFile = authFileFor(target);
  fs.mkdirSync(path.dirname(authFile), { recursive: true });

  /**
   * ПОСТОЯННОЕ «УСТРОЙСТВО» НА КАЖДЫЙ ПРОЕКТ — иначе стенд сам себя разлогинивает.
   *
   * Сервер считает устройства по X-Device-Id, который фронт заводит случайным при
   * первом заходе и хранит в localStorage (lib/deviceId.ts). У свежего контекста
   * Playwright localStorage пустой, поэтому КАЖДЫЙ прогон заводил директору новую
   * Session — а живут они неделю. Лимит — три устройства на человека (MAX_DEVICES,
   * lib/sessions.ts), и четвёртая тихо отзывает самую давнюю: посреди прогона у
   * smoke-тестов отваливался refresh, списки застревали на «Загрузка…», и падало
   * по 14-15 тестов при полностью исправном приложении.
   *
   * С постоянным id проект занимает РОВНО ОДНУ строку Session, сколько бы раз его
   * ни гоняли, и вытеснять больше нечего.
   */
  const deviceId = `e2e-${target}`;
  await page.addInitScript((id) => {
    try {
      localStorage.setItem("royal-home-device-id", id);
    } catch {
      // Приватный режим — сервер откатится на UA-эвристику, как и в жизни.
    }
  }, deviceId);

  // Заставка-приветствие (components/ai/GreetingSplash.tsx) — обычная UI-фича,
  // а не то, что e2e должен проверять на каждом прогоне: раньше компонент сам
  // распознавал автоматизацию по navigator.webdriver, теперь это явная настройка.
  // Ставим её тем же способом, что и device-id — до первой навигации, чтобы
  // компонент увидел флаг уже при первом монтировании.
  await page.addInitScript(() => {
    try {
      localStorage.setItem("rh:greeting:skip", "1");
      // Предложение «входить по отпечатку» после входа кодом встало бы между кодом и главной.
      localStorage.setItem("rh:passkey-offer-dismissed", "1");
    } catch {
      // Приватный режим — заставка иногда покажется, тест на неё не завязан.
    }
  });

  // Сохранённую сессию переиспользуем, но только если она РАБОТАЕТ. Возраст файла
  // тут не показатель: сессию мог вытеснить лимит устройств или отозвать смена
  // пароля. Проверяем делом — открываем главную и смотрим, не увело ли на вход.
  // Так мы и не логинимся лишний раз (иначе срабатывает лимитер попыток
  // «Слишком много попыток входа»), и не гоняем тесты с мёртвым состоянием.
  if (fs.existsSync(authFile)) {
    const context = await browser.newContext({ storageState: authFile });
    // Живость решает ответ /auth/refresh, а не адрес сразу после загрузки — см.
    // pages/sessionProbe.ts (чужой chromium.json, Чат 3, 20.11.2026).
    //
    // Живую сессию сохраняем обратно: сервер на каждом refresh перевыпускает
    // cookie с тем же номером сессии и новым сроком (routes/auth.ts, «скользящий
    // срок»), старая годна до своего срока — так файл не стареет между прогонами.
    const stillValid = await sessionStillValid(context, { onValid: () => context.storageState({ path: authFile }).then(() => undefined) });
    await context.close();
    if (stillValid) return;
  }

  await page.goto("/login");
  // Вход по коду (см. pages/Login.tsx): сначала номер и «Получить код», затем код
  // спрашивается на втором шаге. Раньше setup заполнял оба поля на одном экране
  // и падал по таймауту на подписи «Пароль» — а вместе с ним не выполнялся ВЕСЬ
  // набор e2e, потому что остальные проекты зависят от этого setup-проекта.
  //
  // Ищем поля по видимым подписям, а не по вёрстке: подписи меняются реже, и
  // тест не развалится от смены плейсхолдера или класса.
  await page.getByLabel("Рабочий телефон").fill(phone);
  const getCode = page.getByRole("button", { name: "Получить код", exact: true });
  await getCode.click();

  // Поле кода появляется после ответа сервера; на стенде devCode уже подставлен.
  const codeField = page.getByRole("textbox", { name: /Код из/ });
  // ДВА ПРОЕКТА — ОДИН НОМЕР (20.11.2026). Десктоп и телефон входят одной
  // учёткой и параллельно, а сервер не выдаёт второй код на тот же номер раньше
  // минуты (LOGIN_SMS_RESEND_MS, lib/loginSmsCode.ts) — это защита от
  // СМС-бомбинга, ослаблять её ради стенда нельзя. Проигравший setup видел отсчёт
  // вместо поля кода и падал по таймауту, а с ним весь его проект. Теперь он
  // ждёт конца отсчёта и просит код ещё раз — как сделал бы человек.
  const cooldown = page.getByRole("status").filter({ hasText: /Новый код можно запросить через/ });
  // `.first()`: на шаге кода та же строка отсчёта стоит под полем — оба видны сразу.
  await expect(codeField.or(cooldown).first()).toBeVisible({ timeout: 10_000 });
  if (!(await codeField.isVisible())) {
    await expect(getCode).toBeEnabled({ timeout: 75_000 });
    await getCode.click();
  }
  await expect(codeField).toBeVisible({ timeout: 10_000 });
  await expect(codeField).toHaveValue(/^\d{6}$/, { timeout: 10_000 });
  await page.getByRole("button", { name: "Подтвердить", exact: true }).click();

  // Вошли — приложение увело с /login. Ждём именно смены адреса, а не таймаута:
  // так тест падает с понятной ошибкой, если учётка неверна.
  await expect(page).not.toHaveURL(/\/login/, { timeout: 20_000 });

  await page.context().storageState({ path: authFile });
});
