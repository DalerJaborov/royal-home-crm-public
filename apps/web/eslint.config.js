/**
 * Линтер ровно с одной целью: ловить нарушения правил хуков ДО коммита.
 *
 * 26 июля в проде упала карточка объекта — useCan() был вызван после раннего
 * return, React считает хуки по порядку и компонент рушился целиком. Ни tsc, ни
 * 94 теста этого не увидели: тесты покрывают API, а не отрисовку. Правило
 * rules-of-hooks поймало бы это бесплатно и мгновенно.
 *
 * Намеренно не подключаем общий набор стилевых правил: цель — не переписывать
 * код под чужие вкусы, а закрыть класс ошибок, который уже стоил простоя.
 *
 * ПЛОСКИЙ КОНФИГ ВМЕСТО .eslintrc.cjs (13.09.2026). eslint 8 снят с поддержки и
 * тянул за собой уязвимый @typescript-eslint 6; eslint 9 и 10 формат .eslintrc
 * уже не читают. Набор правил перенесён один в один — ни одного нового правила
 * здесь нет намеренно.
 */
import tsParser from "@typescript-eslint/parser";
import tsPlugin from "@typescript-eslint/eslint-plugin";
import reactHooks from "eslint-plugin-react-hooks";

export default [
  { ignores: ["dist/**", "dev-dist/**", "node_modules/**"] },
  {
    files: ["**/*.ts", "**/*.tsx"],
    languageOptions: {
      parser: tsParser,
      ecmaVersion: "latest",
      sourceType: "module",
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
    },
    // @typescript-eslint подключён только чтобы резолвились существующие в коде
    // комментарии eslint-disable с его правилами; сами правила не включаем.
    plugins: {
      "react-hooks": reactHooks,
      "@typescript-eslint": tsPlugin,
    },
    linterOptions: {
      /**
       * В плоском конфиге eslint сам по себе ругается на eslint-disable, под
       * которым нечего гасить. В коде такие комментарии есть — они стоят под
       * правила, которые здесь намеренно выключены (см. выше), и удалять их
       * нельзя: правила могут включить обратно. Молчим, как молчал eslint 8.
       */
      reportUnusedDisableDirectives: "off",
    },
    rules: {
      // Хук после раннего return / внутри условия — ошибка сборки, а не замечание.
      "react-hooks/rules-of-hooks": "error",
      // Забытая зависимость обычно означает устаревшие данные на экране —
      // предупреждение, потому что в проекте есть осознанные исключения с комментарием.
      "react-hooks/exhaustive-deps": "warn",
    },
  },
];
