import { useEffect, useState } from "react";

/** Chrome/Edge/Android дают событие beforeinstallprompt — его можно отложить и
 * показать собственную кнопку «Установить». iOS Safari события не даёт вообще —
 * там остаётся только инструкция «Поделиться → На экран „Домой"». */
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

let deferredPrompt: BeforeInstallPromptEvent | null = null;
// Событие прилетает один раз при загрузке, часто ДО монтирования React-компонентов —
// ловим на уровне модуля, чтобы не потерять.
if (typeof window !== "undefined") {
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferredPrompt = e as BeforeInstallPromptEvent;
    window.dispatchEvent(new Event("pwa-install-available"));
  });
  window.addEventListener("appinstalled", () => {
    deferredPrompt = null;
    window.dispatchEvent(new Event("pwa-install-available"));
  });
}

export type InstallState =
  | "installed" // уже запущено как приложение
  | "available" // можно показать системный диалог установки
  | "ios" // iOS: только инструкция
  | "unavailable"; // браузер не даёт события (или уже установлено, но открыто в браузере)

function isStandalone() {
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    (navigator as { standalone?: boolean }).standalone === true
  );
}

function isIos() {
  if (/iphone|ipad|ipod/i.test(navigator.userAgent)) return true;
  // iPad с iPadOS 13 и новее представляется настольным Safari на Macintosh —
  // по строке браузера его не отличить. Единственный надёжный признак: «Мак» с
  // сенсорным экраном, которых не бывает. Без этой проверки владелец iPad не видел
  // подсказку об установке никогда: события beforeinstallprompt в Safari нет, а
  // ветка «ios» не срабатывала.
  return /Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1;
}

export function useInstallPrompt() {
  const [, force] = useState(0);

  useEffect(() => {
    const rerender = () => force((n) => n + 1);
    window.addEventListener("pwa-install-available", rerender);
    return () => window.removeEventListener("pwa-install-available", rerender);
  }, []);

  const state: InstallState = isStandalone()
    ? "installed"
    : deferredPrompt
      ? "available"
      : isIos()
        ? "ios"
        : "unavailable";

  async function install() {
    if (!deferredPrompt) return;
    await deferredPrompt.prompt();
    await deferredPrompt.userChoice;
    deferredPrompt = null;
    force((n) => n + 1);
  }

  return { state, install };
}
