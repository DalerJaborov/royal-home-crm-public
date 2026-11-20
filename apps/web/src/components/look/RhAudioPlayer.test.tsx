// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RhAudioPlayer } from "./RhAudioPlayer";
import { claimAudio } from "./rhAudio";

/** jsdom не умеет играть звук: подменяем play/pause и длительность, остальное — настоящий <audio>. */
let playSpy: ReturnType<typeof vi.fn>;
let pauseSpy: ReturnType<typeof vi.fn>;
const durations = new WeakMap<HTMLMediaElement, number>();
const times = new WeakMap<HTMLMediaElement, number>();
const pausedState = new WeakMap<HTMLMediaElement, boolean>();

beforeEach(() => {
  playSpy = vi.fn(function (this: HTMLMediaElement) { pausedState.set(this, false); this.dispatchEvent(new Event("play")); return Promise.resolve(); });
  pauseSpy = vi.fn(function (this: HTMLMediaElement) { pausedState.set(this, true); this.dispatchEvent(new Event("pause")); });
  Object.defineProperty(HTMLMediaElement.prototype, "play", { configurable: true, value: playSpy });
  Object.defineProperty(HTMLMediaElement.prototype, "pause", { configurable: true, value: pauseSpy });
  Object.defineProperty(HTMLMediaElement.prototype, "paused", { configurable: true, get() { return pausedState.get(this) ?? true; } });
  Object.defineProperty(HTMLMediaElement.prototype, "duration", { configurable: true, get() { return durations.get(this) ?? NaN; } });
  Object.defineProperty(HTMLMediaElement.prototype, "currentTime", {
    configurable: true,
    get() { return times.get(this) ?? 0; },
    set(v: number) { times.set(this, v); },
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function audioOf(container: HTMLElement) { return container.querySelector("audio") as HTMLAudioElement; }
function setDuration(el: HTMLAudioElement, value: number, event = "loadedmetadata") {
  durations.set(el, value);
  act(() => { el.dispatchEvent(new Event(event)); });
}

describe("RhAudioPlayer (К01: серый системный плеер «00:00»)", () => {
  it("нет родного <audio controls>: свои кнопка, полоса и время", () => {
    const { container } = render(<RhAudioPlayer src="/a.mp3" label="Голосовое" />);
    expect(audioOf(container).hasAttribute("controls")).toBe(false);
    expect(screen.getByRole("button", { name: "Голосовое: слушать" })).toBeTruthy();
    expect(screen.getByRole("slider", { name: "Голосовое: перемотка" })).toBeTruthy();
    expect(screen.getByTestId("rh-audio-clock").textContent).toBe("0:00");
  });

  it("«0:12 / 0:27» из длительности файла", () => {
    const { container } = render(<RhAudioPlayer src="/a.mp3" />);
    const el = audioOf(container);
    setDuration(el, 27.3);
    act(() => { el.currentTime = 12.4; el.dispatchEvent(new Event("timeupdate")); });
    expect(screen.getByTestId("rh-audio-clock").textContent).toBe("0:12 / 0:27");
  });

  it("Infinity (webm из Chrome): не «Infinity», прыжок в конец, потом настоящая длина", () => {
    const { container } = render(<RhAudioPlayer src="/a.webm" />);
    const el = audioOf(container);
    setDuration(el, Infinity);
    expect(screen.getByTestId("rh-audio-clock").textContent).toBe("0:00");
    expect(el.currentTime).toBeGreaterThan(1e6); // просим конец файла
    setDuration(el, 31.9, "durationchange");
    expect(screen.getByTestId("rh-audio-clock").textContent).toBe("0:00 / 0:31");
    expect(el.currentTime).toBe(0); // вернулись в начало
  });

  it("NaN не показывается; длина от сервера подставляется, пока браузер не дал свою", () => {
    const { container } = render(<RhAudioPlayer src="/a.mp3" knownSec={27} />);
    setDuration(audioOf(container), NaN);
    expect(screen.getByTestId("rh-audio-clock").textContent).toBe("0:00 / 0:27");
  });

  it("▶ играет, ❚❚ ставит на паузу", () => {
    render(<RhAudioPlayer src="/a.mp3" label="Запись" />);
    fireEvent.click(screen.getByRole("button", { name: "Запись: слушать" }));
    expect(playSpy).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Запись: пауза" }));
    expect(pauseSpy).toHaveBeenCalledTimes(1);
  });

  it("одновременно играет один плеер: второй ставит первый на паузу", () => {
    const { container } = render(<><RhAudioPlayer src="/1.mp3" label="Первая" /><RhAudioPlayer src="/2.mp3" label="Вторая" /></>);
    const [first, second] = [...container.querySelectorAll("audio")];
    fireEvent.click(screen.getByRole("button", { name: "Первая: слушать" }));
    expect(screen.getByRole("button", { name: "Первая: пауза" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Вторая: слушать" }));
    expect(pauseSpy.mock.contexts).toContain(first);
    expect(pauseSpy.mock.contexts).not.toContain(second);
    expect(screen.getByRole("button", { name: "Первая: слушать" })).toBeTruthy();
  });

  it("скорость 1× → 1,5× → 2× → 1× только у голосовых, и она доходит до звука", () => {
    const { container, rerender } = render(<RhAudioPlayer src="/a.mp3" />);
    expect(screen.queryByRole("button", { name: /Скорость/ })).toBeNull();
    rerender(<RhAudioPlayer src="/a.mp3" speeds />);
    const el = audioOf(container);
    const next = () => fireEvent.click(screen.getByRole("button", { name: /Скорость/ }));
    next(); expect(el.playbackRate).toBe(1.5);
    next(); expect(el.playbackRate).toBe(2);
    next(); expect(el.playbackRate).toBe(1);
  });

  it("файл не открылся — честная строка и ссылка, а не вечный «00:00»", () => {
    const { container } = render(<RhAudioPlayer src="/broken.mp3" />);
    act(() => { audioOf(container).dispatchEvent(new Event("error")); });
    expect(screen.getByTestId("rh-audio-failed").textContent).toContain("Запись не открылась");
    expect((screen.getByText("Открыть файл") as HTMLAnchorElement).getAttribute("href")).toBe("/broken.mp3");
  });

  it("играющую запись не дёргаем прыжком в конец: Infinity на ходу ждёт конца (preload=none, webm)", () => {
    const { container } = render(<RhAudioPlayer src="/a.webm" preload="none" label="Голосовое" />);
    const el = audioOf(container);
    fireEvent.click(screen.getByRole("button", { name: "Голосовое: слушать" }));
    act(() => { el.currentTime = 3; el.dispatchEvent(new Event("timeupdate")); });
    setDuration(el, Infinity);
    expect(el.currentTime).toBe(3); // не прыгнули
    expect(screen.getByTestId("rh-audio-clock").textContent).toBe("0:03");
    // запись доиграла: длина известна по концу воспроизведения
    act(() => { el.currentTime = 8.4; el.dispatchEvent(new Event("ended")); });
    expect(screen.getByTestId("rh-audio-clock").textContent).toBe("0:00 / 0:08");
  });

  it("ползунок не дёргается, пока его тянут: timeupdate во время перетаскивания игнорируется", () => {
    const { container } = render(<RhAudioPlayer src="/a.mp3" />);
    const el = audioOf(container);
    setDuration(el, 30);
    const slider = screen.getByRole("slider");
    fireEvent.pointerDown(slider);
    fireEvent.change(slider, { target: { value: "20" } });
    act(() => { el.currentTime = 5; el.dispatchEvent(new Event("timeupdate")); });
    expect(screen.getByTestId("rh-audio-clock").textContent).toBe("0:20 / 0:30");
    fireEvent.pointerUp(slider);
    act(() => { el.currentTime = 21; el.dispatchEvent(new Event("timeupdate")); });
    expect(screen.getByTestId("rh-audio-clock").textContent).toBe("0:21 / 0:30");
  });

  it("общий реестр: плеер на new Audio (озвучка) гасит этот, и наоборот", () => {
    render(<RhAudioPlayer src="/a.mp3" label="Запись" />);
    fireEvent.click(screen.getByRole("button", { name: "Запись: слушать" }));
    expect(playSpy).toHaveBeenCalledTimes(1);
    const external = vi.fn();
    act(() => { claimAudio(external); }); // стартовал внешний плеер
    expect(pauseSpy).toHaveBeenCalledTimes(1); // наш поставлен на паузу
    fireEvent.click(screen.getByRole("button", { name: "Запись: слушать" }));
    expect(external).toHaveBeenCalledTimes(1); // внешний погашен нашим стартом
  });

  it("кнопка ▶ меняет подпись, а не держит aria-pressed", () => {
    render(<RhAudioPlayer src="/a.mp3" label="Запись" />);
    const btn = screen.getByRole("button", { name: "Запись: слушать" });
    expect(btn.hasAttribute("aria-pressed")).toBe(false);
  });
});
