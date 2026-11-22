import { describe, expect, it } from "vitest";
import { isResyncPickupCandidate } from "../src/lib/telephony/ariEvents.js";
import type { AriChannel } from "../src/lib/telephony/ariTypes.js";

/**
 * Досинхронизация после обрыва подписки ARI не должна принимать плечи НАШЕГО
 * исходящего за входящие (разбор 21.11.2026 18:14, CDR станции): агент говорила с
 * клиентом, подписка оборвалась, и CRM завела «пропущенный» с номером агента, а плечо
 * клиента увела агенту Redirect'ом — разговор оборвался. Номера в тесте — образцы.
 */
const leg = (over: Partial<AriChannel>): AriChannel => ({
  id: "1795266851.2690",
  name: "SIP/out-00000566",
  state: "Up",
  caller: { number: "900111222" },
  dialplan: { context: "from-trunk-sip-out", exten: "s", priority: 1 },
  ...over,
});

const outgoing = [{ clientPhone: "+992900333444", dialingTo: "+992900111222" }];

describe("isResyncPickupCandidate", () => {
  it("плечо к мобильному агента (в разговоре) не подхватывается", () => {
    expect(isResyncPickupCandidate(leg({}), outgoing)).toBe(false);
  });

  it("плечо к клиенту, даже ещё звонящее, не подхватывается — это наш исходящий", () => {
    expect(isResyncPickupCandidate(leg({ state: "Ringing", caller: { number: "900333444" } }), outgoing)).toBe(false);
  });

  it("любой канал уже в разговоре не подхватывается, даже без нашего исходящего", () => {
    expect(isResyncPickupCandidate(leg({ caller: { number: "900555666" } }), [])).toBe(false);
  });

  it("звонящее плечо к мобильному агента (Ringing) не подхватывается по номеру", () => {
    expect(isResyncPickupCandidate(leg({ state: "Ringing" }), outgoing)).toBe(false);
  });

  it("после рестарта (памяти об исходящем нет) звонящее плечо Dial опознаётся по AppDial", () => {
    const ringingLeg = leg({
      state: "Ringing",
      caller: { number: "900333444" },
      dialplan: { context: "from-trunk-sip-out", exten: "s", priority: 1, app_name: "AppDial", app_data: "(Outgoing Line)" },
    });
    expect(isResyncPickupCandidate(ringingLeg, [])).toBe(false);
    expect(isResyncPickupCandidate({ ...ringingLeg, dialplan: { app_data: "(Outgoing Line)" } }, [])).toBe(false);
    expect(isResyncPickupCandidate({ ...ringingLeg, dialplan: { app_name: "AppQueue" } }, [])).toBe(false);
  });

  it("настоящий входящий, ждущий ответа, подхватывается как раньше", () => {
    expect(isResyncPickupCandidate(leg({ state: "Ring", caller: { number: "900555666" } }), outgoing)).toBe(true);
    // В royalhome-inbound канал стоит в своём приложении диалплана, не в AppDial.
    expect(
      isResyncPickupCandidate(
        leg({
          state: "Ringing",
          caller: { number: "900555666" },
          dialplan: { context: "from-trunk-sip-out", exten: "s", priority: 5, app_name: "WaitForCondition", app_data: "" },
        }),
        []
      )
    ).toBe(true);
  });
});
