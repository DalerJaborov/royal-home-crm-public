# Переносит стили артефакта «Мастер объекта Royal Home» в приложение ДОСЛОВНО,
# ограничивая их областью `.rh2 .wiz`, — так имена макета (.blk, .row, .chip,
# .tile, .ghost, .f) не сталкиваются ни с классами приложения, ни с уже
# перенесёнными стилями пульта (`.rh2 …` в theme-2026-proto.css) и мобильной
# главной (`.rh2 .mh …` в theme-2026-mobile-home.css).
#
#   python scripts/sync-wizard-css.py \
#       docs/pult/theme-2026/artifact-wizard-property-15-09.html \
#       apps/web/src/theme-2026-wizard.css
#
# Источник — ОДИН html-файл артефакта. В нём два блока <style>:
#   1) три строки сброса страницы-обёртки claude.ai (не переносится, в нём нет
#      ни одного класса мастера — отличается от sync-mobile-css.py, где оба
#      блока приходилось различать по содержимому: здесь блок ровно один);
#   2) сами стили мастера и демо-страницы артефакта вокруг него.
# Берётся ТОЛЬКО второй.
#
# ПОЧЕМУ ОБЛАСТЬ ИЗ ДВУХ КЛАССОВ, А НЕ ОДНОГО. Ровно то же рассуждение, что в
# шапке sync-mobile-css.py: `.rh2.wiz X` дало бы силу (0,3,0), совпадающую с
# `.rh2 .scr X` пульта, и порядок @import в index.css начал бы решать исход
# конфликтов вместо явной вложенности. `.rh2 .wiz X` — тоже (0,3,0), но экран
# мастера никогда не вложен ни в `.mh`, ни в `.scr`, так что пересечения нет
# вовсе. Обёртка поэтому ДВУХУРОВНЕВАЯ: <div class="rh2"><div class="wiz">.
# Потомковый селектор требует двух РАЗНЫХ предков — одного `<div class="rh2
# wiz">` мало, он даёт классу мастера ту же специфичность, что и классу пульта
# на том же элементе, и совпадающие имена (`.chip`, `.f`, `.row`) снова решает
# порядок файлов, а не структура разметки.
#
# Преобразования:
#   :root{...}                         -> .rh2 .wiz{...}
#   :root[data-theme=dark] X           -> html[data-theme="royal-home-2026-night"] .rh2 .wiz X
#   @media (prefers-color-scheme:dark) -> тот же ночной селектор, без медиазапроса
#                                         (тема выбирается тумблером приложения)
#   html / body / html,body            -> .rh2 .wiz (страница у приложения своя)
#   обычный селектор                   -> .rh2 .wiz <селектор>
#   @font-face                         -> выбрасывается (Manrope/Onest уже
#                                         подключены в fonts-royal-home-2026.css;
#                                         ссылка артефакта на fonts.googleapis.com
#                                         лежит вне <style>, скрипт её вообще не
#                                         читает — она просто не копируется вместе
#                                         с остальной html-разметкой)
#   @keyframes                         -> без изменений
#
# ВЫБРОШЕНО ЦЕЛИКОМ — демонстрационная обвязка страницы артефакта, не мастер:
#   .wrap, .top (шапка СТРАНИЦЫ артефакта — «Добавить объект», не путать с
#                .whead, это шапка самого мастера, она остаётся), .eyebrow,
#   .split, .stage, .phone, .screen, .notch, .caption — рамка телефона 344x652
#   и подпись под ней;
#   .col, .tabs, .pane, .qa, .tblwrap, .tbl, .todo, .note — правая колонка
#   «разбора» (вкладки Тип/Адрес/Видео/К работе, таблица сравнения справочников,
#   список из 10 правок) — это объяснение владельца для читателя артефакта,
#   в приложении такой колонки нет и не будет.
# У приложения своя оболочка экрана (AppLayout/полноэкранный контейнер мастера,
# делает другой исполнитель), поэтому демо-рамка и разбор карте не нужны.
#
# ОСТАВЛЕНО — сам мастер и всё, что внутри него: .whead, .line1, .ttl, .sub,
# .mode, .xbtn, .bars, .wbody, .blk, .head, .ghost, .tiles, .tile, .ring, .tick,
# .vrow, .chip, .grid2, .f, .segs, .map (и все селекторы `.map …` внутри неё:
# .roads, .blk2, .pin, .msearch, .near, .scale, .zoom, .gps), .sugg, .tag,
# .empty, .rev, .calc, .dup, .draft, .done-card, .wfoot, .sheet, .scrim, .panel,
# .pick2, @keyframes (blip, rise).
#
# Шрифты не переносятся: Manrope и Onest уже подключены в
# fonts-royal-home-2026.css — второй раз их не грузим.
#
# ЧЕГО СКРИПТ НЕ ДЕЛАЕТ. Не переименовывает @keyframes. В артефакте их два:
# `blip` (доезд фото до 100%) и `rise` (появление нижней шторки выбора типа
# объекта). Ни того, ни другого имени нет в других файлах темы (проверено
# `grep -o "@keyframes [a-z-]*" apps/web/src/*.css`), но скрипт всё равно
# печатает список в конце работы — если артефакт когда-нибудь заведёт имя,
# уже занятое темой, анимация молча подменится, и список сделает это видимым.
import re
import sys
import pathlib

