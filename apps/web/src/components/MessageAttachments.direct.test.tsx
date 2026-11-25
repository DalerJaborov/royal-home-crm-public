// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Вложения переписки по прямой подписанной ссылке (25.11.2026, жалоба владельца
 * «фото и видео приходят, но не открываются в CRM»): плитка не качает файл целиком
 * через api() — тег грузит ссылку сам; не открылась — один раз прежним путём.
 */
const apiCalls: string[] = [];
vi.mock("../lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/api")>()),
  api: vi.fn(async (path: string) => {
    apiCalls.push(path);
    return new Blob(["x"], { type: "image/jpeg" });
  }),
}));

const { MessageAttachments, lostAttachmentText } = await import("./MessageAttachments");

afterEach(() => {
  cleanup();
  apiCalls.length = 0;
});

const SRC = "/api/v1/attachments/s/a.jpg?e=1&k=x";

describe("MessageAttachments: прямые ссылки", () => {
  it("фото с src: в ленте миниатюра, ни одного скачивания через api()", () => {
    const { container } = render(
      <MessageAttachments attachments={[{ kind: "image", mime: "image/jpeg", file: "a.jpg", src: SRC, thumb: `${SRC}&v=t` }]} />
    );
    const img = container.querySelector("img")!;
    expect(img.getAttribute("src")).toBe(`${SRC}&v=t`);
    expect(img.getAttribute("loading")).toBe("lazy");
    expect(apiCalls).toEqual([]);
  });

  it("прямая ссылка не открылась — один раз прежним путём (api с заголовком)", async () => {
    const { container } = render(
      <MessageAttachments attachments={[{ kind: "image", mime: "image/jpeg", file: "a.jpg", src: SRC, thumb: `${SRC}&v=t` }]} />
    );
    fireEvent.error(container.querySelector("img")!);
    await vi.waitFor(() => expect(apiCalls).toEqual(["/attachments/a.jpg"]));
  });

  it("видео: preload=metadata по прямой ссылке; ошибка оригинала — версия для браузера", () => {
    const { container } = render(
      <MessageAttachments attachments={[{ kind: "video", mime: "video/quicktime", file: "v.mov", src: SRC, play: `${SRC}&v=p` }]} />
    );
    const video = container.querySelector("video")!;
    expect(video.getAttribute("src")).toBe(SRC);
    expect(video.getAttribute("preload")).toBe("metadata");
    fireEvent.error(video);
    expect(container.querySelector("video")!.getAttribute("src")).toBe(`${SRC}&v=p`);
    fireEvent.error(container.querySelector("video")!);
    expect(screen.getByText(/Видео не воспроизводится/)).toBeTruthy();
    expect(apiCalls).toEqual([]);
  });

  it("без src (нет права на прямую ссылку) — прежний путь, как раньше", async () => {
    render(<MessageAttachments attachments={[{ kind: "image", mime: "image/jpeg", file: "b.jpg" }]} />);
    await vi.waitFor(() => expect(apiCalls).toEqual(["/attachments/b.jpg"]));
  });

  it("несохранённый файл — причина простыми словами и где открыть", () => {
    render(<MessageAttachments channel="WHATSAPP" attachments={[{ kind: "video", mime: "", file: null, lost: "too_big" }]} />);
    expect(screen.getByText("Клиент прислал видео — больше 16 МБ или длиннее 3 минут, в CRM не сохранилось. Откройте в WhatsApp")).toBeTruthy();
    expect(lostAttachmentText("image", "failed", "INSTAGRAM")).toBe("Клиент прислал фото — не скачалось, в CRM не сохранилось. Откройте в Instagram");
  });
});
