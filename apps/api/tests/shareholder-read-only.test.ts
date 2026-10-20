import "./helpers/routeMountRecorder.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { Server } from "node:http";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { signAccessToken } from "../src/auth/jwt.js";
import { isReadOnlyExemptRequest } from "../src/auth/middleware.js";
import { collectRoutes } from "./helpers/routeMountRecorder.js";

/**
 * Акционер (SHAREHOLDER) только смотрит (10.10.2026). Запрет стоит в requireAuth по
 * роли, а не в галочках: многие записывающие роуты закрыты лишь «своё». Тест обходит
 * ВСЕ зарегистрированные роуты записи — новый роут, добавленный завтра, попадёт в
 * обход сам, и если он не за requireAuth, тест об этом скажет.
 */

const runId = Date.now();
const DUMMY_ID = "00000000-0000-4000-8000-000000000000";
let agentId = "";
let token = "";

/** Записывающие роуты вне requireAuth: вебхуки с секретом/ключом, подписанные пуш-действия, отчёт бэкапа. */
const PUBLIC_WRITE_PREFIXES = ["/webhooks/", "/sms/webhook/", "/push/action", "/backups/report", "/auth/"];

function concretePath(path: string): string {
  return path
    .replace(/\{[^}]*\}/g, "")
    .replace(/:[A-Za-z0-9_]+(\([^)]*\))?[?*+]?/g, DUMMY_ID)
    .replace(/\*[A-Za-z0-9_]*/g, "x");
}

// Один сервер на весь обход: supertest с `request(server)` поднимает и гасит сервер на
// КАЖДЫЙ запрос, и после ~140 таких циклов процесс vitest на Windows умирал без
// ошибки («Worker exited unexpectedly», 10.10.2026). С постоянным сервером нет.
let server: Server;

beforeAll(async () => {
  server = app.listen(0);
  const agent = await prisma.agent.create({
    data: {
      fullName: `Акционер ${runId}`,
      phone: `+99298${String(runId).slice(-7)}`,
      role: "SHAREHOLDER",
      passwordHash: "x",
    },
  });
  agentId = agent.id;
  token = signAccessToken({ sub: agent.id, role: "SHAREHOLDER" });
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await prisma.agent.deleteMany({ where: { id: agentId } });
  await prisma.$disconnect();
});

describe("isReadOnlyExemptRequest", () => {
  it.each([
    ["GET", "/api/v1/clients"],
    ["HEAD", "/api/v1/clients"],
    ["OPTIONS", "/api/v1/clients"],
    ["POST", "/api/v1/auth/login"],
    ["POST", "/api/v1/auth/logout"],
    ["POST", "/api/v1/auth/refresh"],
    ["PATCH", "/api/v1/me"],
    ["PATCH", "/api/v1/me/"],
    ["PATCH", "/api/v1/me?x=1"],
    ["POST", "/api/v1/push/subscribe"],
    ["POST", "/api/v1/push/unsubscribe"],
    ["POST", "/api/v1/errors"],
    ["PUT", "/api/v1/me/preferences"],
    ["POST", "/api/v1/me/avatar"],
    ["DELETE", "/api/v1/me/sessions/abc"],
  ])("%s %s разрешён", (method, path) => {
    expect(isReadOnlyExemptRequest(method, path)).toBe(true);
  });

  it.each([
    ["POST", "/api/v1/clients"],
    ["PATCH", "/api/v1/clients/1"],
    ["DELETE", "/api/v1/me/sessions"],
    ["PUT", "/api/v1/me/preferencesx"],
    ["POST", "/api/v1/errors/resolve-all"],
    ["POST", "/api/v1/authx/steal"],
    ["PATCH", "/api/v1/me/montage-copies"],
    ["POST", "/api/v1/push/test"],
  ])("%s %s запрещён", (method, path) => {
    expect(isReadOnlyExemptRequest(method, path)).toBe(false);
  });
});

describe("Акционер: запись закрыта по роли", () => {
  it("каждый зарегистрированный роут записи отвечает 403 READ_ONLY_ROLE", async () => {
    const routes = collectRoutes((app as unknown as { router: { stack: never[] } }).router.stack).filter(
      (r) => ["POST", "PUT", "PATCH", "DELETE"].includes(r.method) && !isReadOnlyExemptRequest(r.method, r.path),
    );
    expect(routes.length, "обход не нашёл роутов записи — сломан сборщик путей").toBeGreaterThan(100);

    const offenders: string[] = [];
    const publicRoutes: string[] = [];
    for (const { method, path } of routes) {
      // Публичные роуты (вебхуки, SMS, отчёт копий) не трогаем вовсе: их обработчики
      // запускают фоновую работу уже после ответа, и пустое тело роняло процесс
      // vitest на следующем файле («Worker exited unexpectedly», 10.10.2026).
      if (PUBLIC_WRITE_PREFIXES.some((prefix) => path.includes(prefix))) {
        publicRoutes.push(`${method} ${path}`);
        continue;
      }
      const url = concretePath(path);
      const send = (auth: boolean) => {
        let req = request(server)[method.toLowerCase() as "post"](url);
        if (auth) req = req.set("Authorization", `Bearer ${token}`);
        return req.send({});
      };
      const res = await send(true);
      if (res.status === 403 && res.body?.code === "READ_ONLY_ROLE") continue;
      // Роут без requireAuth (вебхуки, публичные формы) токен вообще не смотрит —
      // к режиму просмотра отношения не имеет (вебхуки с API-ключом отвечают 401 с
      // другим текстом); признак requireAuth — именно его ответ без токена.
      const anon = await send(false);
      if (anon.body?.error !== "Требуется авторизация") {
        publicRoutes.push(`${method} ${path}`);
        continue;
      }
      offenders.push(`${method} ${path} -> ${res.status} ${JSON.stringify(res.body).slice(0, 80)}`);
    }
    expect(offenders, `Роуты записи, открытые акционеру:\n${offenders.join("\n")}`).toEqual([]);
    // Публичные роуты (без requireAuth) — вебхуки с API-ключом и т.п.; записать от
    // имени акционера они не могут, он для них такой же аноним.
    expect(publicRoutes.every((r) => PUBLIC_WRITE_PREFIXES.some((p) => r.includes(p))), publicRoutes.join(", ")).toBe(true);
  }, 300_000);

  it("исключения не получают READ_ONLY_ROLE", async () => {
    const patch = await request(server)
      .patch("/api/v1/me")
      .set("Authorization", `Bearer ${token}`)
      .send({ fullName: `Акционер ${runId}` });
    expect(patch.body?.code).not.toBe("READ_ONLY_ROLE");
    expect(patch.status).toBe(200);

    const err = await request(server).post("/api/v1/errors").set("Authorization", `Bearer ${token}`).send({});
    expect(err.body?.code).not.toBe("READ_ONLY_ROLE");
  });

  it("GET /me отдаёт readOnly: true, чтение остаётся открытым", async () => {
    const me = await request(server).get("/api/v1/me").set("Authorization", `Bearer ${token}`);
    expect(me.status).toBe(200);
    expect(me.body.readOnly).toBe(true);
    const list = await request(server).get("/api/v1/clients").set("Authorization", `Bearer ${token}`);
    expect(list.status).toBe(200);
  });
});
