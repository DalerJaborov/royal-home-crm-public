/**
 * КАКИЕ НАСТРОЙКИ ОБЛОЖЕК ДЕЙСТВУЮТ ПРИ ВЫБРАННОМ РЕЖИМЕ (28.09.2026).
 *
 * Экран «Обложки для соцсетей» показывал все переключатели всегда, а сервер
 * (apps/api/src/lib/video/coverOpenAi.ts, выбор `bestOf`) часть из них в
 * некоторых режимах не читает вовсе:
 *   - «ChatGPT — весь дизайн и текст» (MODEL) — фото всегда перерисовывает
 *     ChatGPT, выбор «Фото на обложке» не читается (`bestOfModel`);
 *   - «Мы — точный текст поверх» + настоящее фото — картинку обложки ChatGPT
 *     не рисует совсем (`bestOfOriginal`): «Вариантов на картинку» не читается,
 *     а качество влияет только на разовую золотую цифру комнат (она рисуется
 *     один раз на цифру и дальше берётся из кэша).
 * Владелец менял переключатель — сохранялось, а на обложке ничего не менялось.
 * Сохранённые значения этим не трогаются: экран только честно говорит, что
 * сейчас не действует.
 *
 * Цены чипов качества — прайс gpt-image-1 за картинку. У моделей 2.x цена
 * считается по токенам, и таблицы «за картинку» у нас для них нет, поэтому
 * для них цену не выдумываем.
 */
type TextMode = "OVERLAY" | "MODEL";
type PhotoSource = "ORIGINAL" | "MODEL";

export interface CoverSettingEffects {
  /** Читается ли «Фото на обложке». */
  photoSourceApplies: boolean;
  /** Читается ли «Вариантов на картинку». */
  candidatesApplies: boolean;
  /** Качество влияет только на разовую цифру комнат (фото не перерисовывается). */
  qualityOnlyDigit: boolean;
  /** Можно ли показывать цену за обложку по прайсу gpt-image-1. */
  showPerImagePrice: boolean;
}

export function coverSettingEffects(s: {
  textMode: TextMode;
  photoSource: PhotoSource;
  imageModel: string;
}): CoverSettingEffects {
  const originalOverlay = s.textMode === "OVERLAY" && s.photoSource === "ORIGINAL";
  return {
    photoSourceApplies: s.textMode === "OVERLAY",
    candidatesApplies: !originalOverlay,
    qualityOnlyDigit: originalOverlay,
    showPerImagePrice: !originalOverlay && s.imageModel === "gpt-image-1",
  };
}
