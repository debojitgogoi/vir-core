import { Request, Response, Router } from "express";
import { requireAuth } from "../middleware/auth";
import { requireDepotAccess, requireUnlockedJobCard } from "../middleware/depotAccess";
import { AppError } from "../middleware/errors";
import { recordSignatureSchema } from "../schemas/signature.schemas";
import * as signaturesService from "../services/signatures.service";
import { assertUuid } from "../utils/uuid";
import { parseOrThrow } from "../utils/zodError";

export const signaturesRouter = Router();

// Scoped to its path rather than applied router-wide: requireAuth throws
// instead of calling next(), so an unscoped guard on a router mounted at "/"
// rejects requests bound for routers mounted after it. That shipped a 401 on
// the public /app-config in Phase 1.
signaturesRouter.use("/job-cards/:jobCardId/signature", requireAuth, requireDepotAccess);

/** The authenticated caller, or a 500 if a route was mounted without requireAuth. */
function actorId(req: Request): string {
  if (!req.user) throw new AppError(500, "Route reached without an authenticated user");
  return req.user.id;
}

/**
 * @openapi
 * /job-cards/{jobCardId}/signature:
 *   post:
 *     tags: [Signatures]
 *     summary: Record a customer's acknowledgment
 *     description: >
 *       Records an acknowledgment of the card's current intake content as an
 *       HMAC receipt. No signature image, vector strokes, or biometric data is
 *       stored. Re-signing after an edit appends a new receipt; the earlier
 *       ones stay and are readable through the history route. `signed_at` may
 *       be backdated up to seven days, for a device that captured the moment
 *       offline, and may not be in the future.
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: jobCardId
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       201:
 *         description: The receipt. `payload_hash` identifies the acknowledged content.
 *       400:
 *         description: VALIDATION_ERROR — bad body, or a signed_at outside the accepted window
 *       403:
 *         description: DEPOT_FORBIDDEN, or DEPOT_DISABLED if the depot is closed to new work
 *       404:
 *         description: No such job card
 *       409:
 *         description: JOB_CARD_LOCKED — the card is submitted and no longer accepts writes
 */
signaturesRouter.post(
  "/job-cards/:jobCardId/signature",
  requireUnlockedJobCard,
  async (req: Request<{ jobCardId: string }>, res: Response) => {
    const jobCardId = assertUuid(req.params.jobCardId, "jobCardId");
    const input = parseOrThrow(recordSignatureSchema, req.body);
    res.status(201).json(await signaturesService.recordSignature(jobCardId, input, actorId(req)));
  },
);

/**
 * @openapi
 * /job-cards/{jobCardId}/signature/verify:
 *   get:
 *     tags: [Signatures]
 *     summary: Check whether the latest receipt still matches the card
 *     description: >
 *       Recomputes the receipt from the card's current content. Always 200 —
 *       "nobody has signed" and "the content changed" are answers, not errors.
 *       `reason` is one of NO_SIGNATURE; CONTENT_MODIFIED, meaning an
 *       acknowledged field changed and the card needs re-signing;
 *       RECEIPT_TAMPERED, meaning the stored receipt itself was edited — an
 *       incident, and re-signing is the wrong response; or
 *       RECEIPT_UNVERIFIABLE, meaning the receipt names a signing key or
 *       payload version this server no longer holds.
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: jobCardId
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: '{ valid: true, … } or { valid: false, reason }'
 *       403:
 *         description: DEPOT_FORBIDDEN — the card is outside the caller's depot
 *       404:
 *         description: No such job card
 */
signaturesRouter.get(
  "/job-cards/:jobCardId/signature/verify",
  async (req: Request<{ jobCardId: string }>, res: Response) => {
    const jobCardId = assertUuid(req.params.jobCardId, "jobCardId");
    res.json(await signaturesService.verifySignature(jobCardId));
  },
);

/**
 * @openapi
 * /job-cards/{jobCardId}/signature/history:
 *   get:
 *     tags: [Signatures]
 *     summary: Every receipt recorded for this card, newest first
 *     description: >
 *       Re-signing appends rather than replaces, so a card edited after signing
 *       carries more than one receipt. This route is what makes that history
 *       visible — which is what a dispute about an acknowledgment actually
 *       needs. `receipt_hmac` and `nonce` are never returned.
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: jobCardId
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: The receipts, newest first
 *       403:
 *         description: DEPOT_FORBIDDEN — the card is outside the caller's depot
 *       404:
 *         description: No such job card
 */
signaturesRouter.get(
  "/job-cards/:jobCardId/signature/history",
  async (req: Request<{ jobCardId: string }>, res: Response) => {
    const jobCardId = assertUuid(req.params.jobCardId, "jobCardId");
    res.json(await signaturesService.listSignatureHistory(jobCardId));
  },
);
