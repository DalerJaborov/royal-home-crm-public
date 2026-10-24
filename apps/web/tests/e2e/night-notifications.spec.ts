import { test, expect, type Page } from '@playwright/test';

const notificationId = '00000000-0000-4000-8000-000000000001';
type RequestObservation = { method: string; path: string; query?: string; body?: unknown };
type ProbeWindow = Window & {
  notificationProbeClient: typeof import('../../src/lib/queryClient').queryClient;
  notificationProbeToasts: typeof import('../../src/store/toast').useToastStore;
};

async function observe(page: Page) {
  return page.evaluate(() => {
    const probe = window as unknown as ProbeWindow;
    return {
      cache: probe.notificationProbeClient.getQueryData<{ unreadCount: number; items: { read: boolean }[] }>(['notifications']),
      toasts: probe.notificationProbeToasts.getState().toasts,
      mutations: probe.notificationProbeClient.getMutationCache().getAll().map(mutation => ({ status: mutation.state.status, message: mutation.state.error?.message, meta: mutation.options.meta })),
      body: document.body.innerText,
    };
  });
}

for (const width of [1440, 390]) {
  for (const scenario of ['empty', 'load error', 'manual read error acknowledgment and retry', 'own notification open success']) {
    test(`${scenario} ${width}`, async ({ page }, info) => {
      await page.setViewportSize({ width, height: 1000 });
      await page.clock.setFixedTime(new Date('2026-10-24T07:00:00.000Z'));
      const calls: RequestObservation[] = [];
      const unexpected: string[] = [];
      const external: string[] = [];
      const errors: string[] = [];
      let read = false;
      let manualAttempts = 0;
      let release!: () => void;
      const pending = new Promise<void>(resolve => { release = resolve; });
      const item = { id: notificationId, agentId: 'synthetic-actor', kind: 'task', level: 'CRITICAL', title: 'Synthetic own notification', body: 'Synthetic task note', url: null, count: 1, read: false, createdAt: '2026-10-24T06:00:00.000Z' };
      page.on('pageerror', error => errors.push(error.message));
      await page.route('**/*', async route => {
        const request = route.request();
        const url = new URL(request.url());
        if (url.origin !== 'http://127.0.0.1:5217') { external.push(url.origin); return route.abort(); }
        if (!url.pathname.startsWith('/api/v1/')) return route.continue();
        const path = url.pathname.slice('/api/v1'.length);
        if (path === '/clients' && request.method() === 'GET') return route.fulfill({ json: { items: [], total: 0, page: 1, pageSize: 100, totalPages: 0 } });
        if (path === '/me/notifications' && request.method() === 'GET') {
          calls.push({ method: 'GET', path, query: url.search });
          if (scenario === 'load error') return route.fulfill({ status: 400, json: { error: 'Synthetic load rejected' } });
          const empty = scenario === 'empty';
          const value = { ...item, read };
          return route.fulfill({ json: { items: empty ? [] : [value], pinned: empty || read ? [] : [value], unreadCount: empty || read ? 0 : 1, approvalCount: 0, criticalCount: empty || read ? 0 : 1, hasMore: false } });
        }
        if ((path === '/me/notifications/read-all' || path === `/me/notifications/${notificationId}/read`) && request.method() === 'POST') {
          calls.push({ method: 'POST', path, body: request.postDataJSON() });
          await pending;
          if (path === '/me/notifications/read-all' && ++manualAttempts === 1) return route.fulfill({ status: 400, json: { error: 'Synthetic manual read rejected' } });
          read = true;
          return route.fulfill({ json: { ok: true } });
        }
        unexpected.push(`${request.method()} ${path}`);
        return route.fulfill({ status: 500, json: { error: 'Unexpected synthetic endpoint' } });
      });

      await page.goto('/tests/fixtures/night-notifications.html');
      if (scenario === 'empty') await expect(page.getByText('Новых уведомлений нет.', { exact: true })).toBeVisible();
      else if (scenario === 'load error') {
        await expect(page.getByText('Не удалось загрузить ленту. Это не значит, что уведомлений нет — попробуйте ещё раз.', { exact: true })).toBeVisible();
        await expect(page.getByRole('button', { name: 'Попробовать снова', exact: true })).toBeVisible();
        await expect(page.getByText('Новых уведомлений нет.', { exact: true })).toHaveCount(0);
      } else {
        await expect(page.getByText(item.title, { exact: true })).toBeVisible();
        const all = page.getByRole('button', { name: 'Прочитать всё', exact: true });
        const manual = scenario === 'manual read error acknowledgment and retry';
        if (manual) await all.click();
        else await page.getByText(item.title, { exact: true }).click();
        await expect.poll(() => calls.filter(call => call.method === 'POST').length).toBe(1);
        if (manual) await expect(all).toBeDisabled();
        release();
        if (manual) {
          await expect.poll(async () => (await observe(page)).mutations.some(mutation => mutation.status === 'error')).toBe(true);
          await expect(all).toBeEnabled();
          const rejected = await observe(page);
          await info.attach('rejected-observation.json', { body: JSON.stringify({ width, scenario, calls, read, rejected, unexpected, external, errors }, null, 2), contentType: 'application/json' });
          expect(rejected.cache?.unreadCount).toBe(1);
          expect(rejected.cache?.items[0].read).toBe(false);
          expect(rejected.toasts).toEqual([]);
          await expect(page.getByRole('alert')).toContainText('Synthetic manual read rejected');
          await page.getByRole('button', { name: 'Понятно', exact: true }).click();
          await expect(page.getByRole('alert')).toHaveCount(0);
          expect((await observe(page)).cache?.unreadCount).toBe(1);
          expect(calls.filter(call => call.method === 'POST')).toHaveLength(1);
          await expect(page.getByText(item.title, { exact: true })).toBeVisible();
          await all.click();
          await expect.poll(() => calls.filter(call => call.method === 'POST').length).toBe(2);
        }
        await expect(all).toBeDisabled();
        await expect.poll(async () => (await observe(page)).cache?.unreadCount).toBe(0);
        expect(read).toBe(true);
      }
      const observed = await observe(page);
      await info.attach('notifications-evidence.json', { body: JSON.stringify({ width, scenario, calls, read, observed, unexpected, external, errors }, null, 2), contentType: 'application/json' });
      expect(calls.filter(call => call.method === 'POST')).toHaveLength(scenario === 'manual read error acknowledgment and retry' ? 2 : scenario === 'own notification open success' ? 1 : 0);
      expect(observed.toasts).toEqual([]);
      expect(unexpected).toEqual([]);
      expect(external).toEqual([]);
      expect(errors).toEqual([]);
    });
  }
}
