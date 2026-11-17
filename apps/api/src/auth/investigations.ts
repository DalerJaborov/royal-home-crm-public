import type { Request, Response, NextFunction } from "express";
import { canViewInvestigations } from "@royal-home/shared";
import { can } from "./middleware.js";

/**
 * ОДНО ПРАВИЛО для REST и ИИ-помощника: роль, которую можно передавать в
 * проекции «только для проверки» (visibleInteractionWhere, presentClient), — только
 * если И роль ADMIN/DIRECTOR, И действующее право clients.securityReview. Иначе
 * undefined — только публичное. Отзыв права у директора/админа закрывает записи сразу.
 */
export function investigationRoleFor(role: string | null | undefined, hasSecurityReview: boolean): string | undefined {
  return role && canViewInvestigations(role) && hasSecurityReview ? role : undefined;
}

/** Both the role ceiling and current effective grant apply to every private surface. */
export function canReadInvestigations(req: Request): boolean {
  return investigationRoleFor(req.agent?.role, can(req, "clients.securityReview")) !== undefined;
}

/** Pass only this role to projection/query helpers; undefined means public-only. */
export function investigationViewerRole(req: Request): string | undefined {
  return investigationRoleFor(req.agent?.role, can(req, "clients.securityReview"));
}

export function requireInvestigations(req: Request, res: Response, next: NextFunction) {
  if (!canReadInvestigations(req)) return res.status(403).json({ error: "Недостаточно прав" });
  next();
}
