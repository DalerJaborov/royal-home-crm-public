import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
const s = vi.hoisted(() => ({ row: {} as any, originate: vi.fn(), update: vi.fn(), settings: vi.fn(), find: vi.fn() }));
vi.mock('../src/db.js', async importOriginal => ({ ...await importOriginal<typeof import('../src/db.js')>(), prisma: {
  $disconnect: vi.fn(), settings: { findUnique: s.settings }, sellerProbeCall: {
    findMany: s.find, findUnique: vi.fn(async () => s.row), updateMany: s.update,
  },
} }));
vi.mock('../src/lib/telephony/liveVoiceBridge.js', async importOriginal => ({ ...await importOriginal<typeof import('../src/lib/telephony/liveVoiceBridge.js')>(), originateLiveVoiceScenarioCall: s.originate }));
vi.mock('../src/lib/ownerVerificationSources.js', async importOriginal => ({ ...await importOriginal<typeof import('../src/lib/ownerVerificationSources.js')>(), ownerVerificationSourceBlock: vi.fn(async () => null) }));
vi.mock('../src/lib/telephony/stationBlacklist.js', async importOriginal => ({ ...await importOriginal<typeof import('../src/lib/telephony/stationBlacklist.js')>(), isNumberBlocked: vi.fn(async () => ({ ok: true, blocked: false })) }));
vi.mock('../src/lib/scenarioCallEligibility.js', async importOriginal => ({ ...await importOriginal<typeof import('../src/lib/scenarioCallEligibility.js')>(), scenarioCallBlockReason: vi.fn(async () => null) }));
vi.mock('../src/lib/daysOffCalendar.js', async importOriginal => ({ ...await importOriginal<typeof import('../src/lib/daysOffCalendar.js')>(), loadCompanyDaysOff: vi.fn(async () => []), companyDaysOffSnapshot: () => [] }));
vi.mock('../src/lib/telephony/scenarioVoice.js', async importOriginal => ({ ...await importOriginal<typeof import('../src/lib/telephony/scenarioVoice.js')>(), scenarioVoice: vi.fn(async () => ({ gender: 'female', voiceName: 'stand-voice', forceRussianOnly: true })) }));
import { runNewOwnerVerificationTick } from '../src/lib/sellerProbeCall.js';
const now = new Date('2026-10-26T10:00:00Z');
beforeEach(() => {
  vi.clearAllMocks(); vi.stubEnv('CRM_OWNER_VERIFICATION_EXECUTION_MODE', 'LIVE');
  s.row = { id: 'stand-probe', sourceKind: 'MANUAL_OWNER', status: 'PENDING', previewOnly: false, attempts: 0, lastAttemptAt: null,
    sellerClientId: 'stand-seller', seller: { fullName: 'Synthetic owner', phone: '+992000000021', deletedAt: null },
    property: { title: 'Synthetic apartment', status: 'AVAILABLE', deletedAt: null } };
  s.settings.mockResolvedValue({ liveVoiceEnabled: true, postShowingCallEnabled: true });
  s.find.mockImplementation(async (args: any) => args.where.status === 'CALLING' ? [] : ['PENDING', 'NO_ANSWER'].includes(s.row.status) ? [{ id: s.row.id }] : []);
  s.update.mockImplementation(async (args: any) => { Object.assign(s.row, args.data); return { count: 1 }; });
  s.originate.mockRejectedValue(new Error('synthetic ambiguous provider timeout'));
});
afterEach(() => vi.unstubAllEnvs());
describe('new owner verification executor gates and unknown outcome', () => {
  it('requires the caller gate even when environment is LIVE', async () => {
    expect(await runNewOwnerVerificationTick(now)).toBe(0); expect(s.settings).not.toHaveBeenCalled(); expect(s.originate).not.toHaveBeenCalled();
  });
  it('never drains preview even when a due query incorrectly returns one', async () => {
    s.row.previewOnly = true;
    expect(await runNewOwnerVerificationTick(now, { allowLive: true })).toBe(0); expect(s.originate).not.toHaveBeenCalled();
  });
  it('does not infer failure from ambiguous transport and never blindly retries', async () => {
    expect(await runNewOwnerVerificationTick(now, { allowLive: true })).toBe(0);
    expect(s.row.status).toBe('UNKNOWN'); expect(s.originate).toHaveBeenCalledTimes(1);
    expect(s.originate.mock.calls[0][1]).toMatchObject({ investigationOnly: true });
    expect(s.originate.mock.calls[0][1].systemInstruction).not.toContain('продолжаем рекламировать');
    await runNewOwnerVerificationTick(now, { allowLive: true }); expect(s.originate).toHaveBeenCalledTimes(1);
  });
});
