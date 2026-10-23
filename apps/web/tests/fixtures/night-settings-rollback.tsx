// Synthetic settings fixture: every API request is intercepted by its Playwright spec; no providers or database.
import React from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { RoyalScoreToggleSection } from '../../src/pages/settings/TeamTab';
import { CompanySection } from '../../src/pages/settings/AgencyTab';
import { useAuthStore } from '../../src/store/auth';
useAuthStore.setState({ agent: { id: 'synthetic-director', fullName: 'Synthetic director', phone: 'fixture', role: 'DIRECTOR' }, accessToken: 'synthetic-fixture-only', hasSession: true });
const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
Object.assign(window, { probeClient: client });
createRoot(document.getElementById('root')!).render(<QueryClientProvider client={client}><MemoryRouter><CompanySection /><RoyalScoreToggleSection /></MemoryRouter></QueryClientProvider>);


