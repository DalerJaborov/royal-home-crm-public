import { useEffect, useState } from "react";
import { Download, Share, X } from "lucide-react";
import { useInstallPrompt } from "../hooks/useInstallPrompt";
import { useUiPrefs } from "../store/uiPrefs";
import { Rh2Inline } from "./rh2/Rh2Scope";

/**
 * Предложение поставить CRM на домашний экран.
 *
 * ЗАЧЕМ. Приложение и так умеет устанавливаться (это PWA), но узнать об этом
 * можно было единственным способом — забраться в Профиль и найти там кнопку.
 * Никто из агентов туда не забирался. Установленная CRM запускается со своим
 * значком, без адресной строки и на весь экран — то есть перестаёт быть
 * «сайтом, открытым в браузере», а именно так ей и пользуются весь день.
 *
 * КОГДА ПОКАЗЫВАЕМ. На третий заход и только на телефоне. Первый заход человек
 * осматривается, второй — работает; предлагать установку раньше — всё равно что
 * звать в гости на улице. Отказ запоминается навсегда: второй раз не спросим.
 *
 * ГДЕ. Над нижним меню, не перекрывая его и не блокируя работу: подсказка, а не
 * требование. Закрывается крестиком.
 */

const VISITS_KEY = "rh-visit-count";
const HINT_ID = "install-app";
/** Раньше третьего захода не предлагаем. */
const MIN_VISITS = 3;

/** Считает заходы: один раз за загрузку приложения. */
function bumpVisits(): number {
  const n = Number(localStorage.getItem(VISITS_KEY) || "0") + 1;
  localStorage.setItem(VISITS_KEY, String(n));
  return n;
}

export function InstallAppHint() {
  const { state, install } = useInstallPrompt();
  const dismissedHints = useUiPrefs((s) => s.dismissedHints);
  const dismissHint = useUiPrefs((s) => s.dismissHint);
  const [visits] = useState(bumpVisits);
  const [narrow, setNarrow] = useState(() => window.matchMedia("(max-width: 819px)").matches);
  const [showIosSteps, setShowIosSteps] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia("(max-width: 819px)");
    const onChange = (e: MediaQueryListEvent) => setNarrow(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  const canOffer = state === "available" || state === "ios";
  if (!narrow || !canOffer || visits < MIN_VISITS || dismissedHints.includes(HINT_ID)) return null;

  return (
    // 152px = 84 (нижнее меню) + 56 (высота круглой кнопки ассистента) + 12 зазора.
    // Раньше подсказка стояла на тех же 84px, что и кнопка ассистента, и та —
    // будучи выше по слою (z-40 против z-30) — закрывала собой правый угол
    // подсказки вместе с кнопкой «Установить». Ставим подсказку НАД кнопкой.
    //
    // Облик — карточка `.card.tight` эталона со строкой `.mod` (значок, текст,
    // действия) и кнопкой `.pill`. Подсказка живёт в рамке приложения, вне
    // области темы экрана, поэтому открывает область сама (см. Rh2Scope.tsx).
    <Rh2Inline className="fixed inset-x-0 bottom-[calc(152px+env(safe-area-inset-bottom))] z-30 px-3 md:hidden">
      <div className="card tight">
        <div className="mod" style={{ padding: 0, borderBottom: 0 }}>
          <span className="call" aria-hidden>
            <Download className="i" />
          </span>
          <div className="t">
            <b>Поставьте CRM на экран телефона</b>
            <span>Откроется со своим значком и на весь экран, без адресной строки браузера.</span>
          </div>
          <div className="acts">
            <button
              type="button"
              onClick={() => dismissHint(HINT_ID)}
              aria-label="Больше не предлагать"
              className="call"
            >
              <X className="i" />
            </button>
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
          <button
            type="button"
            onClick={() => (state === "ios" ? setShowIosSteps(true) : void install())}
            className="pill"
            style={{ flex: 1 }}
          >
            {state === "ios" ? (showIosSteps ? "Понятно" : "Показать, как") : "Установить"}
          </button>
        </div>
      </div>
    </Rh2Inline>
  );
}
