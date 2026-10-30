import type { Prisma } from "../generated/prisma/client.js";
import { TERMINAL_CLIENT_STATUSES } from "./clientContact.js";

/** Shared by the working-list scope and its buyer/seller counters. */
export const CLIENT_IN_WORK_WHERE = {
  deletedAt: null,
  workStatus: "ACTIVE",
  assignmentCompletedAt: null,
  status: { notIn: [...TERMINAL_CLIENT_STATUSES] },
} satisfies Prisma.ClientWhereInput;
