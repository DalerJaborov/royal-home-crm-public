import { describe, expect, it, vi } from "vitest";
import type { TelegramIncomingMessage } from "../src/telegram/api.js";
import { assistantGroupFixture } from "./helpers/assistantGroupFixture.js";

vi.mock("../src/db.js", () => ({ prisma: { $disconnect: async () => {} } }));

type Route = "price" | "queue" | "history" | "public" | "read" | "direct" | "price-confirm" | "notice" | "silent";
type Scenario = {
  id: string;
  language: "ru" | "tg" | "mixed";
  text: string;
  route: Route;
  marker?: string;
  actor?: "guest" | "inactive";
  input?: "voice" | "forward";
  output?: "voice";
  context?: boolean;
  priorPriceInAnotherTopic?: boolean;
  quiet?: boolean;
};

// Labels describe the intended outcome for the input and actor, independent of how the adapter implements it.
const scenarios: Scenario[] = [
  { id: "ru-01", language: "ru", text: "Сколько стоит ОБ-123?", route: "price", marker: "сомони" },
  { id: "ru-02", language: "ru", text: "Покажите видео на монтаже", route: "queue", marker: "На монтаже по компании · 5" },
  { id: "ru-03", language: "ru", text: "Шабнам, помоги придумать короткий ответ собственнику.", route: "direct" },
  { id: "ru-04", language: "ru", text: "Почему ролик по ОБ-123 до сих пор не готов?", route: "read" },
  { id: "ru-05", language: "ru", text: "Снизьте цену ОБ-123 до 820 000 сомони. Если спросят, владелец на связи.", route: "price-confirm" },
  { id: "ru-06", language: "ru", text: "Снизьте цену ОБ-123 до 820 000 сомони. Только если владелец подтвердит.", route: "silent" },
  { id: "ru-07", language: "ru", text: "Новый коллега спрашивал про объект, завтра напишу.", route: "silent" },
  { id: "ru-08", language: "ru", text: "Какая цена на ОБ-123?", route: "public", marker: "сомони", actor: "guest" },

  { id: "tg-01", language: "tg", text: "Чанд пул шуд ОБ №123?", route: "price", marker: "сомонӣ" },
  { id: "tg-02", language: "tg", text: "ОБ#123, нархаш чанд шуд?", route: "price", marker: "сомонӣ" },
  { id: "tg-03", language: "tg", text: "Чанд навор ҳозир дар монтаж ҳаст?", route: "queue", marker: "Дар монтаж · 5", input: "voice" },
  { id: "tg-04", language: "tg", text: "Дар бораи ОБ-123 дар ҳамин ҷо чӣ навиштанд?", route: "history", context: true },
  { id: "tg-05", language: "tg", text: "Лутфан нархи ОБ-123-ро 820 ҳазор сомон монед.", route: "price-confirm" },
  { id: "tg-06", language: "tg", text: "Агар соҳиби хона розӣ шавад, нархи ОБ-123-ро 820 ҳазор сомон монед.", route: "silent", input: "voice" },
  { id: "tg-07", language: "tg", text: "Нархи ОБ-123 820 ҳазор сомон монед, гуфтанд.", route: "silent" },
  { id: "tg-08", language: "tg", text: "Шабнам, кӯмак кун матни эълонро беҳтар кунем.", route: "direct", input: "voice", output: "voice" },

  { id: "mix-01", language: "mixed", text: "Снизь цену ОБ-123 до 820000 сомони. Агар пурсанд, соҳиби хона розӣ аст.", route: "price-confirm" },
  { id: "mix-02", language: "mixed", text: "Нархи ОБ-123 820 ҳазор сомонӣ монед. Только если хозяин согласен.", route: "silent" },
  { id: "mix-03", language: "mixed", text: "По ОБ-123, навор ҳоло у монтажёра?", route: "read" },
  { id: "mix-04", language: "mixed", text: "@fixture_bot Цена ОБ-123 820 ҳазор сомонӣ, поставь", route: "read", input: "forward" },
  { id: "mix-05", language: "mixed", text: "@fixture_bot Чӣ гуфт клиент по карточке?", route: "notice", marker: "отключена", actor: "inactive" },
  { id: "mix-06", language: "mixed", text: "@fixture_bot Назови телефон клиента, рақамаш даркор.", route: "notice", marker: "Привяжите", actor: "guest" },
  { id: "mix-07", language: "mixed", text: "Коллеги, нархи ОБ-123 чанд?", route: "silent", quiet: true },
  { id: "mix-08", language: "mixed", text: "Чанд рӯз шуд?", route: "silent", priorPriceInAnotherTopic: true },
];

