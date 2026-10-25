import { describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { renderToStaticMarkup } from 'react-dom/server';
const state = vi.hoisted(() => ({ role: 'ADMIN', permission: true }));
vi.mock('../../store/auth', () => ({ useAuthStore: (select: (v: unknown) => unknown) => select({ agent: { role: state.role } }) }));
vi.mock('../../lib/permissions', () => ({ useCan: () => () => state.permission }));
vi.mock('../../lib/api', () => ({ api: vi.fn() }));
import { WeeklyOperationalPreviewPanel } from './WeeklyOperationalPreviewPanel';
function render(role: string, permission = true) {
  state.role = role; state.permission = permission;
  const client = new QueryClient();
  client.setQueryData(['weekly-operational-preview', 'DEFERRED_AFTER_SHOWING', 1], { total: 1, pageSize: 25, items: [{ id: 'fixture', clientId: 'client', propertyId: 'property', agentName: 'PRIVATE_WEEKLY_SENTINEL', observedAt: '2026-10-25T10:00:00Z', sourceType: 'Interaction' }] });
  return renderToStaticMarkup(<MemoryRouter><QueryClientProvider client={client}><WeeklyOperationalPreviewPanel /></QueryClientProvider></MemoryRouter>);
}
describe('weekly operational preview boundaries', () => {
  it.each(['AGENT', 'MARKETING', 'SECURITY', 'MANAGER'])('does not expose cached private observations to %s', role => { expect(render(role)).toBe(''); });
  it('hides cached observations for revoked ADMIN', () => { expect(render('ADMIN', false)).toBe(''); });
  it.each(['ADMIN', 'DIRECTOR'])('shows %s descriptive facts with coverage limits', role => {
    const html = render(role); expect(html).toContain('PRIVATE_WEEKLY_SENTINEL'); expect(html).toContain('Полнота звонков и переписки неизвестна');
    expect(html).toContain('не меняет уровни проверки'); expect(html).toContain('подтверждённого справочника'); expect(html).not.toContain('С4');
  });
});

