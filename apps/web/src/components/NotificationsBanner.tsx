import { useState } from "react";
import { Bell, X } from "lucide-react";
import { usePushNotifications } from "../hooks/usePushNotifications";
import { useInstallPrompt } from "../hooks/useInstallPrompt";
import { Rh2Inline } from "./rh2/Rh2Scope";

/**
 * ПОЧЕМУ БОЛЬШЕ НЕТ TAILWIND-ВЕТКИ (21.09.2026, разбор внешнего вида).
 *
 * До этой правки облик выбирался пропом `rh2`, который AppLayout передавал
 * только на 4 маршрутах из 36 (см. историю компонента) — на остальных 32
 * рисовалась старая Tailwind-вёрстка: на ПК она стояла ВЫШЕ заголовка раздела
 * и съедала ~90px, на телефоне текст ломался в колонку ~140px на восемь строк
 * (кадры `d-finance.png`, `m-clients.png`, `m-lost.png` разбора). Тема к тому
 * моменту уже была ровно одна («Royal Home 2026», CLAUDE.md, слой 4) — второй
 * ветки быть не должно было вовсе.
 *
 * `Rh2Inline` (см. rh2/Rh2Scope.tsx) открывает область темы прямо на месте,
 * не полагаясь на то, обёрнут ли экран-хозяин в `.rh2`/`.scr` — поэтому один
 * и тот же облик работает одинаково на перенесённых и ещё не перенесённых
 * экранах, и держать вторую вёрстку под условие незачем.
 */

const DISMISS_KEY = "royal-home-push-nudge-dismissed-until";

/**
 * Сколько дней молчать после крестика, прежде чем снова напомнить.
 *
 * Раньше крестик прятал баннер НАВСЕГДА (localStorage-флаг без срока) — это и
 * есть основная причина, по которой агенты реально не получают пуши (владелец
 * 31.08.2026, после жалобы «агенты не видят пуш, когда клиент пишет»):
 * человек один раз смахнул подсказку, так и не нажав «Включить», Notification.
 * permission остался "default" — и без повторного напоминания включить
 * уведомления было больше НЕОТКУДА, кроме малозаметного тумблера в Профиле.
 * Тумблер там и остаётся основным путём — баннер лишь не даёт забыть о нём
 * навсегда за один случайный крестик.
 */
const RENUDGE_DAYS = 3;

/**
 * Ненавязчивая подсказка «Включите уведомления» вверху рабочей области.
 * Показывается только когда push реально доступен (браузер поддерживает и на сервере
 * настроены VAPID-ключи), но агент ещё не подписан — тумблер в Профиле неочевиден,
 * а разрешение браузер спрашивает только по клику. «Включить» дёргает subscribe()
 * (браузер попросит разрешение); крестик прячет баннер на RENUDGE_DAYS дней, а не
 * навсегда — см. комментарий у DISMISS_KEY.
 *
 * ОБЛИК. Подсказку монтирует AppLayout, но только на «Главной» (см. комментарий
 * у вызова в AppLayout.tsx) — на остальных 35 маршрутах она не рисуется вовсе,
 * а не подсовывается заново на каждом экране. Разметка — тихая строка `.quiet`
 * в `.card tight` (договор §6.1), обёрнутая в `Rh2Inline`, поэтому облик не
 * зависит от того, перенесён ли сам экран-хозяин на тему.
 */
