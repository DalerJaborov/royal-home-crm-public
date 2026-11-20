// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { act, cleanup, fireEvent, render as rtlRender, screen } from "@testing-library/react";
import type { PropertyNarrationItem, PropertyNarrationView } from "@royal-home/shared";
const api = vi.hoisted(() => vi.fn());
vi.mock("../lib/api", () => ({ api }));
import { narrationChangesLine, narrationFactsChanges, narrationLengthCheck } from "@royal-home/shared";
import { PropertyNarrationManager, narrationCardState, narrationClock, narrationIsPending, narrationReleaseMoving } from "./PropertyNarrationManager";
import { NarrationComposer } from "./NarrationComposer";

/**
 * КАРТОЧКА ОБЪЕКТА: АГЕНТ ВИДИТ ТОЛЬКО ГОЛОС, ТЕКСТ И «ОЗВУЧИТЬ» (14.11.2026, владелец: «всю
 * техническую часть полностью убирать в настройки CRM, в настройках объекта этого вообще не должно быть»).
 * 20.11.2026, разбор владельца с телефона: блок не первый и не «чужой», «послушать и одобрить» отдельно от
 * «переделать», озвучки нет на старом объекте — блока нет, честные «готовим»/«накладываем», двойной тап не шлёт дважды.
 */
const config = {
  modelId: "eleven_v4", autoGenerate: true, defaultVoiceId: "f1",
  voices: [{ id: "f1", name: "Мадина", gender: "female" as const }, { id: "f2", name: "Nataly Vershinina", gender: "female" as const }, { id: "m1", name: "Фирӯз", gender: "male" as const }],
  templates: [
    { id: "tg-a", name: "Кӯтоҳ", lang: "tg" as const, text: "{вид} барои фурӯш. Масоҳаташ {площадь} метри мураббаъ." },
    { id: "tg-b", name: "Дароз", lang: "tg" as const, text: "Ассалому алайкум! {вид}, {площадь} метри мураббаъ." },
    { id: "ru-a", name: "Русский", lang: "ru" as const, text: "В продаже {вид}. Площадь {площадь} метров." },
  ],
};
const facts = { type: "APARTMENT", rooms: 2, areaSqm: "62", floor: 3, totalFloors: 9, district: "Сино", price: "60000", currency: "USD" };
const version = (over: Partial<PropertyNarrationItem> = {}): PropertyNarrationItem => ({ id: "v", revision: 1, script: "Квартира барои фурӯш. Масоҳаташ шасту ду метри мураббаъ.", voiceId: "f1", status: "READY",
  approvedAt: null, stale: false, hasAudio: true, errorCode: null, createdAt: "2026-11-14", source: "WIZARD", templateId: "tg-a", language: "tg", ...over });
const view = (overrides: Partial<PropertyNarrationView> = {}): PropertyNarrationView => ({ versions: [], suggestedScript: "Квартира.", facts, config, configured: true, autoGenerate: true,
  canApprove: false, canApproveAudio: true, canDraft: true, sendsEnabled: false, ...overrides });
function client(overrides: Partial<PropertyNarrationView> = {}) {
  const c = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
  c.setQueryData(["property-narration", "p"], view(overrides));
  return c;
}
function render(overrides: Partial<PropertyNarrationView> = {}, placement: "card" | "media" = "media") {
  return renderToStaticMarkup(<QueryClientProvider client={client(overrides)}><PropertyNarrationManager propertyId="p" placement={placement} /></QueryClientProvider>);
}
function mount(overrides: Partial<PropertyNarrationView> = {}, placement: "card" | "media" = "card") {
  return rtlRender(<QueryClientProvider client={client(overrides)}><PropertyNarrationManager propertyId="p" placement={placement} /></QueryClientProvider>);
}
const TECH = ["Модель озвучки", "Символов в сутки", "Словарь произношения", "Настройки голосов", "Служебное", "Сгенерировать в ElevenLabs", "Подготовить образцы"];
afterEach(() => { cleanup(); api.mockReset(); });

