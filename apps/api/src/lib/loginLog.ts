import type { Request } from "express";
import { prisma } from "../db.js";
import { sendPushToAgent } from "../push.js";
import { resolveDeviceKey } from "./deviceKey.js";
import { clientIp } from "./ip.js";
import { enqueueDirectorAlert } from "./directorAlertQueue.js";

/**
 * Пишет запись в журнал входов и, если устройство новое для этого агента,
 * шлёт push самому агенту и всем активным директорам. Вызывается после успешной
 * выдачи сессии (логин / логин+2FA); ошибки здесь не должны ломать вход —
 * всё обёрнуто и логируется, но не пробрасывается.
 */
export async function recordLogin(req: Request, agent: { id: string; fullName: string }): Promise<void> {
  try {
    const { label, key } = resolveDeviceKey(req);
    const ip = clientIp(req);

    // Новое устройство = у агента уже были входы, но ни одного с таким deviceKey.
    // Самый первый вход в жизни агента новым не считаем — иначе каждый новый
    // сотрудник начинал бы работу с тревожного уведомления директору.
    const [sameDevice, anyPrior] = await Promise.all([
      prisma.loginLog.findFirst({ where: { agentId: agent.id, deviceKey: key }, select: { id: true } }),
      prisma.loginLog.findFirst({ where: { agentId: agent.id }, select: { id: true } }),
    ]);
    const isNewDevice = Boolean(anyPrior && !sameDevice);

    await prisma.loginLog.create({
      data: { agentId: agent.id, ip, userAgent: req.headers["user-agent"]?.slice(0, 500) ?? null, device: label, deviceKey: key, isNewDevice },
    });

    if (isNewDevice) {
      const body = `${label}${ip ? `, IP ${ip}` : ""}`;
      // Самому сотруднику — вдруг это не он.
      void sendPushToAgent(agent.id, {
        title: "🔐 Вход с нового устройства",
        body: `В вашу учётку вошли с нового устройства: ${body}. Если это не вы — смените пароль.`,
        url: "/profile",
        tag: `new-device-${agent.id}`,
      }).catch((err) => console.error("[loginLog] Push агенту не отправлен:", err instanceof Error ? err.message : err));
      // Директорам — контроль входов по всей команде. Часы алармов (владелец
      // 07.09.2026): агент уже предупреждён строкой выше мгновенно (это его
      // собственный аккаунт, если не он — пусть сразу видит и меняет пароль),
      // директорская копия — контроль постфактум, ей можно подождать окна.
      // excludeAgentId — если вошедший сам директор, он не получает дубль о
      // своём же входе (свой персональный пуш он уже получил выше).
      await enqueueDirectorAlert({
        title: "🔐 Вход с нового устройства",
        body: `${agent.fullName}: вход с нового устройства (${body}).`,
        url: "/settings",
        tag: `new-device-${agent.id}`,
        recipientRoles: ["DIRECTOR", "ADMIN"],
        excludeAgentId: agent.id,
      });
    }
  } catch (err) {
    console.error("[loginLog] Не удалось записать вход:", err instanceof Error ? err.message : err);
  }
}
