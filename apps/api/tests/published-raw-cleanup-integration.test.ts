import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { videoHandoffDir } from "../src/upload.js";
import { localVideoUpload, localVideoFilePath } from "../src/lib/localVideoStorage.js";
import { cleanupStalePropertyVideos } from "../src/lib/propertyVideoCleanup.js";

const id = randomUUID();
let agentId: string | undefined;
let districtId: string | undefined;
let finalFile: string | undefined;
let rawFile: string | null = null;

afterAll(async () => {
  await prisma.auditLog.deleteMany({where:{entityId:id}});
  await prisma.propertyVideo.deleteMany({where:{propertyId:id}});
  await prisma.property.deleteMany({where:{id}});
  if(agentId)await prisma.agent.deleteMany({where:{id:agentId}});
  if(districtId)await prisma.district.deleteMany({where:{id:districtId}});
  if(finalFile)await fs.rm(finalFile,{force:true});
  if(rawFile)await fs.rm(rawFile,{force:true});
});

it("deletes a real expired source and database row while preserving the finished file and audit", async () => {
  const agent=await prisma.agent.create({data:{fullName:"Retention test",phone:`ret-${id}`,role:"AGENT",passwordHash:"test"}});
  agentId=agent.id;
  const district=await prisma.district.create({data:{name:`Retention-${id}`}});
  districtId=district.id;
  const publishedAt=new Date(Date.now()-8*86_400_000);
  const finalPath=`/uploads/handoff/${id}-retention.mp4`;
  const storageKey=`${id}/${randomUUID()}.mp4`;
  await prisma.property.create({data:{id,title:"Retention test",type:"APARTMENT",areaSqm:50,price:50000,currency:"USD",
    districtId,address:"Test",condition:"GOOD",status:"AVAILABLE",videoHandoffStatus:"RECEIVED",
    videoHandoffFinalPath:finalPath,publishedChannels:["INSTAGRAM"],
    publishedPostIds:{INSTAGRAM:"test-post",RAW_VIDEO_PUBLISHED_AT:publishedAt.toISOString(),RAW_VIDEO_PUBLISHED_PATH:finalPath},
    videos:{create:{storageKey,filename:"raw.mp4",sizeBytes:3,uploadedById:agentId,uploadedAt:new Date(publishedAt.getTime()-1000)}}}});
  await fs.mkdir(videoHandoffDir,{recursive:true});
  finalFile=path.join(videoHandoffDir,path.basename(finalPath));
  await fs.writeFile(finalFile,"finished");
  await localVideoUpload(storageKey,Buffer.from("raw"));
  rawFile=localVideoFilePath(storageKey);
  await cleanupStalePropertyVideos();
  expect(await prisma.propertyVideo.count({where:{propertyId:id}})).toBe(0);
  await expect(fs.access(rawFile!)).rejects.toThrow();
  expect(await fs.readFile(finalFile,"utf8")).toBe("finished");
  const audit=await prisma.auditLog.findFirst({where:{entityId:id,action:"PROPERTY_VIDEO_CLEANUP"}});
  expect(audit?.meta).toMatchObject({reason:"published-source-retention-7d",retentionDays:7});
});
