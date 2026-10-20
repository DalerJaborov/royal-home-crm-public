import { useCallback, useEffect, useState } from "react";

/**
 * Настройки панели — каждая возможность включается и выключается отдельно.
 *
 * Раньше жил в components/live/panelPrefs.ts вместе с удалённым (18.08.2026)
 * обликом «Живая панель» — но PropertyFormModal.tsx и ui/DismissibleHint.tsx
 * читают отсюда поле `animations` независимо от облика (плавное появление шага
 * формы и подсказки), поэтому модуль перенесён сюда, а не удалён вместе с
 * components/live. Остальные поля (liveUpdates, dragTiles, mapInsteadOfDistricts,
 * comparePeriods, swipes, leadSound, aiHints) были специфичны для удалённой живой
 * панели и её экрана настроек (PanelSettings.tsx, тоже удалён) — их некому больше
 * менять через интерфейс, но поведение и хранимое значение (localStorage) не
 * трогаем, чтобы не расширять эту задачу правкой несвязанной функциональности.
 *
 * Почему локально, а не в учётной записи: это привычки конкретного человека за
 * конкретным экраном. Директор на большом мониторе хочет анимации, агент на
 * слабом телефоне в разъездах — тишину и минимум движения. Одна настройка на
 * аккаунт заставила бы их спорить.
 *
 * Ничего не навязывается: выключил — вернулся к прежнему виду, и это не ломает
 * ничего, а честно убирает элемент.
 */

export interface PanelPrefs {
  /** Панель сама подтягивает свежие данные и подсвечивает то, что прибавилось. */
  liveUpdates: boolean;
  /** Короткий вывод под графиком: что изменилось и на что смотреть. */
  aiHints: boolean;
  /** Плитки можно менять местами. */
  dragTiles: boolean;
  /** Числа набегают, графики прорисовываются. */
  animations: boolean;
  /** Карта объектов вместо списка районов. */
  mapInsteadOfDistricts: boolean;
  /** Предыдущий период пунктиром на графике. */
  comparePeriods: boolean;
  /** Свайпы по строкам на телефоне. */
  swipes: boolean;
  /** Короткий сигнал, когда приходит новая заявка. */
  leadSound: boolean;
}

export const PANEL_PREFS_DEFAULT: PanelPrefs = {
  liveUpdates: true,
  aiHints: true,
  dragTiles: true,
  animations: true,
  mapInsteadOfDistricts: false,
  comparePeriods: false,
  swipes: true,
  // Звук по умолчанию выключен: включённый по умолчанию сигнал в открытом офисе
  // раздражает всех, кроме того, кому он адресован.
  leadSound: false,
};

const STORAGE_KEY = "royal-home:panel-prefs";

function read(): PanelPrefs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return PANEL_PREFS_DEFAULT;
    const saved = JSON.parse(raw);
    if (!saved || typeof saved !== "object") return PANEL_PREFS_DEFAULT;
    // Незнакомые ключи отбрасываем, отсутствующие берём из умолчаний: после релиза
    // с новой возможностью человек не должен терять свои прежние переключатели.
    const next = { ...PANEL_PREFS_DEFAULT };
    for (const key of Object.keys(PANEL_PREFS_DEFAULT) as (keyof PanelPrefs)[]) {
      if (typeof saved[key] === "boolean") next[key] = saved[key];
    }
    return next;
  } catch {
    return PANEL_PREFS_DEFAULT;
  }
}

/** Разные части приложения читают настройки независимо — держим их в синхроне через событие. */
const CHANGED = "royal-home:panel-prefs-changed";

export function usePanelPrefs(): [PanelPrefs, (key: keyof PanelPrefs, value: boolean) => void] {
  const [prefs, setPrefs] = useState<PanelPrefs>(PANEL_PREFS_DEFAULT);

  useEffect(() => {
    setPrefs(read());
    const onChange = () => setPrefs(read());
    window.addEventListener(CHANGED, onChange);
    // storage — когда человек открыл CRM в двух вкладках и переключил в одной.
    window.addEventListener("storage", onChange);
    return () => {
      window.removeEventListener(CHANGED, onChange);
      window.removeEventListener("storage", onChange);
    };
  }, []);

  const set = useCallback((key: keyof PanelPrefs, value: boolean) => {
    const next = { ...read(), [key]: value };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      /* приватный режим — настройка не переживёт перезагрузку, но сейчас применится */
    }
    setPrefs(next);
    window.dispatchEvent(new Event(CHANGED));
  }, []);

  return [prefs, set];
}