export function NotificationsBanner() {
  const { status, busy, error, subscribe } = usePushNotifications();
  const { state: installState } = useInstallPrompt();
  const [dismissed, setDismissed] = useState(() => {
    const until = Number(localStorage.getItem(DISMISS_KEY));
    return Number.isFinite(until) && until > Date.now();
  });
  // "unsubscribed" здесь достижим только когда Notification.permission === "default"
  // (permission ещё не спрашивали) — refresh() в usePushNotifications уже пытается
  // молча восстановить подписку, если permission "granted", и переводит в "error"
  // только при настоящей ошибке сети/сервера. "denied" показываем тоже, но с
  // объяснением, а не с кнопкой, которая всё равно не откроет диалог браузера.
  if (dismissed || (status !== "unsubscribed" && status !== "error" && status !== "denied")) return null;

  function hide() {
    localStorage.setItem(DISMISS_KEY, String(Date.now() + RENUDGE_DAYS * 86_400_000));
    setDismissed(true);
  }

  const permissionGranted = typeof Notification !== "undefined" && Notification.permission === "granted";
  // iPhone/iPad, открытый как вкладка браузера: подписки на уведомления в этом
  // случае не существует, сколько ни нажимай «Включить» (см. ветку ниже).
  const iosNeedsInstall = installState === "ios";

  let title = "Включите уведомления";
  let description =
    "Новые заявки, переназначения и непринятые заявки будут приходить сразу, даже когда CRM закрыта.";
  let buttonLabel = "Включить";
  let showButton = true;

  if (iosNeedsInstall) {
    /**
     * НА IPHONE УВЕДОМЛЕНИЯ РАБОТАЮТ ТОЛЬКО У УСТАНОВЛЕННОГО ПРИЛОЖЕНИЯ.
     *
     * Это требование самой iOS (с версии 16.4): в Safari, открытом как обычная
     * вкладка, подписки на уведомления не существует вовсе. Раньше баннер в этом
     * случае предлагал кнопку «Включить», которая молча ничего не делала, — агент
     * жал её, ничего не происходило, и он решал, что уведомления в CRM сломаны.
     * Теперь честно объясняем условие и что для него нужно.
     */
    title = "Уведомления на iPhone: после установки";
    description =
      "Apple разрешает их только приложению с домашнего экрана: «Поделиться» → «На экран „Домой“», потом включите здесь.";
    showButton = false;
  } else if (status === "denied") {
    title = "Уведомления заблокированы браузером";
    description = "Включите их вручную в настройках сайта в браузере (значок замка рядом с адресом).";
    showButton = false;
  } else if (status === "error" && permissionGranted) {
    // Разрешение есть, но тихое восстановление подписки (см. usePushNotifications)
    // не удалось из-за реальной ошибки — не предлагаем "Включить" (это подразумевало
    // бы повторный запрос разрешения), а просто даём повторить попытку.
    title = "Не удалось обновить уведомления";
    description = error ? `Попробуйте ещё раз: ${error}.` : "Попробуйте ещё раз.";
    buttonLabel = "Повторить";
  } else if (status === "error" && error) {
    description = `Не получилось: ${error}. Попробуйте ещё раз.`;
  }

  /**
   * НА ТЕЛЕФОНЕ БАННЕР ЖИВЁТ В ОДНУ СТРОКУ.
   *
   * `Rh2Inline`/`.card.tight` + `.quiet` — та же строчная карточка темы, что и
   * у других тихих подсказок (см. CallbackRequestsBanner, OwnerQuestionsStrip).
   * `.quiet .txt` — `flex:1;min-width:0;text-wrap:pretty` (theme-2026-proto.css)
   * — заголовок и пояснение переносятся по словам внутри своей ширины, а не
   * сжимаются в колонку ~140px на восемь строк, как ломалась прежняя
   * Tailwind-вёрстка (кадры `m-clients.png`, `m-lost.png` разбора 20.09.2026).
   *
   * Убирать баннер целиком нельзя: без уведомлений агент не узнаёт о новой
   * заявке, и это единственное место, где о выключенных уведомлениях вообще
   * говорится. Кнопку «Включить» не прячем ни при каких условиях: разрешение
   * браузер даёт только по нажатию.
   */
  return (
    <Rh2Inline>
      <div className="card tight" style={{ marginBottom: 16 }}>
        <div className="quiet">
          <Bell className="i" />
          <span className="txt">
            <b>{title}</b> {description}
          </span>
          {showButton && (
            <button className="pill ghost sm" type="button" onClick={() => subscribe()} disabled={busy}>
              {busy ? "Включаем…" : buttonLabel}
            </button>
          )}
          <button className="pill ghost icon" type="button" onClick={hide} aria-label="Скрыть подсказку про уведомления">
            <X className="i" />
          </button>
        </div>
      </div>
    </Rh2Inline>
  );
}
