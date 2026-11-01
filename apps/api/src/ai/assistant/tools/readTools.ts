import { findClientsTool } from "./findClients.js";
import { findPropertyTool } from "./findProperty.js";
import { getClientCardTool } from "./getClientCard.js";
import { getPropertyCardTool } from "./getPropertyCard.js";
import { listMyTasksTool } from "./listMyTasks.js";
import type { AssistantToolPlugin } from "./types.js";

/** Группа «чтение» (уровень A): find_clients, find_property, get_*_card, list_my_tasks. */
export const readTools: readonly AssistantToolPlugin[] = [
  findClientsTool,
  findPropertyTool,
  getClientCardTool,
  getPropertyCardTool,
  listMyTasksTool,
];