sys.stdout.reconfigure(encoding="utf-8")

SCOPE = ".rh2 .wiz"
NIGHT_ROOT = 'html[data-theme="royal-home-2026-night"]'
NIGHT = f"{NIGHT_ROOT} {SCOPE}"

# Демо-обвязка страницы артефакта: рамка телефона и правая колонка «разбора».
# Не мастер — сам мастер начинается с .whead и селекторов внутри .screen.
DROP_PREFIXES = (
    ".wrap", ".top", ".eyebrow", ".split", ".stage", ".phone", ".screen",
    ".notch", ".caption",
    ".col", ".tabs", ".pane", ".qa", ".tblwrap", ".tbl", ".todo", ".note",
)


def split_rules(css: str):
    """Верхний уровень: список (преамбула, тело) с учётом вложенности скобок."""
    out, i, n = [], 0, len(css)
    while i < n:
        j = css.find("{", i)
        if j == -1:
            break
        prelude = css[i:j].strip()
        depth, k = 1, j + 1
        while k < n and depth:
            if css[k] == "{":
                depth += 1
            elif css[k] == "}":
                depth -= 1
            k += 1
        out.append((prelude, css[j + 1 : k - 1]))
        i = k
    return out


def strip_comments(css: str) -> str:
    return re.sub(r"/\*.*?\*/", "", css, flags=re.S)


def split_selectors(prelude: str):
    """Делит список селекторов по запятым верхнего уровня (скобки не режем)."""
    parts, depth, cur = [], 0, []
    for ch in prelude:
        if ch in "([":
            depth += 1
        elif ch in ")]":
            depth -= 1
        if ch == "," and depth == 0:
            parts.append("".join(cur).strip())
            cur = []
        else:
            cur.append(ch)
    tail = "".join(cur).strip()
    if tail:
        parts.append(tail)
    return [p for p in parts if p]


def _split_root(sel: str, root: str):
    """`:root[data-theme=dark] .bar` -> ('[data-theme=dark]', ' .bar')."""
    rest = sel[len(root) :]
    m = re.match(r"^((?:[.:#\[][^\s>+~]*)*)(.*)$", rest, flags=re.S)
    return m.group(1), m.group(2)


def _dropped(rest: str) -> bool:
    """Селектор демо-обвязки: первый простой селектор из DROP_PREFIXES."""
    rest = rest.strip()
    return any(rest == p or rest.startswith(p + " ") or rest.startswith(p + ".") or rest.startswith(p + ":") for p in DROP_PREFIXES)


def scope_one(sel: str, night: bool):
    """Один селектор артефакта -> селектор приложения; None — выбросить."""
    sel = sel.strip()
    if not sel:
        return None
    base = NIGHT if night else SCOPE

    if _dropped(sel):
        return None

    if sel in ("html", "body", "html,body"):
        return base

    if sel.startswith(":root"):
        mods, rest = _split_root(sel, ":root")
        if _dropped(rest):
            return None
        rest = rest.strip()
        if rest in ("body", "html"):
            rest = ""
        dark = "data-theme=dark" in mods or "not([data-theme=light])" in mods
        head = NIGHT if dark else (NIGHT if night else SCOPE)
        return head + ((" " + rest) if rest else "")

    if sel.startswith("body"):
        return base + sel[4:]

    return f"{base} {sel}"


def scope_selector(prelude: str, night: bool):
    """Список селекторов -> список селекторов; None — правило целиком выброшено."""
    kept: list = []
    for s in (scope_one(p, night) for p in split_selectors(prelude)):
        if s and s not in kept:
            kept.append(s)
    return ", ".join(kept) if kept else None


def is_dark_media(prelude: str) -> bool:
    return "prefers-color-scheme:dark" in prelude.lower().replace(" ", "")


def convert(css: str, night: bool, keyframes: list):
    res = []
    for prelude, body in split_rules(css):
        low = prelude.lower()
        if low.startswith("@font-face"):
            # Шрифты уже подключены в fonts-royal-home-2026.css.
            continue
        if low.startswith("@keyframes") or low.startswith("@-webkit-keyframes"):
            keyframes.append(prelude.split(None, 1)[1].strip() if " " in prelude else prelude)
            res.append(f"{prelude}{{{body}}}")
            continue
        if low.startswith("@media") or low.startswith("@supports"):
            if is_dark_media(prelude):
                inner = convert(body, True, keyframes)
                if inner.strip():
                    res.append(inner)
                continue
            inner = convert(body, night, keyframes)
            # Медиазапрос, где осталась одна демо-обвязка, печатать незачем.
            if inner.strip():
                res.append(f"{prelude}{{\n{inner}\n}}")
            continue
        if low.startswith("@"):
            print(f"предупреждение: неизвестное @-правило оставлено как есть: {prelude[:60]}", file=sys.stderr)
            res.append(f"{prelude}{{{body}}}")
            continue
        sel = scope_selector(prelude, night)
        if sel is None:
            continue
        res.append(f"{sel}{{{body}}}")
    return "\n".join(res)


