import { changeClientAgentTool } from "./changeClientAgentTool.js";
import { createClientTool } from "./createClientTool.js";
import { deleteClientPlugin } from "./deleteClientTool.js";
import type { AssistantToolPlugin } from "./types.js";

/** Группа «владение клиентом» (уровень C): change_client_agent и спутники; delete_client — свой клиент в Корзину. */
export const clientOwnershipTools: readonly AssistantToolPlugin[] = [changeClientAgentTool, createClientTool, deleteClientPlugin];
