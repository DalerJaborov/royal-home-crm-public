import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Пункт 17 разбора карточки объекта: блоки правятся прямо в просмотре. */
const src = readFileSync(join(__dirname, "../../pages/PropertyDetail.tsx"), "utf8").replace(/\r\n/g, "\n");
const view = src.slice(src.indexOf("function PropertyViewCard("), src.indexOf("function TrashedBanner("));

describe("карточка объекта: правка на месте", () => {
  it("правка на месте — тем же, кому открыта кнопка «Изменить», и не в корзине", () => {
    expect(view).toContain("const canInlineEdit = canEnterEdit && !isTrashed;");
  });

  it("«Кто ведёт объект» и поля правятся в самом блоке, без отдельного режима", () => {
    expect(view).toContain("editingFields && canInlineEdit ? (");
    expect(view).toContain("setEditingFields(false);\n          onInlineDone();");
    expect(view).toContain('<InlineEditLink label="Изменить" onClick={() => setEditingFields(true)} />');
    expect(view.match(/\{fieldsBlock\}/g)).toHaveLength(1);
  });

  it("документы отмечаются галочками прямо в блоке просмотра", () => {
    expect(view).toContain("editingDocs && canInlineEdit ? (");
    expect(view).toContain("<PropertyDocumentsField");
  });

  it("описание в просмотре правится тем же блоком, что в правке", () => {
    expect(view.match(/<DescriptionBlock\s+property=\{property\}\s+canEdit=\{canInlineEdit\}/g)).toHaveLength(1);
  });

  it("фото на компьютере меняются кнопкой «Изменить фото», без отдельного режима", () => {
    expect(view).toContain('readOnly={isTrashed ? "trashed" : !canInlineEdit ? "view" : editingPhotos ? false : "locked"}');
    expect(view).toContain('<InlineEditLink label="Изменить фото" onClick={() => setEditingPhotos(true)} />');
    const photos = readFileSync(join(__dirname, "../../components/PropertyPhotoManager.tsx"), "utf8");
    expect(photos).toContain("кнопкой «Изменить фото»");
  });

  it("фото: на первом экране одна галерея, редактор в меню «Изменить» и во вкладке «Фото и видео»", () => {
    expect(view.match(/<PropertyPhotoManager/g)).toHaveLength(1);
    expect(view.match(/<PropertyGallery /g)).toHaveLength(1);
    expect(view).toContain('id: "photos"');
    expect(view).toContain("setEditingPhotos(true);");
    expect(view).toContain("(editingPhotos ? (");
  });

  it("в блоке на месте нет документов, подписи Reels и «Готово — в продажу»: у них свои места", () => {
    const card = src.slice(src.indexOf("function AgentFieldsCard("), src.indexOf("function InlineEditLink("));
    expect(card).not.toContain("<PropertyDocumentsField");
    expect(card).not.toContain("<ReelsCaptionBlock");
    expect(card).not.toContain("<CompleteEditingButton");
    expect(card).toContain("<InlineDoneButton onClick={onDone} />");
  });

  it("«Готово» у блока и сохранение описания рассылают подпись и сайт, как прежнее «Готово»", () => {
    expect(src).toContain("onInlineDone={finishInlineEdit}");
    expect(view.match(/onInlineDone\(\);/g)!.length).toBeGreaterThanOrEqual(4);
    expect(view.match(/onSaved=\{onInlineDone\}/g)).toHaveLength(1);
  });

  it("исходники видео — по «Изменить исходники», готовый ролик отдельно", () => {
    expect(view).toContain("readOnly={!(editingVideo && canInlineEdit)}");
    expect(view.match(/\{sourcesBlock\}/g)).toHaveLength(1);
    const vm = readFileSync(join(__dirname, "../../components/PropertyVideoManager.tsx"), "utf8");
    expect(vm).toContain("Изменить исходники");
    expect(vm).toContain("{readOnly && onStartEdit && (");
  });

  it("удаление объекта — только в меню «Ещё», под подтверждением, чужому объекту пункта нет", () => {
    expect(view).toContain('deleteMode === "delete"');
    expect(view).toContain('deleteMode === "request" && !pendingDeleteRequest');
    expect(view).toContain("<DeletePropertyDialog");
    expect(src).toContain("<ConfirmDialog");
    // Права: заявка только тому, кто ведёт объект (иначе сервер отвечает 403).
    expect(src).toContain("!isTrashed && canRequestDeletePropertyPerm && !canDelete && isResponsibleForProperty");
  });
});
