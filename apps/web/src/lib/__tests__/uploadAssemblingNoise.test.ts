import { beforeEach, describe, expect, it, vi } from "vitest";
import { UPLOAD_ERROR_SPECS } from "@royal-home/shared";

/**
 * Журнал ошибок 28.11.2026: «[загрузка] видео IMG_1275.mov … попытка 2/10, «Файл уже
 * собирается — подождите»». Промежуточный ASSEMBLING — ожидаемое ожидание, в журнал
 * не пишется; окончательный отказ пишется всегда.
 */
const apiMock = vi.fn(() => Promise.resolve({}));
vi.mock("../api", () => ({ api: (...a: unknown[]) => (apiMock as (...x: unknown[]) => unknown)(...a) }));
vi.mock("../../store/auth", () => ({ useAuthStore: { getState: () => ({ hasSession: true }) } }));

const base = {
  kind: "video" as const, name: "IMG_1275.mov", sizeBytes: 130 * 1024 * 1024, propertyLabel: "черновик объекта (мастер)",
  attempts: 2, maxAttempts: 10, status: 0, online: true, userAgent: "iPhone Safari",
};

describe("репорт загрузки: ASSEMBLING", () => {
  beforeEach(async () => {
    vi.stubGlobal("location", { pathname: "/properties/new" });
    apiMock.mockClear();
    (await import("../errorReporter")).resetErrorReporterForTests();
  });

  it("промежуточный «Файл уже собирается» в журнал не уходит", async () => {
    const { reportUploadIssue } = await import("../errorReporter");
    reportUploadIssue({ ...base, error: UPLOAD_ERROR_SPECS.ASSEMBLING.message });
    expect(apiMock).not.toHaveBeenCalled();
  });

  it("окончательный отказ с тем же текстом пишется", async () => {
    const { reportUploadIssue } = await import("../errorReporter");
    reportUploadIssue({ ...base, attempts: 10, final: true, error: UPLOAD_ERROR_SPECS.ASSEMBLING.message });
    expect(apiMock).toHaveBeenCalledTimes(1);
  });

  it("другая ошибка на промежуточной попытке пишется как раньше", async () => {
    const { reportUploadIssue } = await import("../errorReporter");
    reportUploadIssue({ ...base, error: "Связь прервалась" });
    expect(apiMock).toHaveBeenCalledTimes(1);
  });

  it("осознанный отказ по сути файла (409, человеческий текст) не пишется, технический 409 пишется", async () => {
    const { reportUploadIssue } = await import("../errorReporter");
    reportUploadIssue({ ...base, status: 409, final: true, error: "Это исходник объекта (121382.mp4), а не смонтированный ролик." });
    expect(apiMock).not.toHaveBeenCalled();
    reportUploadIssue({ ...base, status: 409, final: true, error: UPLOAD_ERROR_SPECS.PARTS_MISSING.message });
    expect(apiMock).toHaveBeenCalledTimes(1);
  });
});
