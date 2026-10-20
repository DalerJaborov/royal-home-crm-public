import { afterEach, describe, expect, it } from "vitest";
import { useAppUpdateStore } from "../appUpdate";

/**
 * Стор автообновления (см. appUpdate.ts). С 10.09.2026 решение звучит не
 * «показать оверлей», а «применить подмену сейчас»: полноэкранный экран
 * обновления убран по требованию владельца, обновление происходит молча.
 *
 * Правило момента, которое здесь закреплено: свободен -> сразу; занят ->
 * ждём; занят, но человек перешёл в другой раздел -> подменяем (экран и так
 * перерисовывается); ждём дольше пяти минут -> подменяем в любом случае.
 */
describe("useAppUpdateStore", () => {
  afterEach(() => {
    useAppUpdateStore.getState().reset();
  });

  it("новая версия (staleBuild), человек свободен -> подмена начинается сразу", () => {
    const { setStaleBuild, requestApply } = useAppUpdateStore.getState();
    setStaleBuild(true);
    const deferred = requestApply(false, { now: 1_000 });
    expect(deferred).toBe(false);
    expect(useAppUpdateStore.getState().applying).toBe(true);
  });

  it("новая версия (needRefresh), человек свободен -> подмена начинается сразу", () => {
    const { setNeedRefresh, requestApply } = useAppUpdateStore.getState();
    setNeedRefresh(true);
    const deferred = requestApply(false, { now: 1_000 });
    expect(deferred).toBe(false);
    expect(useAppUpdateStore.getState().applying).toBe(true);
  });

  it("человек занят -> подмена откладывается", () => {
    const { setStaleBuild, requestApply } = useAppUpdateStore.getState();
    setStaleBuild(true);
    const deferred = requestApply(true, { now: 1_000 });
    expect(deferred).toBe(true);
    expect(useAppUpdateStore.getState().applying).toBe(false);
  });

  it("занят, но перешёл в другой раздел -> подменяем, не дожидаясь освобождения", () => {
    const { setStaleBuild, requestApply } = useAppUpdateStore.getState();
    setStaleBuild(true);
    expect(requestApply(true, { now: 1_000 })).toBe(true);
    const deferred = requestApply(true, { now: 3_000, navigating: true });
    expect(deferred).toBe(false);
    expect(useAppUpdateStore.getState().applying).toBe(true);
  });

  it("переход между разделами без сигнала обновления ничего не запускает", () => {
    const { requestApply } = useAppUpdateStore.getState();
    const deferred = requestApply(false, { now: 1_000, navigating: true });
    expect(deferred).toBe(false);
    expect(useAppUpdateStore.getState().applying).toBe(false);
  });

  it("нет сигнала обновления -> ничего не откладывается и не применяется", () => {
    const { requestApply } = useAppUpdateStore.getState();
    const deferred = requestApply(true, { now: 1_000 });
    expect(deferred).toBe(false);
    expect(useAppUpdateStore.getState().applying).toBe(false);
  });

  it("занят дольше 5 минут с первого сигнала -> подменяем несмотря на занятость", () => {
    const { setStaleBuild, requestApply } = useAppUpdateStore.getState();
    setStaleBuild(true);
    const start = 100_000;
    // Первая попытка фиксирует deferStart и откладывает, как в предыдущем тесте.
    expect(requestApply(true, { now: start })).toBe(true);
    expect(useAppUpdateStore.getState().applying).toBe(false);
    // Прошло больше MAX_DEFER_MS (5 минут) с момента первого сигнала.
    const fiveMinutesLater = start + 5 * 60_000 + 1;
    const deferred = requestApply(true, { now: fiveMinutesLater });
    expect(deferred).toBe(false);
    expect(useAppUpdateStore.getState().applying).toBe(true);
  });

  it("повторный вызов во время начатой подмены ничего не перезапускает", () => {
    const { setStaleBuild, requestApply } = useAppUpdateStore.getState();
    setStaleBuild(true);
    requestApply(false, { now: 1_000 });
    expect(useAppUpdateStore.getState().applying).toBe(true);
    const deferred = requestApply(false, { now: 2_000 });
    expect(deferred).toBe(false);
    expect(useAppUpdateStore.getState().applying).toBe(true);
  });

  it("отсчёт пяти минут ведётся от первого сигнала, а не от последней попытки", () => {
    const { setStaleBuild, requestApply } = useAppUpdateStore.getState();
    setStaleBuild(true);
    const start = 50_000;
    requestApply(true, { now: start });
    requestApply(true, { now: start + 60_000 });
    expect(useAppUpdateStore.getState().deferStart).toBe(start);
  });
});
