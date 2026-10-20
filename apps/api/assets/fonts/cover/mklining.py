# Производная PlayfairDisplay-Bold с ТАБЛИЧНО-ПРОПИСНЫМИ (lining) цифрами по умолчанию.
# librsvg не применяет font-feature-settings 'lnum', а в Playfair по умолчанию
# старостильные цифры (у «9» хвост вниз, «0» ниже заглавных) — у эталона
# royal-green (28.09.2026) цифры прописные. Имя семейства своё, чтобы не
# путать с оригиналом (OFL 1.1 разрешает изменённые версии; RFN не объявлено).
# Запуск: cd apps/api/assets/fonts/cover && python mklining.py
from fontTools.ttLib import TTFont
f = TTFont("PlayfairDisplay-Bold.ttf")
names = {"zero":"zero.lf","one":"one.lf","two":"two.lf","three":"three.lf","four":"four.lf",
         "five":"five.lf","six":"six.lf","seven":"seven.lf","eight":"eight.lf","nine":"nine.lf"}
for t in f["cmap"].tables:
    for cp, g in list(t.cmap.items()):
        if g in names: t.cmap[cp] = names[g]
fam = "RH Playfair Lining"
for r in f["name"].names:
    if r.nameID in (1, 16): r.string = fam
    elif r.nameID == 4: r.string = fam + " Bold"
    elif r.nameID == 6: r.string = "RHPlayfairLining-Bold"
    elif r.nameID == 3: r.string = "RHPlayfairLining-Bold;royal-green"
f.save("RHPlayfairLining-Bold.ttf")
