#!/usr/bin/env python3
"""Кодмод шкалы текста 06.10.2026 (задание A, п. 4): Tailwind `text-[N px]` без половинок.

  12.5 / 13.5 / 12 / 11 / 10 -> 13,   14.5 / 14 -> 15.

Шкала контракта: 13/15/16/18/22/28, мельче 13 нет. Обходит apps/web/src/**/*.tsx, кроме
__tests__ и файлов из EXEMPT (зона чужой правки). Идемпотентен: второй прогон ничего не
меняет. Печатает перечень затронутых файлов и число замен.
Запуск из корня репозитория:  python scripts/codemod-text-scale.py [--dry]
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent / "apps" / "web" / "src"
EXEMPT = ("property-wizard/StepPlace.tsx",)  # зона правки #823 (см. noSmallText.test.ts)
PAT = re.compile(r"text-\[(\d+(?:\.\d+)?)px\]")
MAP = {"10": "13", "11": "13", "12": "13", "12.5": "13", "13.5": "13", "14": "15", "14.5": "15"}


def main() -> None:
    dry = "--dry" in sys.argv
    total = 0
    for path in sorted(ROOT.rglob("*.tsx")):
        rel = path.relative_to(ROOT).as_posix()
        if "__tests__" in rel or rel.endswith(EXEMPT):
            continue
        src = path.read_bytes().decode("utf-8")  # без перевода концов строк
        count = 0

        def repl(m: re.Match) -> str:
            nonlocal count
            new = MAP.get(m.group(1))
            if new is None:
                return m.group(0)
            count += 1
            return f"text-[{new}px]"

        out = PAT.sub(repl, src)
        if count:
            total += count
            print(f"{count:3d}  {rel}")
            if not dry:
                path.write_bytes(out.encode("utf-8"))
    print(f"итого замен: {total}")


if __name__ == "__main__":
    main()
