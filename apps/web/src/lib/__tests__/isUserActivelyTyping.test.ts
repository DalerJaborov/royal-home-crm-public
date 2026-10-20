import { afterEach, describe, expect, it } from "vitest";
import { isUserActivelyTyping, noteFieldTouched } from "../isUserActivelyTyping";

/**
 * «Занят прямо сейчас» — расширено 09.09.2026 (R2-код-ревью, дефект «мешает»):
 * фокус в input/textarea/select/contenteditable С НЕПУСТЫМ значением, открытая
 * модалка/шторка, несохранённая форма, незавершённая загрузка файла — любой из
 * четырёх сигналов откладывает подмену сборки.
 *
 * Уточнено 10.09.2026 (поймано замером на стенде): поле идёт в счёт, ТОЛЬКО
 * если в него печатали. Экран входа сам ставит фокус в поле телефона и сам
 * подставляет «+992» — нетронутая вкладка на /login считалась занятой всегда и
 * не обновлялась до потолка в пять минут.
 *
 * Тест без jsdom (не установлен в этом воркспейсе, environment: "node" в
 * vitest.config.ts) — document стабится вручную, как в pultSound.test.ts.
 */

type FakeElement = {
  tagName: string;
  value?: string;
  isContentEditable?: boolean;
  textContent?: string;
};

function stubDocument(opts: {
  activeElement?: FakeElement | null;
  querySelectorResult?: unknown;
  querySelectorAllResult?: unknown[];
}) {
  (globalThis as { document?: unknown }).document = {
    activeElement: opts.activeElement ?? null,
    querySelector: () => opts.querySelectorResult ?? null,
    querySelectorAll: () => opts.querySelectorAllResult ?? [],
  };
}

/** Поле, в которое человек уже печатал, — как после события input. */
function touchedField(el: FakeElement): FakeElement {
  noteFieldTouched(el);
  return el;
}

describe("isUserActivelyTyping", () => {
  const originalDocument = globalThis.document;

  afterEach(() => {
    (globalThis as { document?: unknown }).document = originalDocument;
  });

  it("нет активного элемента, нет модалки/формы/загрузки — не занят", () => {
    stubDocument({});
    expect(isUserActivelyTyping()).toBe(false);
  });

  it("textarea с набранным текстом в фокусе — занят", () => {
    stubDocument({ activeElement: touchedField({ tagName: "TEXTAREA", value: "привет" }) });
    expect(isUserActivelyTyping()).toBe(true);
  });

  it("textarea пустая в фокусе — не занят (сама по себе)", () => {
    stubDocument({ activeElement: touchedField({ tagName: "TEXTAREA", value: "" }) });
    expect(isUserActivelyTyping()).toBe(false);
  });

  it("input с набранным текстом в фокусе — занят", () => {
    stubDocument({ activeElement: touchedField({ tagName: "INPUT", value: "х" }) });
    expect(isUserActivelyTyping()).toBe(true);
  });

  it("select с выбранным значением в фокусе — занят", () => {
    stubDocument({ activeElement: touchedField({ tagName: "SELECT", value: "opt1" }) });
    expect(isUserActivelyTyping()).toBe(true);
  });

  it("select без значения в фокусе — не занят (сам по себе)", () => {
    stubDocument({ activeElement: touchedField({ tagName: "SELECT", value: "" }) });
    expect(isUserActivelyTyping()).toBe(false);
  });

  it("contenteditable с набранным текстом в фокусе — занят", () => {
    stubDocument({
      activeElement: touchedField({ tagName: "DIV", isContentEditable: true, textContent: "текст" }),
    });
    expect(isUserActivelyTyping()).toBe(true);
  });

  it("АВТОФОКУС В ПОЛЕ С ПОДСТАВЛЕННЫМ ЗНАЧЕНИЕМ — НЕ занят (экран входа, «+992»)", () => {
    // Ровно то, что 10.09.2026 держало нетронутую вкладку на старой сборке:
    // человек не касался поля, значение подставило приложение.
    stubDocument({ activeElement: { tagName: "INPUT", value: "+992" } });
    expect(isUserActivelyTyping()).toBe(false);
  });

  it("открытая модалка [role=dialog][aria-modal=true] — занят, даже без фокуса в поле", () => {
    stubDocument({ querySelectorResult: {} });
    expect(isUserActivelyTyping()).toBe(true);
  });

  it("незавершённая загрузка файла (input[type=file] с файлами) — занят", () => {
    stubDocument({ querySelectorAllResult: [{ files: [{}] }] });
    expect(isUserActivelyTyping()).toBe(true);
  });

  it("input[type=file] без выбранных файлов — не занят (сам по себе)", () => {
    stubDocument({ querySelectorAllResult: [{ files: [] }] });
    expect(isUserActivelyTyping()).toBe(false);
  });
});
