import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
const viewer = vi.hoisted(() => ({ id: '', role: 'AGENT' }));
vi.mock('../src/auth/middleware.js', async importOriginal => ({ ...await importOriginal<typeof import('../src/auth/middleware.js')>(),
  requireAuth: (req: any, _res: any, next: () => void) => { req.agent = { id: viewer.id, role: viewer.role }; next(); }, can: () => true,
}));
import { prisma } from '../src/db.js';
import { notificationsRouter } from '../src/routes/notifications.js';
import { filterInvestigationRecipients, isPrivateNotification } from '../src/lib/investigationNotifications.js';
const app = express(); app.use(express.json()); app.use('/notices', notificationsRouter);
const key = `legacy-notice-${Date.now()}-${Math.random().toString(36).slice(2)}`;
let clientId: string; let adminId: string;
const jobs: string[] = []; const privateIds: string[] = []; const publicIds: string[] = [];
let privateTag: string; let publicTag: string;
beforeAll(async () => {
  viewer.id = (await prisma.agent.create({ data: { fullName: key, phone: `${key}-agent`, passwordHash: 'test', role: 'AGENT' } })).id;
  adminId = (await prisma.agent.create({ data: { fullName: key, phone: `${key}-admin`, passwordHash: 'test', role: 'ADMIN' } })).id;
  clientId = (await prisma.client.create({ data: { fullName: key, phone: key, source: 'PHONE_CALL', kind: 'BUYER', assignedAgentId: viewer.id } })).id;
  const publicCall = await prisma.interaction.create({ data: { clientId, agentId: viewer.id, type: 'CALL', notes: 'Synthetic privacy fixture' } });
  const privateCall = await prisma.interaction.create({ data: { clientId, agentId: viewer.id, type: 'CALL', notes: 'Synthetic privacy fixture', investigationOnly: true } });
  const fixtures = [
    { type: 'transcription-retry', payload: { interactionId: privateCall.id }, private: true },
    { type: 'recording-search-retry', payload: { interactionId: publicCall.id }, private: false },
    { type: 'geocode', payload: { propertyId: 'ordinary' }, private: false },
    { type: 'recording-search-retry', payload: { interactionId: 'missing-source' }, private: true },
    { type: 'geocode', payload: { investigationOnly: true }, private: true },
  ];
  for (const f of fixtures) {
    const job = await prisma.backgroundJob.create({ data: { type: f.type, payload: f.payload, maxAttempts: 1, status: 'GIVEN_UP' } }); jobs.push(job.id);
    const tag = `background-job-given-up:${job.id}`;
    const notice = await prisma.notification.create({ data: { agentId: viewer.id, kind: 'background-job-given-up', title: key, body: key, tag, level: 'CRITICAL' } });
    (f.private ? privateIds : publicIds).push(notice.id);
    if (f.type === 'transcription-retry') privateTag = tag;
    if (f.type === 'geocode' && !f.private) publicTag = tag;
  }
  privateIds.push((await prisma.notification.create({ data: { agentId: viewer.id, kind: 'background-job-given-up', title: key, body: key, tag: `background-job-given-up:deleted-${key}`, level: 'CRITICAL' } })).id);
  for (let i = 0; i < 21; i++) publicIds.push((await prisma.notification.create({ data: { agentId: viewer.id, kind: 'other', title: key, body: key, tag: i ? `${key}-${i}` : null } })).id);
});
beforeEach(async () => { viewer.role = 'AGENT'; await prisma.notification.updateMany({ where: { agentId: viewer.id }, data: { read: false } }); });
afterAll(async () => {
  if (viewer.id) await prisma.notification.deleteMany({ where: { agentId: viewer.id } });
  await prisma.backgroundJob.deleteMany({ where: { id: { in: jobs } } });
  if (clientId) { await prisma.interaction.deleteMany({ where: { clientId } }); await prisma.client.deleteMany({ where: { id: clientId } }); }
  await prisma.agent.deleteMany({ where: { id: { in: [viewer.id, adminId].filter(Boolean) } } });
});
describe('legacy background notice binding before pagination and delivery', () => {
  it('keeps ordinary mixed jobs and untagged notices, with exact page/count/pinned totals', async () => {
    const a = await request(app).get('/notices'); const b = await request(app).get('/notices?page=2');
    expect(a.status).toBe(200); expect(b.status).toBe(200);
    expect(a.body.unreadCount).toBe(23); expect(a.body.criticalCount).toBe(2); expect(a.body.pinned).toHaveLength(2);
    expect(a.body.items).toHaveLength(20); expect(a.body.hasMore).toBe(true);
    expect(b.body.items).toHaveLength(3); expect(b.body.hasMore).toBe(false);
    expect([...a.body.items, ...b.body.items].map((n: any) => n.id).sort()).toEqual([...publicIds].sort());
  });
  it.each(['ADMIN', 'DIRECTOR'])('retains full history for %s', async role => {
    viewer.role = role; const result = await request(app).get('/notices');
    expect(result.body.unreadCount).toBe(27); expect(result.body.criticalCount).toBe(6);
  });
  it('direct read and bulk mutations never mutate hidden history', async () => {
    expect((await request(app).post(`/notices/${privateIds[0]}/read`)).status).toBe(404);
    const many = await request(app).post('/notices/read-many').send({ ids: [privateIds[0], publicIds[0]] }); expect(many.body.count).toBe(1);
    await request(app).post('/notices/read-all');
    expect(await prisma.notification.count({ where: { id: { in: privateIds }, read: false } })).toBe(4);
    expect(await prisma.notification.count({ where: { id: { in: publicIds }, read: false } })).toBe(0);
  });
  it('rechecks job and current roles for feed/live/push recipients without actual transport', async () => {
    expect(await isPrivateNotification({ tag: privateTag })).toBe(true);
    expect(await isPrivateNotification({ tag: publicTag })).toBe(false);
    expect(await filterInvestigationRecipients([viewer.id, adminId], { tag: privateTag })).toEqual([adminId]);
    expect(await filterInvestigationRecipients([viewer.id], { tag: publicTag })).toEqual([viewer.id]);
    await prisma.agent.update({ where: { id: adminId }, data: { role: 'AGENT' } });
    try { expect(await filterInvestigationRecipients([adminId], { tag: privateTag })).toEqual([]); }
    finally { await prisma.agent.update({ where: { id: adminId }, data: { role: 'ADMIN' } }); }
  });
});

