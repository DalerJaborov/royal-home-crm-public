import { describe, expect, it } from "vitest";
import { canCloseWizard, decideSave, skippedMediaCount, skippedMediaMessage, uploadProblemTitle } from "../saveDecision";

describe("decideSave: «Сохранить» и файлы мастера", () => {
  it("всё на сервере → создаём", () => {
    expect(decideSave({ pending: 0, failed: 0 })).toBe("proceed");
  });

  it("что-то ещё едет → ждём, даже если часть уже упала", () => {
    expect(decideSave({ pending: 2, failed: 0 })).toBe("wait");
    expect(decideSave({ pending: 1, failed: 3 })).toBe("wait");
  });

  it("упавшие или потерянные при пустой очереди → спрашиваем, а не создаём молча", () => {
    expect(decideSave({ pending: 0, failed: 1 })).toBe("ask");
  });

  it("«Сохранить без них» — только явным согласием, и едущие всё равно ждём", () => {
    expect(decideSave({ pending: 0, failed: 2 }, { acceptedLoss: true })).toBe("proceed");
    expect(decideSave({ pending: 1, failed: 2 }, { acceptedLoss: true })).toBe("wait");
  });
});

describe("тексты окна выбора", () => {
  it("заголовок считает файлы по-русски", () => {
    expect(uploadProblemTitle(1, false)).toBe("Не загрузилось 1 файл");
    expect(uploadProblemTitle(2, false)).toBe("Не загрузилось 2 файла");
    expect(uploadProblemTitle(5, false)).toBe("Не загрузилось 5 файлов");
    expect(uploadProblemTitle(0, true)).toBe("Файлы ещё не доехали");
  });
});

describe("ответ сервера о пропавших файлах", () => {
  it("читает media.skipped, а без поля ничего не ломает", () => {
    expect(skippedMediaCount({ id: "p", media: { attached: 4, skipped: 2 } })).toBe(2);
    expect(skippedMediaCount({ id: "p" })).toBe(0);
    expect(skippedMediaCount({ media: {} })).toBe(0);
    expect(skippedMediaCount({ media: { skipped: "2" } })).toBe(0);
    expect(skippedMediaCount(null)).toBe(0);
    expect(skippedMediaCount(undefined)).toBe(0);
  });

  it("сообщение — «N файлов не дошли»", () => {
    expect(skippedMediaMessage(3)).toContain("3 файла не дошли");
  });
});

describe("canCloseWizard: закрыть мастер", () => {
  it("до «Сохранить» можно закрыть, даже пока файлы едут", () => {
    // файлы едут — это сводка очереди, на закрытие она не влияет вовсе
    expect(decideSave({ pending: 3, failed: 0 })).toBe("wait");
    expect(canCloseWizard({ saving: false, finishing: false })).toBe(true);
  });

  it("во время сохранения и на финальном экране — нельзя", () => {
    expect(canCloseWizard({ saving: true, finishing: false })).toBe(false);
    expect(canCloseWizard({ saving: false, finishing: true })).toBe(false);
  });
});
