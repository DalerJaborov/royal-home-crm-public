import { beforeEach, describe, expect, it, vi } from "vitest";
const s = vi.hoisted(() => ({ remove: vi.fn(), log: vi.fn() }));
vi.mock("../src/lib/localVideoStorage.js", async (importOriginal) => ({ ...await importOriginal<typeof import("../src/lib/localVideoStorage.js")>(), localVideoDelete: s.remove }));
vi.mock("../src/lib/systemError.js", async (importOriginal) => ({ ...await importOriginal<typeof import("../src/lib/systemError.js")>(), logSystemError: s.log }));
import { narrationOwnedKeys, removePurgedNarrationAudio } from "../src/lib/propertyNarrationCleanup.js";
const p = "11111111-1111-4111-8111-111111111111", v = "22222222-2222-4222-8222-222222222222";
describe("exact narration hard purge", () => {
  beforeEach(() => { vi.clearAllMocks(); s.remove.mockResolvedValue(true); s.log.mockResolvedValue(undefined); });
  it("derives only exact version mp3 paths even without a persisted storageKey", async () => {
    expect(narrationOwnedKeys(p, [v, v])).toEqual([`${p}/${v}.mp3`]);
    await removePurgedNarrationAudio(p, [v]); expect(s.remove).toHaveBeenCalledExactlyOnceWith(`${p}/${v}.mp3`);
  });
  it("rejects traversal and does not touch photos or unrelated audio", async () => {
    expect(() => narrationOwnedKeys(p, ["../../other.mp3"])).toThrow();
    await removePurgedNarrationAudio(p, []); expect(s.remove).not.toHaveBeenCalled();
  });
  it("records false storage outcomes, not only thrown errors", async () => {
    s.remove.mockResolvedValue(false); await removePurgedNarrationAudio(p, [v]); expect(s.log).toHaveBeenCalledOnce();
  });
});
