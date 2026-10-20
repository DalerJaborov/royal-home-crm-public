import { useState } from "react";
import { X } from "lucide-react";

/** Список слов с добавлением по Enter/запятой и удалением по крестику — тот же
 *  рисунок пилюль, что у ключевых слов воронки (FunnelEditor.tsx), вынесен сюда,
 *  чтобы не заводить вторую копию для списков вроде Settings.transferConflictKeywords.
 *
 *  Разметка — эталон темы «Royal Home 2026» (screens/settings.html, «Передача как
 *  признак конфликта»): чипы `.chip` в ряду `.wrap`, ниже строка добавления с
 *  полем `.inp` и капсулой «Добавить». */
export function KeywordTags({
  values,
  onChange,
  placeholder = "слово",
  max = 20,
}: {
  values: string[];
  onChange: (v: string[]) => void;
  placeholder?: string;
  max?: number;
}) {
  const [text, setText] = useState("");

  function add() {
    const word = text.trim();
    // Пустое слово совпало бы с чем угодно — молча и незаметно.
    if (word.length < 2) return;
    if (!values.some((v) => v.toLowerCase() === word.toLowerCase())) onChange([...values, word]);
    setText("");
  }

  return (
    <div>
      {values.length > 0 && (
        <div className="wrap">
          {values.map((word) => (
            <span className="chip" key={word}>
              {word}
              <button
                type="button"
                onClick={() => onChange(values.filter((v) => v !== word))}
                aria-label={`Убрать «${word}»`}
                className="lnk"
                style={{ minHeight: 0, padding: 0, color: "inherit" }}
              >
                <X className="i" style={{ width: 12, height: 12 }} aria-hidden="true" />
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="wrap" style={{ marginTop: values.length > 0 ? "var(--s3)" : 0 }}>
        <input
          className="inp"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            // Enter добавляет слово, а не отправляет форму: форма может быть одна
            // на всю вкладку, и случайная отправка сохранила бы половину заполненного.
            if (e.key === "Enter" || e.key === ",") {
              e.preventDefault();
              add();
            }
          }}
          placeholder={placeholder}
          aria-label={placeholder}
        />
        <button
          className="pill ghost"
          type="button"
          onClick={add}
          disabled={text.trim().length < 2 || values.length >= max}
        >
          Добавить
        </button>
      </div>
    </div>
  );
}
