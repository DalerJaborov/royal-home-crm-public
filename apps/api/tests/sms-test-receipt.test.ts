import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
const s=vi.hoisted(()=>({send:vi.fn(),receipt:vi.fn()}));
vi.mock('../src/db.js',async (importOriginal)=>({...await importOriginal<typeof import('../src/db.js')>(),prisma:{$disconnect:vi.fn(),smsMessage:{findUnique:s.receipt}}}));
vi.mock('../src/auth/middleware.js',async (importOriginal)=>({...await importOriginal<typeof import('../src/auth/middleware.js')>(),requireAuth:(req:any,_res:any,next:()=>void)=>{req.agent={id:'admin',role:'ADMIN'};next();},requirePermission:()=> (_req:any,_res:any,next:()=>void)=>next()}));
vi.mock('../src/lib/stepUp.js',async (importOriginal)=>({...await importOriginal<typeof import('../src/lib/stepUp.js')>(),requireElevation:(_req:any,_res:any,next:()=>void)=>next()}));
vi.mock('../src/lib/sms/index.js',async (importOriginal)=>({...await importOriginal<typeof import('../src/lib/sms/index.js')>(),sendSms:s.send}));
import { smsRouter } from '../src/routes/sms.js';
const app=express();app.use(express.json());app.use('/sms',smsRouter);
beforeEach(()=>{vi.clearAllMocks();s.send.mockResolvedValue({ok:true,id:'receipt',parts:1});});
describe('SMS test returns actual journal status',()=>{
  it.each(['DRY_RUN','SENT'])('returns %s without pretending delivery',async status=>{s.receipt.mockResolvedValue({status});const res=await request(app).post('/sms/test').send({phone:'+992900000001'});expect(res.status).toBe(200);expect(res.body.status).toBe(status);expect(res.body).not.toHaveProperty('delivered');});
  it('unknown journal is not a success claim about send',async()=>{s.receipt.mockResolvedValue(null);expect((await request(app).post('/sms/test').send({phone:'+992900000001'})).body.status).toBe('UNKNOWN');});
  it('keeps invalid input and provider refusal as errors',async()=>{expect((await request(app).post('/sms/test').send({phone:'12'})).status).toBe(400);expect(s.send).not.toHaveBeenCalled();s.send.mockResolvedValue({ok:false,error:'Provider unavailable'});expect((await request(app).post('/sms/test').send({phone:'+992900000001'})).status).toBe(502);expect(s.receipt).not.toHaveBeenCalled();});
});

