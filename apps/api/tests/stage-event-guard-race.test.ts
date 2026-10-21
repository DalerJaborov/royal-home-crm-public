import { afterAll, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { waitFor, waitForSettled } from "./helpers/waitFor.js";

const ids: string[] = [];
afterAll(async () => {
  await prisma.stageEvent.deleteMany({ where: { entityId: { in: ids } } });
  await prisma.client.deleteMany({ where: { id: { in: ids } } });
  await prisma.$disconnect();
});

it("a lost conditional write never invents a status transition in the journal", async () => {
  const client = await prisma.client.create({ data: {
    fullName: "test guarded stage journal", phone: `test-guarded-journal-${Date.now()}`,
    source: "WALK_IN", status: "CONTACTED",
  } });
  ids.push(client.id);
  // Runs after the stage hook's BEFORE read and before the guarded SQL write.
  const raced = prisma.$extends({ query: { client: {
    async updateMany({ args, query }) {
      await prisma.client.update({ where: { id: client.id }, data: { status: "ARCHIVED" } });
      return query(args);
    },
  } } });
  const written = await raced.client.updateMany({
    where: { id: client.id, status: "CONTACTED", workStatus: "ACTIVE" },
    data: { workStatus: "INACTIVE" },
  });
  expect(written.count).toBe(0);
  expect(await prisma.client.findUniqueOrThrow({ where: { id: client.id } }))
    .toMatchObject({ status: "ARCHIVED", workStatus: "ACTIVE" });
  await waitFor(() => prisma.stageEvent.count({ where: { entityId: client.id, field: "status", to: "ARCHIVED" } }),
    (count) => count === 1);
  const falseTransitions = await waitForSettled(() => prisma.stageEvent.count({
    where: { entityId: client.id, field: "workStatus", to: "INACTIVE" },
  }));
  expect(falseTransitions).toBe(0);
});