describe("связь моргнула во время опроса", () => {
  it("ошибка ПОВТОРНОГО запроса не прячет уже показанный блок в карточке", () => {
    const c = client({ versions: [version()], published: true, clipSec: 35, changed: ["цена"] });
    c.getQueryCache().find({ queryKey: ["property-narration", "p"] })!.setState({ status: "error", error: new Error("Сервер временно недоступен"), fetchStatus: "idle" });
    const html = renderToStaticMarkup(<QueryClientProvider client={c}><PropertyNarrationManager propertyId="p" placement="card" /></QueryClientProvider>);
    expect(html).not.toBe("");
    expect(html).not.toContain("Озвучка недоступна");
  });
});

describe("20.11: блок в карточке — короткий статус, не форма на весь экран", () => {
  it("состояния блока — одно правило на ПК и телефон", () => {
    expect(narrationCardState(view({ off: true }))).toBe("off");
    expect(narrationCardState(view({ published: true }))).toBe("hidden");
    expect(narrationCardState(view({ published: false }))).toBe("none");
    expect(narrationCardState(view({ versions: [version({ status: "GENERATING", hasAudio: false })] }))).toBe("pending");
    expect(narrationCardState(view({ versions: [version()] }))).toBe("awaiting");
    expect(narrationCardState(view({ versions: [version({ status: "FAILED", hasAudio: false })] }))).toBe("failed");
    expect(narrationCardState(view({ versions: [version({ approvedAt: "2026-11-19" })], release: { stage: "MIXING", versionId: "v", at: null, reason: null, channels: [] } }))).toBe("mixing");
    expect(narrationCardState(view({ versions: [version({ approvedAt: "2026-11-19" })] }))).toBe("approved");
    expect(narrationCardState(view({ versions: [version({ approvedAt: "2026-11-19" })], mix: { hasMaster: true, error: null, problem: "FAILED" } }))).toBe("mixFailed");
  });
  it("старый объект без озвучки, ролик давно вышел: в карточке блока нет («в любом объекте выходит такое»)", () => {
    expect(render({ published: true }, "card")).toBe("");
    // Во вкладке ролика (полный блок) — есть, с кнопкой выбрать голос и текст.
    expect(render({ published: true }, "media")).toContain("Выбрать голос и текст");
  });
  it("озвучки нет, ролика ещё нет: одна строка и кнопка, выбора голоса и текста на экране нет", () => {
    const html = render({ published: false }, "card");
    expect(html).toContain("Озвучки пока нет"); expect(html).toContain("Выбрать голос и текст");
    expect(html).not.toContain("Текст озвучки"); expect(html).not.toContain("Женские");
    for (const word of TECH) expect(html).not.toContain(word);
  });
  it("готова: «Одобрить» сразу под плеером, голос и текст НЕ открыты; «Изменить голос или текст» — отдельной кнопкой ниже", () => {
    const html = render({ versions: [version({ audioSec: 27 })] }, "card");
    expect(html).toContain("Новая озвучка готова"); expect(html).toContain("▶ Послушать"); expect(html).toContain("0:27");
    expect(html).toContain("✓ Одобрить"); expect(html).not.toContain("Утвердить и выпустить");
    expect(html.indexOf("✓ Одобрить")).toBeLessThan(html.indexOf("Изменить голос или текст"));
    expect(html).not.toContain("Текст озвучки"); expect(html).not.toContain("Женские");
  });
  it("нажали «Изменить голос или текст»: форма, «Одобрить» спрятан; без правки «Озвучить заново» закрыта (тот же текст сервер не примет)", () => {
    mount({ versions: [version()] });
    fireEvent.click(screen.getByRole("button", { name: "Изменить голос или текст" }));
    expect(screen.queryByRole("button", { name: "✓ Одобрить" })).toBeNull();
    expect(screen.getByLabelText("Текст озвучки")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Озвучить заново" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Текст озвучки"), { target: { value: "Квартира барои фурӯш, нархаш хуб. Масоҳаташ шасту ду метри мураббаъ." } });
    expect((screen.getByRole("button", { name: "Озвучить заново" }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Отмена" }));
    expect(screen.getByRole("button", { name: "✓ Одобрить" })).toBeTruthy();
  });
  it("двойной тап «Одобрить» шлёт одно утверждение", async () => {
    let finish!: (v: unknown) => void;
    api.mockImplementation(() => new Promise((r) => { finish = r; }));
    mount({ versions: [version()] });
    const button = screen.getByRole("button", { name: "✓ Одобрить" });
    await act(async () => { fireEvent.click(button); fireEvent.click(button); });
    expect(api.mock.calls.filter(([url]) => String(url).endsWith("/approve"))).toHaveLength(1);
    await act(async () => { finish({ delivery: "QUEUED" }); });
  });
  it("двойной тап «Озвучить заново» шлёт одну платную озвучку", async () => {
    let finish!: (v: unknown) => void;
    api.mockImplementation(() => new Promise((r) => { finish = r; }));
    mount({ versions: [version({ status: "FAILED", hasAudio: false })] });
    fireEvent.click(screen.getByRole("button", { name: "Исправить и озвучить" }));
    const button = screen.getByRole("button", { name: "Озвучить" });
    await act(async () => { fireEvent.click(button); fireEvent.click(button); });
    expect(api.mock.calls.filter(([, opts]) => (opts as { body?: { generate?: boolean } })?.body?.generate)).toHaveLength(1);
    await act(async () => { finish({ id: "v2", revision: 2, queued: true }); });
  });
  it("готовится: значок хода без выдуманной половины полосы и сколько минут идёт; долго — честная строка", () => {
    const fresh = render({ versions: [version({ status: "GENERATING", hasAudio: false, createdAt: new Date().toISOString() })] }, "card");
    expect(fresh).toContain("Готовим озвучку"); expect(fresh).toContain("Идёт 1 мин"); expect(fresh).not.toContain("w-1/2");
    const slow = render({ versions: [version({ status: "GENERATING", hasAudio: false, createdAt: new Date(Date.now() - 20 * 60_000).toISOString() })] }, "card");
    expect(slow).toContain("дольше обычного");
  });
  it("накладывается: свежее — «обычно пара минут», висит больше получаса — «дольше обычного», а не вечная полоса", () => {
    const mixing = { stage: "MIXING" as const, versionId: "v", at: null, reason: null, channels: [] };
    expect(render({ published: true, versions: [version({ approvedAt: new Date().toISOString() })], release: mixing }, "card")).toContain("Обычно пара минут");
    const stuck = render({ published: true, versions: [version({ approvedAt: new Date(Date.now() - 26 * 3_600_000).toISOString() })], release: mixing }, "card");
    expect(stuck).toContain("дольше обычного"); expect(stuck).not.toContain("Обычно пара минут");
  });
  it("вышел: одна строка, сети свёрнуты; есть что сделать руками (TikTok) — сети открыты", () => {
    const ok = render({ published: true, versions: [version({ approvedAt: "2026-11-18" })], release: { stage: "DONE", versionId: "v", at: null, reason: null, channels: [{ channel: "INSTAGRAM", state: "OLD_REMOVED" }] } }, "card");
    expect(ok).toContain("Ролик с новой озвучкой вышел"); expect(ok).toContain("<details");
    const manual = render({ published: true, versions: [version({ approvedAt: "2026-11-18" })], release: { stage: "DONE", versionId: "v", at: null, reason: null, channels: [
      { channel: "INSTAGRAM", state: "OLD_REMOVED" }, { channel: "YOUTUBE", state: "NEW_FAILED" }, { channel: "TIKTOK", state: "OLD_MANUAL", url: "https://www.tiktok.com/@r/video/1" }] } }, "card");
    expect(manual).not.toContain("<details"); expect(manual).toContain("новый не вышел, старый пост на месте");
    expect(manual).toContain("Старый удалите сами"); expect(manual).toContain('href="https://www.tiktok.com/@r/video/1"');
  });
  it("плеер: длина из сервера, «0:27», не «00:00»", () => {
    expect(narrationClock(27.4)).toBe("0:27"); expect(narrationClock(75)).toBe("1:15"); expect(narrationClock(-3)).toBe("0:00");
  });
  it("тексты блока без длинного тире", () => {
    const states: Array<Partial<PropertyNarrationView>> = [{ published: false }, { versions: [version()] }, { published: true, versions: [version()] },
      { versions: [version({ approvedAt: "2026-11-18" })], mix: { hasMaster: true, error: null, problem: null } }, { versions: [version({ stale: true })] }];
    for (const s of states) expect(render(s, "card")).not.toContain("—");
  });
});

describe("выбор голоса: имена целиком и понятные подписи", () => {
  it("длинное латинское имя не обрезается, «по умолчанию» и «вы выбирали в прошлый раз» подписаны", () => {
    const html = renderToStaticMarkup(<NarrationComposer name="n" templates={config.templates} voices={config.voices} facts={facts} value={{}} onChange={() => {}}
      defaultTemplateId="tg-a" defaultVoiceId="f1" lastPickedVoiceId="f2" recommendedVoiceId="f1" samples={[{ voiceId: "f2", lang: "tg" }]} />);
    expect(html).toContain("Nataly Vershinina"); expect(html).not.toContain("truncate");
    expect(html).toContain("по умолчанию"); expect(html).toContain("вы выбирали в прошлый раз");
    expect(html.indexOf("Голос")).toBeLessThan(html.indexOf("Текст"));
    expect(html).toContain("Квартира барои фурӯш. Масоҳаташ шасту ду метри мураббаъ.");
    expect(html).toContain("Тоҷикӣ"); expect(html).toContain("Русский");
  });
});

describe("карточка объекта: озвучка для агента", () => {
  it("озвучку разового прохода одобряет владелец, а не агент", () => {
    expect(render({ versions: [version({ source: "BACKFILL" })], canApproveAudio: false })).toContain("одобряет владелец");
  });
  it("готовится: статус и опрос сервера, кнопок нет", () => {
    const pending = version({ status: "DRAFT", hasAudio: false, generateAfter: "2026-11-14T10:00:00Z" });
    const html = render({ versions: [pending] });
    expect(html).toContain("Готовим озвучку"); expect(html).not.toContain("Изменить");
    expect(narrationIsPending(pending)).toBe(true);
    expect(narrationIsPending(version())).toBe(false);
  });
  it("ревью 14.11: устаревший текст со старой ценой в форму не попадает; неизвестный итог — статус без формы; зависшая генерация не опрашивается вечно", () => {
    mount({ versions: [version({ status: "FAILED", hasAudio: false, stale: true, script: "Нархаш СТАРАЯ ЦЕНА сомонӣ." })] });
    fireEvent.click(screen.getByRole("button", { name: "Исправить и озвучить" }));
    const text = (screen.getByLabelText("Текст озвучки") as HTMLTextAreaElement).value;
    expect(text).not.toContain("СТАРАЯ ЦЕНА");
    expect(text).toContain("Квартира барои фурӯш. Масоҳаташ шасту ду метри мураббаъ.");
    cleanup();
    const unknown = render({ versions: [version({ status: "UNKNOWN", hasAudio: false })] });
    expect(unknown).toContain("уточняет руководство");
    expect(unknown).not.toContain(">Озвучить<"); expect(unknown).not.toContain("Исправить");
    expect(unknown).not.toContain("Озвучка не получилась");
    expect(narrationIsPending(version({ status: "GENERATING", hasAudio: false, canReconcile: true }))).toBe(false);
    expect(narrationIsPending(version({ status: "GENERATING", hasAudio: false }))).toBe(true);
  });
  it("новая озвучка не легла на вышедший ролик — агенту сказано, что дальше", () => {
    const approved = [version({ approvedAt: "2026-11-14" })];
    expect(render({ versions: approved, mix: { hasMaster: true, error: null, problem: "VOICE_LONGER" } })).toContain("Обрезать голос CRM не стала");
    expect(render({ versions: approved, mix: { hasMaster: true, error: null, problem: "FAILED" } })).toContain("в соцсетях пока прежний ролик");
    expect(render({ versions: approved, mix: { hasMaster: true, error: null, problem: null } })).not.toContain("warn-bg");
    // 16.11.2026: строка агенту, что CRM делает со звуком вышедшего ролика.
    expect(render({ versions: approved, mix: { hasMaster: false, error: null, problem: null, note: "CRM убирает из ролика старый голос и наложит новый. Обычно несколько минут." } })).toContain("CRM убирает из ролика старый голос");
  });
  it("одобрено, устарело, не получилось — понятными словами", () => {
    expect(render({ versions: [version({ approvedAt: "2026-11-14" })] })).toContain("Озвучка утверждена");
    expect(render({ versions: [version({ stale: true })] })).toContain("Данные объекта изменились");
    const failed = render({ versions: [version({ status: "FAILED", hasAudio: false })] });
    expect(failed).toContain("Озвучка не получилась"); expect(failed).toContain("Исправить и озвучить");
  });
  it("«Без озвучки»: только кнопка включить", () => {
    const html = render({ off: true });
    expect(html).toContain("Включить озвучку"); expect(html).not.toContain(">Озвучить<"); expect(html).not.toContain("Выбрать голос");
  });
  it("автоозвучка выключена: агент сохраняет текст, генерирует маркетинг", () => {
    mount({ autoGenerate: false, published: false });
    fireEvent.click(screen.getByRole("button", { name: "Выбрать голос и текст" }));
    expect(screen.getByRole("button", { name: "Сохранить текст" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Озвучить" })).toBeNull();
  });
  it("служебное (передача монтажёру, отчёт собственнику) — только маркетингу и руководству, свёрнутым, и только во вкладке ролика", () => {
    const marketing = render({ canApprove: true, versions: [version({ approvedAt: "2026-11-14" })] });
    expect(marketing).toContain("Служебное"); expect(marketing).toContain("Только новую озвучку"); expect(marketing).toContain("<details");
    expect(render({ versions: [version({ approvedAt: "2026-11-14" })] })).not.toContain("Служебное");
    expect(render({ canApprove: true, versions: [version({ approvedAt: "2026-11-14" })] }, "card")).not.toContain("Служебное");
  });
  it("живая отправка плана монтажёру — только когда сервер в LIVE", () => {
    const deliveries = [{ id: "d", status: "PREVIEW", mode: "AUDIO_ONLY", versionId: "v", createdAt: "2026-11-14", lastError: null, planHash: "a".repeat(64) }];
    expect(render({ canApprove: true, deliveries })).not.toContain("Подтвердить отправку этого плана");
    expect(render({ canApprove: true, sendsEnabled: true, deliveries })).toContain("Подтвердить отправку этого плана");
  });
  it("18.11: ролик вышел, данные изменились — «новая озвучка», что изменилось, значок хода", () => {
    const html = render({ published: true, changed: ["цена", "этаж"], versions: [version({ status: "DRAFT", hasAudio: false, generateAfter: "2026-11-18T10:00:00Z" })] });
    expect(html).toContain("Готовим новую озвучку"); expect(html).toContain("Изменилось: цена и этаж"); expect(html).toContain('aria-label="Готовим озвучку"');
  });
  it("18.11: готово, ролик вышел — одна главная «Утвердить и выпустить», длина укладывается, старые посты снимет CRM", () => {
    const html = render({ published: true, clipSec: 35, changed: ["цена"], versions: [version()] });
    expect(html).toContain("Новая озвучка готова"); expect(html).toContain("✓ Утвердить и выпустить");
    expect(html).toMatch(/Укладывается в ролик: ~\d+ с из 35 с/);
    expect(html).toContain("Старые посты CRM снимет сама");
    for (const gone of ["Оставить старый", "Прослушать перед выпуском", "Выпустить новый"]) expect(html).not.toContain(gone);
    expect(html).not.toContain("—");
  });
  it("18.11: текст длиннее ролика, замера нет — «Сократите текст», кнопка неактивна", () => {
    const html = render({ published: true, clipSec: 2, versions: [version()] });
    expect(html).toMatch(/Длиннее ролика на \d+ с\. Сократите текст/);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Сократите текст<\/button>/);
    expect(html).not.toContain("✓ Утвердить и выпустить");
  });
  it("ревью 18.11: готовое аудио с замером — «Утвердить» решает настоящая длина, а не оценка по тексту", () => {
    // Оценка по тексту говорит «длиннее ролика» (ролик 2 с), а голос на деле 1,5 с — укладывается.
    const html = render({ published: true, clipSec: 2, versions: [version({ audioSec: 1.5 })] });
    expect(html).toContain("✓ Утвердить и выпустить");
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*>Сократите текст/);
    // Замер длиннее ролика — кнопка закрыта.
    expect(render({ published: true, clipSec: 2, versions: [version({ audioSec: 9 })] })).toMatch(/<button[^>]*disabled=""[^>]*>Сократите текст<\/button>/);
  });
  it("18.11: выпуск — выйдет в назначенное время", () => {
    const approved = [version({ approvedAt: "2026-11-18" })];
    const scheduled = render({ published: true, versions: approved, release: { stage: "SCHEDULED", versionId: "v", at: "2026-11-19T04:00:00Z", reason: "Ночью посты не видят, ролик с новой озвучкой выйдет утром в 09:00.", channels: [] } });
    expect(scheduled).toContain("выйдет"); expect(scheduled).toContain("09:00"); expect(scheduled).toContain("утром в 09:00");
    expect(narrationReleaseMoving({ release: { stage: "PUBLISHING", versionId: "v", at: null, reason: null, channels: [] } } as never)).toBe(true);
    expect(narrationReleaseMoving({ release: { stage: "DONE", versionId: "v", at: null, reason: null, channels: [{ channel: "INSTAGRAM", state: "OLD_REMOVED" }] } } as never)).toBe(false);
  });
  it("в спокойном состоянии — строка, «Послушать» и «Изменить озвучку»", () => {
    const quiet = render({ versions: [version({ approvedAt: "2026-11-18" })] }, "card");
    expect(quiet).toContain("Озвучка утверждена"); expect(quiet).toContain("Изменить озвучку"); expect(quiet).toContain("▶ Послушать"); expect(quiet).not.toContain("Служебное");
  });
  it("общее правило длины: оценка по тексту словами, ускорение до 15 %, что поменялось — человеческими словами", () => {
    const check = narrationLengthCheck("Квартира в Душанбе. ".repeat(10), "ru", 10, null)!;
    expect(check.fits).toBe(false); expect(check.overBySec).toBeGreaterThan(0);
    expect(narrationLengthCheck("Квартира в Душанбе.", "ru", 10, null)!.fits).toBe(true);
    expect(narrationLengthCheck("Квартира.", "ru", null, null)).toBeNull();
    expect(narrationFactsChanges({ ...facts, price: "50000" }, { ...facts, floor: 4 })).toEqual(["этаж", "цена"]);
    expect(narrationChangesLine(["цена", "этаж", "район"])).toBe("Изменилось: цена, этаж и район");
  });
  it("монтажёр (canDraft=false) только слушает", () => {
    const html = render({ canDraft: false, canApproveAudio: false, versions: [version({ approvedAt: "2026-11-14" })] });
    expect(html).not.toContain("Без озвучки"); expect(html).not.toContain("Изменить");
  });
});
