import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * СЕНСОРЫ ПЕРЕТАСКИВАНИЯ — ТОЛЬКО ЧЕРЕЗ hooks/useTouchSafeDragSensors.ts
 * (17.11.2026, аудит F2-3).
 *
 * `PointerSensor` на телефоне превращал попытку пролистать страницу в
 * перетаскивание: в сетке фото объекта так молча менялось главное фото на сайте.
 * Починка жила в одном файле («Сделки»), а сетка фото и шторка порядка вкладок
 * остались со старым сенсором. Сторож не пускает сенсоры dnd-kit в код мимо
 * общего хука — следующий `DndContext` получит правильное поведение пальца сам.
 */
const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DOOR = path.join("hooks", "useTouchSafeDragSensors.ts");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

const SENSOR_IMPORT =
  /import\s*\{[^}]*\b(PointerSensor|MouseSensor|TouchSensor|useSensor|useSensors)\b[^}]*\}\s*from\s*["']@dnd-kit\/core["']/;

function importsRawSensors(source: string): boolean {
  return SENSOR_IMPORT.test(source);
}

describe("сенсоры перетаскивания — одна дверь", () => {
  it("находит файлы исходников (иначе сторож проверяет пустоту)", () => {
    expect(sourceFiles(SRC).length).toBeGreaterThan(100);
  });

  it("никто, кроме общего хука, не берёт сенсоры dnd-kit напрямую", () => {
    const offenders = sourceFiles(SRC)
      .filter((file) => path.relative(SRC, file) !== DOOR)
      .filter((file) => importsRawSensors(fs.readFileSync(file, "utf8")))
      .map((file) => path.relative(SRC, file));
    expect(offenders).toEqual([]);
  });

  it("сторож краснеет на прямом PointerSensor (поломка нарочно)", () => {
    expect(importsRawSensors(`import { DndContext,\n  PointerSensor, useSensor } from "@dnd-kit/core";`)).toBe(true);
    expect(importsRawSensors(`import { DndContext, type DragEndEvent } from "@dnd-kit/core";`)).toBe(false);
  });
});
