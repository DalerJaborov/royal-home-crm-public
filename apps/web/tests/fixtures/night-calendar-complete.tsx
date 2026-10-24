// Actual page/hooks; the spec intercepts synthetic transport only. No database/providers.
import React from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { Calendar } from '../../src/pages/Calendar';
import { useAuthStore } from '../../src/store/auth';
import { initMobileUxFlag } from '../../src/hooks/useMobileUx';
import '../../src/index.css';

initMobileUxFlag();
document.documentElement.dataset.theme = 'royal-home-2026-light';
// AppLayout's screen prerequisite: the desktop prototype otherwise hides screens.
document.documentElement.dataset.screen = 'calendar';
useAuthStore.setState({ agent: { id: 'synthetic-actor', fullName: 'Synthetic actor', phone: 'fixture', role: 'AGENT' }, accessToken: 'synthetic-only', hasSession: true });
const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
createRoot(document.getElementById('root')!).render(<QueryClientProvider client={client}><MemoryRouter initialEntries={['/calendar?date=2026-10-25&shell=legacy']}><Calendar /></MemoryRouter></QueryClientProvider>);