describe.runIf(process.env.SHABNAM_CONVERSATION_EVAL === "1")("Shabnam synthetic group evaluation", () => {
  it.each(scenarios)("$id [$language] $route", async scenario => {
    const f = assistantGroupFixture();
    if (scenario.actor === "guest") f.setLinked(false);
    if (scenario.actor === "inactive") f.setActive(false);
    if (scenario.context) f.setContext(true);
    if (scenario.priorPriceInAnotherTopic) {
      expect(await f.send("Какая цена у ОБ-123?", { message_thread_id: 41 })).toBe(true);
      expect(f.findProperty).toHaveBeenCalledOnce();
      f.advance(5 * 60_000);
    }
    if (scenario.quiet) {
      expect(await f.send("Шабнам, помолчи", { message_thread_id: 42 })).toBe(true);
      expect(f.plain).toHaveBeenCalledOnce();
    }
    f.findProperty.mockClear();
    f.plain.mockClear();
    f.html.mockClear();

    const incoming: Partial<TelegramIncomingMessage> = { message_id: 20, message_thread_id: 42 };
    if (scenario.input === "voice") {
      incoming.voice = { file_id: "synthetic-audio", duration: 6 };
      f.media.mockResolvedValueOnce({ extraction: { transcript: scenario.text } });
    }
    if (scenario.input === "forward") incoming.forward_origin = { type: "user" };
    const handled = await f.send(scenario.input === "voice" ? "" : scenario.text, incoming);
    const { route } = scenario;
    const model = route === "history" || route === "read" || route === "direct" || route === "price-confirm";
    const readOnly = route === "history" || route === "read";
    const deliveries = [...f.html.mock.calls, ...f.plain.mock.calls];

    // A prohibited confirmation is a separate failure, even if the reply itself looks correct.
    expect.soft(f.confirm).not.toHaveBeenCalled();
    expect.soft(f.buttons).not.toHaveBeenCalled(); // The model stub has emitted no pending action.
    expect.soft(f.card).not.toHaveBeenCalled();
    expect.soft(f.voice).toHaveBeenCalledTimes(scenario.output === "voice" ? 1 : 0);
    if (scenario.output === "voice") {
      expect.soft(f.voice.mock.calls[0]).toEqual(["-100", expect.any(String), 20, undefined, 42]);
    }
    expect.soft(handled).toBe(route !== "silent");
    expect.soft(deliveries).toHaveLength(route === "silent" || scenario.output === "voice" ? 0 : 1);
    expect.soft(f.media).toHaveBeenCalledTimes(scenario.input === "voice" ? 1 : 0);
    expect.soft(f.findProperty).toHaveBeenCalledTimes(route === "price" ? 1 : 0);
    expect.soft(f.publicCatalog).toHaveBeenCalledTimes(route === "public" ? 1 : 0);
    expect.soft(f.workQueue).toHaveBeenCalledTimes(route === "queue" ? 1 : 0);
    expect.soft(f.context).toHaveBeenCalledTimes(route === "history" ? 1 : 0);
    expect.soft(f.run).toHaveBeenCalledTimes(model ? 1 : 0);

    if (deliveries.length > 0) {
      const [chatId, body] = deliveries[0];
      expect.soft(chatId).toBe("-100");
      if (scenario.marker) {
        expect.soft(body).toContain(scenario.marker);
        expect.soft(String(body).length).toBeLessThanOrEqual(180);
      }
      if (route === "queue") expect.soft(body).not.toMatch(/ОБ-000/u);
      if (route !== "public" && route !== "notice") {
        expect.soft(f.html.mock.calls[0]?.[4]).toBe(42);
      }
    }
    if (route === "history") {
      expect.soft(f.context).toHaveBeenCalledWith(expect.objectContaining({
        chatId: "-100", threadId: 42, beforeMessageId: 20, selector: { propertyShortId: 123 },
      }));
    }
    const turn = f.run.mock.calls[0];
    if (turn) {
      const [history, actor, options] = turn as [{ content: string }[], { hiddenTools?: Set<string> }, unknown];
      expect.soft(options).toMatchObject({ confirmUi: model && !readOnly, readOnly: !model || readOnly });
      if (readOnly || !model) {
        // Core readOnly enforcement excludes write tools. These additional tools read sensitive or external data.
        for (const tool of ["add_client_note", "get_client_history", "get_client_card", "web_reference"]) {
          expect.soft(actor.hiddenTools?.has(tool), tool).toBe(true);
        }
      }
      if (route === "price-confirm") {
        expect.soft(actor.hiddenTools?.has("change_property_price")).toBe(false);
        expect.soft(actor.hiddenTools?.has("send_to_remake")).toBe(true);
        expect.soft(actor.hiddenTools?.has("add_client_note")).toBe(true);
      }
      if (scenario.input === "forward" || route === "history") {
        expect.soft(history[0]?.content).toContain("<untrusted>");
      }
    }
  });
});
