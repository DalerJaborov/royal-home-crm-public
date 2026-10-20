import { useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { signOut } from "../lib/signOut";
import { isBusy } from "../lib/workGuard";
import { useAuthStore } from "../store/auth";
import { idleActivityKey, readIdleActivity } from "../lib/idleActivity";
import { useUiPrefs } from "../store/uiPrefs";

/** Метка последней активности в localStorage — общая для всех вкладок CRM,
 * переживает перезагрузку: вернулся через 2 часа при лимите 30 минут — выход сразу. */
const CHECK_INTERVAL_MS = 30_000;
/**
 * Что считается «человек работает». Список расширен 19.09.2026: раньше в нём
 * были только нажатия (`pointerdown`, `keydown`, `wheel`, `touchstart`), и
 * этого мало. Агент читает карточку клиента, слушает запись разговора, ведёт
 * по ней пальцем, смотрит карту — с точки зрения прежнего списка он бездействует,
 * и CRM молча выкидывала его посреди работы. Прокрутка и движение указателя —
 * такая же работа, как нажатие; запись метки всё равно троттлится до раза в
 * пять секунд (см. onActivity ниже), так что цена нулевая.
 */
const ACTIVITY_EVENTS = ["pointerdown", "pointermove", "keydown", "wheel", "touchstart", "touchmove", "scroll"] as const;

/**
 * Автовыход при неактивности. Лимит — личная настройка (Профиль → Безопасность),
 * null = «никогда» (по умолчанию, прежнее поведение). Монтируется в AppLayout,
 * т.е. работает только внутри авторизованной части приложения.
 */
export function useIdleLogout() {
  const minutes = useUiPrefs((s) => s.autoLogoutMinutes);
  const navigate = useNavigate();
  const actorId = useAuthStore(s => s.agent?.id);
  const hydrated = useUiPrefs((s) => s.serverHydrated);
  // The stamp is not refreshed while the limit is off, so switching it back on would
  // read an hours-old stamp and sign out at once. Only a change the person made after
  // hydration counts; a reopened session keeps its existing deadline.
  const previous = useRef({ minutes, hydrated });

  useEffect(() => {
    const switchedOn = previous.current.hydrated && !previous.current.minutes && !!minutes;
    previous.current = { minutes, hydrated };
    if (!minutes || !actorId) return;
    const limitMs = minutes * 60_000;

    let lastActivity = switchedOn ? Date.now() : readIdleActivity(actorId, Date.now());
    let signingOut = false;
    const touch = () => {
      lastActivity = Date.now();
      try { localStorage.setItem(idleActivityKey(actorId), String(lastActivity)); }
      catch { /* In-memory deadline still works without storage. */ }
    };

    const check = () => {
      if (signingOut) return;
      const last = lastActivity = readIdleActivity(actorId, Date.now(), lastActivity);
      if (Date.now() - last >= limitMs) {
        // Идёт загрузка файлов (lib/workGuard.ts): выход оборвал бы её, а токен
        // файлов уже не обновился бы. Сама загрузка — работа, а не бездействие.
        if (isBusy()) return;
        // Тот же общий выход, что по кнопке (lib/signOut): гасит cookie, снимает
        // push-подписку устройства и чистит состояние. Автовыход по бездействию —
        // ровно тот случай, ради которого правится утечка: телефон лежит без
        // присмотра, а уведомления с именем клиента продолжали приходить.
        signingOut = true;
        void signOut();
        navigate("/login");
      }
    };

    if (switchedOn) touch();
    check();
    if (signingOut) return;

    // Троттлинг записи: активность обновляем не чаще раза в 5 секунд — не дёргаем localStorage на каждый скролл.
    let lastTouch = 0;
    const onActivity = () => {
      const now = Date.now();
      if (now - lastTouch > 5_000) {
        lastTouch = now;
        touch();
      }
    };

    // capture: true — прокрутка НЕ всплывает. На компьютере едет внутренний div
    // оболочки (см. AppLayout), и без перехвата на фазе погружения событие
    // `scroll` до window не доходит вовсе, то есть длинный список читался бы
    // как бездействие.
    for (const ev of ACTIVITY_EVENTS) window.addEventListener(ev, onActivity, { passive: true, capture: true });
    const timer = setInterval(check, CHECK_INTERVAL_MS);
    // Вкладку развернули после долгого сна — проверяем немедленно, не ждём тика.
    const onVisible = () => {
      if (document.visibilityState === "visible") check();
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      for (const ev of ACTIVITY_EVENTS) window.removeEventListener(ev, onActivity, { capture: true });
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [minutes, hydrated, navigate, actorId]);
}
