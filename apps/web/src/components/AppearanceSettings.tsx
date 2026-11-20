import type { TextSizeId } from "@royal-home/shared";
import { THEMES, DEFAULT_THEME } from "../lib/themes";
import { useUiPrefs } from "../store/uiPrefs";
import { ProtoToggle } from "./ProtoToggle";
import { Segment } from "./rh2/Segment";
import { useRoyalLookAttr } from "./look/team/useRoyalLookAttr";

/** «Размер текста» нового вида: один множитель на всю шкалу шрифта (theme-look-royal.css). */
export const TEXT_SIZE_OPTIONS = [
  { id: "normal", label: "Обычный" },
  { id: "large", label: "Крупный" },
  { id: "xlarge", label: "Очень крупный" },
] as const satisfies readonly { id: TextSizeId; label: string }[];

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
  const textSize = useUiPrefs((s) => s.textSize);
  const setTextSize = useUiPrefs((s) => s.setTextSize);
  // Размер текста действует только в новом виде (шкала --rh-fs-*), в старом его не показываем.
  const royal = useRoyalLookAttr();

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

      {royal && (
        <div className="mod" data-text-size-setting="">
          <div className="t">
            <b>Размер текста</b>
            <span>Крупнее — читать легче. Действует на этом устройстве и в вашем профиле.</span>
          </div>
          <div className="acts">
            <Segment options={TEXT_SIZE_OPTIONS} value={textSize ?? "normal"} onChange={setTextSize} aria-label="Размер текста" />
          </div>
        </div>
      )}

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
