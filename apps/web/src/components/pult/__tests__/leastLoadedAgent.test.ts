import { describe, expect, it } from "vitest";
import { pickLeastLoadedAgent } from "../leastLoadedAgent";
import type { McAgent } from "../../../hooks/useMissionControl";

/**
 * «Передать наименее загруженному» в пульте (глубокая проверка 02.10.2026, F2):
 * замороженный агент или агент на паузе приёма лидов (takesLeads=false) с
 * нагрузкой 0 был первым в сортировке, и пульт отдавал лид ему.
 */
function agent(id: string, activeLoad: number, takesLeads?: boolean): McAgent {
  return { id, fullName: id, avatarUrl: null, activeLoad, pendingAccept: 0, acceptedToday: 0, buyerCount: 0, sellerCount: 0, takesLeads };
}

describe("pickLeastLoadedAgent", () => {
  it("пропускает тех, кто лиды не принимает, даже с нулевой нагрузкой", () => {
    expect(pickLeastLoadedAgent([agent("заморожен", 0, false), agent("работает", 3, true)])?.id).toBe("работает");
  });

  it("из принимающих — наименее загруженный", () => {
    expect(pickLeastLoadedAgent([agent("а", 4, true), agent("б", 1, true), agent("в", 2, true)])?.id).toBe("б");
  });

  it("никто не принимает — предлагать некого", () => {
    expect(pickLeastLoadedAgent([agent("а", 0, false)])).toBeNull();
  });

  it("старый ответ сервера без поля — агент считается принимающим", () => {
    expect(pickLeastLoadedAgent([agent("а", 2), agent("б", 1)])?.id).toBe("б");
  });
});
