# Переносит стили артефакта «Единый пульт директора» в приложение ДОСЛОВНО,
# ограничивая их областью `.rh2`, — так имена макета (.card, .row, .pill, .hero)
# не сталкиваются с классами приложения, а значения остаются ровно те же.
#
#   python scripts/sync-proto-css.py <артефакт.html> apps/web/src/theme-2026-proto.css
#
# Источник — ОДИН html-файл артефакта (копия в docs/pult/theme-2026/). В нём два
# содержательных блока <style>:
#   1) стили пульта (дашборда): токены, шапка, кольцо, восемь разделов, рейка,
#      верхняя строка, нижняя панель вкладок `.tabbar`, все точки перелома
#      1359/1180/1080/960/820/640/480 — это то, чего в приложении не было до 10.09;
#   2) стили 43 экранов (`.scr`, карточки, списки, чипы).
# Блоки переносятся в том же порядке, что в артефакте, поэтому каскад совпадает:
# где второй блок переопределяет первый в макете, там же он переопределяет и у нас.
#
# Преобразования (одинаковые для обоих блоков):
#   :root{...}                         -> .rh2{...}
#   :root[data-theme=dark] X           -> html[data-theme="royal-home-2026-night"] .rh2 X
#   @media (prefers-color-scheme:dark) -> тот же ночной селектор, без медиазапроса
#                                         (тема выбирается тумблером приложения,
#                                         вложенные @media внутри сохраняются)
#   html.mo X, html[data-screen] X     -> html.mo .rh2 X (режимы, которые макет
#                                         вешает на <html>, остаются на <html>)
#   html / body                        -> .rh2 (страница у приложения своя)
#   обычный селектор                   -> .rh2 <селектор>
#   @font-face с url(...)              -> выбрасывается (шрифты уже подключены в
#                                         fonts-royal-home-2026.css); локальные
#                                         запасные начертания остаются
#   @keyframes                         -> без изменений
# Каждая часть списка селекторов обрабатывается отдельно: правило вида
# `:root[data-theme=dark] .a, :root .b{...}` даёт два селектора, а не один.
#
# ПОЧЕМУ У ЭКРАНОВ ОСТАЁТСЯ `.scr`. В артефакте стили экранов написаны как
# `.scr .card`, `.scr .row` — на ступень строже стилей пульта (`.card`), и именно
# так экраны побеждают пульт там, где имена совпадают (92 общих имени), а пульт
# (он вне `.scr`) экранные правила не получает. Скрипт это сохраняет: получается
# `.rh2 .scr .card`. Значит каждая область темы обязана вкладывать `.scr`:
# экран — через Rh2Screen, окна и встроенные куски — через Rh2Portal/Rh2Inline
# (components/rh2/Rh2Scope.tsx). Обёртка вида `<div class="rh2 scr">` на одном
# элементе НЕ подходит: потомковый селектор требует двух разных предков.
import re
import sys
import pathlib

sys.stdout.reconfigure(encoding="utf-8")

SCOPE = ".rh2"
NIGHT_ROOT = 'html[data-theme="royal-home-2026-night"]'
NIGHT = f"{NIGHT_ROOT} {SCOPE}"


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
    """`html.mo .hero` -> ('.mo', ' .hero'): модификаторы корня и остаток."""
    rest = sel[len(root) :]
    m = re.match(r"^((?:[.:#\[][^\s>+~]*)*)(.*)$", rest, flags=re.S)
    return m.group(1), m.group(2)


def scope_one(sel: str, night: bool) -> str:
    sel = sel.strip()
    if not sel:
        return sel
    base = NIGHT if night else SCOPE

    if sel == "html,body" or sel in ("html", "body"):
        return base

    if sel.startswith(":root"):
        mods, rest = _split_root(sel, ":root")
        if "data-theme=dark" in mods or "not([data-theme=light])" in mods:
            return NIGHT + rest
        if "data-theme=light" in mods:
            return SCOPE + rest
        return base + mods + rest

    if sel.startswith("html"):
        mods, rest = _split_root(sel, "html")
        if "data-theme=dark" in mods or "not([data-theme=light])" in mods:
            return NIGHT + rest
        if "data-theme=light" in mods:
            return SCOPE + rest
        rest = rest.strip()
        if rest.startswith("body"):
            rest = rest[4:]
        if night:
            return f"html{mods}[data-theme=\"royal-home-2026-night\"] {SCOPE}" + (
                (" " + rest) if rest else ""
            )
        if not mods:
            return base + ((" " + rest) if rest else "")
        return f"html{mods} {SCOPE}" + ((" " + rest) if rest else "")

    if sel.startswith("body"):
        return base + sel[4:]

    return f"{base} {sel}"


