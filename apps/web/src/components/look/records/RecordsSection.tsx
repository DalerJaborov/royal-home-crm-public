import type { ReactNode } from "react";
import { useRoyalLook } from "../../../hooks/useRoyalLook";
import { RoyalSection, useRoyalSectionName } from "../clients/RoyalSection";
import { RECORDS_SECTION } from "./publicLook";

/**
 * РАЗДЕЛ «ЗАПИСИ» НОВОГО ВИДА (пачка records, 20.11.2026): «Архив и корзина»
 * (/archive), «Подбор сотрудников» (/vacancies) и анкета кандидата
 * (/vacancies/:id). Экраны входа и публичные ссылки — та же метка, но признак у
 * них свой (publicLook.ts): сотрудника там нет.
 *
 * При `useRoyalLook()` контекст получает метку `records` (общий механизм
 * RoyalSection): `Rh2Screen` и `Rh2Portal` ставят `data-ry-section` сами, экран со
 * своей обёрткой (Архив) — через `useRecordsSectionMark()`. Без признака метки нет:
 * ни атрибута, ни класса — слой theme-look-royal-records.css весь под меткой.
 */
export function RecordsSection({ children }: { children: ReactNode }) {
  const royal = useRoyalLook();
  return <RoyalSection name={royal ? RECORDS_SECTION : undefined}>{children}</RoyalSection>;
}

/** Значение `data-ry-section` для корня экрана: «records» в новом виде, иначе атрибута нет. */
export function useRecordsSectionMark(): string | undefined {
  return useRoyalSectionName() === RECORDS_SECTION ? RECORDS_SECTION : undefined;
}
