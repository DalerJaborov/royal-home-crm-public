import { describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import type { PropertyNarrationItem, PropertyNarrationView } from "@royal-home/shared";
vi.mock("../lib/api", () => ({ api: vi.fn() }));
import { narrationChangesLine, narrationFactsChanges, narrationLengthCheck } from "@royal-home/shared";
import { PropertyNarrationManager, narrationIsPending, narrationReleaseMoving } from "./PropertyNarrationManager";

/**
 * КАРТОЧКА ОБЪЕКТА: АГЕНТ ВИДИТ ТОЛЬКО ГОЛОС, ТЕКСТ И «ОЗВУЧИТЬ» (14.11.2026, владелец: «всю
 * техническую часть полностью убирать в настройки CRM, в настройках объекта этого вообще не должно быть»).
 */
const config = {
  modelId: "eleven_v4", autoGenerate: true,
  voices: [{ id: "f1", name: "Мадина", gender: "female" as const }, { id: "m1", name: "Фирӯз", gender: "male" as const }],
  templates: [
    { id: "tg-a", name: "Кӯтоҳ", lang: "tg" as const, text: "{вид} барои фурӯш. Масоҳаташ {площадь} метри мураббаъ." },
    { id: "tg-b", name: "Дароз", lang: "tg" as const, text: "Ассалому алайкум! {вид}, {площадь} метри мураббаъ." },
    { id: "ru-a", name: "Русский", lang: "ru" as const, text: "В продаже {вид}. Площадь {площадь} метров." },
  ],
};
const facts = { type: "APARTMENT", rooms: 2, areaSqm: "62", floor: 3, totalFloors: 9, district: "Сино", price: "60000", currency: "USD" };
const version = (over: Partial<PropertyNarrationItem> = {}): PropertyNarrationItem => ({ id: "v", revision: 1, script: "Квартира барои фурӯш. Масоҳаташ шасту ду метри мураббаъ.", voiceId: "f1", status: "READY",
  approvedAt: null, stale: false, hasAudio: true, errorCode: null, createdAt: "2026-11-14", source: "WIZARD", templateId: "tg-a", language: "tg", ...over });
function render(overrides: Partial<PropertyNarrationView> = {}, placement: "top" | "media" = "media") {
  const client = new QueryClient();
  client.setQueryData(["property-narration", "p"], { versions: [], suggestedScript: "Квартира.", facts, config, configured: true, autoGenerate: true,
    canApprove: false, canApproveAudio: true, canDraft: true, sendsEnabled: false, ...overrides } satisfies PropertyNarrationView);
  return renderToStaticMarkup(<QueryClientProvider client={client}><PropertyNarrationManager propertyId="p" placement={placement} /></QueryClientProvider>);
}
const TECH = ["Модель озвучки", "Символов в сутки", "Словарь произношения", "Настройки голосов", "Служебное", "Сгенерировать в ElevenLabs", "Подготовить образцы"];

describe("связь моргнула во время опроса", () => {
  it("ошибка ПОВТОРНОГО запроса не прячет уже показанный блок наверху карточки", () => {
    const client = new QueryClient();
    const key = ["property-narration", "p"];
    client.setQueryData(key, { versions: [version({ status: "READY", approvedAt: null })], suggestedScript: "Квартира.", facts, config, configured: true, autoGenerate: true,
      canApprove: false, canApproveAudio: true, canDraft: true, sendsEnabled: false, published: true, clipSec: 35, changed: ["цена"] } satisfies PropertyNarrationView);
    client.getQueryCache().find({ queryKey: key })!.setState({ status: "error", error: new Error("Сервер временно недоступен"), fetchStatus: "idle" });
    const html = renderToStaticMarkup(<QueryClientProvider client={client}><PropertyNarrationManager propertyId="p" placement="top" /></QueryClientProvider>);
    expect(html).not.toBe("");
    expect(html).not.toContain("Озвучка недоступна");
  });
});

describe("карточка объекта: озвучка для агента", () => {
  it("нет озвучки: сначала голос, потом текст по шаблону с цифрами словами, одна кнопка «Озвучить», техники нет", () => {
    // Шаблон выбирается случайно (16.11.2026): первый подходящий — при броске 0.
    const random = vi.spyOn(Math, "random").mockReturnValue(0);
    const html = render();
    random.mockRestore();
    expect(html.indexOf("Голос")).toBeLessThan(html.indexOf("Текст"));
    expect(html).toContain("Квартира барои фурӯш. Масоҳаташ шасту ду метри мураббаъ.");
    expect(html).toContain(">Озвучить<");
    expect(html).toContain("Другой вариант");
    expect(html).toContain("Тоҷикӣ"); expect(html).toContain("Русский");
    for (const word of TECH) expect(html).not.toContain(word);
  });
  it("готовое аудио, ролика ещё нет: послушать и одобрить, голос и текст рядом (макет 18.11)", () => {
    const html = render({ versions: [version()] });
    expect(html).toContain("послушайте и одобрите"); expect(html).toContain("✓ Одобрить"); expect(html).toContain("▶ Послушать");
    expect(html).toContain("Голос"); expect(html).toContain("Текст озвучки");
    expect(html).not.toContain("Утвердить и выпустить");
  });
  it("озвучку разового прохода одобряет владелец, а не агент", () => {
    expect(render({ versions: [version({ source: "BACKFILL" })], canApproveAudio: false })).toContain("одобряет владелец");
  });
  it("готовится: статус и опрос сервера, кнопок нет", () => {
    const pending = version({ status: "DRAFT", hasAudio: false, generateAfter: "2026-11-14T10:00:00Z" });
    expect(render({ versions: [pending] })).toContain("Готовим озвучку");
    expect(narrationIsPending(pending)).toBe(true);
    expect(narrationIsPending(version())).toBe(false);
  });
  it("ревью 14.11: устаревший текст со старой ценой в форму не попадает; неизвестный итог — статус без формы; зависшая генерация не опрашивается вечно", () => {
    const old = render({ versions: [version({ status: "FAILED", hasAudio: false, stale: true, script: "Нархаш СТАРАЯ ЦЕНА сомонӣ." })] });
    expect(old).not.toContain("СТАРАЯ ЦЕНА");
    expect(old).toContain("Квартира барои фурӯш. Масоҳаташ шасту ду метри мураббаъ.");
    const unknown = render({ versions: [version({ status: "UNKNOWN", hasAudio: false })] });
    expect(unknown).toContain("уточняет руководство");
    expect(unknown).not.toContain(">Озвучить<");
    expect(unknown).not.toContain("Озвучка не получилась");
    expect(narrationIsPending(version({ status: "GENERATING", hasAudio: false, canReconcile: true }))).toBe(false);
    expect(narrationIsPending(version({ status: "GENERATING", hasAudio: false }))).toBe(true);
  });
  it("новая озвучка не легла на вышедший ролик — агенту сказано, что дальше", () => {
    const approved = [version({ approvedAt: "2026-11-14" })];
    expect(render({ versions: approved, mix: { hasMaster: true, error: null, problem: "VOICE_LONGER" } })).toContain("длиннее ролика, обрезать голос CRM не стала");
    expect(render({ versions: approved, mix: { hasMaster: true, error: null, problem: "FAILED" } })).toContain("в соцсетях пока прежний ролик");
    expect(render({ versions: approved, mix: { hasMaster: true, error: null, problem: null } })).not.toContain("warn-bg");
    // 16.11.2026: строка агенту, что CRM делает со звуком вышедшего ролика.
    expect(render({ versions: approved, mix: { hasMaster: false, error: null, problem: null, note: "CRM убирает из ролика старый голос и наложит новый. Обычно несколько минут." } })).toContain("CRM убирает из ролика старый голос");
  });
  it("одобрено, устарело, не получилось — понятными словами", () => {
    expect(render({ versions: [version({ approvedAt: "2026-11-14" })] })).toContain("Озвучка одобрена");
    expect(render({ versions: [version({ stale: true })] })).toContain("Данные объекта изменились");
    const failed = render({ versions: [version({ status: "FAILED", hasAudio: false })] });
    expect(failed).toContain("Озвучка не получилась"); expect(failed).toContain(">Озвучить<");
  });
  it("«Без озвучки»: только кнопка включить", () => {
    const html = render({ off: true });
    expect(html).toContain("Включить озвучку"); expect(html).not.toContain(">Озвучить<");
  });
  it("автоозвучка выключена: агент сохраняет текст, генерирует маркетинг", () => {
    const html = render({ autoGenerate: false });
    expect(html).toContain("Сохранить текст"); expect(html).not.toContain(">Озвучить<");
  });
  it("служебное (передача монтажёру, отчёт собственнику) — только маркетингу и руководству, свёрнутым", () => {
    const marketing = render({ canApprove: true, versions: [version({ approvedAt: "2026-11-14" })] });
    expect(marketing).toContain("Служебное"); expect(marketing).toContain("Только новую озвучку"); expect(marketing).toContain("<details");
    expect(render({ versions: [version({ approvedAt: "2026-11-14" })] })).not.toContain("Служебное");
  });
  it("живая отправка плана монтажёру — только когда сервер в LIVE", () => {
    const deliveries = [{ id: "d", status: "PREVIEW", mode: "AUDIO_ONLY", versionId: "v", createdAt: "2026-11-14", lastError: null, planHash: "a".repeat(64) }];
    expect(render({ canApprove: true, deliveries })).not.toContain("Подтвердить отправку этого плана");
    expect(render({ canApprove: true, sendsEnabled: true, deliveries })).toContain("Подтвердить отправку этого плана");
  });
  it("18.11: ролик вышел, данные изменились — «Озвучка под новые данные», что изменилось, полоса хода", () => {
    const html = render({ published: true, changed: ["цена", "этаж"], versions: [version({ status: "DRAFT", hasAudio: false, generateAfter: "2026-11-18T10:00:00Z" })] });
    expect(html).toContain("Озвучка под новые данные"); expect(html).toContain("Изменилось: цена и этаж"); expect(html).toContain('role="progressbar"');
  });
  it("18.11: готово, ролик вышел — одна главная «Утвердить и выпустить», длина укладывается, старые посты снимет CRM", () => {
    const html = render({ published: true, clipSec: 35, changed: ["цена"], versions: [version()] });
    expect(html).toContain("Новая озвучка готова"); expect(html).toContain("✓ Утвердить и выпустить");
    expect(html).toMatch(/Укладывается в ролик: ~\d+ с из 35 с/);
    expect(html).toContain("Старые посты CRM снимет сама");
    for (const gone of ["Оставить старый", "Прослушать перед выпуском", "Выпустить новый"]) expect(html).not.toContain(gone);
    expect(html).not.toContain("—");
  });
  it("18.11: текст длиннее ролика — «Сократите текст», кнопка неактивна", () => {
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
  it("18.11: выпуск — выйдет в назначенное время; вышел — по сетям, TikTok «удалите сами» со ссылкой", () => {
    const approved = [version({ approvedAt: "2026-11-18" })];
    const scheduled = render({ published: true, versions: approved, release: { stage: "SCHEDULED", versionId: "v", at: "2026-11-19T04:00:00Z", reason: "Ночью посты не видят, ролик с новой озвучкой выйдет утром в 09:00.", channels: [] } });
    expect(scheduled).toContain("Выйдет"); expect(scheduled).toContain("09:00"); expect(scheduled).toContain("утром в 09:00");
    const done = render({ published: true, versions: approved, release: { stage: "DONE", versionId: "v", at: null, reason: null, channels: [
      { channel: "INSTAGRAM", state: "OLD_REMOVED" }, { channel: "YOUTUBE", state: "NEW_FAILED" }, { channel: "TIKTOK", state: "OLD_MANUAL", url: "https://www.tiktok.com/@r/video/1" }] } });
    expect(done).toContain("Ролик вышел"); expect(done).toContain("новый пост, старый снят"); expect(done).toContain("новый не вышел, старый пост на месте");
    expect(done).toContain("Старый удалите сами"); expect(done).toContain('href="https://www.tiktok.com/@r/video/1"'); expect(done).toContain("Открыть старый пост в TikTok");
  });
  it("18.11: наверху карточки в спокойном состоянии — одна строка и «Изменить озвучку»; ошибка загрузки — ничего", () => {
    const quiet = render({ versions: [version({ approvedAt: "2026-11-18" })] }, "top");
    expect(quiet).toContain("Озвучка утверждена"); expect(quiet).toContain("Изменить озвучку"); expect(quiet).not.toContain("Служебное");
    expect(narrationReleaseMoving({ release: { stage: "PUBLISHING", versionId: "v", at: null, reason: null, channels: [] } } as never)).toBe(true);
    expect(narrationReleaseMoving({ release: { stage: "DONE", versionId: "v", at: null, reason: null, channels: [{ channel: "INSTAGRAM", state: "OLD_REMOVED" }] } } as never)).toBe(false);
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
    expect(html).not.toContain("Без озвучки"); expect(html).not.toContain(">Изменить<");
  });
});
