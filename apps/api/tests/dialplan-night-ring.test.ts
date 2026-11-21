import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Ночное правило «ring» (владелец 21.11.2026): днём не взяли за 15 с — директору,
 * ночью директора не будим — звонит основной аппарат без предела, без переадресации.
 */
const conf = readFileSync(resolve(__dirname, "../../../ops/asterisk/extensions_custom.conf"), "utf8").replace(/\r\n/g, "\n");
const inbound = conf.slice(conf.indexOf("[royalhome-inbound]"), conf.indexOf("[royalhome-agent-route]"));
const lines = inbound.split("\n").filter((l) => /^\s*exten\s*=>/.test(l));
const at = (label: string) => lines.findIndex((l) => l.includes(`n(${label}),`));

describe("ночное правило ring", () => {
  it("ночью ring уходит на основной аппарат, а не в failover", () => {
    const night = at("night");
    expect(lines[night]).toContain('"${RH_NACT}"="ring"]?nightring');
    const ring = at("nightring");
    expect(ring).toBeGreaterThan(night);
    expect(lines.slice(ring, ring + 3).join("\n")).toMatch(/Set\(RH_ACTION=none\)[\s\S]*Set\(RH_WAIT=\)[\s\S]*Goto\(target\)/);
  });

  it("действие none у прямого аппарата = звонить без предела (пустой таймаут Dial)", () => {
    expect(inbound).toContain('ExecIf($["${RH_ACTION}"="none"]?Set(RH_DWAIT=))');
  });

  it("CRM принимает значение ring", () => {
    const settings = readFileSync(resolve(__dirname, "../src/routes/settings.ts"), "utf8");
    expect(settings).toContain('incomingNightAction: z.enum(["none", "forward", "voicemail", "ring"])');
  });
});
