import { Router } from "express";
import { z } from "zod";
import type { Prisma } from "../../generated/prisma/client.js";
import { requireAuth } from "../../auth/middleware.js";
import { prisma } from "../../db.js";

const bodySchema = z.object({ expectedStartedAt: z.string().datetime(), providerChecked: z.literal(true), outcome: z.enum(["APPLIED", "FAILED"]), note: z.string().trim().min(20).max(2000) }).strict();
export const publicationMetadataRouter = Router();
/** Operator attestation only; never calls a provider and never requeues an attempt. */
publicationMetadataRouter.post("/:id/publication-metadata/:attemptId/reconcile", requireAuth, async (req,res)=>{
  if(!["ADMIN","DIRECTOR"].includes(req.agent!.role)) return res.status(403).json({error:"Проверку фиксирует руководство"});
  const propertyId=z.string().uuid().safeParse(req.params.id),attemptId=z.string().uuid().safeParse(req.params.attemptId),body=bodySchema.safeParse(req.body);
  if(!propertyId.success||!attemptId.success||!body.success) return res.status(400).json({error:"Подтвердите проверку площадки и опишите фактический результат (не менее20символов)"});
  const changed=await prisma.$transaction(async tx=>{
    await tx.$queryRaw`SELECT id FROM "PublicationMetadataSync" WHERE id = ${attemptId.data} FOR UPDATE`;
    const row=await tx.publicationMetadataSync.findFirst({where:{id:attemptId.data,propertyId:propertyId.data}});
    if(!row?.startedAt || row.startedAt.toISOString()!==body.data.expectedStartedAt || !["EXECUTING","UNKNOWN"].includes(row.status)) return null;
    const status=body.data.outcome==='APPLIED'?'APPLIED_MANUAL':'FAILED_MANUAL';
    const original=row.result as Prisma.InputJsonValue|null;
    const result={originalProviderResult:original,operatorConfirmation:{actorId:req.agent!.id,at:new Date().toISOString(),outcome:body.data.outcome,note:body.data.note,providerChecked:true,remoteVerification:false}};
    const updated=await tx.publicationMetadataSync.updateMany({where:{id:row.id,status:row.status,startedAt:row.startedAt},data:{status,finishedAt:new Date(),result,reason:'Результат подтверждён сотрудником после проверки площадки. Автоповтор этой попытки запрещён.'}});
    if(!updated.count) return null;
    await tx.auditLog.create({data:{agentId:req.agent!.id,agentName:'Руководитель',action:'PUBLICATION_METADATA_RECONCILED',entityType:'Property',entityId:propertyId.data,meta:{attemptId:row.id,priorStatus:row.status,status,note:body.data.note,operatorAttestation:true}}});
    return status;
  });
  if(!changed) return res.status(409).json({error:"Попытка уже изменилась. Обновите карточку; повтор не выполнен."});
  res.json({status:changed,operatorAttestation:true,sent:false});
});
