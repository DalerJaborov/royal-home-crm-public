import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Client } from "../types";
import { ClientIntentConfirmation } from "./ClientIntentConfirmation";

const client = { id: "role-test", kind: "BUYER", dualIntent: false } as Client;
function render(value: Client, mode: "overview" | "edit" = "overview", locked = false) {
  return renderToStaticMarkup(<QueryClientProvider client={new QueryClient()}><ClientIntentConfirmation client={value} locked={locked} mode={mode} /></QueryClientProvider>);
}
describe("current role presentation", () => {
  it("never asks every buyer whether they also sell", () => {
    expect(render(client)).not.toContain("<button");
    expect(render({ ...client, dualIntentNeedsConfirmation: true })).not.toContain("<button");
  });
  it("shows automatic dual role without a confirmation action", () => {
    const html = render({ ...client, dualIntent: true, dualIntentDecisionSource: "AUTO" });
    expect(html).toContain("Покупает и продаёт");
    expect(html).toContain("Определено автоматически");
    expect(html).not.toContain("<button");
  });
  it("offers clarification only for ambiguity and manual correction in edit", () => {
    expect(render({ ...client, dualIntentNeedsReview: true })).toContain("Уточнить роли клиента");
    expect(render(client, "edit")).toContain("Изменить роли клиента");
    expect(render({ ...client, dualIntentNeedsReview: true }, "overview", true)).not.toContain("<button");
  });
});
