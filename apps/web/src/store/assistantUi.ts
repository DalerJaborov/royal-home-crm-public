import { create } from "zustand";

/**
 * ОТКРЫТА ЛИ ПАНЕЛЬ ИИ-ПОМОЩНИКА — ОДНО СОСТОЯНИЕ НА ВСЕ ВХОДЫ.
 *
 * Входов три, и до 31.10.2026 у каждого был свой `useState` и своя копия панели:
 * удержание «+» на телефоне (BottomNav), кнопка в шапке чистой оболочки
 * (CleanShell) и — на ПК в прежней оболочке — ничего. Две копии могли открыться
 * одновременно, а третий вход пришлось бы заводить третьей копией. Теперь панель
 * монтирует один `AssistantHost` (AppLayout), а входы только просят её открыть.
 *
 * `autoStartVoice` — только удержание «+»: открыть сразу с включённым микрофоном.
 * `seed` — подсказка, которую панель отправит сама при открытии (пункты меню).
 */
interface AssistantUiState {
  open: boolean;
  autoStartVoice: boolean;
  seed?: string;
  openAssistant: (options?: { autoStartVoice?: boolean; seed?: string }) => void;
  closeAssistant: () => void;
}

export const useAssistantUi = create<AssistantUiState>((set) => ({
  open: false,
  autoStartVoice: false,
  seed: undefined,
  openAssistant: (options) =>
    set({ open: true, autoStartVoice: options?.autoStartVoice ?? false, seed: options?.seed }),
  closeAssistant: () => set({ open: false, autoStartVoice: false, seed: undefined }),
}));
