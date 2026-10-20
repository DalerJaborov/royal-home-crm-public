import { useState } from "react";
import {
  PROPERTY_DOCUMENTS,
  REQUIRED_DOCUMENTS,
  missingRequired,
  parseDocuments,
  serializeDocuments,
  type PropertyDocument,
} from "../lib/propertyDocuments";

/**
 * «Документы» объекта (решение Dan 24.09.2026: список галочек вместо строки).
 * Просмотр — `PropertyDocumentsCard`, правка — `PropertyDocumentsField`; обе
 * читают одну строку `Property.documents` через lib/propertyDocuments.ts.
 */

/** Просмотр: какие документы есть, каких из обязательных нет. Рисуется внутри
 *  `.card` вызывающего экрана. */
export function PropertyDocumentsCard({ documents }: { documents: string | null | undefined }) {
  const { have, other } = parseDocuments(documents);
  const missing = missingRequired(have);
  const shown = PROPERTY_DOCUMENTS.filter((d) => have.includes(d) || REQUIRED_DOCUMENTS.includes(d));
  return (
    <>
      <div className="sec-h stack">
        <h2>Документы</h2>
        <span className="note">Видны только сотрудникам</span>
      </div>
      <div className="list">
        {shown.map((doc) => (
          <div className="row" key={doc}>
            <div className="t">
              <b>{doc}</b>
            </div>
            {have.includes(doc) ? <span className="chip ok">Есть</span> : <span className="chip warn">Нет</span>}
          </div>
        ))}
        {other && (
          <div className="row">
            <div className="t">
              <b>{other.charAt(0).toUpperCase() + other.slice(1)}</b>
              <span>Другие документы</span>
            </div>
            <span className="chip ok">Есть</span>
          </div>
        )}
      </div>
      {missing.length > 0 && (
        <div className="quiet warn">
          <span className="dot warn" />
          <span className="txt">
            Для сделки не хватает: {missing.map((d) => d.toLowerCase()).join(" и ")}.
          </span>
        </div>
      )}
    </>
  );
}

/** Правка: галочки и строка «Другие документы». Каждая галочка сохраняется
 *  сразу, строка — когда поле теряет фокус, как остальные поля карточки. */
export function PropertyDocumentsField({
  documents,
  disabled,
  onSave,
}: {
  documents: string | null | undefined;
  disabled?: boolean;
  onSave: (value: string | null) => void;
}) {
  const initial = parseDocuments(documents);
  const [have, setHave] = useState<PropertyDocument[]>(initial.have);
  const [other, setOther] = useState(initial.other);

  const save = (nextHave: PropertyDocument[], nextOther: string) => {
    const value = serializeDocuments(nextHave, nextOther);
    if (value !== (documents?.trim() || null)) onSave(value);
  };

  const toggle = (doc: PropertyDocument, on: boolean) => {
    const next = on ? [...have, doc] : have.filter((d) => d !== doc);
    setHave(next);
    save(next, other);
  };

  return (
    <div className="fld docs-fld">
      <span className="lab">Документы</span>
      <div className="docs-chks">
        {PROPERTY_DOCUMENTS.map((doc) => (
          <label className="chk" key={doc}>
            <input
              type="checkbox"
              checked={have.includes(doc)}
              disabled={disabled}
              onChange={(e) => toggle(doc, e.target.checked)}
            />
            {doc}
          </label>
        ))}
      </div>
      <input
        value={other}
        disabled={disabled}
        placeholder="Другие документы"
        aria-label="Другие документы"
        onChange={(e) => setOther(e.target.value)}
        onBlur={() => save(have, other)}
      />
      <span className="msg">Отметьте, что есть на руках. Видны только сотрудникам.</span>
    </div>
  );
}