HEADER = """/* МАСТЕР ОБЪЕКТА — ЭТАЛОН ВЛАДЕЛЬЦА, ПЕРЕНЕСЁННЫЙ ДОСЛОВНО.
 *
 * Источник: артефакт «Мастер объекта Royal Home»
 * (копия в docs/pult/theme-2026/artifact-wizard-property-15-09.html), второй
 * блок <style> целиком: токены, шапка шага, полосы прогресса, блоки фото,
 * видео, полей, карты, продавца, проверки, шторка выбора типа объекта.
 *
 * Значения НЕ правятся руками: файл собирается скриптом
 * `scripts/sync-wizard-css.py` и перегенерируется, если артефакт меняется.
 * Дописанное сюда руками стирается при следующей генерации.
 *
 * ОТЛИЧИЯ ОТ ИСТОЧНИКА, И ТОЛЬКО ОНИ:
 *   1. Каждый селектор ограничен областью `.rh2 .wiz`. Мастер называет вещи
 *      теми же именами, что мобильная главная и пульт (.chip, .row, .f, .tile,
 *      .ghost), поэтому смешивать их в одной области нельзя. Экран мастера
 *      оборачивается в <div className="rh2"><div className="wiz"> (два РАЗНЫХ
 *      предка: потомковый селектор одного элемента с двумя классами не видит).
 *   2. Выброшена демо-обвязка страницы артефакта: рамка телефона (.wrap, .top
 *      страницы — не путать с .whead мастера, .eyebrow, .split, .stage,
 *      .phone, .screen, .notch, .caption) и правая колонка «разбора» для
 *      читателя артефакта (.col, .tabs, .pane, .qa, .tblwrap, .tbl, .todo,
 *      .note). У приложения своя оболочка экрана.
 *   3. Ночной режим приходит от темы приложения
 *      (`html[data-theme="royal-home-2026-night"]`), а не от
 *      prefers-color-scheme и не от `:root[data-theme=dark]` артефакта.
 *   4. Шрифты не копируются: Manrope/Onest подключены в
 *      fonts-royal-home-2026.css.
 */
"""


def extract_block(html: str) -> str:
    blocks = re.findall(r"<style[^>]*>(.*?)</style>", html, flags=re.S)
    # В этом артефакте, в отличие от мобильного, только ОДИН содержательный
    # блок: первый — трёхстрочный сброс страницы claude.ai в <head> (не имеет
    # ни .whead, ни .wbody), второй — сам мастер с демо-обвязкой.
    app = [b for b in blocks if ".whead{" in b and ".wbody{" in b]
    if len(app) != 1:
        sys.exit(f"ожидался ровно один блок стилей мастера, найдено {len(app)} из {len(blocks)}")
    return app[0]


def main():
    if len(sys.argv) != 3:
        sys.exit("использование: sync-wizard-css.py <артефакт.html> <выход.css>")
    src = pathlib.Path(sys.argv[1])
    out = pathlib.Path(sys.argv[2])
    html = src.read_text(encoding="utf-8")
    keyframes: list = []
    css = convert(strip_comments(extract_block(html)), False, keyframes)
    text = HEADER + css + "\n"
    # newline="\n" обязателен: в текстовом режиме Windows пишет CRLF, и следующая
    # точечная правка по точному совпадению строки молча не находит ничего.
    out.write_text(text, encoding="utf-8", newline="\n")
    open_b, close_b = text.count("{"), text.count("}")
    if open_b != close_b:
        sys.exit(f"скобки не сходятся: {open_b} открывающих, {close_b} закрывающих")
    # Проверяется собранный CSS, а не весь файл: в шапке эти имена перечислены
    # как выброшенные, и проверка по всему тексту падала бы всегда. Граница
    # `\b`-подобная: без неё `.pane` находит себя внутри `.panel` (совпадающего
    # префикса недостаточно — нужен разделитель класса или конец имени).
    for p in DROP_PREFIXES:
        if re.search(re.escape(p) + r"(?![a-zA-Z0-9_-])", css):
            sys.exit(f"демо-обвязка артефакта осталась в выходе ({p}) — проверьте DROP_PREFIXES")
    print(
        f"записано {out} — {out.stat().st_size} байт, {text.count('{')} правил, "
        f"@keyframes: {', '.join(keyframes) or 'нет'}"
    )


if __name__ == "__main__":
    main()
