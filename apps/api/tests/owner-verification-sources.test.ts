import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { TxClient } from '../src/db.js';
const state = vi.hoisted(() => ({ create: vi.fn(), call: vi.fn(), property: vi.fn(), seller: vi.fn(), checkpoint: vi.fn(), lease: vi.fn(), exposures: vi.fn(), probe: vi.fn(), actor: vi.fn(), raw: vi.fn(), owners: vi.fn(), epoch: vi.fn(), epochCurrent: vi.fn() }));
vi.mock('../src/db.js', async importOriginal => ({ ...await importOriginal<typeof import('../src/db.js')>(),
  prisma: { agent: { findUnique: state.actor }, $queryRaw: state.raw, $disconnect: vi.fn(), settings: { findUnique: vi.fn() }, workflowCheckpoint: { upsert: state.checkpoint, updateMany: state.lease }, propertyExposure: { findMany: state.exposures }, sellerProbeCall: { findUnique: state.probe },
    $transaction: async (fn: (tx: unknown) => unknown) => fn({ $queryRaw: state.raw, client: { findMany: state.owners }, agent: { findUnique: state.actor }, sellerProbeCall: { findUnique: state.probe, upsert: state.create } }) } }));
vi.mock('../src/lib/investigationAssignmentEpoch.js', async importOriginal => ({ ...await importOriginal<typeof import('../src/lib/investigationAssignmentEpoch.js')>(), resolveInvestigationAssignmentEpoch: state.epoch, assignmentSourceEpochIsCurrent: state.epochCurrent }));
import { ownerProbeAssignmentCurrent, ownerVerificationSourceBlock, scheduleManualOwnerVerification, runExposureOwnerPreviewTick, approveOwnerVerificationExecution, sellerProbeSourcePhoneHash } from '../src/lib/ownerVerificationSources.js';
const now = new Date('2026-10-25T10:00:00Z');
const tx = { $queryRaw: state.raw, property: { findUnique: state.property }, client: { findUnique: state.seller },
  interaction: { findFirst: state.call }, sellerProbeCall: { upsert: state.create } } as unknown as TxClient;
beforeEach(() => {
  vi.clearAllMocks(); vi.stubEnv('JWT_ACCESS_SECRET', 'stand-owner-probe-secret'); vi.stubEnv('CRM_OWNER_VERIFICATION_EXECUTION_MODE', '');
  state.property.mockResolvedValue({ id: 'stand-property', sellerClientId: 'stand-seller', createdById: 'stand-agent', createdAt: now, deletedAt: null });
  state.seller.mockResolvedValue({ id: 'stand-seller', assignedAgentId: 'stand-agent', assignedAt: now, source: 'WALK_IN', phone: '+992000000021', lastClientMessageAt: null, deletedAt: null });
  state.call.mockResolvedValue(null); state.raw.mockResolvedValue([]); state.epoch.mockResolvedValue('AUDIT:initial'); state.epochCurrent.mockResolvedValue(true);
  state.owners.mockResolvedValue([{ id: 'stand-seller', assignedAgentId: 'stand-agent', assignedAt: now, phone: '+992000000021', deletedAt: null }]);
  state.checkpoint.mockResolvedValue({ key: "owner-exposure-verification-v1", createdAt: now, cursor: null, revision: 1 }); // gitleaks:allow -- public workflow checkpoint identifier in a synthetic fixture
  state.lease.mockResolvedValue({ count: 1 }); state.exposures.mockResolvedValue([]);
});
afterEach(() => vi.unstubAllEnvs());
describe('actual manual property creation seed', () => {
  it('creates a uniquely bound PREVIEW without a fake showing or raw phone in evidence', async () => {
    await scheduleManualOwnerVerification(tx, 'stand-property', 'stand-agent');
    const create = state.create.mock.calls[0][0].create;
    expect(create).toMatchObject({ sourceKind: 'MANUAL_OWNER', previewOnly: true, sourceId: 'stand-property' });
    expect(create.postShowingCallId).toBeUndefined(); expect(create.sourcePhoneHash).toHaveLength(64);
    expect(JSON.stringify(create.evidence)).not.toContain('+992');
    await scheduleManualOwnerVerification(tx, 'stand-property', 'stand-agent');
    expect(state.create.mock.calls[1][0].where.sourceKey).toBe(state.create.mock.calls[0][0].where.sourceKey);
  });
  it('does not verify a linked channel owner or somebody else’s creation', async () => {
    state.seller.mockResolvedValueOnce({ source: 'INSTAGRAM' });
    await scheduleManualOwnerVerification(tx, 'stand-property', 'stand-agent');
    await scheduleManualOwnerVerification(tx, 'stand-property', 'another-actor');
    expect(state.create).not.toHaveBeenCalled();
  });
  it('does not repeat first verification after an independent station conversation', async () => {
    state.call.mockResolvedValue({ id: 'stand-station-call' });
    await scheduleManualOwnerVerification(tx, 'stand-property', 'stand-agent');
    expect(state.create).not.toHaveBeenCalled();
  });
  it('environment LIVE cannot automatically promote a creation preview', async () => {
    vi.stubEnv('CRM_OWNER_VERIFICATION_EXECUTION_MODE', 'LIVE');
    await scheduleManualOwnerVerification(tx, 'stand-property', 'stand-agent');
    expect(state.create.mock.calls[0][0]).toMatchObject({ update: {}, create: { previewOnly: true } });
  });
});


