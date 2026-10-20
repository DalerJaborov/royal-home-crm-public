import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeMediaInfo } from "./ffmpeg.js";
import type { CustomerAgentAwaitContext } from "../ai/customerAgentModelContracts.js";

/** Server-observed container tracks, never a client/model claim. Unknown is
 * distinct from absent; no media bytes or path are logged or persisted. */
export async function customerVideoHasAudio(bytes: Buffer, wait: CustomerAgentAwaitContext): Promise<boolean | undefined> {
  wait.signal.throwIfAborted();
  const remaining = wait.deadlineAt - Date.now();
  if (remaining <= 0) throw new Error("Original media deadline expired");
  const folder = await mkdtemp(join(tmpdir(), "rh-customer-media-"));
  try {
    const path = join(folder, randomUUID() + ".media");
    await writeFile(path, bytes, { flag: "wx", signal: wait.signal });
    const info = await probeMediaInfo(path, Math.max(1, Math.min(4000, remaining)));
    wait.signal.throwIfAborted();
    if (Date.now() >= wait.deadlineAt) throw new Error("Original media deadline expired");
    return info?.hasVideo ? info.hasAudio : undefined;
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}
