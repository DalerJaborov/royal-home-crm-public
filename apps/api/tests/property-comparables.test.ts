import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
const s=vi.hoisted(()=>({access:true,findUnique:vi.fn(),count:vi.fn(),findMany:vi.fn()}));
vi.mock('../src/db.js',async importOriginal=>({...await importOriginal<typeof import('../src/db.js')>(),prisma:{$disconnect:vi.fn(),property:{findUnique:s.findUnique,count:s.count,findMany:s.findMany}}}));
vi.mock('../src/auth/middleware.js',async (importOriginal)=>({...await importOriginal<typeof import('../src/auth/middleware.js')>(),requireAuth:(req:any,_res:any,next:()=>void)=>{req.agent={id:'agent'};next();}}));
vi.mock('../src/routes/properties/shared.js',async (importOriginal)=>({...await importOriginal<typeof import('../src/routes/properties/shared.js')>(),canManageProperty:()=>s.access}));
import { propertyComparablesRouter } from '../src/routes/properties/comparables.js';
const id='00000000-0000-4000-8000-000000000001';const app=express();app.use('/properties',propertyComparablesRouter);
describe('internal comparable route',()=>{
  beforeEach(()=>{vi.clearAllMocks();s.access=true;s.findUnique.mockResolvedValue({id,deletedAt:null,districtId:'district',areaSqm:60,price:600000,currency:'TJS',type:'APARTMENT',rooms:2});s.count.mockResolvedValue(0);s.findMany.mockResolvedValue([]);});
  it('denies unauthorised subject and does not query catalogue',async()=>{s.access=false;expect((await request(app).get(`/properties/${id}/comparables`)).status).toBe(403);expect(s.findMany).not.toHaveBeenCalled();});
  it('does not invent geography or area',async()=>{s.findUnique.mockResolvedValue({id,districtId:null,areaSqm:60,price:600000,currency:'TJS'});const res=await request(app).get(`/properties/${id}/comparables`);expect(res.status).toBe(200);expect(res.body.criteria).toBeNull();expect(res.body.medianPricePerSqm).toBeNull();expect(s.findMany).not.toHaveBeenCalled();});
  it('excludes own/deleted/nonavailable/offsite and uses explicit same-currency criteria',async()=>{const res=await request(app).get(`/properties/${id}/comparables`);expect(res.status).toBe(200);expect(s.findMany.mock.calls[0][0]).toMatchObject({take:100,where:{id:{not:id},deletedAt:null,offSite:false,status:'AVAILABLE',currency:'TJS',areaSqm:{gte:48,lte:72}}});expect(res.body).toMatchObject({basis:'ASKING_PRICES',source:'CRM',usableCount:0});expect(s.findMany.mock.calls[0][0].select).not.toHaveProperty('ownerContact');});
  it('rejects unbounded client supplied filters',async()=>{expect((await request(app).get(`/properties/${id}/comparables?radius=1000000`)).status).toBe(400);});
});
