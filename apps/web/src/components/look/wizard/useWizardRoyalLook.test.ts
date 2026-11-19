import { describe, expect, it } from "vitest";
import { wizardLookGrant } from "./useWizardRoyalLook";

/** Признак вида мастера: запомненное действует только пока ответ сервера в пути. */
describe("wizardLookGrant", () => {
  it("сервер дал вид — новый вид", () => expect(wizardLookGrant(true, false, false)).toBe(true));
  it("ответ в пути и вид запомнен на устройстве — новый вид сразу, без мигания", () => expect(wizardLookGrant(false, true, true)).toBe(true));
  it("ответ в пути, ничего не запомнено — прежний вид", () => expect(wizardLookGrant(false, true, false)).toBe(false));
  it("сервер ответил без вида — запомненное не действует (выключение и отказ сразу)", () => expect(wizardLookGrant(false, false, true)).toBe(false));
});
