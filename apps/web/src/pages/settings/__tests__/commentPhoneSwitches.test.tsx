import React from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CommentPhoneSwitches } from "../CommentPhoneSwitches";

/**
 * Номер под постом (ревью #283, 20.11.2026): заявка — свой рубильник, по умолчанию ВЫКЛ; «написать человеку и скрыть»
 * действует только при включённой заявке, и экран это честно показывает.
 */
const render = (leadOn: boolean, talkOn: boolean) =>
  renderToString(<CommentPhoneSwitches leadOn={leadOn} talkOn={talkOn} onToggle={() => {}} />);

describe("переключатели «Номер под постом»", () => {
  it("заявка ВЫКЛ: подпись говорит, что агент номер не получит; разговор недоступен и показан выключенным", () => {
    const html = render(false, true);
    expect(html).toContain("Номер под постом: завести заявку агенту");
    expect(html).toContain("заявкой не становится");
    expect(html).toContain("Работает, только когда включено «Номер под постом: завести заявку агенту»");
    expect(html).not.toContain("Включено");
    expect(html).toMatch(/disabled/);
  });
  it("заявка ВКЛ, разговор ВЫКЛ: заявка для агента, ответ под постом как обычно", () => {
    const html = render(true, false);
    expect(html).toContain("сразу становится заявкой для агента");
    expect(html).toContain("Под постом бот отвечает как обычно");
    expect(html).not.toMatch(/disabled=""/);
  });
  it("оба ВКЛ: одно личное сообщение и скрытие", () => {
    expect(render(true, true)).toContain("одно личное сообщение");
  });
});
