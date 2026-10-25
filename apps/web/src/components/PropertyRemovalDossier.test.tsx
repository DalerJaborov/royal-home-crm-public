import { describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
const state = vi.hoisted(() => ({ role: 'ADMIN', security: true }));
vi.mock('../store/auth', () => ({ useAuthStore: (select: (v: unknown) => unknown) => select({ agent: { role: state.role } }) }));
vi.mock('../lib/permissions', () => ({ useCan: () => () => state.security }));
vi.mock('../lib/api', () => ({ api: vi.fn() }));
import { PropertyRemovalDossier } from './PropertyRemovalDossier';
const render = (role: string, security = true) => {
  state.security = security;
  state.role = role;
  const client = new QueryClient();
  client.setQueryData(['property-removal-dossiers', ['stand-property']], [{ propertyId: 'stand-property', lines: ['PRIVATE_SENTINEL', 'Отправка не подтверждает просмотр.'] }]);
  return renderToStaticMarkup(<QueryClientProvider client={client}><PropertyRemovalDossier propertyIds={['stand-property']} /></QueryClientProvider>);
};
describe('removal dossier privacy and truthful semantics', () => {
  it.each(['AGENT', 'MARKETING', 'EDITOR', 'ROP', 'SECURITY'])('does not render cached private facts or hint for %s', role => {
    expect(render(role)).toBe('');
  });
  it('hides cached facts after ADMIN permission revocation', () => { expect(render('ADMIN', false)).toBe(''); });
  it.each(['ADMIN', 'DIRECTOR'])('shows observed facts to %s without claiming a view or guilt', role => {
    const html = render(role);
    expect(html).toContain('PRIVATE_SENTINEL');
    expect(html).toContain('Отправка не подтверждает просмотр');
    expect(html).toContain('не доказывает нарушение');
  });
});
