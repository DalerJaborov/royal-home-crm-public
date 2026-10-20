import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { WizardShell } from "../WizardShell";
import type { ComponentProps } from "react";

const base: ComponentProps<typeof WizardShell> = {
  stepIndex: 0, onClose: () => {}, onBack: null, onNext: () => {},
  nextLabel: "Далее", offSite: false, onOffSiteChange: () => {}, children: <input aria-label="Имя" />,
};
const render = (props: Partial<ComponentProps<typeof WizardShell>> = {}) => renderToStaticMarkup(<WizardShell {...base} {...props} />);

describe("property wizard workspace", () => {
  it("distinguishes this-device storage from an acknowledged server save", () => {
    const local = render({ draftStatus: { state: "local", message: "Нет связи" }, onRetryDraft: () => {} });
    expect(local).toContain("Сохранено на этом устройстве");
    expect(local).toContain("Нет связи");
    expect(local).toContain("Повторить сохранение");
    expect(local).not.toContain("Сохранено на сервере");
    const server = render({ draftStatus: { state: "server", savedAt: "2026-10-20T12:30:00Z" } });
    expect(server).toContain("Сохранено на сервере");
    expect(server).toMatch(/datetime="2026-10-20T12:30:00Z"/i);
    expect(server).not.toContain("Повторить сохранение");
  });

  it("exposes an actionable saving failure without claiming success", () => {
    const html = render({ draftStatus: { state: "error", message: "Черновик изменён в другой вкладке" }, onRetryDraft: () => {} });
    expect(html).toContain('role="alert"');
    expect(html).toContain("Черновик изменён в другой вкладке");
    expect(html).toContain('data-testid="wizard-draft-retry"');
    expect(html).not.toContain("Сохранено на сервере");
  });

  it("names all desktop steps, marks the current step, and preserves mobile sequential controls", () => {
    const html = render({ stepIndex: 2, onBack: () => {}, onGoToStep: () => {}, stepStates: { seller: "complete", media: "invalid" } });
    for (const title of ["Продавец", "Фото и видео", "Параметры", "Адрес", "Проверка"]) expect(html).toContain(title);
    expect(html.match(/aria-current="step"/g)).toHaveLength(1);
    expect(html).toContain('data-step-state="invalid"');
    expect(html).toContain('data-testid="wizard-back"');
    expect(html).toContain('data-testid="wizard-next"');
    expect(html).toContain('aria-label="Продавец, заполнено"');
  });

  it("blocks conflicting operations during deletion and keeps a failed deletion retryable", () => {
    const pending = render({ deleteDraftPending: true, onDeleteDraft: () => {}, onSaveAndExit: () => {}, onGoToStep: () => {} });
    for (const id of ["wizard-delete-draft", "wizard-save-exit", "wizard-next", "wizard-close"]) {
      const control = pending.match(new RegExp(`<button[^>]*data-testid="${id}"[^>]*>`))?.[0];
      expect(control).toContain('disabled=""');
    }
    const failed = render({ onDeleteDraft: () => {}, deleteDraftError: "Не удалось удалить черновик" });
    expect(failed).toContain("Не удалось удалить черновик");
    expect(failed).not.toMatch(/<button[^>]*data-testid="wizard-delete-draft"[^>]*disabled=""/);
  });

  it("does not call saving completed while a new save is in flight", () => {
    const html = render({ draftSaved: true, draftStatus: { state: "saving" } });
    expect(html).toContain("Сохраняю черновик");
    expect(html).not.toContain("Сохранено на сервере");
    expect(html).not.toContain("Черновик сохранён");
  });
});