describe('future-only owner observation checkpoint', () => {
  it('does not backfill old exposures and stores the immutable first observation cutoff', async () => {
    await runExposureOwnerPreviewTick(now);
    expect(state.checkpoint.mock.calls[0][0]).toMatchObject({ update: {}, create: { createdAt: now } });
    expect(state.exposures.mock.calls[0][0].where.sentAt.gte).toEqual(now);
    expect(state.exposures.mock.calls[0][0].where.sentAt.lte.getTime()).toBeLessThan(now.getTime());
    expect(state.lease.mock.calls[1][0].where.leaseToken).toBe(state.lease.mock.calls[0][0].data.leaseToken);
  });
  it('does not scan when another worker owns the lease', async () => {
    state.lease.mockResolvedValueOnce({ count: 0 });
    expect(await runExposureOwnerPreviewTick(now)).toEqual({ created: 0, busy: true });
    expect(state.exposures).not.toHaveBeenCalled();
  });
});

describe('explicit owner execution approval', () => {
  beforeEach(() => {
    vi.stubEnv('CRM_OWNER_VERIFICATION_EXECUTION_MODE', 'LIVE');
    state.actor.mockResolvedValue({ role: 'ADMIN', isActive: true });
    state.probe.mockResolvedValue({ id: 'stand-preview', sourceKind: 'MANUAL_OWNER', sourceKey: 'stand-preview-key', sourceId: 'stand-property',
      previewOnly: true, status: 'PENDING', updatedAt: now, assignmentAt: now, anchorAt: now,
      sellerClientId: 'stand-seller', propertyId: 'stand-property', agentId: 'stand-agent', buyerClientId: null,
      sourcePhoneHash: sellerProbeSourcePhoneHash('stand-seller', '+992000000021'), evidence: {}, signals: ['manual_owner_number_unverified'],
      seller: { id: 'stand-seller', assignedAgentId: 'stand-agent', assignedAt: now, deletedAt: null, phone: '+992000000021', lastClientMessageAt: null },
      property: { sellerClientId: 'stand-seller', deletedAt: null, status: 'AVAILABLE' } });
  });
  it('creates a separate approved LIVE execution and leaves the old preview immutable', async () => {
    await approveOwnerVerificationExecution({ previewId: 'stand-preview', actorId: 'stand-director', expectedUpdatedAt: now }, now);
    expect(state.create.mock.calls[0][0]).toMatchObject({ where: { sourceKey: 'stand-preview-key:execution:LIVE' }, update: {},
      create: { previewOnly: false, evidence: { previewId: 'stand-preview', approvedById: 'stand-director' } } });
  });
  it('rejects A→B→A even when current owner and assignedAt match the old seed', async () => {
    state.raw.mockResolvedValue([{ id: 'ownership-return-to-A' }]);
    expect(await ownerVerificationSourceBlock('stand-preview', now, true)).toBe('assignment_epoch_changed');
    await expect(approveOwnerVerificationExecution({ previewId: 'stand-preview', actorId: 'stand-director', expectedUpdatedAt: now }, now)).rejects.toThrow('Источник изменился');
    expect(state.create).not.toHaveBeenCalled();
  });
  it('checks epoch again under client locks if reassignment happens after the preview check', async () => {
    let checks = 0;
    state.raw.mockImplementation(async (sql: TemplateStringsArray) => sql.join('').includes('SELECT a.id') && ++checks > 1 ? [{ id: 'late-ABA' }] : []);
    await expect(approveOwnerVerificationExecution({ previewId: 'stand-preview', actorId: 'stand-director', expectedUpdatedAt: now }, now)).rejects.toThrow('назначение изменилось');
    expect(state.create).not.toHaveBeenCalled();
  });
  it.each(['AGENT', 'MARKETING', 'ROP'])('rejects approval by %s', async role => {
    state.actor.mockResolvedValue({ role, isActive: true });
    await expect(approveOwnerVerificationExecution({ previewId: 'stand-preview', actorId: 'stand-actor', expectedUpdatedAt: now }, now)).rejects.toThrow('Недостаточно прав');
    expect(state.create).not.toHaveBeenCalled();
  });
  it('rejects revoked ADMIN approval and previously approved execution', async () => {
    state.actor.mockResolvedValue({ role: 'ADMIN', isActive: true, permissions: { granted: [], revoked: ['clients.securityReview'] } });
    await expect(approveOwnerVerificationExecution({ previewId: 'stand-preview', actorId: 'stand-actor', expectedUpdatedAt: now }, now)).rejects.toThrow('Недостаточно прав');
    const row = await state.probe(); row.previewOnly = false; row.evidence = { approvedById: 'stand-actor' };
    expect(await ownerVerificationSourceBlock('stand-preview', now)).toBe('approval_no_longer_valid');
    expect(state.create).not.toHaveBeenCalled();
  });
  it('rejects a stale preview fence and phone replacement', async () => {
    await expect(approveOwnerVerificationExecution({ previewId: 'stand-preview', actorId: 'stand-actor', expectedUpdatedAt: new Date(0) }, now)).rejects.toThrow('Предпросмотр устарел');
    const row = await state.probe(); row.seller.phone = '+992000000022';
    await expect(approveOwnerVerificationExecution({ previewId: 'stand-preview', actorId: 'stand-actor', expectedUpdatedAt: now }, now)).rejects.toThrow('Источник изменился');
    expect(state.create).not.toHaveBeenCalled();
  });
});

