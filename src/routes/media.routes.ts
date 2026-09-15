import { Request, Response, Router } from "express";
import { env } from "../config/env";
import { requireAuth } from "../middleware/auth";
import { requireDepotAccess, requireUnlockedJobCard } from "../middleware/depotAccess";
import { AppError } from "../middleware/errors";
import { singleFileUpload } from "../middleware/upload";
import { attachMediaSchema, registerMediaSchema } from "../schemas/media.schemas";
import * as mediaService from "../services/media.service";
import { assertUuid } from "../utils/uuid";
import { parseOrThrow } from "../utils/zodError";

export const mediaRouter = Router();

// Scoped to their paths rather than applied router-wide: requireAuth throws
// instead of calling next(), so an unscoped guard on a router mounted at "/"
// rejects requests bound for routers mounted after it.
mediaRouter.use("/depots/:depotId/media", requireAuth, requireDepotAccess);
mediaRouter.use("/job-cards/:jobCardId/media", requireAuth, requireDepotAccess);

const handleUpload = singleFileUpload("file", env.mediaMaxBytes);

function actor(req: Request): mediaService.MediaActor {
  if (!req.user) throw new AppError(500, "Route reached without an authenticated user");
  if (!req.depot) throw new AppError(500, "Route reached without a resolved depot");
  return { id: req.user.id, depotId: req.depot.id };
}

/**
 * @openapi
 * /depots/{depotId}/media:
 *   post:
 *     tags: [Media]
 *     summary: Register an intended upload
 *     description: >
 *       Declares a file before sending it. The response carries the media id to
 *       PUT the bytes to. The declared size is checked against the server's cap
 *       here, so an oversized file is refused before it crosses the wire; the
 *       declared checksum is verified against the bytes when they arrive.
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: depotId
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       201:
 *         description: A PENDING media asset
 *       400:
 *         description: VALIDATION_ERROR — unsupported content type, bad checksum, or size over the cap
 *       403:
 *         description: DEPOT_FORBIDDEN, or DEPOT_DISABLED if the depot is closed to new work
 */
mediaRouter.post(
  "/depots/:depotId/media",
  async (req: Request<{ depotId: string }>, res: Response) => {
    const depotId = assertUuid(req.params.depotId, "depotId");
    const input = parseOrThrow(registerMediaSchema, req.body);
    res.status(201).json(await mediaService.registerMedia(depotId, input, actor(req).id));
  },
);

/**
 * @openapi
 * /depots/{depotId}/media/{mediaId}/content:
 *   put:
 *     tags: [Media]
 *     summary: Upload the bytes for a registration
 *     description: >
 *       An ordinary authenticated call — the bearer token is the credential.
 *       Send the file as multipart form field `file`. The bytes are hashed and
 *       compared with the checksum declared at registration; a mismatch is
 *       refused and nothing is written. Re-sending identical bytes is
 *       idempotent, so a retry after a dropped connection succeeds.
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: depotId
 *         required: true
 *         schema: { type: string, format: uuid }
 *       - in: path
 *         name: mediaId
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: The asset, now READY
 *       403:
 *         description: DEPOT_FORBIDDEN, or DEPOT_DISABLED
 *       404:
 *         description: No such asset, or it belongs to another depot
 *       413:
 *         description: The uploaded file exceeds the maximum size
 *       422:
 *         description: CHECKSUM_MISMATCH, or the content type disagrees with the registration
 */
mediaRouter.put(
  "/depots/:depotId/media/:mediaId/content",
  handleUpload,
  async (req: Request<{ depotId: string; mediaId: string }>, res: Response) => {
    const mediaId = assertUuid(req.params.mediaId, "mediaId");
    const file = req.file;
    if (!file) throw new AppError(400, "Missing required file field: file");

    res.json(
      await mediaService.storeMediaContent(mediaId, file.buffer, file.mimetype, actor(req)),
    );
  },
);

