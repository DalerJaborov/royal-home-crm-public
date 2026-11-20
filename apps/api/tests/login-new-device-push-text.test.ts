import { describe, expect, it } from "vitest";
import { newDevicePushBody } from "../src/lib/loginLog.js";

/**
 * Пуш сотруднику о входе с нового устройства (пачка D1, ревью #331): агенту — без IP
 * («IP ::1» ему ничего не говорит), директору и остальным ролям — с IP, как было.
 */
describe("пуш о входе с нового устройства", () => {
  it("агенту — без IP", () => {
    const body = newDevicePushBody("Chrome на Windows", "::1", "AGENT");
    expect(body).toContain("Chrome на Windows");
    expect(body).not.toContain("IP");
    expect(body).not.toContain("::1");
  });
  it("директору — с IP в его собственном пуше", () => {
    expect(newDevicePushBody("Chrome на Windows", "10.0.0.5", "DIRECTOR")).toContain("IP 10.0.0.5");
  });
  it("без IP — без хвоста «, IP»", () => {
    expect(newDevicePushBody("Safari на iPhone", null, "DIRECTOR")).not.toContain("IP");
  });
});
