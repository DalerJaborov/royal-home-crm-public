import { addClientNoteTool } from "./addClientNoteTool.js";
import { bookShowingTool } from "./bookShowingTool.js";
import { cancelShowingTool } from "./cancelShowingTool.js";
import { rescheduleShowingTool } from "./rescheduleShowingTool.js";
import type { AssistantToolPlugin } from "./types.js";

/** Группа «показы и заметки»: book/reschedule/cancel_showing (C), add_client_note (B). */
export const showingNoteTools: readonly AssistantToolPlugin[] = [
  bookShowingTool,
  rescheduleShowingTool,
  cancelShowingTool,
  addClientNoteTool,
];
