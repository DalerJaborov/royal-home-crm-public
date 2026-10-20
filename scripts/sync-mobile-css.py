# Переносит стили МОБИЛЬНОГО артефакта владельца в приложение ДОСЛОВНО,
# ограничивая их областью `.rh2 .mh`, — так имена макета (.row, .card-s, .tile,
# .ring, .chip) не сталкиваются ни с классами приложения, ни с уже перенесёнными
# стилями пульта (`.rh2 …` в theme-2026-proto.css).
#
#   python scripts/sync-mobile-css.py \
#       docs/pult/theme-2026/artifact-c99db05f-mobile-nav.html \
#       apps/web/src/theme-2026-mobile-home.css
#
# Источник — ОДИН html-файл артефакта. В нём два блока <style>:
#   1) три строки сброса страницы-обёртки claude.ai (не переносится);
#   2) сами стили мобильного приложения, 141 КБ вместе с зашитыми шрифтами.
# Берётся ТОЛЬКО второй.
#
# ПОЧЕМУ ОБЛАСТЬ ИЗ ДВУХ КЛАССОВ, А НЕ ОДНОГО. Мобильный артефакт и артефакт
# пульта называют разные вещи одинаково: `.row`, `.card`, `.chip`, `.btn`,
# `.top`, `.sec`, `.tile`, `.quiet`, `.bar`, `.av`, `.plate`. Стили пульта уже
# лежат в theme-2026-proto.css как `.rh2 X` (0,2,0) и `.rh2 .scr X` (0,3,0).
# Одноклассовая область `.rh2.mh X` дала бы ту же силу (0,3,0), что и `.scr`, и
# исход решался бы порядком файлов — то есть держался бы на том, что никто не
# переставит @import. `.rh2 .mh X` — тоже (0,3,0), но экраны `.scr` и мобильная
# главная `.mh` никогда не вложены друг в друга, так что пересечения нет вовсе:
# внутри `.mh` действуют правила мобильного артефакта, снаружи — пульта.
# Обёртка поэтому ДВУХУРОВНЕВАЯ: <div class="rh2"><div class="mh">. Потомковый
# селектор требует двух разных предков, одного `<div class="rh2 mh">` мало —
# ровно та же ловушка, что описана у `.scr` в scripts/sync-proto-css.py.
#
# Преобразования:
#   :root{...}                         -> .rh2 .mh{...}
#   :root[data-theme=dark] X           -> html[data-theme="royal-home-2026-night"] .rh2 .mh X
#   @media (prefers-color-scheme:dark) -> тот же ночной селектор, без медиазапроса
#                                         (тема выбирается тумблером приложения)
#   html / body / html,body            -> .rh2 .mh (страница у приложения своя)
#   .scr, .scr X                       -> .rh2 .mh, .rh2 .mh X (экран мобильного
#                                         артефакта — это и есть область .mh)
#   .stage/.phone/.panel/.stack        -> выбрасываются: это демо-рамка артефакта
#                                         (макет телефона 390x844 на сером фоне и
#                                         панель переключения ролей). У приложения
#                                         своя оболочка — AppLayout + BottomNav.
#   обычный селектор                   -> .rh2 .mh <селектор>
#   @font-face с url(...)              -> выбрасывается (Manrope/Onest уже
#                                         подключены в fonts-royal-home-2026.css)
#   @keyframes                         -> без изменений
# Медиазапрос, из которого после выбрасывания не осталось ни одного правила, не
# печатается вовсе.
#
# ЧЕГО СКРИПТ НЕ ДЕЛАЕТ. Он не переименовывает @keyframes. Сейчас единственное
# имя мобильного артефакта — `pulse`, и ни в одном другом файле приложения его
# нет (проверено `grep -o "@keyframes [a-z-]*"` по apps/web/src/*.css). Если
# артефакт заведёт имя, уже занятое темой, анимация молча подменится — поэтому
# скрипт печатает список имён в конце работы, чтобы столкновение было видно.
#
# ЧТО ПРИХОДИТСЯ ПЕРЕКРЫВАТЬ РУКАМИ (theme-2026-mobile-shell.css, блок 7). В
# артефакте экран — `position:absolute;inset:0` внутри рамки телефона, а `.body`
# внутри него — свой скроллер. У приложения на телефоне прокручивается САМА
# страница (см. AppLayout.tsx: вложенные скроллеры на iOS дают двойную резину).
# Эти три свойства снимаются в своём файле, а не правкой здесь: файл собирается
# скриптом и любая ручная строка в нём стирается при следующей генерации.
import re
import sys
import pathlib

sys.stdout.reconfigure(encoding="utf-8")

SCOPE = ".rh2 .mh"
NIGHT_ROOT = 'html[data-theme="royal-home-2026-night"]'
NIGHT = f"{NIGHT_ROOT} {SCOPE}"

