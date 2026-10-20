/**
 * Сторож веток: конфликт в СОБРАННОМ файле — не расхождение работы.
 *
 * Зачем тест. 02.10.2026 сторож называл конфликтом три файла карты у почти каждой
 * открытой ветки: после любого вливания в `main` обе стороны пересобирают карту из
 * разного кода, и сухое слияние честно показывает расхождение. Разбирать там нечего
 * (`npm run sync:main` пересоберёт), но в отчёте это выглядело ровно так же, как
 * настоящий конфликт в `apps/api/src/...`. Предупреждение, которое горит всегда,
 * перестают читать к тому дню, когда конфликт настоящий, — в тот день их было
 * семь веток с одинаковой записью и одна из них с конфликтом по существу.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { GENERATED_FILES, splitConflicts, describeConflicts, stickyBody } from "./sync-guard.mjs";

const MAP = "docs/product-flows.json";
const MAP2 = "docs/product-map-simple.json";
const SRC = "apps/api/src/routes/properties/crud.ts";

test("собранные файлы отделяются от конфликтов по существу", () => {
  const { real, generated } = splitConflicts([MAP, SRC, MAP2]);
  assert.deepEqual(real, [SRC]);
  assert.deepEqual(generated, [MAP, MAP2]);
});

test("словари подписей правятся руками — их конфликт настоящий", () => {
  // Маска `docs/product-*` проглотила бы оба, и настоящий конфликт стал бы невидим.
  for (const f of ["docs/product-map-labels.json", "docs/product-map-words.json"]) {
    assert.equal(GENERATED_FILES.has(f), false, `${f} не собирается скриптом`);
    assert.deepEqual(splitConflicts([f]).real, [f]);
  }
});

test("разборы с датой в имени — тоже не собранные файлы", () => {
  for (const f of ["docs/product-map-gaps-20-09.md", "docs/product-map-razbor-19-09.md"]) {
    assert.deepEqual(splitConflicts([f]).real, [f]);
  }
});

test("в тексте отчёта про собранные сказано, что разбирать не надо", () => {
  const only = describeConflicts([MAP, MAP2]);
  assert.match(only, /собранных файлах/);
  assert.match(only, /sync:main/);
  assert.doesNotMatch(only, /по существу/);

  const both = describeConflicts([MAP, SRC]);
  assert.match(both, /\*\*1\*\* по существу/);
  assert.match(both, /1 в собранных файлах/);
});

test("чистое слияние и несчитанное описываются как раньше", () => {
  assert.equal(describeConflicts([]), "нет, сливается чисто");
  assert.match(describeConflicts(null), /посчитать не удалось/);
  assert.equal(splitConflicts(null), null);
});

const branch = (over) => ({
  name: "claude/проба",
  ahead: 3,
  behind: 2,
  date: "2026-10-02T10:00:00Z",
  ageDays: 0,
  conflicts: [],
  ...over,
});

test("конфликт только в собранных файлах не объявляет ветку разошедшейся", () => {
  const body = stickyBody(branch({ conflicts: [MAP, MAP2] }));
  assert.doesNotMatch(body, /Ветка разошлась/);
  assert.match(body, /идёт вровень/);
  // И не зовёт голый merge: он оставил бы в карте маркеры конфликта.
  assert.doesNotMatch(body, /git merge origin/);
});

test("конфликт по существу разошедшуюся ветку объявляет", () => {
  const body = stickyBody(branch({ conflicts: [SRC] }));
  assert.match(body, /Ветка разошлась/);
});

test("когда конфликтует и то и другое — зовёт свод, а не голый merge", () => {
  const body = stickyBody(branch({ conflicts: [SRC, MAP] }));
  assert.match(body, /Ветка разошлась/);
  assert.match(body, /npm run sync:main/);
  assert.doesNotMatch(body, /git merge origin/);
});

test("сильное отставание без конфликтов зовёт обычный merge", () => {
  const body = stickyBody(branch({ behind: 500, conflicts: [] }));
  assert.match(body, /Ветка разошлась/);
  assert.match(body, /git merge origin/);
});
