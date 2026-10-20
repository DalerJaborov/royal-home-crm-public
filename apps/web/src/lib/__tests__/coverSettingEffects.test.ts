import { describe, expect, it } from "vitest";
import { coverSettingEffects } from "../coverSettingEffects";

describe("coverSettingEffects — какие настройки обложек действуют в режиме", () => {
  it("ChatGPT пишет весь текст — «Фото на обложке» не действует, варианты действуют", () => {
    const e = coverSettingEffects({ textMode: "MODEL", photoSource: "ORIGINAL", imageModel: "gpt-image-2.5-sunburst" });
    expect(e.photoSourceApplies).toBe(false);
    expect(e.candidatesApplies).toBe(true);
    expect(e.qualityOnlyDigit).toBe(false);
  });

  it("наш текст поверх настоящего фото — варианты не действуют, качество только для цифры, цены нет", () => {
    const e = coverSettingEffects({ textMode: "OVERLAY", photoSource: "ORIGINAL", imageModel: "gpt-image-1" });
    expect(e.photoSourceApplies).toBe(true);
    expect(e.candidatesApplies).toBe(false);
    expect(e.qualityOnlyDigit).toBe(true);
    expect(e.showPerImagePrice).toBe(false);
  });

  it("наш текст поверх перерисовки — действует всё", () => {
    const e = coverSettingEffects({ textMode: "OVERLAY", photoSource: "MODEL", imageModel: "gpt-image-1" });
    expect(e).toEqual({ photoSourceApplies: true, candidatesApplies: true, qualityOnlyDigit: false, showPerImagePrice: true });
  });

  it("цена за картинку показывается только для gpt-image-1 — у моделей 2.x цена по токенам", () => {
    for (const imageModel of ["gpt-image-2.5-sunburst", "gpt-image-2.5-flare", "gpt-image-2"]) {
      expect(coverSettingEffects({ textMode: "MODEL", photoSource: "ORIGINAL", imageModel }).showPerImagePrice).toBe(false);
    }
    expect(coverSettingEffects({ textMode: "MODEL", photoSource: "ORIGINAL", imageModel: "gpt-image-1" }).showPerImagePrice).toBe(true);
  });
});
