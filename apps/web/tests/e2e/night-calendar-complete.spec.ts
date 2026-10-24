import { test, expect } from '@playwright/test';

const taskId = '00000000-0000-4000-8000-000000000001';
type Scenario = 'completion error, acknowledge, retry' | 'completion success' | 'edit failure preserves draft';
type TaskWrite = { path: string; body: unknown };

for (const width of [1440, 390]) {
  for (const scenario of ['completion error, acknowledge, retry', 'completion success', 'edit failure preserves draft'] satisfies Scenario[]) {
    test(`${scenario} ${width}`, async ({ page }, info) => {
      await page.setViewportSize({ width, height: 1000 });
      // Calendar groups past days separately; keep the fixture's planned date future.
      await page.clock.setFixedTime(new Date('2026-10-24T07:00:00.000Z'));
      const calls: TaskWrite[] = [];
      const unexpected: string[] = [];
      const external: string[] = [];
      const errors: string[] = [];
      let active = true;
      let release!: () => void;
      const pending = new Promise<void>(resolve => { release = resolve; });
      const task = { id: taskId, clientId: '00000000-0000-4000-8000-000000000002', type: scenario === 'edit failure preserves draft' ? 'SHOWING' : 'CALL', notes: 'Synthetic original', nextAction: 'Synthetic planned task', nextActionDate: '2026-10-25T10:00:00.000Z', completedAt: null, client: { shortId: 1, fullName: 'Synthetic client', phone: null }, property: null };
      page.on('pageerror', error => errors.push(error.message));
      await page.route('**/*', async route => {
        const request = route.request();
        const url = new URL(request.url());
        if (url.origin !== 'http://127.0.0.1:5214') { external.push(url.origin); return route.abort(); }
        if (!url.pathname.startsWith('/api/v1/')) return route.continue();
        const path = url.pathname.slice('/api/v1'.length);
        if (path === '/ui-shell' && request.method() === 'GET') return route.fulfill({ json: { enabled: false } });
        if (path === '/dashboard/counters/seen' && request.method() === 'POST') return route.fulfill({ json: { ok: true } });
        if (path === '/calendar/tasks' && request.method() === 'GET') return route.fulfill({ json: active ? [task] : [] });
        if (path === `/interactions/${taskId}/complete` && request.method() === 'PATCH') {
          calls.push({ path, body: request.postDataJSON() });
          await pending;
          if (scenario === 'completion success' || calls.length === 2) {
            active = false;
            return route.fulfill({ json: { ...task, completedAt: '2026-10-25T10:00:00.000Z' } });
          }
          return route.fulfill({ status: 500, json: { error: 'Synthetic completion failed' } });
        }
        if (path === `/interactions/${taskId}/showing/reschedule` && request.method() === 'PATCH') {
          calls.push({ path, body: request.postDataJSON() });
          await pending;
          return route.fulfill({ status: 400, json: { error: 'Synthetic reschedule rejected' } });
        }
        unexpected.push(`${request.method()} ${path}`);
        return route.fulfill({ status: 500, json: { error: 'Unexpected synthetic endpoint' } });
      });
      await page.goto('/tests/fixtures/night-calendar-complete.html');
      await page.getByRole('tab', { name: 'День', exact: true }).click();
      const planned = page.getByText('Synthetic planned task', { exact: true });
      await expect(planned).toBeVisible();

      if (scenario === 'edit failure preserves draft') {
        await page.getByRole('button', { name: 'Перенести', exact: true }).click();
        const date = page.getByLabel('Новое время показа');
        const reason = page.getByLabel('Причина переноса');
        const save = page.getByRole('button', { name: 'Сохранить', exact: true });
        await date.fill('2026-10-26T16:35');
        await reason.fill('x');
        await expect(save).toBeDisabled();
        expect(calls).toHaveLength(0);
        await reason.fill('Synthetic revised reason');
        await save.click();
        await expect.poll(() => calls.length).toBe(1);
        await expect(save).toBeDisabled();
        release();
        await expect(page.getByRole('alert')).toContainText('Synthetic reschedule rejected');
        await expect(date).toHaveValue('2026-10-26T16:35');
        await expect(reason).toHaveValue('Synthetic revised reason');
        expect(calls[0].body).toEqual({ at: '2026-10-26T11:35:00.000Z', reason: 'Synthetic revised reason' });
      } else {
        const done = page.getByRole('button', { name: 'Сделано', exact: true });
        await done.click();
        await expect.poll(() => calls.length).toBe(1);
        release();
        if (scenario === 'completion error, acknowledge, retry') {
          await expect(page.getByRole('alert')).toContainText('Synthetic completion failed');
          await expect(planned).toBeVisible();
          await page.getByRole('button', { name: 'Понятно', exact: true }).click();
          await expect(page.getByRole('alert')).toHaveCount(0);
          await expect(planned).toBeVisible();
          expect(calls).toHaveLength(1);
          await done.click();
          await expect.poll(() => calls.length).toBe(2);
        }
        await expect(planned).toHaveCount(0);
      }
      await info.attach('synthetic-task-evidence.json', { body: JSON.stringify({ width, scenario, role: 'AGENT', calls, unexpected, external, errors }, null, 2), contentType: 'application/json' });
      expect(calls).toHaveLength(scenario === 'completion error, acknowledge, retry' ? 2 : 1);
      expect(unexpected).toEqual([]);
      expect(external).toEqual([]);
      expect(errors).toEqual([]);
    });
  }
}
