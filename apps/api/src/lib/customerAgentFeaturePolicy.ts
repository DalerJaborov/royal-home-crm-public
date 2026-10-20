import { prisma } from "../db.js";

/** Existing feature switches restrict implemented customer capabilities; a
 * legacy switch never grants a new tool, transport, identity or staff right. */
export async function loadCustomerAgentFeaturePolicy() {
  const row = await prisma.settings.findUnique({ where: { id: "singleton" }, select: {
    botCanSendLinks: true, botCanSendPhotos: true, botPhotosPerOffer: true, botCanBookShowings: true, botCanHandleVacancies: true,
  } });
  return { links: row?.botCanSendLinks === true, photos: row?.botCanSendPhotos === true,
    photosPerOffer: Math.max(0, Math.min(5, row?.botPhotosPerOffer ?? 0)),
    showings: row?.botCanBookShowings === true, vacancies: row?.botCanHandleVacancies === true };
}
