// All settings responses are synthetic local interceptions; no live configuration or provider requests.
import { test, expect } from '@playwright/test';
for (const width of [1440,390]) {
  for (const mode of ['rollback','canonical','newer']) test(`${width} actual Company ${mode}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 });
    const saved = { companyName: 'Saved name', companySlogan: 'Saved slogan', companyLogoUrl: null, royalScoreEnabled: true };
    let release!: () => void;
    let calls = 0;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/api/v1/**', async route => {
      if (!route.request().url().endsWith('/settings')) throw new Error(`Unexpected fixture request ${route.request().url()}`);
      if (route.request().method() === 'GET') return route.fulfill({ json: saved });
      expect(route.request().method()).toBe('PATCH');
      calls++;
      expect(route.request().postDataJSON()).toEqual({ companyName: 'Submitted name', companySlogan: 'Saved slogan' });
      await waiting;
      return route.fulfill(mode === 'rollback' ? { status: 400, json: { error: 'Synthetic validation rejection' } } : { json: { ...saved, companyName: 'Canonical name' } });
    });
    await page.goto('/tests/fixtures/night-settings-rollback.html');
    const name = page.getByRole('textbox', { name: 'Название агентства' });
    await expect(name).toHaveValue('Saved name');
    await name.fill('Submitted name');
    const save = page.getByRole('button', { name: 'Сохранить', exact: true });
    await save.click();
    await expect.poll(() => calls).toBe(1);
    await expect.poll(() => page.evaluate(() => (window as any).probeClient.getQueryData(['settings']).companyName)).toBe('Submitted name');
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(name).toHaveValue('Submitted name');
    if (mode === 'newer') await name.fill('Newer draft');
    release();
    await expect(save).toBeEnabled();
    const expected = mode === 'rollback' ? 'Submitted name' : mode === 'newer' ? 'Newer draft' : 'Canonical name';
    const observed = await name.inputValue();
    await info.attach('actual-result.json', { body: JSON.stringify({ mode, width, calls, expected, observed, errors },null,2), contentType: 'application/json' });
    console.log(JSON.stringify({ mode, width, calls, expected, observed, errors }));
    await expect(name).toHaveValue(expected);
  });
}

for (const width of [1440,390]) test(`${width} actual default toggle optimistic then rollback`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 900 });
  let release!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  let calls = 0;
  await page.route('**/api/v1/**', async route => {
    expect(route.request().url()).toMatch(/\/settings$/);
    if (route.request().method() === 'GET') return route.fulfill({ json: { companyName: 'Saved name', companySlogan: 'Saved slogan', companyLogoUrl: null, royalScoreEnabled: true } });
    calls++;
    expect(route.request().postDataJSON()).toEqual({ royalScoreEnabled: false });
    await waiting;
    return route.fulfill({ status: 400, json: { error: 'Synthetic toggle rejection' } });
  });
  await page.goto('/tests/fixtures/night-settings-rollback.html');
  await expect(page.getByRole('textbox', { name: 'Название агентства' })).toHaveValue('Saved name');
  const toggle = page.getByRole('checkbox', { name: 'Модуль Royal Score включён' });
  await expect(toggle).toBeChecked();
  await toggle.uncheck();
  await expect.poll(() => calls).toBe(1);
  await expect(toggle).not.toBeChecked();
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  release();
  await expect(toggle).toBeChecked();
  await info.attach('actual-toggle-result.json', { body: JSON.stringify({ width, calls, optimisticOff: true, rolledBackOn: true }), contentType: 'application/json' });
});
