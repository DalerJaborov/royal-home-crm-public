/**
 * Минимальный CSV-парсер (RFC 4180): кавычки, экранированные кавычки, переносы строк
 * внутри полей, разделитель `,` или `;` (Excel в русской локали сохраняет с `;`).
 * Зависимость не тянем — формат простой, а поведение полностью под контролем.
 */
export function parseCsv(text: string): string[][] {
  // BOM от Excel
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const delimiter = detectDelimiter(text);

  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.some((f) => f.trim() !== "")) rows.push(row);
      row = [];
    } else {
      field += ch;
    }
  }
  row.push(field);
  if (row.some((f) => f.trim() !== "")) rows.push(row);
  return rows;
}

function detectDelimiter(text: string): "," | ";" {
  let commas = 0;
  let semicolons = 0;
  let inQuotes = false;
  // Separators inside a quoted header are data. A quoted line break also
  // belongs to that header, so inspect the first logical record in full.
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      if (inQuotes && text[i + 1] === '"') i++;
      else inQuotes = !inQuotes;
    } else if (!inQuotes) {
      if (ch === ",") commas++;
      else if (ch === ";") semicolons++;
      else if (ch === "\n" || ch === "\r") break;
    }
  }
  return semicolons > commas ? ";" : ",";
}

/** Строки → объекты по заголовку; заголовки нормализуются (регистр/пробелы). */
export function csvToRecords(text: string): { headers: string[]; records: Record<string, string>[] } {
  const rows = parseCsv(text);
  if (rows.length === 0) return { headers: [], records: [] };
  const headers = rows[0].map((h) => h.trim().toLowerCase());
  const records = rows.slice(1).map((cells) => {
    const rec: Record<string, string> = {};
    headers.forEach((h, i) => {
      rec[h] = (cells[i] ?? "").trim();
    });
    return rec;
  });
  return { headers, records };
}

/**
 * ЗАЩИТА ВЫГРУЗКИ ОТ CSV-ИНЪЕКЦИИ (находка №216, рекомендация OWASP).
 *
 * Excel и Google Таблицы исполняют ячейку, начинающуюся с `=`, `+`, `-`, `@`, а
 * также с табуляции или возврата каретки, как формулу: имя клиента
 * `=HYPERLINK("http://…","Нажмите")` из ника мессенджера уходило бы бухгалтеру
 * живой ссылкой. Спасает апостроф в начале — ячейка остаётся текстом.
 *
 * Обычное число (`-1200.50`, `+992901234567`) формулой быть не может и остаётся
 * как есть: иначе отрицательные суммы в выгрузке превращались бы в текст.
 * Применять ко всем ТЕКСТОВЫМ значениям, которые вводит человек или приходят из
 * мессенджеров, перед обрамлением кавычками.
 */
export function csvSafeText(value: unknown): string {
  const text = String(value ?? "");
  if (!/^[=+\-@\t\r]/.test(text)) return text;
  if (/^[+-]?\d+(?:[.,]\d+)?$/.test(text)) return text;
  return `'${text}`;
}
