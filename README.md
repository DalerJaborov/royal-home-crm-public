# Royal Home CRM

CRM для агентства недвижимости (Душанбе, Таджикистан). Full-stack TypeScript-монорепо:
React/Vite клиент, Express API, Prisma/PostgreSQL, общие Zod-схемы.

## Стек

- **Frontend** — React 18, Vite, TypeScript, Tailwind CSS, React Router, TanStack Query,
  Zustand, dnd-kit, PWA.
- **Backend** — Express, TypeScript, Prisma ORM, PostgreSQL, JWT (access-токен в памяти +
  refresh-токен в HttpOnly-cookie), bcrypt, Zod, multer, sharp, helmet, express-rate-limit.
- **Shared** — `@royal-home/shared`: общие Zod-схемы и типы, импортируются в api и web.

## Структура

```
apps/api        @royal-home/api      Express + TypeScript (tsx), Prisma, JWT-аутентификация
apps/web        @royal-home/web      React 18 + Vite + Tailwind + PWA
packages/shared @royal-home/shared   Общие Zod-схемы/типы
```

## Быстрый старт

Требуется Node 24 и Docker (для локального PostgreSQL).

```bash
docker compose up -d              # поднять PostgreSQL 16 (порт 5432)
npm install
cp apps/api/.env.example apps/api/.env   # заполнить значения (см. ниже)
npm run prisma:migrate            # применить миграции
npm run prisma:seed               # заполнить тестовыми данными
npm run build:shared              # обязательно перед первым dev:api/dev:web

npm run dev:api                   # http://localhost:4000
npm run dev:web                   # http://localhost:5173
```

После правок в `packages/shared/src` пересобирайте пакет (`npm run build:shared`) —
api и web используют скомпилированный `dist/`, а не исходники напрямую.

## Переменные окружения (`apps/api/.env`)

| Переменная | Назначение |
|---|---|
| `DATABASE_URL` | строка подключения к PostgreSQL |
| `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET` | секреты для подписи JWT |
| `JWT_ACCESS_TTL` / `JWT_REFRESH_TTL` | время жизни токенов (напр. `15m`, `30d`) |
| `SETTINGS_ENCRYPTION_KEY` | 32-байтный hex-ключ (64 символа) для шифрования секретов в БД |
| `CORS_ORIGIN` | разрешённый origin для CORS (адрес web-клиента) |
| `PORT`, `UPLOADS_DIR` | порт API и каталог загрузок |

Сгенерировать `SETTINGS_ENCRYPTION_KEY`:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## Тестовые учётные записи (после `npm run prisma:seed`)

Пароль для всех: `password123`

| Роль | Телефон |
|---|---|
| Администратор | `+992900000001` |
| Агент | `+992900000002` |
| Агент | `+992900000003` |
| Менеджер | `+992900000004` |

## Команды

```bash
npm run build              # build shared → api → web, по порядку
npm run build:api          # build shared → api
npm run build:web          # build shared → web
npm run test:api           # vitest-тесты на права доступа (apps/api/tests), нужна поднятая БД
npm run prisma:generate    # перегенерировать Prisma Client
npm run prisma:migrate     # создать/применить dev-миграцию
npm run prisma:seed        # засеять БД демо-данными
```

CI (`.github/workflows/ci.yml`) на каждый push/PR поднимает PostgreSQL, прогоняет
`npm run build` и `npm run test:api`.

## Продакшн

Развёртывание на VPS (Docker Compose + Caddy HTTPS), чистая инициализация базы
(`npm run prisma:seed:prod`), бэкапы и привязка сайта royalhome.tj — см. [DEPLOY.md](DEPLOY.md).
