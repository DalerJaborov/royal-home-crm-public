import { readFileSync, realpathSync } from "node:fs";
import { z } from "zod";

const markerSchema = z.object({ version: z.literal(1), database: z.string().regex(/^agent_[1-9]\d{3,4}$/), host: z.literal("127.0.0.1"), port: z.literal(15500), worktree: z.string(), nonce: z.string().uuid() }).strict();
export function standOwnership(url: string | undefined, markerPath: string | undefined, worktree: string) {
  if (!url || !markerPath) throw new Error("Explicit own replay database and ownership marker required");
  const target = new URL(url);
  const marker = markerSchema.parse(JSON.parse(readFileSync(markerPath, "utf8")));
  if (target.protocol !== "postgresql:" || !["localhost", "127.0.0.1"].includes(target.hostname) || target.port !== String(marker.port) || target.pathname !== `/${marker.database}` || target.search ||
      realpathSync(marker.worktree) !== realpathSync(worktree)) throw new Error("Replay database ownership boundary rejected");
  target.hostname = "127.0.0.1";
  return { marker, url: target.toString(), expectedComment: `p04-replay:${marker.nonce}` };
}
