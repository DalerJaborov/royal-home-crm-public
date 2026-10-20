import net from "node:net";
import http from "node:http";
import https from "node:https";
import childProcess from "node:child_process";
import dns from "node:dns";
import dgram from "node:dgram";
import http2 from "node:http2";
import tls from "node:tls";
import { syncBuiltinESMExports } from "node:module";
import { ReplayLedger } from "./ledger.js";

/** Install inside the already-created test worker, never around Vitest itself.
 * No URL/body/credentials enter the ledger. Original I/O is never called. */
export function installOfflineSandbox(ledger: ReplayLedger, pg?: { host: string; port: number }, localHttpPorts: ReadonlySet<number> = new Set()) {
  const saved: (() => void)[] = [];
  function replace(target: object, key: string, value: unknown) {
    const object = target as Record<string, unknown>; const before = object[key]; object[key] = value;
    saved.push(() => { object[key] = before; });
  }
  replace(globalThis, "fetch", async () => ledger.deny("network", "fetch"));
  for (const module of [http, https]) for (const name of ["request", "get"] as const) {
    const original = module[name];
    replace(module, name, (...args: unknown[]) => {
      const target = typeof args[0] === "string" || args[0] instanceof URL ? new URL(String(args[0])) : args[0] as { hostname?: string; host?: string; port?: number };
      const hostname = target instanceof URL ? target.hostname : target?.hostname ?? target?.host;
      const port = target instanceof URL ? Number(target.port) : Number(target?.port);
      if (module === http && hostname === "127.0.0.1" && localHttpPorts.has(port)) { ledger.record("network", "owned-loopback-http", true); return Reflect.apply(original, module, args); }
      return ledger.deny("network", `http-${name}`);
    });
  }
  replace(http2, "connect", () => ledger.deny("network", "http2-connect"));
  replace(tls, "connect", () => ledger.deny("network", "tls-connect"));
  replace(dgram, "createSocket", () => ledger.deny("network", "udp-socket"));
  for (const key of Object.keys(dns)) if (key === "lookup" || key === "lookupService" || key.startsWith("resolve") || key === "reverse") replace(dns, key, (...args: unknown[]) => {
    // Node Server.listen invokes lookup even for a numeric address. Resolve our
    // one declared literal locally; never call the original resolver/c-ares.
    if (pg && key === "lookup" && args[0] === "127.0.0.1") {
      const callback = args.at(-1) as (...values: unknown[]) => void;
      const all = typeof args[1] === "object" && args[1] !== null && (args[1] as { all?: boolean }).all;
      queueMicrotask(() => all ? callback(null, [{ address: "127.0.0.1", family: 4 }]) : callback(null, "127.0.0.1", 4)); return;
    }
    return ledger.deny("network", "dns");
  });
  for (const key of Object.keys(dns.promises)) if (key === "lookup" || key.startsWith("resolve") || key === "reverse") replace(dns.promises, key, async () => ledger.deny("network", "dns-promises"));
  for (const Resolver of [dns.Resolver, dns.promises.Resolver]) for (const key of Object.getOwnPropertyNames(Resolver.prototype)) {
    if (key.startsWith("resolve") || key === "reverse") replace(Resolver.prototype, key, () => ledger.deny("network", "dns-resolver-instance"));
  }
  const connect = net.Socket.prototype.connect;
  replace(net.Socket.prototype, "connect", function (this: net.Socket, ...args: unknown[]) {
    const first = Array.isArray(args[0]) ? args[0][0] : args[0]; // Node HTTP passes normalized argument tuple.
    const options = typeof first === "object" && first !== null ? first as { host?: string; port?: number } : { port: Number(first), host: typeof args[1] === "string" ? args[1] : "localhost" };
    if (pg && options.host === pg.host && Number(options.port) === pg.port) return Reflect.apply(connect, this, args);
    if (options.host === "127.0.0.1" && localHttpPorts.has(Number(options.port))) return Reflect.apply(connect, this, args);
    return ledger.deny("network", "socket-connect");
  });
  for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) replace(childProcess, name, () => ledger.deny("subprocess", name));
  syncBuiltinESMExports();
  return () => { for (const restore of saved.reverse()) restore(); syncBuiltinESMExports(); };
}
