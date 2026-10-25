import path from "node:path";
import { uploadsDir } from "../upload.js";
/** Only existing generated/manual CRM covers. No remote fetch or caller-controlled path. */
export function metadataCoverPath(key: string | null): string | null {
  if (!key || !/^\/uploads\/covers\/[a-zA-Z0-9_-]+\.(?:jpg|jpeg|png)$/i.test(key)) return null;
  return path.join(uploadsDir, "covers", path.basename(key));
}
