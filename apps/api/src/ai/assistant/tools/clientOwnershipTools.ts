import { changeClientAgentTool } from "./changeClientAgentTool.js";
import { createClientTool } from "./createClientTool.js";
import { deleteClientPlugin } from "./deleteClientTool.js";
import { restoreClientPlugin } from "./restoreClientTool.js";
import type { AssistantToolPlugin } from "./types.js";

/** Группа «владение клиентом» (уровень C): change_client_agent и спутники; delete_client — клиент в Корзину (свой; чужой — с clients.delete); restore_client — из Корзины. */
export const clientOwnershipTools: readonly AssistantToolPlugin[] = [changeClientAgentTool, createClientTool, deleteClientPlugin, restoreClientPlugin];
