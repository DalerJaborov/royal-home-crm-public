import { test, expect } from "@playwright/test";
import { contextForRole, type RoleName } from "./pages/roleAuth";

/**
 * СЕТЬ РЕГРЕССИЙ: каждый дефект, найденный руками, становится тестом.
 *
 * 05-06.08.2026 владелец за один вечер нашёл больше дефектов, чем весь набор
 * серверных тестов. Причина была системная: в сиде не существовало ролей
 * маркетинга, монтажёра и СБ, поэтому их рабочий день не проверял никто —
 * ни автотесты, ни живые прогоны. Роль, которой нет в сиде, никто не тестирует.
 *
 * Здесь закреплено то, что было сломано, чтобы оно не вернулось. Каждый тест
 * назван симптомом, который видел человек, а не именем функции в коде.
 */

/** Разделы, закрытые для конвейерных ролей: это работа отдела продаж. */
const SALES_ONLY_PATHS = ["/clients", "/deals", "/sellers"] as const;

test.describe("Роли конвейера не видят чужой работы", () => {
  for (const role of ["MARKETING", "EDITOR"] as const) {
    test(`${role}: в меню нет разделов отдела продаж`, async ({ browser }) => {
      const context = await contextForRole(browser, role);
      const page = await context.newPage();
      await page.goto("/");
      await expect(page.getByRole("heading").first()).toBeVisible();

      // Проверяем именно НАВИГАЦИЮ, а не всю страницу: слово «Клиенты» может
      // встретиться в тексте виджета, и тест бы падал на ровном месте.
      const nav = page.locator("nav");
      await expect(nav.getByRole("link", { name: /^Клиенты$/ })).toHaveCount(0);
      await expect(nav.getByRole("link", { name: /^Сделки$/ })).toHaveCount(0);
      await context.close();
    });

    test(`${role}: прямой ввод адреса не открывает чужой раздел`, async ({ browser }) => {
      const context = await contextForRole(browser, role);
      const page = await context.newPage();
      for (const path of SALES_ONLY_PATHS) {
        await page.goto(path);
        // Либо увело прочь, либо честно сказано, что раздел не для этой роли.
        // Чего быть НЕ должно — рабочего экрана с данными чужого отдела.
        const closed = page.getByText(/недоступен|нет доступа|недостаточно прав/i);
        const leftPage = !new RegExp(path).test(page.url());
        if (!leftPage) await expect(closed.first()).toBeVisible({ timeout: 10_000 });
      }
      await context.close();
    });
  }

  test("MARKETING: кабинет маркетинга открывается и очередь не пустая", async ({ browser }) => {
    const context = await contextForRole(browser, "MARKETING");
    const page = await context.newPage();
    await page.goto("/marketing");
    // Первый ВИДИМЫЙ, а не просто первый: на телефоне подзаголовок ПК-шапки
    // остаётся в разметке, но спрятан темой, и `.first()` цеплялся именно за
    // него (прогон 11.09) — экран при этом честно показывает «Очередь
    // подготовки» ниже.
    await expect(page.getByText(/очередь|подготовк/i).filter({ visible: true }).first()).toBeVisible({
      timeout: 15_000,
    });
    await context.close();
  });

  test("SECURITY: кабинет службы безопасности открывается", async ({ browser }) => {
    const context = await contextForRole(browser, "SECURITY");
    const page = await context.newPage();
    await page.goto("/security");
    await expect(page.getByText(/клиенты в сб|потерянные объекты/i).first()).toBeVisible({
      timeout: 15_000,
    });
    await context.close();
  });
});

test.describe("Одобрять материалы может только модератор", () => {
  test("AGENT не видит кнопок одобрения на объекте, ждущем проверки", async ({ browser }) => {
    const context = await contextForRole(browser, "AGENT");
    const page = await context.newPage();
    await page.goto("/properties?status=PENDING_REVIEW");

    const card = page.getByRole("link", { name: /на проверке/i }).first();
    if ((await card.count()) === 0) {
      test.skip(true, "В базе нет объекта на проверке — нечего проверять");
    }
    await card.click();
    await expect(page.getByRole("button", { name: /^Одобрить/ })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /запросить нов/i })).toHaveCount(0);
    await context.close();
  });
});

test.describe("Назначение показа — про будущее, а не про прошлое", () => {
  test("форма показа спрашивает дату и время, а не «как прошло»", async ({ browser }) => {
    const context = await contextForRole(browser, "AGENT");
    const page = await context.newPage();
    await page.goto("/clients");

    const firstClient = page.getByRole("link").filter({ hasText: /\+992/ }).first();
    if ((await firstClient.count()) === 0) {
      test.skip(true, "Нет клиентов в базе");
    }
    await firstClient.click();

    const matchBtn = page.getByRole("button", { name: /подобрать объект|выбрать объект/i }).first();
    if ((await matchBtn.count()) === 0) {
      test.skip(true, "У клиента нет кнопки подбора");
    }
    await matchBtn.click();

    const scheduleBtn = page.getByRole("button", { name: /назначить показ/i }).first();
    await scheduleBtn.waitFor({ timeout: 15_000 });
    await scheduleBtn.click();

    // Именно этот симптом видел владелец: открывался мастер «Что было → Как
    // прошло» с вопросом про уже состоявшийся показ.
    await expect(page.getByText(/как прошло/i)).toHaveCount(0);
    await expect(page.getByText(/какой объект показывали/i)).toHaveCount(0);
    // А должна открыться форма планирования с датой и временем.
    await expect(page.getByText(/дата показа/i).first()).toBeVisible({ timeout: 10_000 });
    await context.close();
  });
});

test.describe("Каждая роль открывает свою главную без падения", () => {
  const ROLES: RoleName[] = ["DIRECTOR", "ADMIN", "MANAGER", "AGENT", "MARKETING", "EDITOR", "SECURITY"];
  for (const role of ROLES) {
    test(`${role}: главная отрисовалась`, async ({ browser }) => {
      const context = await contextForRole(browser, role);
      const page = await context.newPage();
      const crashes: string[] = [];
      page.on("pageerror", (e) => crashes.push(e.message));
      await page.goto("/");
      // ErrorBoundary рисует этот текст, когда экран упал.
      await expect(page.getByText("Что-то пошло не так")).toHaveCount(0);
      await expect(page.getByRole("heading").first()).toBeVisible({ timeout: 15_000 });
      expect(crashes, `Необработанные ошибки у роли ${role}: ${crashes.join(" | ")}`).toHaveLength(0);
      await context.close();
    });
  }
});
