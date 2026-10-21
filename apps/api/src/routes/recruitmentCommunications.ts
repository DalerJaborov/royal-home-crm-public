import { Router } from "express";
import { z } from "zod";
import { recruitmentContactConfirmSchema, recruitmentContactPreviewSchema } from "@royal-home/shared";
import { requireAuth, requirePermission } from "../auth/middleware.js";
import { confirmRecruitmentContact, previewRecruitmentContact, recruitmentContactOptions, RecruitmentCommunicationError } from "../lib/recruitmentCommunications.js";

/** Mount at /vacancies, before /:id catch-all routes. All source/actor checks
 * are repeated under the service's actual core locks, not just middleware. */
export const recruitmentCommunicationsRouter = Router();
recruitmentCommunicationsRouter.use(requireAuth, requirePermission("vacancies.view"));
recruitmentCommunicationsRouter.use("/:id", (req, res, next) => {
  if (!z.string().uuid().safeParse(req.params.id).success) { res.status(400).json({ error: "Неверная анкета" }); return; }
  next();
});
const failure = (res: import("express").Response, error: unknown) => {
  if (error instanceof RecruitmentCommunicationError) res.status(error.status).json({ error: error.message });
  else res.status(503).json({ error: "Результат операции не подтверждён. Обновите историю обращений перед повтором." });
};
recruitmentCommunicationsRouter.get("/:id/contact-options", async (req, res) => {
  try { res.json(await recruitmentContactOptions(req.params.id, req.agent!.id)); } catch (error) { failure(res, error); }
});
recruitmentCommunicationsRouter.post("/:id/invitations/preview", async (req, res) => {
  const body = recruitmentContactPreviewSchema.safeParse(req.body);
  if (!body.success) { res.status(400).json({ error: "Проверьте время, каналы и условия обращения", details: body.error.flatten() }); return; }
  try { res.json(await previewRecruitmentContact(req.params.id, req.agent!.id, body.data)); } catch (error) { failure(res, error); }
});
recruitmentCommunicationsRouter.post("/:id/invitations", async (req, res) => {
  const body = recruitmentContactConfirmSchema.safeParse(req.body);
  if (!body.success) { res.status(400).json({ error: "Нужны актуальный предпросмотр и ключ операции" }); return; }
  try { res.json(await confirmRecruitmentContact(req.params.id, req.agent!.id, body.data)); } catch (error) { failure(res, error); }
});
