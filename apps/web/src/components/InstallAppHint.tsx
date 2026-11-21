import { useEffect, useState } from "react";
import { Download, Share } from "lucide-react";
import { useInstallPrompt } from "../hooks/useInstallPrompt";
import { useUiPrefs } from "../store/uiPrefs";
import { useRoyalLook } from "../hooks/useRoyalLook";
import { Rh2Inline } from "./rh2/Rh2Scope";
import {
  iosCanAddToHome, installHintShownBefore, installVisitCount, markInstallHintShown, shouldOfferInstall,
} from "../lib/installHint";

/**
 * Предложение поставить CRM на домашний экран.
 *
 * ЗАЧЕМ. Приложение и так умеет устанавливаться (это PWA), но узнать об этом
 * можно было единственным способом — забраться в Профиль и найти там кнопку.
 * Установленная CRM запускается со своим значком, без адресной строки и на весь экран.
 *
 * КОГДА. Решает lib/installHint.ts: третий заход и позже, только на телефоне, только когда установка
 * реально возможна (системный диалог готов либо iPhone-браузер с «На экран „Домой"»), ОДИН раз на
 * устройстве. «Не сейчас» запоминается навсегда; установить можно и позже из Профиля.
 *
 * ГДЕ. Строкой в самом экране «Главная» (AppLayout), а не плавающим слоем: прежняя плашка висела над
 * нижним меню и закрывала низ каждого экрана телефона (аудит К06.1, 21.11.2026).
 */

const HINT_ID = "install-app";

export function InstallAppHint() {
  const { state, install } = useInstallPrompt();
  const dismissedHints = useUiPrefs((s) => s.dismissedHints);
  const dismissHint = useUiPrefs((s) => s.dismissHint);
  const [visits] = useState(installVisitCount);
  // Читается один раз за загрузку: в заходе, где подсказка показана, она остаётся на месте до его конца.
  const [shownBefore] = useState(installHintShownBefore);
  const [narrow, setNarrow] = useState(() => window.matchMedia("(max-width: 819px)").matches);
  const [showIosSteps, setShowIosSteps] = useState(false);
  const royal = useRoyalLook();

  useEffect(() => {
    const mq = window.matchMedia("(max-width: 819px)");
    const onChange = (e: MediaQueryListEvent) => setNarrow(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  const offer = shouldOfferInstall({
    narrow, state, visits, shownBefore,
    iosCanAdd: iosCanAddToHome(navigator.userAgent),
    dismissed: dismissedHints.includes(HINT_ID),
  });
  useEffect(() => { if (offer) markInstallHintShown(); }, [offer]);
  if (!offer) return null;

  const goLabel = state === "ios" ? (showIosSteps ? "Понятно" : "Как") : "Установить";
  const onGo = () => (state === "ios" ? setShowIosSteps((v) => !v) : void install());

  /**
   * «НОВЫЙ ВИД» — ОДНОЙ СТРОКОЙ В ЭКРАНЕ. Значок, «Поставьте CRM на экран», действие и «Не сейчас».
   * Шаги для iPhone раскрываются по «Как» той же карточкой.
   */
  if (royal) {
    return (
      <Rh2Inline className="ry-install-hint md:hidden">
        <div className="ry-install-card" role="region" aria-label="Установка CRM на экран телефона">
          {state === "ios" && showIosSteps && (
            <ol className="ry-install-steps">
              <li><Share className="i" aria-hidden />Нажмите «Поделиться» внизу браузера</li>
              <li>Выберите «На экран „Домой"»</li>
              <li>Нажмите «Добавить», значок появится на экране</li>
            </ol>
          )}
          <div className="ry-install-row">
            <Download className="i" aria-hidden />
            <b>Поставьте CRM на экран</b>
            <button type="button" className="ry-install-go" onClick={onGo}>{goLabel}</button>
            <button type="button" className="ry-install-x" onClick={() => dismissHint(HINT_ID)}>Не сейчас</button>
          </div>
        </div>
      </Rh2Inline>
    );
  }

  return (
    // Облик — карточка `.card.tight` эталона со строкой `.mod` (значок, текст) и кнопками `.pill`.
    // Подсказка живёт в рамке приложения, вне области темы экрана, поэтому открывает область сама.
    <div data-install-hint className="md:hidden">
      <Rh2Inline>
        <div className="card tight">
          <div className="mod" style={{ padding: 0, borderBottom: 0 }}>
            <span className="call" aria-hidden>
              <Download className="i" />
            </span>
            <div className="t">
              <b>Поставьте CRM на экран телефона</b>
              <span>Откроется со своим значком и на весь экран, без адресной строки браузера.</span>
            </div>
          </div>

          {/* На iPhone системного диалога установки не существует — Safari его не даёт.
              Единственный путь: «Поделиться» → «На экран „Домой"». Поэтому здесь не
              кнопка-обманка, а показ трёх шагов. */}
          {state === "ios" && showIosSteps && (
            <div className="list">
              <p className="quiet">
                <Share className="i" />
                <span className="txt">Нажмите «Поделиться» внизу браузера</span>
              </p>
              <p className="quiet">
                <span className="txt">Выберите «На экран „Домой"»</span>
              </p>
              <p className="quiet">
                <span className="txt">Нажмите «Добавить», значок появится на экране</span>
              </p>
            </div>
          )}

          <div className="sheet-f" style={{ padding: "12px 0 0", borderTop: 0 }}>
            <button type="button" onClick={() => dismissHint(HINT_ID)} className="pill ghost">Не сейчас</button>
            <button type="button" onClick={onGo} className="pill" style={{ flex: 1 }}>
              {state === "ios" ? (showIosSteps ? "Понятно" : "Показать, как") : "Установить"}
            </button>
          </div>
        </div>
      </Rh2Inline>
    </div>
  );
}
