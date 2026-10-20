export default {
  plugins: {
    // Tailwind v4: плагин переехал в отдельный пакет, autoprefixer больше
    // не нужен — префиксы ставит встроенный Lightning CSS.
    "@tailwindcss/postcss": {},
  },
};
