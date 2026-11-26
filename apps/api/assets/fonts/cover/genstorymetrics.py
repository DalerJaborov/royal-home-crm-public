"""Генератор src/lib/video/storyMetrics.ts: ширины глифов Onest Medium/SemiBold (в 1/1000 em).

Нужны карточке-истории (lib/video/storyCard.ts), чтобы считать ширину строки ДО отрисовки —
librsvg метрики наружу не отдаёт. Запуск (из apps/api): python assets/fonts/cover/genstorymetrics.py
"""
from fontTools.ttLib import TTFont
import json, pathlib

here = pathlib.Path(__file__).parent
chars = [chr(c) for c in range(32, 127)]
chars += [chr(c) for c in range(0x410, 0x450)] + ["Ё", "ё", "Ғ", "ғ", "Ӣ", "ӣ", "Қ", "қ", "Ӯ", "ӯ", "Ҳ", "ҳ", "Ҷ", "ҷ"]
chars += ["№", "²", "·", "−", "—", "–", "…", "«", "»", " ", " "]
out = {}
for key, fname in (("Medium", "Onest-Medium.ttf"), ("SemiBold", "Onest-SemiBold.ttf")):
    f = TTFont(here / fname)
    cmap = f.getBestCmap()
    hmtx = f["hmtx"]
    upm = f["head"].unitsPerEm
    out[key] = {c: round(hmtx[cmap[ord(c)]][0] * 1000 / upm) for c in chars if ord(c) in cmap}
    if key == "SemiBold":
        os2 = f["OS/2"]
        cap = round(os2.sCapHeight * 1000 / upm)
        xh = round(os2.sxHeight * 1000 / upm)
body = json.dumps(out, ensure_ascii=False, separators=(",", ":"))
target = here.parent.parent.parent / "src" / "lib" / "video" / "storyMetrics.ts"
target.write_text(
    "/* СГЕНЕРИРОВАНО assets/fonts/cover/genstorymetrics.py — руками не править. */\n"
    f"export const STORY_CAP_HEIGHT = {cap / 1000};\n"
    f"export const STORY_X_HEIGHT = {xh / 1000};\n"
    "export type StoryFontWeight = \"Medium\" | \"SemiBold\";\n"
    f"export const STORY_ADVANCE: Record<StoryFontWeight, Record<string, number>> = {body};\n",
    encoding="utf-8",
    newline="\n",
)
print("written", target, "cap", cap, "xh", xh)
