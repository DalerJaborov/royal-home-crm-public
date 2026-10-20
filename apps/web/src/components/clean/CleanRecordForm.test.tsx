import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ReadOnlyRecordFields, CleanRecordForm, cleanRecordChoiceProps, CleanInteractionContext } from "./CleanRecordForm";

describe("record form presentation boundary", () => {
  it("retains an opened draft while revocation disables editing fields", () => {
    const html = renderToStaticMarkup(<ReadOnlyRecordFields readOnly><input defaultValue="Unsent draft" /><button type="submit">Save</button></ReadOnlyRecordFields>);
    expect(html).toContain("Unsent draft");
    expect(html).toContain('<fieldset disabled=""');
    expect(html).toContain('role="status"');
  });
  it("keeps the selected client visible through loading and errors without invented contact details", () => {
    const html = renderToStaticMarkup(<CleanInteractionContext name="Мадина Каримова · очень длинное имя" isLoading isError onRetry={() => {}} scheduling />);
    expect(html).toContain("Показ для клиента");
    expect(html).toContain("Мадина Каримова");
    expect(html).not.toContain("Повторить");
    const failure = renderToStaticMarkup(<CleanInteractionContext isLoading={false} isError onRetry={() => {}} scheduling />);
    expect(failure).toContain('role="alert"');
    expect(failure).toContain("Повторить");
    expect(failure).not.toContain("Мадина");
  });
  it("uses pressed semantics for clean choices and retains legacy selected styling", () => {
    expect(cleanRecordChoiceProps(true, true)).toEqual({ "aria-pressed": true });
    expect(cleanRecordChoiceProps(false, false)).toEqual({ "aria-selected": false });
  });
  it("keeps legacy form DOM untouched", () => {
    expect(renderToStaticMarkup(<CleanRecordForm enabled={false}><label>Телефон<input name="phone" disabled /></label></CleanRecordForm>))
      .toBe(renderToStaticMarkup(<label>Телефон<input name="phone" disabled /></label>));
  });
  it("preserves validation, field identity and disabled controls in Clean", () => {
    const html = renderToStaticMarkup(<CleanRecordForm enabled><label htmlFor="notes">Заметка</label><textarea id="notes" name="notes" aria-invalid aria-describedby="notes-error" /><p id="notes-error" role="alert">Введите заметку</p><button type="submit" disabled>Сохранить</button></CleanRecordForm>);
    expect(html).toContain('class="clean-record-form"');
    expect(html).toContain('aria-describedby="notes-error"');
    expect(html).toContain('role="alert"');
    expect(html).toContain('type="submit" disabled=""');
  });
});