describe('owner proof anchor is not revived by reused date', () => {
  it('rejects an ownership transition at the exact source millisecond', async () => {
    state.raw.mockResolvedValue([{ id: 'same-ms-transition' }]);
    expect(await ownerProbeAssignmentCurrent(tx, { clientId: 'stand-seller', subjectAgentId: 'stand-agent', assignmentAt: now, sourceAt: now, now })).toBe(false);
    expect(state.epochCurrent).not.toHaveBeenCalled();
  });
  it('rejects unresolved historical epoch without a known intervening row', async () => {
    state.epochCurrent.mockResolvedValue(false);
    expect(await ownerProbeAssignmentCurrent(tx, { clientId: 'stand-seller', subjectAgentId: 'stand-agent', assignmentAt: now, sourceAt: now, now })).toBe(false);
  });
  it('binds a new seed identity to immutable audit epoch, not reused owner/date', async () => {
    await scheduleManualOwnerVerification(tx, 'stand-property', 'stand-agent');
    const firstKey = state.create.mock.calls[0][0].where.sourceKey;
    state.epoch.mockResolvedValue('AUDIT:new-epoch');
    await scheduleManualOwnerVerification(tx, 'stand-property', 'stand-agent');
    expect(state.create.mock.calls[1][0].where.sourceKey).not.toBe(firstKey);
  });
});
