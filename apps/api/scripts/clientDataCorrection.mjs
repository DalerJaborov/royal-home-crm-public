#!/usr/bin/env node
// Uses the existing authenticated API, never loads production DB credentials.
import { readFileSync, writeFileSync, realpathSync, existsSync } from "node:fs";
import { resolve, relative, isAbsolute, dirname, basename, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
const options = new Map(process.argv.slice(2).map(value => { const at = value.indexOf("="); return at < 0 ? [value, true] : [value.slice(0, at), value.slice(at + 1)]; }));
const base = process.env.CRM_MAINTENANCE_API_BASE;
const token = process.env.CRM_MAINTENANCE_ACCESS_TOKEN;
try {
  if (!base || !token) throw new Error("Укажите CRM_MAINTENANCE_API_BASE и CRM_MAINTENANCE_ACCESS_TOKEN в окружении. По умолчанию выполняется только предпросмотр.");
  const parsedBase = new URL(base);
  if (parsedBase.protocol !== "https:" && !(parsedBase.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(parsedBase.hostname))) throw new Error("Нужен HTTPS или локальный стенд");
  if (parsedBase.username || parsedBase.password || parsedBase.search || parsedBase.hash) throw new Error("Недопустимый адрес API");
  const previewOutput = options.get("--output-preview");
  let destination;
  if (previewOutput !== undefined) {
    if (typeof previewOutput !== "string") throw new Error("Укажите путь к приватному файлу предпросмотра");
    try { destination = join(realpathSync(dirname(resolve(previewOutput))), basename(previewOutput)); }
    catch { throw new Error("Приватная папка предпросмотра недоступна"); }
    const repository = realpathSync(fileURLToPath(new URL("../../../", import.meta.url)));
    const inside = relative(repository, destination);
    if (!isAbsolute(inside) && inside !== ".." && !inside.startsWith(`..${sep}`)) throw new Error("Приватный предпросмотр нельзя сохранять внутри репозитория");
    for (let parent = dirname(destination); ; parent = dirname(parent)) {
      if (existsSync(join(parent, ".git"))) throw new Error("Приватный предпросмотр нельзя сохранять ни в одном Git-репозитории");
      if (dirname(parent) === parent) break;
    }
    if (existsSync(destination)) throw new Error("Файл предпросмотра уже существует; нужен новый файл");
  }
  let path, body, method = "POST";
  if (options.has("--status") || options.has("--review")) {
    const id = options.get("--plan-id");
    if (typeof id !== "string" || !/^[a-f0-9-]{36}$/i.test(id)) throw new Error("Укажите --plan-id");
    path = `/${id}${options.has("--review") ? "/review" : ""}`; method = "GET";
  } else if (options.has("--apply")) {
    if (!options.has("--review-impact") || process.env.CRM_MAINTENANCE_ALLOW_APPLY !== "explicitly-approved") throw new Error("Применение требует --review-impact и отдельного разрешения оператора в окружении");
    const id = options.get("--plan-id"), hash = options.get("--plan-hash");
    if (typeof id !== "string" || !/^[a-f0-9-]{36}$/i.test(id) || typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash)) throw new Error("Нужны идентификатор и отпечаток подготовленного плана");
    path = `/${id}/apply`; body = { planHash: hash, impactReviewed: true };
  } else {
    const input = options.get("--input");
    if (typeof input !== "string") throw new Error("Укажите --input=путь-к-плану.json; --persist-plan сохраняет план, но не меняет карточки");
    let bytes;
    try { bytes = readFileSync(input); } catch { throw new Error("Не удалось прочитать локальный файл плана"); }
    if (bytes.length > 65536) throw new Error("Слишком большой план");
    try { body = JSON.parse(bytes.toString("utf8")); } catch { throw new Error("Некорректный JSON плана; приватное содержимое скрыто"); }
    path = options.has("--persist-plan") ? "/plans" : "/preview";
  }
  const result = await fetch(`${base.replace(/\/+$/, "")}/api/v1/maintenance/data-corrections${path}`, {
    method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined,
    redirect: "error", signal: AbortSignal.timeout(40_000),
  });
  const response = await result.json();
  if (!result.ok) throw new Error(typeof response.error === "string" ? response.error : `CRM вернула ${result.status}`);
  if (destination) {
    try { writeFileSync(destination, JSON.stringify(response, null, 2), { flag: "wx", mode: 0o600 }); }
    catch { throw new Error("Не удалось создать приватный файл предпросмотра; проверьте состояние плана перед повтором"); }
    console.log("Приватный предпросмотр сохранён в указанный новый файл. Проверьте старые/новые значения и влияние на фоновые задачи.");
  }
  // Labels/reason stay in the authenticated private plan, never in shell output.
  console.log(JSON.stringify({ id: response.id, planHash: response.planHash, status: response.status, mode: response.mode,
    impact: response.impact, targets: response.targets?.map(row => ({ clientId: row.clientId, fields: Object.keys(row.patch ?? {}) })), result: response.result }, null, 2));
} catch (error) { console.error(error instanceof Error ? error.message : "Операция не выполнена"); process.exitCode = 1; }
