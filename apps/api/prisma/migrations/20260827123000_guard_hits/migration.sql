-- Счётчики срабатывания фильтров ответа бота (27.08.2026, совет экспертов, п. 8):
-- сколько раз каждый guard чинил реплику за сутки. Только наблюдение — на сам
-- ответ клиенту не влияет.
CREATE TABLE IF NOT EXISTS "GuardHit" (
    "id" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "guard" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "GuardHit_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "GuardHit_day_guard_key" ON "GuardHit"("day", "guard");
CREATE INDEX IF NOT EXISTS "GuardHit_day_idx" ON "GuardHit"("day");
