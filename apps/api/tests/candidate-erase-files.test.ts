import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { eraseJobApplicationsTx, removeCandidateFiles } from "../src/lib/candidateErase.js";
import { privateFilePath, savePrivateFile } from "../src/lib/privateFiles.js";

const marker = `synthetic-candidate-files-${randomUUID()}`;
const applicationIds: string[] = [];
let filesDir: string;
let oldFilesDir: string | undefined;

beforeAll(() => {
  oldFilesDir = process.env.PRIVATE_UPLOADS_DIR;
  filesDir = fs.mkdtempSync(path.join(os.tmpdir(), "crm-candidate-files-"));
  process.env.PRIVATE_UPLOADS_DIR = filesDir;
});
afterAll(async () => {
  await prisma.jobApplication.deleteMany({ where: { id: { in: applicationIds } } });
  fs.rmSync(filesDir, { recursive: true, force: true });
  if (oldFilesDir === undefined) delete process.env.PRIVATE_UPLOADS_DIR;
  else process.env.PRIVATE_UPLOADS_DIR = oldFilesDir;
});

it.each(["cv", "portfolio", "voice"] as const)(
  "retains a deleted application's file referenced by another application's %s", async (reference) => {
    const filename = await savePrivateFile(Buffer.from("Synthetic shared candidate file"), "application/pdf");
    expect(filename).not.toBeNull();
    const erased = await prisma.jobApplication.create({ data: { channel: "MANUAL", name: marker, cvFile: filename } });
    const retained = await prisma.jobApplication.create({ data: {
      channel: "MANUAL", name: marker,
      ...(reference === "cv" ? { cvFile: filename } : {}),
      ...(reference === "voice" ? { rejectionReasonVoiceUrl: `/me/voice-notes/${filename}` } : {}),
      ...(reference === "portfolio" ? { customerPortfolio: [{
        kind: "file", file: filename, mime: "application/pdf", sourceEventKey: "f".repeat(64),
      }] } : {}),
    } });
    applicationIds.push(erased.id, retained.id);
    const files = await prisma.$transaction((tx) => eraseJobApplicationsTx(tx, [erased.id]));
    expect(await removeCandidateFiles(files)).toEqual({ removed: 0, kept: 1 });
    expect(privateFilePath(filename!)).not.toBeNull();

    // Once the final reference is gone, normal cleanup must still work.
    await prisma.$transaction((tx) => eraseJobApplicationsTx(tx, [retained.id]));
    expect(await removeCandidateFiles(files)).toEqual({ removed: 1, kept: 0 });
    expect(privateFilePath(filename!)).toBeNull();
  }
);

it("retains files still present in a conversation after the application is erased", async () => {
  const filename = await savePrivateFile(Buffer.from("Synthetic chat attachment"), "application/pdf");
  expect(filename).not.toBeNull();
  const conversationId = randomUUID();
  await prisma.botConversation.create({ data: {
    id: conversationId, channel: "WHATSAPP", subscriberId: marker,
    messages: [{ role: "user", content: "Synthetic attachment", attachments: [{ kind: "file", file: filename }] }],
  } });
  try {
    const erased = await prisma.jobApplication.create({ data: { channel: "MANUAL", name: marker, cvFile: filename } });
    applicationIds.push(erased.id);
    const files = await prisma.$transaction((tx) => eraseJobApplicationsTx(tx, [erased.id]));
    expect(await removeCandidateFiles(files)).toEqual({ removed: 0, kept: 1 });
    expect(privateFilePath(filename!)).not.toBeNull();
  } finally {
    await prisma.botConversation.delete({ where: { id: conversationId } });
  }
});
