import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { resolvePermissions, parsePermissionOverrides, type Role } from '@royal-home/shared';
import request from 'supertest';
const state = vi.hoisted(() => ({ role: 'ADMIN', security: true, phone: true, dossier: vi.fn() }));
vi.mock('../src/auth/middleware.js', async importOriginal => ({ ...await importOriginal<typeof import('../src/auth/middleware.js')>(),
  requireAuth: (req: any, _res: any, next: () => void) => { req.agent = { id: 'stand-actor', role: state.role, permissions: resolvePermissions(state.role as Role, parsePermissionOverrides({ granted: [], revoked: [...(!state.security ? ['clients.securityReview'] : []), ...(!state.phone ? ['clients.viewPhone'] : [])] })) }; next(); } }));
vi.mock('../src/lib/propertyDeleteDossier.js', async importOriginal => ({ ...await importOriginal<typeof import('../src/lib/propertyDeleteDossier.js')>(), buildPropertyDeleteDossiers: state.dossier }));
import { propertyRemovalDossierRouter } from '../src/routes/properties/removalDossier.js';
const app = express(); app.use(express.json()); app.use('/properties', propertyRemovalDossierRouter);
const id = '00000000-0000-4000-8000-000000000021';
beforeEach(() => { vi.clearAllMocks(); state.role = 'ADMIN'; state.security = true; state.phone = true; state.dossier.mockResolvedValue(new Map([[id, { exposuresCount: 1, lines: ['Отправка не подтверждает просмотр.'] }]])); });
describe('shared removal dossier role ceiling', () => {
  it.each(['AGENT', 'MARKETING', 'EDITOR', 'ROP', 'SECURITY'])('denies %s before reading private history', async role => {
    state.role = role;
    expect((await request(app).post('/properties/removal-dossiers').send({ propertyIds: [id] })).status).toBe(403);
    expect(state.dossier).not.toHaveBeenCalled();
  });
  it.each(['ADMIN', 'DIRECTOR'])('allows %s with exposure semantics and deduplicates IDs', async role => {
    state.role = role;
    const result = await request(app).post('/properties/removal-dossiers').send({ propertyIds: [id, id] });
    expect(result.status).toBe(200); expect(result.body.items).toHaveLength(1);
    expect(result.body.items[0]).toMatchObject({ propertyId: id, exposuresCount: 1 });
    expect(state.dossier).toHaveBeenCalledWith([id]);
  });
  it('denies revoked ADMIN before private reads', async () => {
    state.security = false;
    expect((await request(app).post('/properties/removal-dossiers').send({ propertyIds: [id] })).status).toBe(403);
    expect(state.dossier).not.toHaveBeenCalled();
  });
  it('masks embedded phones without destroying timestamp fields', async () => {
    state.phone = false;
    state.dossier.mockResolvedValue(new Map([[id, { lastShowingAt: new Date('2026-10-25T10:00:00Z'), lastShowingClientName: 'Client +992901234567', lastShowingAgentName: '+992901234567', sellerProbeOutcome: null, lines: ['Call +992901234567'] }]]));
    const result = await request(app).post('/properties/removal-dossiers').send({ propertyIds: [id] });
    expect(result.status).toBe(200); expect(JSON.stringify(result.body)).not.toContain('901234567');
    expect(result.body.items[0].lastShowingAt).toBe('2026-10-25T10:00:00.000Z');
  });
  it('validates IDs and bounded batch before calculation', async () => {
    expect((await request(app).post('/properties/removal-dossiers').send({ propertyIds: ['invalid'] })).status).toBe(400);
    expect((await request(app).post('/properties/removal-dossiers').send({ propertyIds: Array(101).fill(id) })).status).toBe(400);
    expect(state.dossier).not.toHaveBeenCalled();
  });
});
