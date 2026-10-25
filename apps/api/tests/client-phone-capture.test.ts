import { beforeEach, describe, expect, it, vi } from "vitest";
const state=vi.hoisted(()=>({tx:{ $queryRaw:vi.fn(),client:{findUnique:vi.fn(),updateMany:vi.fn()},interaction:{findFirst:vi.fn()},botConversation:{findFirst:vi.fn(),findUnique:vi.fn()},telegramConversation:{findFirst:vi.fn(),findUnique:vi.fn()},agent:{findMany:vi.fn()},clientPhoneOrigin:{updateMany:vi.fn()} }}));
vi.mock('../src/db.js',async importOriginal=>({...await importOriginal<typeof import('../src/db.js')>(),prisma:{$disconnect:vi.fn(),...state.tx,$transaction:async(fn:any)=>fn(state.tx)}}));
import { captureExplicitClientPhone, captureConversationPhoneMessages } from '../src/lib/clientPhoneCapture.js';
const at=new Date('2026-10-25T12:00:00Z');const source={kind:'CONVERSATION' as const,id:'chat',at,clientId:'client',text:'Мой новый номер +992900000001'};
const client={id:'client',phone:'+992900000009',whatsappPhone:null,extraPhones:[],deletedAt:null,assignmentCompletedAt:null,assignedAt:new Date('2026-10-24'),assignedAgentId:'agent',updatedAt:at};
beforeEach(()=>{vi.clearAllMocks();state.tx.$queryRaw.mockResolvedValue([]);state.tx.client.findUnique.mockResolvedValue(client);state.tx.client.updateMany.mockResolvedValue({count:1});state.tx.botConversation.findFirst.mockResolvedValue({id:'chat'});state.tx.interaction.findFirst.mockResolvedValue({id:'call'});state.tx.agent.findMany.mockResolvedValue([]);state.tx.clientPhoneOrigin.updateMany.mockResolvedValue({count:1});});
describe('trusted phone capture',()=>{
  it('adds extra only and attributes provenance in same transaction',async()=>{expect(await captureExplicitClientPhone(source)).toBe(true);expect(state.tx.client.updateMany.mock.calls[0][0].data).toEqual({extraPhones:['+992900000001']});expect(state.tx.clientPhoneOrigin.updateMany.mock.calls[0][0].data).toEqual({source:'CONVERSATION',sourceId:'chat'});});
  it('preserves genuine explicit own primary correction and old phone',async()=>{expect(await captureExplicitClientPhone({...source,text:'Я ошибся, мой правильный номер +992900000001'})).toBe(true);expect(state.tx.client.updateMany.mock.calls[0][0].data).toEqual({phone:'+992900000001',extraPhones:[client.phone]});});
  it.each([{deletedAt:at},{assignmentCompletedAt:at},{assignedAt:new Date('2026-10-26')}])('does not modify closed/deleted/older-assignment client %j',async patch=>{state.tx.client.findUnique.mockResolvedValue({...client,...patch});expect(await captureExplicitClientPhone(source)).toBe(false);expect(state.tx.client.updateMany).not.toHaveBeenCalled();});
  it('denies rebound conversation or private call',async()=>{state.tx.botConversation.findFirst.mockResolvedValue(null);expect(await captureExplicitClientPhone(source)).toBe(false);state.tx.interaction.findFirst.mockResolvedValue(null);expect(await captureExplicitClientPhone({...source,kind:'CALL',text:'Клиент: Мой номер +992900000001'})).toBe(false);expect(state.tx.interaction.findFirst.mock.calls[0][0].where.investigationOnly).toBe(false);expect(state.tx.client.updateMany).not.toHaveBeenCalled();});
  it('denies staff phone and full phone conflict',async()=>{state.tx.agent.findMany.mockResolvedValue([{phone:'+992900000001'}]);expect(await captureExplicitClientPhone(source)).toBe(false);state.tx.agent.findMany.mockResolvedValue([]);state.tx.$queryRaw.mockImplementation(async(strings:TemplateStringsArray)=>strings.join('').includes('FROM "Client" WHERE id <>')?[{id:'other'}]:[]);expect(await captureExplicitClientPhone(source)).toBe(false);expect(state.tx.client.updateMany).not.toHaveBeenCalled();});
  it('CAS loss cannot create false provenance',async()=>{state.tx.client.updateMany.mockResolvedValue({count:0});expect(await captureExplicitClientPhone(source)).toBe(false);expect(state.tx.clientPhoneOrigin.updateMany).not.toHaveBeenCalled();});
  it('does not collapse equal tails across countries',async()=>{state.tx.client.findUnique.mockResolvedValue({...client,phone:'+7900000001'});expect(await captureExplicitClientPhone(source)).toBe(true);});
  it('never enriches assistant/staff/unattributed historic messages',async()=>{await captureConversationPhoneMessages('chat',[{role:'assistant',content:source.text,at:at.toISOString()},{role:'user',by:{kind:'agent'},content:source.text,at:at.toISOString()},{role:'user',content:source.text}]);expect(state.tx.botConversation.findUnique).not.toHaveBeenCalled();});
});

it('captures an own extra number only as direct reply to a recorded current-assignment question', async () => {
  const messages = [{ role: 'user', content: 'Фаридун', at: at.toISOString() }, { role: 'assistant', by: {kind:'bot'}, content: 'Раҳмат, Фаридун! Ва боз рақами дигаре доред?' }];
  state.tx.botConversation.findUnique.mockResolvedValue({ clientId: 'client', messages });
  state.tx.botConversation.findFirst.mockResolvedValue({ id: 'chat', messages });
  expect(await captureExplicitClientPhone({...source,text:'да, вот ещё 930001028'})).toBe(true);
  expect(state.tx.client.updateMany.mock.calls[0][0].data).toEqual({extraPhones:['+992930001028']});
  state.tx.client.updateMany.mockClear();
  for (const text of ['да, вот ещё брата 930001028','не мой номер 930001028','да, вот ещё 930001028 и 930001029']) {
    expect(await captureExplicitClientPhone({...source,text})).toBe(false);
  }
  state.tx.botConversation.findFirst.mockResolvedValue({id:'chat',messages:[...messages,{role:'assistant',content:'Другой вопрос?'}]});
  expect(await captureExplicitClientPhone({...source,text:'да, вот ещё 930001028'})).toBe(false);
  state.tx.botConversation.findFirst.mockResolvedValue({id:'chat',messages:[{...messages[0],at:'2027-01-01T00:00:00Z'},messages[1]]});
  expect(await captureExplicitClientPhone({...source,text:'да, вот ещё 930001028'})).toBe(false);
  state.tx.botConversation.findFirst.mockResolvedValue({id:'chat',messages:[{...messages[0],at:'2020-01-01T00:00:00Z'},messages[1]]});
  expect(await captureExplicitClientPhone({...source,text:'да, вот ещё 930001028'})).toBe(false);
  expect(state.tx.client.updateMany).not.toHaveBeenCalled();
});
it('does not infer ownership from a bare extra-number reply without a recorded question', async () => {
  state.tx.botConversation.findUnique.mockResolvedValue({clientId:'client',messages:[]});
  expect(await captureExplicitClientPhone({...source,text:'да, вот ещё 930001028'})).toBe(false);
  expect(state.tx.client.updateMany).not.toHaveBeenCalled();
});