# Демо-рамка артефакта: макет телефона на сером фоне и панель переключения ролей.
DROP_PREFIXES = (".stage", ".phone", ".panel", ".stack")


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
    """Селектор демо-рамки: первый простой селектор — .stage/.phone/.panel/.stack."""
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
        # `:root[data-theme=dark] body` — тот же корень, что и `:root[...]`.
        rest = rest.strip()
        if rest in ("body", "html"):
            rest = ""
        dark = "data-theme=dark" in mods or "not([data-theme=light])" in mods
        head = NIGHT if dark else (NIGHT if night else SCOPE)
        return head + ((" " + rest) if rest else "")

    # `.scr`, `.scr.push`, `.scr .body` — экран артефакта, он же область `.mh`.
    if sel == ".scr" or sel.startswith(".scr.") or sel.startswith(".scr "):
        return base + sel[len(".scr") :]

    if sel.startswith("body"):
        return base + sel[4:]

    return f"{base} {sel}"


def scope_selector(prelude: str, night: bool):
    """Список селекторов -> список селекторов; None — правило целиком выброшено."""
    kept: list = []
    for s in (scope_one(p, night) for p in split_selectors(prelude)):
        # `html,body` схлопывается в один и тот же `.rh2 .mh`: печатать его
        # дважды в одном списке незачем, порядок остальных не меняется.
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
            if "url(" in body:
                continue
            res.append(f"{prelude}{{{body}}}")
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
            # Медиазапрос, где осталась одна демо-рамка, печатать незачем.
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


HEADER = """/* МОБИЛЬНАЯ ГЛАВНАЯ — ЭТАЛОН ВЛАДЕЛЬЦА, ПЕРЕНЕСЁННЫЙ ДОСЛОВНО.
 *
 * Источник: артефакт «Royal Home 2026 · мобильная навигация»
 * (копия в docs/pult/theme-2026/artifact-c99db05f-mobile-nav.html), второй блок
 * <style> целиком: токены, шапка «Салом», секции главной, свайп строки, шторки,
 * поиск, карточка клиента, нижняя панель с FAB и кольцом удержания.
 *
 * Значения НЕ правятся руками: файл собирается скриптом
 * `scripts/sync-mobile-css.py` и перегенерируется, если артефакт меняется.
 * Дописанное сюда руками стирается при следующей генерации. Свои правила и
 * вынужденные отступления — в theme-2026-mobile-shell.css (блок 7).
 *
 * ОТЛИЧИЯ ОТ ИСТОЧНИКА, И ТОЛЬКО ОНИ:
 *   1. Каждый селектор ограничен областью `.rh2 .mh`. Мобильный артефакт и
 *      артефакт пульта называют разные вещи одинаково (.row, .card, .chip,
 *      .btn, .top, .sec, .tile, .quiet, .bar, .av, .plate), поэтому смешивать
 *      их в одной области нельзя. Экран мобильной главной оборачивается в
 *      <div className="rh2"><div className="mh"> (два РАЗНЫХ предка: потомковый
 *      селектор одного элемента с двумя классами не видит).
 *   2. `.scr` артефакта (экран внутри рамки телефона) — это и есть `.mh`:
 *      `.scr .body` стал `.rh2 .mh .body`.
 *   3. Выброшена демо-рамка артефакта: `.stage`, `.phone` (макет телефона
 *      390x844 на сером фоне), `.panel` (переключатель ролей мокапа), `.stack`.
 *      У приложения своя оболочка — AppLayout, Topbar, BottomNav.
 *   4. Ночной режим приходит от темы приложения
 *      (`html[data-theme="royal-home-2026-night"]`), а не от
 *      prefers-color-scheme и не от `:root[data-theme=dark]` мокапа.
 *   5. Шрифты не копируются: Manrope/Onest подключены в
 *      fonts-royal-home-2026.css; остаются только локальные запасные начертания.
 */
"""


def extract_block(html: str) -> str:
    blocks = re.findall(r"<style[^>]*>(.*?)</style>", html, flags=re.S)
    # Нужный блок — тот, где есть и рамка телефона, и нижняя панель вкладок.
    app = [b for b in blocks if ".phone{" in b and ".tabbar{" in b]
    if len(app) != 1:
        sys.exit(f"ожидался ровно один блок стилей приложения, найдено {len(app)} из {len(blocks)}")
    return app[0]


def main():
    if len(sys.argv) != 3:
        sys.exit("использование: sync-mobile-css.py <артефакт.html> <выход.css>")
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
    # как выброшенные, и проверка по всему тексту падала бы всегда.
    if any(p in css for p in DROP_PREFIXES):
        sys.exit("демо-рамка артефакта осталась в выходе — проверьте DROP_PREFIXES")
    print(
        f"записано {out} — {out.stat().st_size} байт, {text.count('{')} правил, "
        f"@keyframes: {', '.join(keyframes) or 'нет'}"
    )


if __name__ == "__main__":
    main()
