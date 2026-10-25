import { saveWithInvestigationControlAudit } from "../lib/investigationSettingsAudit.js";
import { Router } from "express";
import { z } from "zod";
import { sellerControlCommandSchema, sellerControlConfigUpdateSchema } from "@royal-home/shared";
import { prisma } from "../db.js";
import { commandSellerControl, SellerControlConflict, startSellerControl } from "../lib/sellerControlEpisodes.js";
import { readSellerControlConfig } from "../lib/sellerControlMachine.js";
import { can, requireAuth, requirePermission } from "../auth/middleware.js";
import { maskPhonesDeep } from "../lib/clientPhone.js";
import { requireInvestigations } from "../auth/investigations.js";

export const sellerControlRouter = Router();
sellerControlRouter.use(requireAuth, requireInvestigations, requirePermission("clients.securityReview"));
sellerControlRouter.get("/", async (req, res) => {
  const [settings, episodes] = await Promise.all([
    prisma.settings.findUnique({ where: { id: "singleton" }, select: { sellerControlConfig: true } }),
    prisma.sellerControlEpisode.findMany({ take: 50, orderBy: { updatedAt: "desc" }, include: { events: { orderBy: { occurredAt: "desc" }, take: 20 } } }),
  ]);
  const config = readSellerControlConfig(settings?.sellerControlConfig);
  const safeEpisodes = episodes.map(episode => ({ ...episode,
    events: episode.events.map(event => ({ ...event, payload: maskPhonesDeep(event.payload, can(req, "clients.viewPhone")) })) }));
  res.json({ config, configurationState: config ? "CONFIGURED" : "NOT_CONFIGURED", mode: "PREVIEW", episodes: safeEpisodes });
});
sellerControlRouter.put("/config", async (req, res) => {
  const parsed = sellerControlConfigUpdateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Заполните все три положительных срока или очистите настройку" });
  if ("defaultRopAgentId" in parsed.data.config && parsed.data.config.defaultRopAgentId) {
    const rop = await prisma.agent.findUnique({ where: { id: parsed.data.config.defaultRopAgentId }, select: { role: true, isActive: true } });
    if (!rop?.isActive || !["MANAGER", "ADMIN", "DIRECTOR"].includes(rop.role)) return res.status(400).json({ error: "Выберите действующего руководителя" });
  }
  await saveWithInvestigationControlAudit({ sellerControlConfig: parsed.data.config }, { id: req.agent!.id, name: req.agent!.id }, tx => tx.settings.update({ where: { id: "singleton" }, data: { sellerControlConfig: parsed.data.config } }));
  res.json({ config: readSellerControlConfig(parsed.data.config), mode: "PREVIEW" });
});
sellerControlRouter.post("/", async (req, res) => {
  const parsed = z.object({ clientId: z.string().uuid(), ropAgentId: z.string().uuid(), requestKey: z.string().uuid() }).strict().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Укажите карточку и ответственного руководителя" });
  try { res.json(await startSellerControl({ ...parsed.data, actorId: req.agent!.id })); }
  catch (error) { if (error instanceof SellerControlConflict) return res.status(409).json({ error: error.message }); throw error; }
});
sellerControlRouter.post("/buyer-candidate", async (req, res) => {
  const parsed = z.object({ buyerCandidateId: z.string().uuid(), candidateRevision: z.number().int().positive(),
    ropAgentId: z.string().uuid(), requestKey: z.string().uuid() }).strict().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Укажите договорённость и ответственного руководителя" });
  const candidate = await prisma.buyerShowingCandidate.findUnique({ where: { id: parsed.data.buyerCandidateId }, select: { clientId: true } });
  if (!candidate) return res.status(404).json({ error: "Договорённость не найдена" });
  try { res.json(await startSellerControl({ ...parsed.data, clientId: candidate.clientId, actorId: req.agent!.id, live: true })); }
  catch (error) { if (error instanceof SellerControlConflict) return res.status(409).json({ error: error.message }); throw error; }
});
sellerControlRouter.post("/:id/commands", async (req, res) => {
  const id = z.string().uuid().safeParse(req.params.id);
  const parsed = sellerControlCommandSchema.safeParse(req.body);
  if (!id.success || !parsed.success) return res.status(400).json({ error: "Проверьте действие и комментарий" });
  const episode = await prisma.sellerControlEpisode.findUnique({ where: { id: id.data }, select: { executionMode: true } });
  if (!episode) return res.status(404).json({ error: "Эпизод не найден" });
  if (episode.executionMode === "LIVE" && !["RESOLVE", "CANCEL"].includes(parsed.data.action))
    return res.status(409).json({ error: "Реальное получение и действие отмечает назначенный руководитель в своей задаче" });
  if (episode.executionMode === "LIVE" && process.env.SELLER_CONTROL_INTERNAL_LIVE !== "explicitly-approved")
    return res.status(409).json({ error: "Рабочее исполнение выключено" });
  if (!["PREVIEW", "LIVE"].includes(episode.executionMode)) return res.status(409).json({ error: "Неизвестный режим эпизода" });
  try { res.json(await commandSellerControl(id.data, parsed.data, req.agent!.id, { simulated: episode.executionMode === "PREVIEW" })); }
  catch (error) { if (error instanceof SellerControlConflict) return res.status(409).json({ error: error.message }); throw error; }
});
