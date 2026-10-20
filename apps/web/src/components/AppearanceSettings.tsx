import { THEMES, DEFAULT_THEME } from "../lib/themes";
import { useUiPrefs } from "../store/uiPrefs";
import { ProtoToggle } from "./ProtoToggle";

/**
 * Профиль → «Вид приложения»: режим темы и декоративные эффекты.
 *
 * ОБЛИК: блок «Вид приложения» прототипа темы «Royal Home 2026»
 * (docs/pult/theme-2026/screens/profile.html): `.card` + `.sec-h.stack`,
 * выбор режима плитками `.modes` с образцом `.sw2`, строка «Сохранено»
 * классом `.saved.on`.
 *
 * Режим «Как в системе» в прототипе третьей плиткой, но в приложении такого
 * значения нет: uiPrefs хранит конкретную тему (см. lib/themes.ts), и рисовать
 * плитку, которая ничего не переключает, нельзя. Плитки две, обе живые.
 *
 * Тумблер «Звуки уведомлений» прототип не рисует, но экран это умеет, и
 * терять нельзя: одет в те же `.mod` и `.tgl`, что остальные настройки профиля.
 */
export function AppearanceSettings() {
  const theme = useUiPrefs((s) => s.theme);
  const aurora = useUiPrefs((s) => s.aurora);
  const glass = useUiPrefs((s) => s.glass);
  const aiSoundsEnabled = useUiPrefs((s) => s.aiSoundsEnabled);
  const setTheme = useUiPrefs((s) => s.setTheme);
  const setAurora = useUiPrefs((s) => s.setAurora);
  const setGlass = useUiPrefs((s) => s.setGlass);
  const setAiSoundsEnabled = useUiPrefs((s) => s.setAiSoundsEnabled);

  const current = THEMES.find((t) => t.id === theme) ?? THEMES.find((t) => t.id === DEFAULT_THEME)!;

  function pickTheme(dark: boolean) {
    const target = THEMES.find((t) => t.isDark === dark);
    if (target) setTheme(target.id);
  }

  return (
    <section className="card">
      <div className="sec-h stack">
        <h2>Вид приложения</h2>
        <span className="note">Тема одна: Royal Home 2026. Выбирается только режим</span>
      </div>

      <div className="modes" role="group" aria-label="Режим темы">
        <button type="button" aria-pressed={!current.isDark} onClick={() => pickTheme(false)}>
          <span className="sw2" aria-hidden="true">
            <i className="l" />
            <i className="l" />
          </span>
          <b>Светлая</b>
        </button>
        <button type="button" aria-pressed={current.isDark} onClick={() => pickTheme(true)}>
          <span className="sw2" aria-hidden="true">
            <i className="d" />
            <i className="d" />
          </span>
          <b>Тёмная</b>
        </button>
      </div>
      <p className="saved on" style={{ marginTop: 12 }}>
        Сохраняется сразу, отдельной кнопки нет
      </p>

      <div className="mod">
        <div className="t">
          <b>Аврора-фон</b>
          <span>Мягкое цветное поле по краям экрана.</span>
        </div>
        <div className="acts">
          <ProtoToggle on={aurora} label="Аврора-фон" onToggle={setAurora} />
        </div>
      </div>

      <div className="mod">
        <div className="t">
          <b>Эффект стекла</b>
          <span>Полупрозрачные панели с размытием. Отключите, если устройство подтормаживает.</span>
        </div>
        <div className="acts">
          <ProtoToggle on={glass} label="Эффект стекла" onToggle={setGlass} />
        </div>
      </div>

      <div className="mod">
        <div className="t">
          <b>Звуки уведомлений</b>
          <span>Мягкие тона на новый лид, сообщение, звонок, сохранение и ошибку.</span>
        </div>
        <div className="acts">
          <ProtoToggle on={aiSoundsEnabled} label="Звуки уведомлений" onToggle={setAiSoundsEnabled} />
        </div>
      </div>
    </section>
  );
}
