// Actual Notifications page, shared queryClient and Toasts; synthetic transport only.
import React from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { Notifications } from '../../src/pages/Notifications';
import { queryClient } from '../../src/lib/queryClient';
import { Toasts } from '../../src/components/Toasts';
import { useToastStore } from '../../src/store/toast';
import { useAuthStore } from '../../src/store/auth';
import { initMobileUxFlag } from '../../src/hooks/useMobileUx';
import '../../src/index.css';

initMobileUxFlag();
document.documentElement.dataset.theme = 'royal-home-2026-light';
document.documentElement.dataset.screen = 'notifications';
useAuthStore.setState({ agent: { id: 'synthetic-actor', fullName: 'Synthetic Agent', phone: 'fixture', role: 'AGENT' }, accessToken: 'synthetic-only', hasSession: true });
Object.assign(window, { notificationProbeClient: queryClient, notificationProbeToasts: useToastStore });
createRoot(document.getElementById('root')!).render(<QueryClientProvider client={queryClient}><MemoryRouter initialEntries={['/notifications']}><Notifications /><Toasts /></MemoryRouter></QueryClientProvider>);
