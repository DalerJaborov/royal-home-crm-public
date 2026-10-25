import { Router } from 'express';
import { z } from 'zod';
import { canViewInvestigations } from '@royal-home/shared';
import { requireAuth, can } from '../../auth/middleware.js';
import { buildPropertyDeleteDossiers, presentPropertyDeleteDossier } from '../../lib/propertyDeleteDossier.js';

export const propertyRemovalDossierRouter = Router();
/** Read-only pre-decision facts, shared by direct withdrawal, trash, bulk and requests. */
propertyRemovalDossierRouter.post('/removal-dossiers', requireAuth, async (req, res) => {
  if (!canViewInvestigations(req.agent?.role) || !can(req, "clients.securityReview")) return res.status(403).json({ error: 'Недостаточно прав' });
  const parsed = z.object({ propertyIds: z.array(z.string().uuid()).min(1).max(100) }).strict().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Некорректный список объектов' });
  const ids = [...new Set(parsed.data.propertyIds)];
  const rows = await buildPropertyDeleteDossiers(ids);
  res.json({ items: ids.map(id => ({ propertyId: id, ...presentPropertyDeleteDossier(rows.get(id), can(req, "clients.viewPhone")) })), basis: 'CRM_OBSERVATIONS_NOT_A_VERDICT' });
});