/**
 * @openapi
 * /depots/{depotId}/media/{mediaId}/url:
 *   get:
 *     tags: [Media]
 *     summary: Get a short-lived signed download URL
 *     description: >
 *       The returned URL carries its own credential in the path, so an <img>
 *       tag or a native downloader can fetch it without an Authorization
 *       header. It expires; fetch a fresh one rather than storing it.
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: depotId
 *         required: true
 *         schema: { type: string, format: uuid }
 *       - in: path
 *         name: mediaId
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: "{ url, expires_at }"
 *       403:
 *         description: DEPOT_FORBIDDEN
 *       404:
 *         description: No such asset at this depot
 *       409:
 *         description: MEDIA_NOT_READY — the bytes have not been uploaded yet
 */
mediaRouter.get(
  "/depots/:depotId/media/:mediaId/url",
  async (req: Request<{ depotId: string; mediaId: string }>, res: Response) => {
    const mediaId = assertUuid(req.params.mediaId, "mediaId");
    res.json(await mediaService.signMediaUrl(mediaId, actor(req)));
  },
);

/**
 * @openapi
 * /job-cards/{jobCardId}/media:
 *   get:
 *     tags: [Media]
 *     summary: List the media attached to a job card
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: jobCardId
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: A bare array; attachments are never paginated
 *       403:
 *         description: DEPOT_FORBIDDEN
 */
mediaRouter.get(
  "/job-cards/:jobCardId/media",
  async (req: Request<{ jobCardId: string }>, res: Response) => {
    const jobCardId = assertUuid(req.params.jobCardId, "jobCardId");
    res.json(await mediaService.listForJobCard(jobCardId));
  },
);

/**
 * @openapi
 * /job-cards/{jobCardId}/media:
 *   post:
 *     tags: [Media]
 *     summary: Attach a READY asset to a job card
 *     description: >
 *       The asset must already hold its bytes and must have been registered at
 *       the same depot as the card. Attaching the same asset twice is
 *       idempotent rather than a conflict.
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: jobCardId
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       201:
 *         description: The attached asset, carrying its kind
 *       403:
 *         description: DEPOT_FORBIDDEN, or DEPOT_DISABLED
 *       404:
 *         description: No such card, or no such asset at this depot
 *       409:
 *         description: MEDIA_NOT_READY, or JOB_CARD_LOCKED if the card was submitted
 */
mediaRouter.post(
  "/job-cards/:jobCardId/media",
  requireUnlockedJobCard,
  async (req: Request<{ jobCardId: string }>, res: Response) => {
    const jobCardId = assertUuid(req.params.jobCardId, "jobCardId");
    const input = parseOrThrow(attachMediaSchema, req.body);
    res.status(201).json(await mediaService.attachToJobCard(jobCardId, input, actor(req)));
  },
);

/**
 * @openapi
 * /job-cards/{jobCardId}/media/{mediaId}:
 *   delete:
 *     tags: [Media]
 *     summary: Detach media from a job card
 *     description: >
 *       Removes the link only. The asset and its bytes remain, because
 *       content-addressed storage may be shared with another card.
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: jobCardId
 *         required: true
 *         schema: { type: string, format: uuid }
 *       - in: path
 *         name: mediaId
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       204:
 *         description: Detached
 *       404:
 *         description: That media is not attached to this card
 *       409:
 *         description: JOB_CARD_LOCKED
 */
mediaRouter.delete(
  "/job-cards/:jobCardId/media/:mediaId",
  requireUnlockedJobCard,
  async (req: Request<{ jobCardId: string; mediaId: string }>, res: Response) => {
    const jobCardId = assertUuid(req.params.jobCardId, "jobCardId");
    const mediaId = assertUuid(req.params.mediaId, "mediaId");
    await mediaService.detachFromJobCard(jobCardId, mediaId);
    res.status(204).end();
  },
);
