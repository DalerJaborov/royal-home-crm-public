import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
const s=vi.hoisted(()=>({role:'ADMIN',find:vi.fn(),update:vi.fn(),audit:vi.fn()}));
vi.mock('../src/db.js',async importOriginal=>({...await importOriginal<typeof import('../src/db.js')>(),prisma:{$disconnect:vi.fn(),$transaction:async(fn:any)=>fn({$queryRaw:vi.fn(),publicationMetadataSync:{findFirst:s.find,updateMany:s.update},auditLog:{create:s.audit}})}}));
vi.mock('../src/auth/middleware.js',async (importOriginal)=>({...await importOriginal<typeof import('../src/auth/middleware.js')>(),requireAuth:(req:any,_res:any,next:()=>void)=>{req.agent={id:'actor',role:s.role};next();}}));
import { publicationMetadataRouter } from '../src/routes/properties/publicationMetadata.js';
const id='00000000-0000-4000-8000-000000000001',attempt='00000000-0000-4000-8000-000000000002',at='2026-10-25T12:00:00.000Z';
const app=express();app.use(express.json());app.use('/properties',publicationMetadataRouter);
const body={expectedStartedAt:at,providerChecked:true,outcome:'FAILED',note:'Проверены публикация и журнал площадки: изменение отсутствует.'};
beforeEach(()=>{vi.clearAllMocks();s.role='ADMIN';s.find.mockResolvedValue({id:attempt,propertyId:id,status:'UNKNOWN',startedAt:new Date(at),result:{original:'timeout'}});s.update.mockResolvedValue({count:1});});
describe('manual metadata reconciliation',()=>{
  it.each(['AGENT','MARKETING','EDITOR'])('denies %s',async role=>{s.role=role;expect((await request(app).post(`/properties/${id}/publication-metadata/${attempt}/reconcile`).send(body)).status).toBe(403);expect(s.update).not.toHaveBeenCalled();});
  it('requires explicit provider inspection and meaningful note',async()=>{expect((await request(app).post(`/properties/${id}/publication-metadata/${attempt}/reconcile`).send({...body,providerChecked:false})).status).toBe(400);expect((await request(app).post(`/properties/${id}/publication-metadata/${attempt}/reconcile`).send({...body,note:'ok'})).status).toBe(400);});
  it('preserves provider evidence and records operator attribution, never sends',async()=>{const res=await request(app).post(`/properties/${id}/publication-metadata/${attempt}/reconcile`).send(body);expect(res.body).toEqual({status:'FAILED_MANUAL',operatorAttestation:true,sent:false});expect(s.update.mock.calls[0][0].data.result).toMatchObject({originalProviderResult:{original:'timeout'},operatorConfirmation:{remoteVerification:false,actorId:'actor'}});expect(s.audit).toHaveBeenCalledTimes(1);});
  it('rejects stale fence or already resolved attempt',async()=>{expect((await request(app).post(`/properties/${id}/publication-metadata/${attempt}/reconcile`).send({...body,expectedStartedAt:'2026-10-24T12:00:00.000Z'})).status).toBe(409);s.find.mockResolvedValue({status:'APPLIED_MANUAL',startedAt:new Date(at)});expect((await request(app).post(`/properties/${id}/publication-metadata/${attempt}/reconcile`).send(body)).status).toBe(409);expect(s.update).not.toHaveBeenCalled();});
});
