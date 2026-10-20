import { test, expect } from "@playwright/test";

for (const theme of ["light", "night"]) for (const width of [360, 390, 768, 1024, 1440]) {
  test(`Clean static surfaces ${width} ${theme}`, async ({ page }, testInfo) => {
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
    await page.setViewportSize({ width, height: 1000 });
    await page.goto(`/tests/fixtures/clean-surfaces.html?theme=${theme}`);
    await expect(page.getByRole("heading", { name: "Проверка поверхностей" })).toBeVisible();
    await expect(page.getByTestId("counter")).toHaveText("12345");
    await expect(page.getByTestId("money")).toContainText("23");
    await expect(page.getByTestId("entrance")).toHaveCSS("opacity", "1");
    await expect(page.getByTestId("entrance")).toHaveCSS("transform", "none");
    const expectedCardColor = theme === "light" ? "rgb(255, 255, 255)" : "rgb(28, 31, 36)";
    await expect(page.locator(".clean-kpi")).toHaveCount(3);
    for (const kpi of await page.locator(".clean-kpi").all()) {
      await expect(kpi).toHaveCSS("background-color", expectedCardColor);
      await expect(kpi).toHaveCSS("border-top-width", "1px");
      await expect(kpi.locator(".clean-kpi-label")).toBeVisible();
      const gap = await kpi.evaluate(node => node.querySelector(".clean-kpi-label")!.getBoundingClientRect().left - node.querySelector(".clean-kpi-icon")!.getBoundingClientRect().right);
      expect(gap).toBeGreaterThanOrEqual(8);
    }
    await expect(page.locator(".clean-channel-detail .clean-card")).toHaveCSS("border-top-width", "1px");
    const headingGeometry = await page.getByTestId("heading-stress").evaluate(node => {
      const outer = node.getBoundingClientRect();
      const items = [...node.querySelectorAll("h3,.clean-card-heading > span,button")].map(item => item.getBoundingClientRect());
      return {
        contained: items.every(rect => rect.left >= outer.left && rect.right <= outer.right),
        overlaps: items.flatMap((a, i) => items.slice(i + 1).filter(b =>
          Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 &&
          Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1)).length,
      };
    });
    expect(headingGeometry).toEqual({ contained: true, overlaps: 0 });
    const iconText = page.locator(".clean-icon-text");
    const geometry = await iconText.evaluate(node => {
      const icon = node.querySelector("svg")!.getBoundingClientRect();
      const text = node.querySelector("span")!.getBoundingClientRect();
      return { iconRight: icon.right, textLeft: text.left, iconTop: icon.top, iconBottom: icon.bottom, textTop: text.top, textBottom: text.bottom };
    });
    expect(geometry.textLeft - geometry.iconRight).toBeGreaterThanOrEqual(5);
    expect(geometry.iconBottom).toBeGreaterThan(geometry.textTop);
    expect(geometry.textBottom).toBeGreaterThan(geometry.iconTop);
    for (const chip of await page.locator(".clean-channel-state").all()) {
      const gap = await chip.evaluate(node => node.querySelector("span")!.getBoundingClientRect().left - node.querySelector("svg")!.getBoundingClientRect().right);
      expect(gap).toBeGreaterThanOrEqual(5);
    }
    await page.screenshot({ path: testInfo.outputPath(`layout-${width}-${theme}.png`), fullPage: true });
    for (const slot of ["people", "description"]) {
      const wrapper = slot === "description" ? `.clean-property-slot[data-record-area="${slot}"] .rh-pcard-desc` : `.clean-property-slot[data-record-area="${slot}"]`;
      await expect(page.locator(wrapper)).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
      await expect(page.locator(wrapper)).toHaveCSS("padding", "0px");
    }
    const actions = page.locator(".clean-property-actions > button");
    await expect(actions).toHaveCount(3);
    for (const button of await actions.all()) {
      // Hover auto-scrolls an offscreen target; settle that deliberate scroll
      // before comparing geometry so it is not mistaken for hover motion.
      await button.scrollIntoViewIfNeeded();
      const before = await button.boundingBox();
      await button.hover();
      const after = await button.boundingBox();
      expect(after).toEqual(before);
      expect(after!.height).toBeGreaterThanOrEqual(44);
      expect(after!.x).toBeGreaterThanOrEqual(0);
      expect(after!.x + after!.width).toBeLessThanOrEqual(width + 1);
    }
    await page.getByRole("button", { name: "Назначить показ" }).click();
    await expect(page.getByRole("status")).toHaveCount(1);
    await expect(page.locator("output")).toHaveText("Показ");
    await page.getByRole("button", { name: "Открыть окно", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Тестовое окно", exact: true });
    await expect(dialog).toBeVisible();
    const surface = await dialog.evaluate(node => {
      const css = getComputedStyle(node); return { background: css.backgroundColor, border: css.borderTopWidth, transition: css.transitionDuration, animation: css.animationName, blur: css.backdropFilter };
    });
    expect(surface.background).toMatch(/^rgb\(/);
    expect(surface.border).toBe("1px"); expect(surface.transition).toBe("0s");
    expect(surface.animation).toBe("none"); expect(surface.blur).toBe("none");
    await page.screenshot({ path: testInfo.outputPath(`surface-${width}-${theme}.png`), fullPage: false });
    await dialog.getByRole("button", { name: "Открыть вложенное окно" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(2);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "Вложенное окно", exact: true })).toHaveCount(0);
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Отмена", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect(await page.evaluate(() => document.getAnimations().length)).toBe(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
    expect(errors).toEqual([]);
  });
}

for (const theme of ["light", "night"]) for (const width of [360, 390]) test(`Property two-action permissions ${width} ${theme}`, async ({ page }) => {
  await page.setViewportSize({ width, height: 844 });
  await page.goto(`/tests/fixtures/clean-surfaces.html?theme=${theme}&actions=two`);
  const actions = page.locator(".clean-property-actions > button");
  await expect(actions).toHaveCount(2);
  for (const button of await actions.all()) {
    expect(await button.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
    const box = await button.boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(44);
    expect(box!.x + box!.width).toBeLessThanOrEqual(width);
  }
  await page.getByRole("button", { name: "Назначить показ" }).click();
  await expect(page.locator("output")).toHaveText("Показ");
});

test("Legacy surfaces retain their original card wrapper and device motion preference", async ({ page }) => {
  await page.goto("/tests/fixtures/clean-surfaces.html?shell=legacy");
  await expect(page.getByRole("heading", { name: "Проверка поверхностей" })).toBeVisible();
  await expect(page.locator("html")).not.toHaveAttribute("data-shell", "clean");
  expect(await page.locator("html").evaluate(node => getComputedStyle(node).getPropertyValue("--c-card"))).toContain("0.84");
});