def scope_selector(prelude: str, night: bool) -> str:
    # `.screens` — контейнер экранов артефакта (<div class="screens"> вокруг всех
    # <section class="scr">): в нём лежат правила-«отмены» стилей пульта
    # (`.screens .pill{background:revert…}`) и колонка экрана 1180 px. У нас его
    # роль играет сама область: <div class="rh2 screens"> — модификатор на том же
    # элементе, а не вложенный блок, иначе пришлось бы перекраивать сотню обёрток.
    # Специфичность та же: `.rh2.screens .pill` = `.rh2 .screens .pill`.
    return ", ".join(
        scope_one(s, night).replace(f"{SCOPE} .screens", f"{SCOPE}.screens") for s in split_selectors(prelude)
    )


def is_dark_media(prelude: str) -> bool:
    return "prefers-color-scheme:dark" in prelude.lower().replace(" ", "")


COLLAPSED = 0


def collapse_repeats(rules):
    """Схлопывает ПОДРЯД повторённые куски: если отрезок правил сразу же
    повторяется дословно (`A A`, `A B A B`), вторая копия выбрасывается.

    Зачем. Артефакт объявляет ночные значения ДВАЖДЫ, как и положено странице,
    которая живёт и с системной темой, и с тумблером: сначала
    `@media (prefers-color-scheme:dark){:root:not([data-theme=light]){…}}`,
    следом `:root[data-theme=dark]{…}` с тем же телом. У нас тема приходит
    только тумблером, поэтому оба вида превращаются в один и тот же селектор
    `html[data-theme="royal-home-2026-night"] .rh2 …` — и в файл попадает
    буквально та же строка два раза подряд.

    Почему безопасно именно «подряд». Одинаковые правила, идущие вплотную,
    дают тот же каскад, что и одно: объявления те же и в том же порядке,
    взаимное расположение всех остальных правил не меняется. Дубли,
    РАЗНЕСЁННЫЕ по файлу, не трогаем: между ними могут стоять переопределения,
    и повтор ниже по файлу может быть намеренным возвратом к значению.
    Правила с одним селектором и разными телами не трогаем никогда.
    """
    global COLLAPSED
    out = []
    i, n = 0, len(rules)
    while i < n:
        best = 0
        for length in range((n - i) // 2, 0, -1):
            if rules[i : i + length] == rules[i + length : i + 2 * length]:
                best = length
                break
        if best:
            out.extend(rules[i : i + best])
            COLLAPSED += best
            i += 2 * best
        else:
            out.append(rules[i])
            i += 1
    return out


def convert_rules(css: str, night: bool = False):
    res = []
    for prelude, body in split_rules(css):
        low = prelude.lower()
        if low.startswith("@font-face"):
            if "url(" in body:
                continue
            res.append(f"{prelude}{{{body}}}")
            continue
        if low.startswith("@keyframes") or low.startswith("@-webkit-keyframes"):
            res.append(f"{prelude}{{{body}}}")
            continue
        if low.startswith("@media") or low.startswith("@supports"):
            if is_dark_media(prelude):
                # медиазапрос растворяется: его правила встают в общий поток,
                # поэтому и складывать их надо поштучно, иначе соседний
                # `[data-theme=dark]` не с чем будет сравнить.
                res.extend(convert_rules(body, night=True))
                continue
            inner = "\n".join(convert_rules(body, night=night))
            res.append(f"{prelude}{{\n{inner}\n}}")
            continue
        if low.startswith("@"):
            print(f"предупреждение: неизвестное @-правило оставлено как есть: {prelude[:60]}", file=sys.stderr)
            res.append(f"{prelude}{{{body}}}")
            continue
        res.append(f"{scope_selector(prelude, night)}{{{body}}}")
    return collapse_repeats(res)


def convert(css: str, night: bool = False) -> str:
    return "\n".join(convert_rules(css, night))


HEADER = """/* ЭТАЛОН ТЕМЫ «ROYAL HOME 2026», ПЕРЕНЕСЁННЫЙ ДОСЛОВНО.
 *
 * Источник: артефакт владельца «Единый пульт директора»
 * (https://claude.ai/code/artifact/ff1d9d17-798b-4e52-9fda-d0cc0a730d91,
 * копия в docs/pult/theme-2026/artifact-ff1d9d17-pult-director.html). Из него
 * взяты ОБА блока стилей в порядке артефакта: сначала стили пульта (токены,
 * шапка, кольцо, восемь разделов, рейка, нижняя панель `.tabbar`, точки
 * перелома 1359/1180/1080/960/820/640/480), затем стили 43 экранов.
 *
 * Значения НЕ правятся руками: файл собирается скриптом
 * `scripts/sync-proto-css.py` и перегенерируется, если артефакт меняется.
 * Дописанное сюда руками стирается при следующей генерации. Свои правила —
 * в theme-royal-home-2026.css и theme-2026-*.css.
 *
 * Единственное отличие от источника: каждый селектор ограничен областью `.rh2`,
 * чтобы имена макета (.card, .row, .pill, .hero) не сталкивались с классами
 * приложения. Экран включает эталон, оборачивая содержимое в
 * <div className="rh2"><div className="scr">: стили экранов в артефакте
 * написаны как `.scr .card` (на ступень строже стилей пульта) и здесь остаются
 * такими же — `.rh2 .scr .card`. Без вложенного `.scr` экранные правила не
 * действуют; дашборд (`.rh2 .pult`) вложенного `.scr` не имеет НАРОЧНО, как и в
 * артефакте. Контейнер экранов артефакта `.screens` (в нём «отмены» стилей
 * пульта и колонка 1180 px) стал модификатором области: `<div class="rh2
 * screens">`, селектор `.rh2.screens …` той же специфичности. Ночной режим
 * приходит от темы приложения (`html[data-theme="royal-home-2026-night"]`),
 * а не от prefers-color-scheme. Режимы, которые макет вешает на <html>
 * (html.mo, html[data-screen]), остаются на <html>: `html.mo .rh2 …`;
 * `data-screen` приложение ставит само (hooks/useScreenAttribute.ts), без него
 * `.screens{display:none}` артефакта спрятал бы все экраны.
 *
 * Шрифты сюда не копируются: Manrope/Onest уже подключены в
 * `fonts-royal-home-2026.css`; остаются только локальные запасные начертания.
 */
"""


def extract_blocks(html: str):
    blocks = re.findall(r"<style[^>]*>(.*?)</style>", html, flags=re.S)
    pult = [b for b in blocks if ".wash{" in b and ".tabbar" in b]
    screens = [b for b in blocks if b.lstrip().startswith("/* экраны волн") or (".scr{" in b and ".wash{" not in b)]
    if len(pult) != 1 or len(screens) != 1:
        sys.exit(f"ожидались ровно один блок пульта и один блок экранов, найдено {len(pult)} и {len(screens)}")
    return pult[0], screens[0]


def main():
    if len(sys.argv) != 3:
        sys.exit("использование: sync-proto-css.py <артефакт.html> <выход.css>")
    src = pathlib.Path(sys.argv[1])
    out = pathlib.Path(sys.argv[2])
    html = src.read_text(encoding="utf-8")
    pult, screens = extract_blocks(html)
    pult_css = convert(strip_comments(pult))
    screens_css = convert(strip_comments(screens))
    note = (
        f"/* Схлопнуто подряд идущих дословных повторов: {COLLAPSED}"
        " (артефакт объявляет ночные значения дважды — через"
        " prefers-color-scheme и через [data-theme=dark]; у нас оба вида дают"
        " один и тот же селектор). Разнесённые по файлу повторы и правила с"
        " одним селектором, но разными телами оставлены как есть. */\n"
    )
    text = HEADER + note + pult_css + "\n" + screens_css + "\n"
    out.write_text(text, encoding="utf-8", newline="\n")
    open_b, close_b = text.count("{"), text.count("}")
    if open_b != close_b:
        sys.exit(f"скобки не сходятся: {open_b} открывающих, {close_b} закрывающих")
    print(
        f"записано {out} — {out.stat().st_size} байт, "
        f"блок пульта {len(pult_css)} симв., блок экранов {len(screens_css)} симв., "
        f".tabbar: {text.count('.tabbar')} упоминаний"
    )


if __name__ == "__main__":
    main()
