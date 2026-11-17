/**
 * PDF для тестов многостраничного разбора: страница — список строк-ячеек (текстовый слой
 * Helvetica, колонки на разных x) или null — пустая страница (как скан без текста).
 */
export function textPdfFixture(pages: (string[][] | null)[]): Buffer {
  const objects: string[] = [];
  const add = (body: string) => objects.push(body) ;
  add("<< /Type /Catalog /Pages 2 0 R >>");
  add("PAGES");
  add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  const pageIds: number[] = [];
  for (const page of pages) {
    const stream = (page ?? []).map((cells, row) => cells.map((cell, col) =>
      `BT /F1 10 Tf ${30 + col * 220} ${760 - row * 18} Td (${cell.replace(/[()\\]/g, "")}) Tj ET`).join("\n")).join("\n");
    add(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
    const contentId = objects.length;
    add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentId} 0 R >>`);
    pageIds.push(objects.length);
  }
  objects[1] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageIds.length} >>`;
  let text = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((object, i) => { offsets.push(Buffer.byteLength(text)); text += `${i + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(text);
  text += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  text += offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  text += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(text, "latin1");
}
