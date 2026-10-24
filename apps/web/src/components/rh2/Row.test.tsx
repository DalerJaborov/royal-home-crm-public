import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { Row, ROW_STACK_TITLE } from "./Row";

const long = "К".repeat(ROW_STACK_TITLE + 8);
const render = (props: Partial<Parameters<typeof Row>[0]>) =>
  renderToStaticMarkup(
    <MemoryRouter>
      <Row title={long} actions={<button type="button">Позвонить</button>} {...props} />
    </MemoryRouter>,
  );

describe("Row — перенос действий под текст на телефоне", () => {
  it("длинный заголовок уводит действия под текст", () => {
    expect(render({})).toContain("rh-row-wrap");
  });

  it("одна круглая кнопка (compactAction) остаётся справа даже при длинном заголовке", () => {
    expect(render({ compactAction: true })).not.toContain("rh-row-wrap");
  });

  it("несколько кнопок уходят под текст и при compactAction", () => {
    expect(render({ compactAction: true, actionCount: 2 })).toContain("rh-row-wrap");
  });
});
