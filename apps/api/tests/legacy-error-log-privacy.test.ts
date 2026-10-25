import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
const viewer = vi.hoisted(() => ({ id: '', role: 'AGENT', security: true }));
vi.mock('../src/auth/middleware.js', async importOriginal => ({ ...await importOriginal<typeof import('../src/auth/middleware.js')>(),
  requireAuth: (req: any, _res: any, next: () => void) => { req.agent = { id: viewer.id, role: viewer.role }; next(); },
  requirePermission: () => (_req: any, _res: any, next: () => void) => next(), can: () => viewer.role === "DIRECTOR" || viewer.security,
}));
import { prisma } from '../src/db.js';
import { errorLogRouter } from '../src/routes/errorLog.js';
import { visibleErrorLogs, errorLogWhereSql } from '../src/lib/systemErrorVisibility.js';
const app = express(); app.use(express.json()); app.use('/errors', errorLogRouter);
const run = `legacy-errors-${Date.now()}-${Math.random().toString(36).slice(2)}`;
let clientId: string; let privateCallId: string; let publicCallId: string;
let baselineCount: number; let baselineWeek: number;
const jobs: string[] = []; const privateIds: string[] = []; const publicIds: string[] = [];
const transcriptText = (id: string) => `Разговор ${id} так и не расшифрован после всех попыток — запись на станции цела, можно повторить вручную`;
const recordingText = (id: string) => `Разговор ${id} был отвечен, но запись так и не нашлась на станции после всех попыток — проверьте MixMonitor и туннель до АТС`;
beforeAll(async () => {
  viewer.id = (await prisma.agent.create({ data: { fullName: run, phone: run, passwordHash: 'test', role: 'AGENT' } })).id;
  clientId = (await prisma.client.create({ data: { fullName: run, phone: run, source: 'PHONE_CALL', kind: 'BUYER', assignedAgentId: viewer.id } })).id;
  publicCallId = (await prisma.interaction.create({ data: { clientId, agentId: viewer.id, type: 'CALL', notes: 'Synthetic privacy fixture' } })).id;
  privateCallId = (await prisma.interaction.create({ data: { clientId, agentId: viewer.id, type: 'CALL', notes: 'Synthetic privacy fixture', investigationOnly: true } })).id;
  const baseline = await request(app).get('/errors'); baselineCount = baseline.body.total; baselineWeek = baseline.body.count7d;
  const add = async (source: string, message: string, isPrivate: boolean) => {
    const row = await prisma.errorLog.create({ data: { source, message, dedupKey: null } });
    (isPrivate ? privateIds : publicIds).push(row.id);
  };
  for (const [type, payload, isPrivate] of [
    ['transcription-retry', { interactionId: privateCallId }, true],
    ['recording-search-retry', { interactionId: publicCallId }, false],
    ['geocode', { propertyId: 'ordinary' }, false],
  ] as const) {
    const job = await prisma.backgroundJob.create({ data: { type, payload, maxAttempts: 1, status: 'GIVEN_UP' } }); jobs.push(job.id);
    await add('background-jobs', `Задание ${type} (${job.id}) сдалось после 1 попыток: ${run}`, isPrivate);
  }
  await add('background-jobs', `Задание transcription-retry (deleted-${run}) сдалось: 1 захватов без завершения — вероятно, роняло процесс`, true);
  await add('ai', transcriptText(privateCallId), true); await add('telephony', recordingText(privateCallId), true);
  await add('ai', transcriptText(`missing-${run}`), true);
  await add('ai', transcriptText(publicCallId), false); await add('telephony', recordingText(publicCallId), false);
  await add('investigation', `future-private-${run}`, true);
  await add('cron', 'Крон «seller-probe-call»: private test', true);
  // Same prose from an unrelated producer is not authoritative classification.
  await add('web', transcriptText(privateCallId), false);
  for (let i = 0; i < 21; i++) await add('api', `${run} ordinary_${i}%`, false);
});
beforeEach(async () => { viewer.role = 'AGENT'; viewer.security = true; await prisma.errorLog.updateMany({ where: { id: { in: [...publicIds, ...privateIds] } }, data: { resolvedAt: null, resolvedById: null } }); });
afterAll(async () => {
  await prisma.errorLog.deleteMany({ where: { id: { in: [...publicIds, ...privateIds] } } });
  await prisma.backgroundJob.deleteMany({ where: { id: { in: jobs } } });
  if (clientId) { await prisma.interaction.deleteMany({ where: { clientId } }); await prisma.client.deleteMany({ where: { id: clientId } }); }
  if (viewer.id) await prisma.agent.deleteMany({ where: { id: viewer.id } });
});
describe('historical ErrorLog producer-bound SQL privacy', () => {
  it('revoked ADMIN security permission keeps ordinary errors but excludes private counts and mutations', async () => {
    viewer.role = 'ADMIN'; viewer.security = false;
    const result = await request(app).get('/errors');
    expect(result.status).toBe(200); expect(result.body.total).toBe(baselineCount + publicIds.length);
    expect((await request(app).post(`/errors/${privateIds[0]}/resolve`)).status).toBe(404);
    expect((await request(app).post(`/errors/${publicIds[0]}/resolve`)).status).toBe(204);
    viewer.role = 'DIRECTOR';
    expect((await request(app).post(`/errors/${privateIds[0]}/resolve`)).status).toBe(204);
  });
  it('keeps public linked calls/jobs and nullable ordinary keys before page/count', async () => {
    const scope = { id: { in: [...privateIds, ...publicIds] } };
    const rows = await visibleErrorLogs('AGENT').findMany({ where: scope, orderBy: { id: 'asc' }, take: 100 });
    expect(rows.map(r => r.id).sort()).toEqual([...publicIds].sort());
    expect(await visibleErrorLogs().count({ where: scope })).toBe(publicIds.length);
    expect(await visibleErrorLogs('ADMIN').count({ where: scope })).toBe(publicIds.length + privateIds.length);
    const a = await request(app).get('/errors?page=1&pageSize=20');
    expect(a.status).toBe(200); expect(a.body.total).toBe(baselineCount + publicIds.length);
    expect(a.body.count7d).toBe(baselineWeek + publicIds.length);
    expect(a.body.recent.every((r: any) => !privateIds.includes(r.id))).toBe(true);
    expect(a.body.recent).toHaveLength(20);
  });
  it('binds public classification to current parent, not the old apparent source', async () => {
    await prisma.interaction.update({ where: { id: publicCallId }, data: { investigationOnly: true } });
    try {
      expect(await visibleErrorLogs().count({ where: { id: { in: publicIds } } })).toBe(publicIds.length - 3);
    } finally { await prisma.interaction.update({ where: { id: publicCallId }, data: { investigationOnly: false } }); }
  });
  it('direct resolve/reopen reject private IDs, while admin retains access', async () => {
    expect((await request(app).post(`/errors/${privateIds[0]}/resolve`)).status).toBe(404);
    expect((await request(app).post(`/errors/${privateIds[0]}/reopen`)).status).toBe(404);
    expect((await request(app).post(`/errors/${publicIds[0]}/resolve`)).status).toBe(204);
    viewer.role = 'ADMIN'; expect((await request(app).post(`/errors/${privateIds[0]}/resolve`)).status).toBe(204);
    expect((await prisma.errorLog.findUniqueOrThrow({ where: { id: privateIds[0] } })).resolvedById).toBe(viewer.id);
  });
  it('scoped bulk resolve preserves every private row without rewriting history', async () => {
    const result = await visibleErrorLogs('AGENT').updateMany({ where: { id: { in: [...publicIds, ...privateIds] } }, data: { resolvedAt: new Date(), resolvedById: viewer.id } });
    expect(result.count).toBe(publicIds.length);
    expect(await prisma.errorLog.count({ where: { id: { in: privateIds }, resolvedAt: null } })).toBe(privateIds.length);
  });
  it('preserves literal contains and rejects unsupported SQL fields/operators', async () => {
    expect(await visibleErrorLogs().count({ where: { message: { contains: `${run} ordinary_1%` } } })).toBe(1);
    expect(() => errorLogWhereSql({ message: { invented: 'x' } } as any)).toThrow('Unsupported');
    expect(() => errorLogWhereSql({ 'id; DROP TABLE': 'x' } as any)).toThrow('Unsupported');
  });
});

