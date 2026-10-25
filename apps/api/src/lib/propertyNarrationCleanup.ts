import { localVideoDelete } from "./localVideoStorage.js";
import { logSystemError } from "./systemError.js";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Exact namespace used by generation, including files whose final DB write failed. */
export function narrationOwnedKeys(propertyId: string, versionIds: string[]): string[] {
  if (!UUID.test(propertyId) || versionIds.some(id => !UUID.test(id))) throw new Error("Invalid narration file identity");
  return [...new Set(versionIds)].map(id => `${propertyId}/${id}.mp3`);
}
/** Call only after the explicit hard-purge transaction commits. Never scans folders. */
export async function removePurgedNarrationAudio(propertyId: string, versionIds: string[]): Promise<void> {
  for (const key of narrationOwnedKeys(propertyId, versionIds)) {
    try {
      if (!await localVideoDelete(key)) await logSystemError("storage", `Озвучка удалённого объекта ${propertyId}: файл ${key} не удалён`);
    } catch {
      await logSystemError("storage", `Озвучка удалённого объекта ${propertyId}: ошибка удаления ${key}`);
    }
  }
}
