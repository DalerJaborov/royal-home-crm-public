import { findClientsTool } from "./findClients.js";
import { findOpenTasksTool } from "./findOpenTasks.js";
import { findPropertiesByPlaceTool } from "./findPropertiesByPlace.js";
import { findPropertyTool } from "./findProperty.js";
import { getClientCardTool } from "./getClientCard.js";
import { getClientLastCallTool } from "./getClientLastCall.js";
import { getPropertyCardTool } from "./getPropertyCard.js";
import { getPropertyWorkStatusTool } from "./getPropertyWorkStatus.js";
import { listMyTasksTool } from "./listMyTasks.js";
import type { AssistantToolPlugin } from "./types.js";

/** Группа «чтение» (уровень A): find_clients, find_property, get_*_card, list_my_tasks. */
export const readTools: readonly AssistantToolPlugin[] = [
  findClientsTool,
  findOpenTasksTool,
  findPropertiesByPlaceTool,
  findPropertyTool,
  getClientCardTool,
  getClientLastCallTool,
  getPropertyCardTool,
  getPropertyWorkStatusTool,
  listMyTasksTool,
];
