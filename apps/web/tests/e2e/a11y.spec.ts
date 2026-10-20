import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { SECTIONS } from "./pages/crm.page";

/**
 * a11y: каждый раздел проходит автоматическую проверку axe (WCAG 2.1 A/AA).
 *
 * Не заменяет ручную проверку клавиатурой/скринридером — axe ловит только то,
 * что механически проверяемо (контраст, роли, подписи полей, дубли id).
 * Часть найденного здесь — накопленный за годы долг, не регрессия конкретной
 * правки: при первом прогоне список нарушений ожидаемо не пуст. Список
 * известных нарушений — не повод гасить проверку целиком: см. `docs/`.
 */

for (const section of SECTIONS) {
  test(`раздел ${section.path} проходит axe (WCAG 2.1 A/AA) @a11y`, async ({ page }) => {
    await page.goto(section.path);
    await expect(page.getByRole("heading", { name: section.heading }).first()).toBeVisible({
      timeout: 15_000,
    });

    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();

    const summary = results.violations
      .map((v) => `${v.id} (${v.impact}): ${v.nodes.length} узлов — ${v.help}`)
      .join("\n");

    expect(results.violations, `axe-нарушения на ${section.path}:\n${summary}`).toEqual([]);
  });
}
