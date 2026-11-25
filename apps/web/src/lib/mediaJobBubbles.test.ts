import { describe, expect, it } from "vitest";
import { reconcileJobBubbles, serverJobLocalId, type OutgoingMediaJobView } from "./mediaUpload";

/**
 * Сверка пузырей отправки с сервером при открытии переписки (ревью 26.11.2026): без дублей, если ответ
 * списка заданий обогнал ответ на загрузку, и без вечного «проверьте позже», если задание давно ушло.
 */

const job = (id: string, status: OutgoingMediaJobView["status"] = "PREPARING"): OutgoingMediaJobView => ({
  id, status, progress: 10, error: null, note: null,
});

describe("reconcileJobBubbles", () => {
  it("задание есть на сервере, пузыря нет — пузырь заводится", () => {
    expect(reconcileJobBubbles([job("a")], [], new Set()).add.map((j) => j.id)).toEqual(["a"]);
  });

  it("за заданием уже следит эта вкладка или у загрузки уже есть его номер — второй пузырь не заводится", () => {
    expect(reconcileJobBubbles([job("a")], [], new Set(["a"])).add).toEqual([]);
    expect(reconcileJobBubbles([job("a")], [{ localId: "123-x", jobId: "a" }], new Set()).add).toEqual([]);
  });

  it("пузырь с заданием, которого сервер уже не называет (ушло), без слежки — убирается", () => {
    const plan = reconcileJobBubbles([], [{ localId: "123-x", jobId: "gone" }], new Set());
    expect(plan.removeLocalIds).toEqual(["123-x"]);
  });

  it("пузырь без слежки, но задание в списке (упало, ждёт «Повторить») — остаётся; пока вкладка следит — тоже", () => {
    expect(reconcileJobBubbles([job("f", "FAILED")], [{ localId: "l", jobId: "f" }], new Set()).removeLocalIds).toEqual([]);
    expect(reconcileJobBubbles([], [{ localId: "l", jobId: "live" }], new Set(["live"])).removeLocalIds).toEqual([]);
  });

  it("загрузка без номера задания (ещё грузится) не трогается", () => {
    expect(reconcileJobBubbles([], [{ localId: "uploading" }], new Set()).removeLocalIds).toEqual([]);
  });

  it("номер поднятого пузыря — по заданию", () => {
    expect(serverJobLocalId("abc")).toBe("job-abc");
  });
});
