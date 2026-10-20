import { randomBytes } from "node:crypto";
import { PrismaClient } from "../src/generated/prisma/client.js";
import { makePrismaAdapter } from "../src/lib/prismaAdapter.js";

/**
 * Продакшн-сид: чистая база для передачи агентству. Никаких демо-клиентов и объектов —
 * только районы Душанбе, настройки по умолчанию и один директор со случайным паролем
 * (высшая роль: создаёт админов и других директоров). Пароль печатается в консоль
 * ОДИН раз — сохраните его и смените после первого входа (Мой профиль → Смена пароля).
 * Повторный запуск ничего не перезапишет.
 */
const prisma = new PrismaClient({ adapter: makePrismaAdapter(process.env.DATABASE_URL ?? "") });

// The initial administrator phone must be provided by the operator.
const ADMIN_PHONE = (() => {
  const phone = process.env.SEED_ADMIN_PHONE?.trim();
  if (!phone) throw new Error("SEED_ADMIN_PHONE is required for the production seed");
  return phone;
})();
const ADMIN_NAME = process.env.SEED_ADMIN_NAME ?? "Директор";

async function main() {
  await Promise.all(
    ["Сино", "Исмоили Сомони", "Фирдавси", "Шохмансур"].map((name) =>
      prisma.district.upsert({ where: { name }, update: {}, create: { name } })
    )
  );

  await prisma.settings.upsert({ where: { id: "singleton" }, update: {}, create: { id: "singleton" } });

  const existing = await prisma.agent.findUnique({ where: { phone: ADMIN_PHONE } });
  if (existing) {
    console.log(`Учётная запись ${ADMIN_PHONE} уже существует.`);
    return;
  }

  await prisma.agent.create({
    data: { fullName: ADMIN_NAME, phone: ADMIN_PHONE, role: "DIRECTOR" },
  });

  console.log("─".repeat(52));
  console.log("Продакшн-база инициализирована.");
  console.log(`  Вход:   ${ADMIN_PHONE}`);
  console.log("Пароля нет: вход по коду из СМС (или Telegram) на этот номер.");
  console.log("─".repeat(52));
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
