import { describe, it, expect, vi, beforeEach } from "vitest";
const state = vi.hoisted(() => ({ before: null as any, audit: vi.fn(), save: vi.fn(), lock: vi.fn(), errorCreate: vi.fn() }));
vi.mock('../src/db.js', async importOriginal => ({ ...await importOriginal<typeof import('../src/db.js')>(), prisma: {
  $disconnect: vi.fn(), errorLog: { findFirst: async () => null, create: state.errorCreate }, $transaction: async (fn: any) => fn({ $executeRaw: state.lock,
    settings: { findUnique: async () => state.before }, auditLog: { create: state.audit } }),
} }));
vi.mock('../src/lib/pultCacheHook.js', async importOriginal => ({ ...await importOriginal<typeof import('../src/lib/pultCacheHook.js')>(), requestPultSnapshot: vi.fn() }));
import { logSystemError, onNewSystemError } from '../src/lib/systemError.js';
import { disabledInvestigationControls, saveWithInvestigationControlAudit } from '../src/lib/investigationSettingsAudit.js';
import { PRIVATE_CRON_NAMES, visibleCronWhere, visibleSystemErrorWhere, withCronPrivacy, isPrivateOperation } from '../src/lib/investigationOperations.js';
import { publicAuditMeta, visibleAuditWhere } from '../src/lib/investigationAudit.js';
beforeEach(() => { vi.clearAllMocks(); state.before = null; state.save.mockResolvedValue({ saved: true }); });
describe('private operational observability', () => {
  it.each(['AGENT', 'MARKETING', 'EDITOR', 'ROP', 'SECURITY', undefined])('does not widen role ceiling for %s', role => {
    expect(visibleCronWhere(role)).toEqual({ name: { notIn: [...PRIVATE_CRON_NAMES] } });
    expect(visibleSystemErrorWhere(role)).toMatchObject({ NOT: { OR: expect.arrayContaining([{ source: 'investigation' }]) } });
    expect(JSON.stringify(visibleAuditWhere(role))).toContain('InvestigationControl');
  });
  it.each(['ADMIN', 'DIRECTOR'])('retains %s inspection', role => {
    expect(visibleCronWhere(role)).toEqual({}); expect(visibleSystemErrorWhere(role)).toEqual({});
  });
  it('classifies exact historical producer signatures without generic customer keyword search', () => {
    const filter = JSON.stringify(visibleSystemErrorWhere('AGENT'));
    expect(filter).toContain('Крон «seller-probe-call»');
    expect(filter).toContain('post-showing-originate');
    expect(filter).not.toContain('contains');
  });
  it('isolates concurrent async context from ordinary jobs', async () => {
    const [privateJob, ordinaryJob] = await Promise.all([
      withCronPrivacy('seller-probe-call', async () => { await Promise.resolve(); return isPrivateOperation(); }),
      withCronPrivacy('site-stats', async () => { await Promise.resolve(); return isPrivateOperation(); }),
    ]);
    expect(privateJob).toBe(true); expect(ordinaryJob).toBe(false); expect(isPrivateOperation()).toBe(false);
  });
  it('removes private setting names from generic audit while preserving ordinary changes', () => {
    const row = { meta: { fields: ['companyName', 'postShowingCallEnabled'], postShowingCallEnabled: false, companyName: 'CRM' } };
    expect(publicAuditMeta(row, 'AGENT').meta).toEqual({ fields: ['companyName'], companyName: 'CRM' });
    expect(publicAuditMeta(row, 'ADMIN')).toBe(row);
  });
});
describe('private error production', () => {
  it('persists private context errors without external notification hook, retaining ordinary errors', async () => {
    const hook = vi.fn(); onNewSystemError(hook);
    await withCronPrivacy('seller-probe-call', () => logSystemError('telephony', 'private error'));
    expect(state.errorCreate.mock.calls[0][0].data.source).toBe('investigation'); expect(hook).not.toHaveBeenCalled();
    await logSystemError('investigation', 'private direct callback'); expect(hook).not.toHaveBeenCalled();
    await logSystemError('telephony', 'ordinary error'); expect(hook).toHaveBeenCalledOnce();
    onNewSystemError(() => {});
  });
});
describe('explicit disabled transition receipt', () => {
  it.each([null, { postShowingCallEnabled: false }, { buyerSellerAutomationMode: 'PREVIEW' }])('does not create startup/preview/repeated disable backlog: %j', before => {
    expect(disabledInvestigationControls(before, { postShowingCallEnabled: false, buyerSellerAutomationMode: 'PREVIEW' })).toEqual([]);
  });
  it('records only true to false and LIVE to non-LIVE, not omitted keys or enabling', () => {
    expect(disabledInvestigationControls({ postShowingCallEnabled: true, liveVoiceEnabled: true }, { postShowingCallEnabled: false })).toEqual(['postShowingCallEnabled']);
    expect(disabledInvestigationControls({ postShowingCallEnabled: false }, { postShowingCallEnabled: true })).toEqual([]);
    expect(disabledInvestigationControls({ buyerSellerAutomationMode: 'LIVE' }, { buyerSellerAutomationMode: 'PREVIEW' })).toEqual(['buyerSellerAutomationMode']);
  });
  it('writes one private closed preview with actor in same transaction, no notification/provider', async () => {
    state.before = { postShowingCallEnabled: true };
    await saveWithInvestigationControlAudit({ postShowingCallEnabled: false }, { id: 'actor', name: 'Director' }, state.save);
    expect(state.lock).toHaveBeenCalledOnce(); expect(state.save).toHaveBeenCalledOnce(); expect(state.audit).toHaveBeenCalledOnce();
    expect(state.audit).toHaveBeenCalledWith({ data: expect.objectContaining({ entityType: 'InvestigationControl', agentId: 'actor', meta: {
      controls: ['postShowingCallEnabled'], title: 'Опрос после показа', status: 'CLOSED_PREVIEW', externalDelivery: 'NOT_REQUESTED',
    } }) });
    state.before = { postShowingCallEnabled: false };
    await saveWithInvestigationControlAudit({ postShowingCallEnabled: false }, { id: 'actor', name: 'Director' }, state.save);
    expect(state.audit).toHaveBeenCalledOnce();
  });
  it('does not record disable when save fails', async () => {
    state.before = { postShowingCallEnabled: true }; state.save.mockRejectedValue(new Error('storage failed'));
    await expect(saveWithInvestigationControlAudit({ postShowingCallEnabled: false }, { id: 'actor', name: 'Director' }, state.save)).rejects.toThrow('storage failed');
    expect(state.audit).not.toHaveBeenCalled();
  });
});
