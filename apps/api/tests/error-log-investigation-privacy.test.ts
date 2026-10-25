import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
const state = vi.hoisted(() => ({ role: 'AGENT', findMany: vi.fn(), count: vi.fn(), update: vi.fn(), updateMany: vi.fn() }));
vi.mock('../src/db.js', async importOriginal => ({ ...await importOriginal<typeof import('../src/db.js')>(), prisma: {
  $disconnect: vi.fn(), errorLog: { findMany: state.findMany, count: state.count, update: state.update, updateMany: state.updateMany },
} }));
vi.mock('../src/auth/middleware.js', async importOriginal => ({ ...await importOriginal<typeof import('../src/auth/middleware.js')>(),
  requireAuth: (req: any, _res: any, next: () => void) => { req.agent = { id: 'actor', role: state.role }; next(); },
  can: () => ['ADMIN', 'DIRECTOR'].includes(state.role),
  requirePermission: () => (_req: any, _res: any, next: () => void) => next(),
}));
vi.mock('../src/lib/systemErrorVisibility.js', async importOriginal => ({ ...await importOriginal<typeof import('../src/lib/systemErrorVisibility.js')>(), visibleErrorLogs: () => ({ findMany: state.findMany, count: state.count, update: state.update, updateMany: state.updateMany }) }));
import { errorLogRouter } from '../src/routes/errorLog.js';
import { visibleSystemErrorWhere } from '../src/lib/investigationOperations.js';
const app = express(); app.use(express.json()); app.use('/errors', errorLogRouter);
beforeEach(() => { vi.clearAllMocks(); state.role = 'AGENT'; state.findMany.mockResolvedValue([]); state.count.mockResolvedValue(0); state.update.mockResolvedValue({}); state.updateMany.mockResolvedValue({ count: 0 }); });
describe('error log override cannot reveal or mutate investigation rows', () => {
  it.each(['AGENT', 'MARKETING', 'ROP', 'SECURITY'])('filters %s list, paging and every count before reading', async role => {
    state.role = role;
    const response = await request(app).get('/errors?page=2&pageSize=5&includeResolved=true');
    expect(response.status).toBe(200);
    const guard = visibleSystemErrorWhere(role);
    expect(state.findMany.mock.calls[0][0]).toMatchObject({ skip: 5, take: 5, where: { AND: expect.arrayContaining([guard]) } });
    expect(state.findMany.mock.calls[1][0].where).toMatchObject(guard);
    expect(state.count.mock.calls[0][0].where).toEqual(state.findMany.mock.calls[0][0].where);
    expect(state.count.mock.calls[1][0].where).toMatchObject(guard);
  });
  it.each(['resolve', 'reopen'])('adds private predicate to direct %s mutation, not only the visible UI', async action => {
    expect((await request(app).post(`/errors/secret-id/${action}`).send({})).status).toBe(204);
    expect(state.update.mock.calls[0][0].where).toEqual({ ...visibleSystemErrorWhere('AGENT'), id: 'secret-id' });
  });
  it('bulk resolve cannot clear private rows', async () => {
    expect((await request(app).post('/errors/resolve-all').send({ scope: 'today' })).status).toBe(200);
    expect(state.updateMany.mock.calls[0][0].where).toMatchObject({ ...visibleSystemErrorWhere('AGENT'), resolvedAt: null, createdAt: { gte: expect.any(Date) } });
  });
  it.each(['ADMIN', 'DIRECTOR'])('keeps %s operational inspection available', async role => {
    state.role = role;
    expect((await request(app).get('/errors')).status).toBe(200);
    expect(state.findMany.mock.calls[1][0].where).not.toHaveProperty('NOT');
    await request(app).post('/errors/secret-id/resolve').send({});
    expect(state.update.mock.calls[0][0].where).toEqual({ id: 'secret-id' });
  });
});
