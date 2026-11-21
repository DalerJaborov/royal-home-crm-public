// @vitest-environment jsdom
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
const api = vi.hoisted(() => vi.fn());
vi.mock("../lib/api", () => ({ api }));
import { NarrationComposer, narrationListenFresh, type NarrationDraft } from "./NarrationComposer";
import { narrationChoiceForCreate } from "./property-wizard/NarrationChoice";

/**
 * «▶ ПРОСЛУШАТЬ» ПРЯМО В МАСТЕРЕ И КАРТОЧКЕ (21.11.2026, владелец: «разве нельзя просто кнопку нажать и прослушать?»).
 * Кнопка шлёт ровно показанные текст, голос и язык; плеер на месте; сменили голос или текст — звук помечен устаревшим,
 * кнопка снова активна; в запрос создания уходит id только свежего прослушивания.
 */
const templates = [{ id: "ru-a", name: "Русский", lang: "ru" as const, text: "В продаже {вид}. Площадь {площадь} метров." }];
const voices = [{ id: "f1", name: "Мадина", gender: "female" as const }, { id: "m1", name: "Фирӯз", gender: "male" as const }];
const facts = { type: "APARTMENT", rooms: 2, areaSqm: "62", floor: 3, totalFloors: 9, district: "Сино" };
const TEXT = "В продаже квартира. Площадь шестьдесят два метров.";
let changes: NarrationDraft[] = [];

function Harness({ canListen = true }: { canListen?: boolean }) {
  const [value, setValue] = useState<NarrationDraft>({});
  return <NarrationComposer name="v" templates={templates} voices={voices} facts={facts} value={value} canListen={canListen}
    onChange={(next) => { changes.push(next); setValue(next); }} defaultTemplateId="ru-a" defaultVoiceId="f1" />;
}

beforeEach(() => {
  changes = [];
  api.mockImplementation(async (url: string, opts?: { method?: string; responseType?: string }) => {
    if (opts?.method === "POST") return { id: "11111111-1111-4111-8111-111111111111", fileUrl: "/properties/narration-listen/x/file", cached: false };
    if (opts?.responseType === "blob") return new Blob(["mp3"], { type: "audio/mpeg" });
    throw new Error(`unexpected ${url}`);
  });
  Object.assign(URL, { createObjectURL: vi.fn(() => "blob:listen"), revokeObjectURL: vi.fn() });
  // jsdom не умеет играть звук: свой плеер приложения сразу запускает свежий звук.
  Object.assign(HTMLMediaElement.prototype, { play: vi.fn(async () => {}), pause: vi.fn() });
});
afterEach(() => { cleanup(); api.mockReset(); });

async function listen() {
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "▶ Прослушать" })); });
}

describe("кнопка «Прослушать»", () => {
  it("шлёт показанные текст, голос и язык, ставит плеер на месте и отмечает «Прослушано»", async () => {
    render(<Harness />);
    await listen();
    expect(api).toHaveBeenCalledWith("/properties/narration-listen", expect.objectContaining({ method: "POST", body: { script: TEXT, voiceId: "f1", lang: "ru" } }));
    expect(document.querySelector("audio")?.getAttribute("src")).toBe("blob:listen");
    expect(document.querySelector("audio[controls]")).toBeNull();
    expect(screen.getByText("✓ Прослушано")).toBeTruthy();
    // Свежий звук уже на месте — повторно платить нечего, кнопки нет.
    expect(screen.queryByRole("button", { name: "▶ Прослушать" })).toBeNull();
    expect(changes.at(-1)?.listened).toEqual({ id: "11111111-1111-4111-8111-111111111111", text: TEXT, voiceId: "f1", lang: "ru" });
  });

  it("сменили голос — звук устарел, кнопка снова активна", async () => {
    render(<Harness />);
    await listen();
    fireEvent.click(screen.getByRole("radio", { name: /Фирӯз/u }));
    expect(screen.getByText(/этот звук устарел/u)).toBeTruthy();
    expect(screen.queryByText("✓ Прослушано")).toBeNull();
    expect((screen.getByRole("button", { name: "▶ Прослушать" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("поменяли текст — звук устарел, кнопка снова активна", async () => {
    render(<Harness />);
    await listen();
    fireEvent.change(screen.getByLabelText("Текст озвучки"), { target: { value: `${TEXT} Звоните.` } });
    expect(screen.getByText(/этот звук устарел/u)).toBeTruthy();
    expect((screen.getByRole("button", { name: "▶ Прослушать" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("ответ пришёл после правки текста (ревью 21.11): правка не затирается, устаревший звук не применяется", async () => {
    let answer: (v: unknown) => void = () => {};
    api.mockImplementation((_url: string, opts?: { method?: string; responseType?: string }) => {
      if (opts?.method === "POST") return new Promise((resolve) => { answer = resolve; });
      return Promise.resolve(new Blob(["mp3"], { type: "audio/mpeg" }));
    });
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "▶ Прослушать" }));
    fireEvent.change(screen.getByLabelText("Текст озвучки"), { target: { value: `${TEXT} Правка во время ожидания.` } });
    await act(async () => { answer({ id: "22222222-2222-4222-8222-222222222222", fileUrl: "/f", cached: false }); });
    expect((screen.getByLabelText("Текст озвучки") as HTMLTextAreaElement).value).toBe(`${TEXT} Правка во время ожидания.`);
    expect(changes.at(-1)?.listened).toBeUndefined();
    expect(changes.at(-1)?.script).toBe(`${TEXT} Правка во время ожидания.`);
    expect(screen.queryByText("✓ Прослушано")).toBeNull();
    expect(screen.getByText(/этот звук устарел/u)).toBeTruthy();
  });

  it("без автоозвучки кнопки нет (слушать нечего: звук ролика готовится в карточке)", () => {
    render(<Harness canListen={false} />);
    expect(screen.queryByRole("button", { name: "▶ Прослушать" })).toBeNull();
  });
});

describe("прослушанное и запрос создания", () => {
  it("свежесть: тот же текст, голос и язык", () => {
    const heard = { id: "x", text: TEXT, voiceId: "f1", lang: "ru" as const };
    expect(narrationListenFresh(heard, { text: `${TEXT} `, voiceId: "f1", lang: "ru" })).toBe(true);
    expect(narrationListenFresh(heard, { text: TEXT, voiceId: "m1", lang: "ru" })).toBe(false);
    expect(narrationListenFresh(heard, { text: TEXT, voiceId: "f1", lang: "tg" })).toBe(false);
    expect(narrationListenFresh(undefined, { text: TEXT, voiceId: "f1", lang: "ru" })).toBe(false);
  });
  it("id прослушивания уходит в запрос создания, сам звук — нет", () => {
    const out = narrationChoiceForCreate({ templateId: "ru-a", voiceId: "f1", listened: { id: "11111111-1111-4111-8111-111111111111", text: TEXT, voiceId: "f1", lang: "ru" } });
    expect(out).toEqual({ templateId: "ru-a", voiceId: "f1", listenId: "11111111-1111-4111-8111-111111111111" });
  });
});
