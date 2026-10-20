/** Synthetic preview only. Run from apps/api after migrating the dedicated local database. */
import '../src/loadEnv.js';
import { prisma } from '../src/db.js';
import { app } from '../src/app.js';
import { ROLES } from '@royal-home/shared';
if (process.env.NODE_ENV === 'production') throw new Error('Synthetic preview is unavailable in production');
const standDb = new URL(process.env.DATABASE_URL ?? '');
if (!['localhost', '127.0.0.1'].includes(standDb.hostname) || standDb.pathname !== '/rh_client_card_20261020') throw new Error('Isolated local client-card DB required');
const roles = ['ADMIN','AGENT','SECURITY','SHAREHOLDER','MANAGER','HEAD_OF_SALES','MARKETING','EDITOR','DIRECTOR'] as const;
const agents = [];
for (const [i, role] of roles.entries()) agents.push(await prisma.agent.upsert({where:{phone:`+9929000000${String(i+1).padStart(2,'0')}`},update:{},create:{fullName:`Тестовый ${role}`,phone:`+9929000000${String(i+1).padStart(2,'0')}`,role,preferences:{onboardingCompletedAt:new Date(0).toISOString()}}}));
await prisma.settings.upsert({where:{id:'singleton'},update:{uiShellRollout:{enabled:true,agentIds:[],roles:[...ROLES]}},create:{id:'singleton',uiShellRollout:{enabled:true,agentIds:[],roles:[...ROLES]}}});
const district=await prisma.district.upsert({where:{name:'Тестовый район'},update:{},create:{name:'Тестовый район'}});
for (const [i, kind] of ['SELLER','BUYER','BUYER','SELLER','BUYER'].entries()) await prisma.client.upsert({where:{shortId:90001+i},update:{assignedAgentId:i===4?null:agents[1].id,acceptedAt:new Date()},create:{shortId:90001+i,fullName:['Тестовый продавец','Тестовый покупатель','Продаёт и покупает','Продавец без объектов','Дополнительный клиент'][i],phone:`+99290100900${i}`,source:'PHONE_CALL',kind:kind as 'SELLER'|'BUYER',dualIntent:i===2,assignedAgentId:i===4?null:agents[1].id,acceptedAt:new Date(),budgetMax:700000,currency:'TJS',desiredDistrictId:district.id,desiredRooms:2,aiInsight:'Сейчас: тестовые данные для проверки карточки.\nДальше: договориться о показе.',aiInsightAt:new Date()}});
await prisma.client.updateMany({ where: { shortId: { in: [90001, 90002, 90004, 90005] } },
  data: { dualIntent: false, dualIntentConfirmedAt: null, dualIntentConfirmedById: null } });
await prisma.client.update({ where: { shortId: 90003 }, data: { dualIntent: true,
  dualIntentConfirmedAt: new Date(), dualIntentConfirmedById: agents[0].id } });
await prisma.client.updateMany({ where: { shortId: { in: [90002, 90003] } }, data: {
  requirementsFieldsKind: 'BUYER', desiredType: 'APARTMENT', desiredRooms: 2, budgetMax: 700000,
  desiredDistrictId: district.id, desiredFloorMin: 2, requirementsNotes: 'Нужен лифт, с ремонтом',
} });
await prisma.client.upsert({ where: { shortId: 90006 }, update: { kind: 'SELLER', dualIntent: true,
  dualIntentConfirmedAt: null, dualIntentConfirmedById: null, acceptedAt: new Date(), assignedAgentId: agents[1].id },
  create: { shortId: 90006, fullName: 'Тестовая неподтверждённая роль', phone: '+992901009006',
    source: 'PHONE_CALL', kind: 'SELLER', dualIntent: true, acceptedAt: new Date(), assignedAgentId: agents[1].id } });
const seller=await prisma.client.findUniqueOrThrow({where:{shortId:90001}});
const buyer=await prisma.client.findUniqueOrThrow({where:{shortId:90002}});
const dual=await prisma.client.findUniqueOrThrow({where:{shortId:90003}});
for (const [i, sellerId] of [seller.id, seller.id, dual.id].entries()) await prisma.property.upsert({where:{shortId:91001+i},update:{},create:{shortId:91001+i,title:`Тестовая квартира ${i+1}`,type:'APARTMENT',rooms:2,areaSqm:60,price:550000+i*10000,currency:'TJS',condition:'GOOD',status:'AVAILABLE',districtId:district.id,address:'Тестовый адрес',sellerClientId:sellerId,intakeAgentId:agents[1].id,createdById:agents[0].id}});
const property=await prisma.property.findUniqueOrThrow({where:{shortId:91001}});
await prisma.interaction.deleteMany({ where: { clientId: { in: [seller.id, buyer.id] } } });
await prisma.propertyExposure.deleteMany({ where: { clientId: buyer.id } });
await prisma.propertyExposure.createMany({data:Array.from({length:23},(_,i)=>({clientId:buyer.id,recipientId:'test-preview',channel:'WHATSAPP',propertyId:property.id,shortId:property.shortId,kind:'LINK',sentAt:new Date(Date.now()-i*60000)}))});
for (const clientId of [seller.id,buyer.id]) if (!await prisma.interaction.count({where:{clientId}})) await prisma.interaction.create({data:{clientId,agentId:agents[1].id,type:'CALL',notes:'Тестовое обещание',nextAction:'Согласовать показ',nextActionDate:new Date(Date.now()+86400000)}});
for (const c of [seller,buyer]) if (!await prisma.botConversation.count({where:{clientId:c.id}})) await prisma.botConversation.create({data:{clientId:c.id,channel:'INSTAGRAM',subscriberId:`test-preview-${c.shortId}`,messages:[{role:'user',content:'Тестовое сообщение',at:new Date().toISOString()}]}});
if (!await prisma.botConversation.count({ where: { clientId: buyer.id, channel: 'WEBSITE' } })) {
  await prisma.botConversation.create({ data: { clientId: buyer.id, channel: 'WEBSITE', subscriberId: 'test-preview-website-90002',
    messages: [{ role: 'user', content: 'Тестовое сообщение сайта', at: new Date().toISOString() }] } });
}
await prisma.property.updateMany({ where: { shortId: { in: [91001, 91002, 91003] } }, data: {
  floor: 3, totalFloors: 9, amenities: ['Лифт', 'Парковка'], description: 'Есть лифт. С ремонтом.',
} });
console.log('Client card stand: synthetic fixtures ready, localhost:4520');
app.listen(4520,'127.0.0.1');
