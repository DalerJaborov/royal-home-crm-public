import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { Prisma } from '../src/generated/prisma/client.js';
import { prisma } from '../src/db.js';
import { weeklyOperationalSourceSql } from '../src/lib/weeklyOperationalPreview.js';
import type { WeeklyOperationalPreviewKind } from '@royal-home/shared';
const now = new Date(); const ago = (days: number) => new Date(now.getTime() - days * 86400000);
const run = `weekly-preview-${Date.now()}-${Math.random().toString(36).slice(2)}`;
let agentId: string, districtId: string, buyerId: string, idleBuyerId: string, showingId: string, dealId: string;
const properties: string[] = []; const auditIds: string[] = [];
async function ids(kind: WeeklyOperationalPreviewKind) {
  const rows = await prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`SELECT id FROM (${weeklyOperationalSourceSql(kind, now)}) evidence WHERE id IN (${Prisma.join([...properties, buyerId, dealId])})`);
  return rows.map(row => row.id);
}
beforeAll(async () => {
  agentId = (await prisma.agent.create({ data: { fullName: run, phone: run, passwordHash: 'test', role: 'AGENT' } })).id;
  districtId = (await prisma.district.create({ data: { name: run } })).id;
  buyerId = (await prisma.client.create({ data: { fullName: run, phone: run, source: 'PHONE_CALL', kind: 'BUYER', assignedAgentId: agentId, assignedAt: ago(30), workStatus: 'DEFERRED', deferredAt: ago(1) } })).id;
  idleBuyerId = (await prisma.client.create({ data: { fullName: run, phone: `${run}-idle`, source: 'PHONE_CALL', kind: 'BUYER', assignedAgentId: agentId, assignedAt: ago(30) } })).id;
  for (const index of [0, 1, 2, 3, 4]) {
    const p = await prisma.property.create({ data: { title: `${run}-${index}`, type: 'APARTMENT', areaSqm: 50, price: 1000, districtId, address: 'Synthetic', condition: 'GOOD', status: index === 2 ? 'RESERVED' : 'AVAILABLE', createdAt: ago(30), listingAcceptedAt: ago(30), assignedAgentId: agentId, ...(index === 2 ? { reservedAt: ago(20), reservedForClientId: idleBuyerId } : {}) } }); properties.push(p.id);
    if (index === 1) await prisma.propertyExposure.create({ data: { propertyId: p.id, shortId: p.shortId, clientId: buyerId, channel: 'WHATSAPP', recipientId: run, kind: 'LINK', sentAt: ago(1) } });
  }
  showingId = (await prisma.interaction.create({ data: { clientId: buyerId, agentId, propertyId: properties[3], type: 'SHOWING', notes: 'Synthetic completed showing', nextActionDate: ago(4), completedAt: ago(4), showingEvidenceVersion: 1 } })).id;
  dealId = (await prisma.deal.create({ data: { clientId: idleBuyerId, agentId, propertyId: properties[4], startedAt: ago(20), stage: 'NEGOTIATION' } })).id;
});
afterAll(async () => {
  const clients = [buyerId, idleBuyerId].filter((id): id is string => !!id);
  await prisma.auditLog.deleteMany({ where: { id: { in: auditIds } } });
  await prisma.deal.deleteMany({ where: { id: { in: dealId ? [dealId] : [] } } });
  await prisma.propertyExposure.deleteMany({ where: { propertyId: { in: properties } } });
  await prisma.interaction.deleteMany({ where: { clientId: { in: clients } } });
  await prisma.property.deleteMany({ where: { id: { in: properties } } });
  await prisma.client.deleteMany({ where: { id: { in: clients } } });
  await prisma.district.deleteMany({ where: { id: { in: districtId ? [districtId] : [] } } });
  await prisma.agent.deleteMany({ where: { id: { in: agentId ? [agentId] : [] } } });
});
describe('read-only weekly CRM fact snapshot', () => {
  it('includes explicit completed dated showing before current deferral, not a future or undated claim', async () => {
    expect(await ids('DEFERRED_AFTER_SHOWING')).toContain(buyerId);
    await prisma.interaction.update({ where: { id: showingId }, data: { nextActionDate: ago(-1) } });
    try { expect(await ids('DEFERRED_AFTER_SHOWING')).not.toContain(buyerId); }
    finally { await prisma.interaction.update({ where: { id: showingId }, data: { nextActionDate: ago(4) } }); }
  });
  it('keeps only active aged properties and excludes known recent exposure or showing', async () => {
    const found = await ids('PROPERTY_NO_RECORDED_ACTIVITY');
    expect(found).toContain(properties[0]); expect(found).not.toContain(properties[1]); expect(found).not.toContain(properties[2]); expect(found).not.toContain(properties[3]);
  });
  it('shows old reservation/deal and removes it when a recent actual audit change exists', async () => {
    expect(await ids('IDLE_RESERVATION_DEAL')).toEqual(expect.arrayContaining([properties[2], dealId]));
    for (const [entityType, entityId] of [['Property', properties[2]], ['Deal', dealId]]) auditIds.push((await prisma.auditLog.create({ data: { entityType, entityId, action: 'TEST_CHANGE', agentId, agentName: run } })).id);
    expect(await ids('IDLE_RESERVATION_DEAL')).not.toEqual(expect.arrayContaining([properties[2], dealId]));
  });
});
