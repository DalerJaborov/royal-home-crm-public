# Пересборка src/lib/video/coverMetrics.ts из файлов шрифта этой папки.
# Запуск из apps/api/assets/fonts/cover:
#   PYTHONIOENCODING=utf-8 python genmetrics.py > ../../../src/lib/video/coverMetrics.ts
from fontTools.ttLib import TTFont
import json
chars=" 0123456789"+"".join(chr(c) for c in range(0x410,0x450))+"ЁёҒғӢӣҚқӮӯҲҳҶҷ"+"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"+":,.-–—()/«»\"'²№+&!?"
def ink(f,cm,ch):
  from fontTools.pens.boundsPen import BoundsPen
  bp=BoundsPen(f.getGlyphSet()); f.getGlyphSet()[cm[ord(ch)]].draw(bp); return bp.bounds

out={}
cap=xh=sup=None
for w in ["Medium","ExtraBold"]:
  f=TTFont(f"TTNormsPro-{w}.ttf"); cm=f.getBestCmap(); hm=f["hmtx"]; upm=f["head"].unitsPerEm
  out[w]={c:round(hm[cm[ord(c)]][0]*1000/upm) for c in chars if ord(c) in cm}
  cap=f["OS/2"].sCapHeight/upm
  # Высота строчной («м») и надстрочного («²») — по РЕАЛЬНОМУ контуру глифа, а не
  # по высоте заглавной: у «м» это x-height, у «²» — его собственный рост над
  # базовой линией. Считать их через cap-height значит промахнуться вдвое.
  xh=f["OS/2"].sxHeight/upm
  b=ink(f,cm,"²"); sup=(b[3]-b[1])/upm
# Серифный «RH Playfair Lining» (royal-green, 28.09.2026): цифра комнат, ХОНАГА, цена, TJS.
f=TTFont("RHPlayfairLining-Bold.ttf"); cm=f.getBestCmap(); hm=f["hmtx"]; upm=f["head"].unitsPerEm
out["SerifBold"]={c:round(hm[cm[ord(c)]][0]*1000/upm) for c in chars if ord(c) in cm}
serif_cap=f["OS/2"].sCapHeight/upm
print("// АВТОГЕНЕРАЦИЯ из apps/api/assets/fonts/cover/TTNormsPro-*.ttf (hmtx, единицы на 1000 кегля).")
print("// Нужны шаблону обложки (coverTemplate.ts), чтобы считать ширину строк ДО рендера:")
print("// librsvg не отдаёт метрики текста наружу, а плашка цены и нижний ряд строятся по ширине.")
print("// Пересобрать после замены файлов шрифта — скрипт в assets/fonts/cover/README.md.")
print(f"export const COVER_CAP_HEIGHT = {cap:.3f};")
print("/** Высота строчной буквы («м» в «90 м²») — доля кегля. */")
print(f"export const COVER_X_HEIGHT = {xh:.3f};")
print("/** Высота глифа «²» — доля кегля; у надстрочного она своя, много меньше заглавной. */")
print(f"export const COVER_SUP_HEIGHT = {sup:.3f};")
print("/** Высота прописных серифного «RH Playfair Lining» — доля кегля. */")
print(f"export const COVER_SERIF_CAP_HEIGHT = {serif_cap:.3f};")
print("export type CoverMetricsWeight = \"Medium\" | \"ExtraBold\" | \"SerifBold\";")
print("export const COVER_ADVANCE: Record<CoverMetricsWeight, Record<string, number>> = "+json.dumps(out,ensure_ascii=False)+";")
