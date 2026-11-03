import { beforeEach, expect, it, vi } from "vitest";
const { findMany, findFirst, findProperty } = vi.hoisted(() => ({ findMany: vi.fn(), findFirst: vi.fn(), findProperty: vi.fn() }));
vi.mock("../src/db.js", () => ({ prisma: { client: { findMany, findFirst }, property: { findFirst: findProperty, findMany: vi.fn() } } }));
import { parseFastPathIntent, tryAssistantFastPath } from "../src/ai/assistantFastPath.js";
const actor = { id: 'test-agent', role: 'AGENT', canViewAllClients: false, canViewPhone: false, canViewAllDeals: false };
beforeEach(() => { vi.clearAllMocks(); findMany.mockResolvedValue([]); });
it.each(['найди клиента по номеру 112', 'номер 112', 'клиент 112', 'ПК-000112', 'покажи покупателя 112'])('parses card: %s', text => expect(parseFastPathIntent(text)).toEqual({ kind: 'client-code', shortId: 112 }));
it('does not mistake full phone for short id', () => expect(parseFastPathIntent('номер 901234567')).toEqual({ kind: 'phone', phone: '+992901234567' }));
it('does not intercept compound tasks', () => expect(parseFastPathIntent('найди клиента 112 и поменяй цену')).toBeNull());
it('returns exact DB IDs and asks to choose when ambiguous', async () => {
  const fixture = { shortId: 112, kind: 'BUYER', fullName: 'Тест', dualIntent: false, phone: '+992901234567', status: 'ACTIVE', acceptedAt: new Date(), lastContactAt: null, assignedAgent: null };
  findMany.mockResolvedValue([{ ...fixture, id: '00000000-0000-4000-8000-000000000001' }, { ...fixture, id: '00000000-0000-4000-8000-000000000002' }]);
  const result = await tryAssistantFastPath('найди клиента по номеру 112', actor);
  expect(result?.cards).toHaveLength(2);
  expect(result?.reply).toContain('/clients/00000000-0000-4000-8000-000000000001');
  expect(result?.reply).toContain('Уточните');
  expect(result?.cards[0]).toMatchObject({ phone: '+992•••••67' });
  const where = findMany.mock.calls[0][0].where;
  expect(where.shortId).toBe(112);
  expect(JSON.stringify(where)).toContain('test-agent');
  expect(where.deletedAt).toBeNull();
});
it('no results preserves fallback without inventing ID', async () => expect(await tryAssistantFastPath('клиент 112', actor)).toBeNull());
it("answers an exact missing property without inventing a deletion reason", async () => {
  findProperty.mockResolvedValueOnce(null);
  expect(await tryAssistantFastPath("найди объект 98", actor)).toMatchObject({
    cards: [], reply: "Не нашла объект ОБ-000098 среди доступных карточек.",
  });
});
