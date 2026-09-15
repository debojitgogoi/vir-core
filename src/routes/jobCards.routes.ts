import { Request, Response, Router } from "express";
import { requireAuth, requireRole } from "../middleware/auth";
import { requireDepotAccess, requireUnlockedJobCard } from "../middleware/depotAccess";
import { AppError } from "../middleware/errors";
import * as jobCardsService from "../services/jobCards.service";
import * as mediaService from "../services/media.service";
import * as signaturesService from "../services/signatures.service";
import * as submissionService from "../services/submission.service";
import {
  createJobCardSchema,
  ListJobCardsQuery,
  listJobCardsQuerySchema,
  patchJobCardSchema,
} from "../schemas/jobCard.schemas";
import { assertUuid } from "../utils/uuid";
import { parseOrThrow } from "../utils/zodError";

export const jobCardsRouter = Router();

// Scoped to their paths rather than applied router-wide: requireAuth throws
// instead of calling next(), so an unscoped guard on a router mounted at "/"
// rejects requests bound for routers mounted after it. That shipped a 401 on
// the public /app-config in Phase 1.
jobCardsRouter.use("/depots/:depotId/job-cards", requireAuth, requireDepotAccess);
jobCardsRouter.use("/job-cards/:jobCardId", requireAuth, requireDepotAccess);

/** The authenticated caller, or a 500 if a route was mounted without requireAuth. */
function actorId(req: Request): string {
  if (!req.user) throw new AppError(500, "Route reached without an authenticated user");
  return req.user.id;
}

/**
 * The query string's snake_case names become the service's camelCase ones in
 * exactly one place, so the two list routes cannot disagree about what a filter
 * means.
 */
function listInput(query: ListJobCardsQuery): jobCardsService.ListJobCardsInput {
  const { depot_id, inspected_from, inspected_to, ...rest } = query;
  return {
    ...rest,
    depotId: depot_id,
    inspectedFrom: inspected_from,
    inspectedTo: inspected_to,
  };
}

/**
 * @openapi
 * /depots/{depotId}/job-cards:
 *   post:
 *     tags: [Job Cards]
 *     summary: Create a job card (intake)
 *     description: >
 *       Creates a DRAFT card at the given depot. Supplying `client_uuid` makes
 *       the call idempotent: a repeat of the same key at the same depot returns
 *       the existing card with 200 rather than creating a duplicate.
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: depotId
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       201:
 *         description: The card was created
 *       200:
 *         description: A card with this client_uuid already existed; it is returned unchanged
 *       400:
 *         description: VALIDATION_ERROR — body failed validation; `violations` names each field
 *       403:
 *         description: >
 *           DEPOT_FORBIDDEN if the depot is outside the caller's active membership,
 *           or DEPOT_DISABLED if the depot is closed to new work
 */
jobCardsRouter.post(
  "/depots/:depotId/job-cards",
  async (req: Request<{ depotId: string }>, res: Response) => {
    const depotId = assertUuid(req.params.depotId, "depotId");
    const input = parseOrThrow(createJobCardSchema, req.body);
    const { card, created } = await jobCardsService.createJobCard(depotId, input, actorId(req));
    // A replay is not a creation: 200 tells an offline client its retry was
    // absorbed, 201 tells it the card is new.
    res.status(created ? 201 : 200).json(card);
  },
);

/**
 * @openapi
 * /depots/{depotId}/job-cards:
 *   get:
 *     tags: [Job Cards]
 *     summary: List the depot's job cards, newest first
 *     description: >
 *       Returns a `{ data, pagination }` envelope so a cursor can be added later
 *       without breaking clients. Note that the depot *membership* endpoints
 *       return a bare array instead, because membership is never paginated.
 *       Unknown query parameters are ignored rather than rejected.
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: depotId
 *         required: true
 *         schema: { type: string, format: uuid }
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *           enum: [DRAFT, IN_INSPECTION, SUBMITTED, IN_ESTIMATION, ESTIMATED, REPORTED, VOID]
 *       - in: query
 *         name: direction
 *         schema: { type: string, enum: [INBOUND, OUTBOUND] }
 *       - in: query
 *         name: q
 *         description: Matches job_number, container_number, chassis_number or customer_name
 *         schema: { type: string }
 *       - in: query
 *         name: from
 *         description: Lower bound on created_at, as an ISO 8601 instant
 *         schema: { type: string, format: date-time }
 *       - in: query
 *         name: to
 *         description: Upper bound on created_at, as an ISO 8601 instant
 *         schema: { type: string, format: date-time }
 *       - in: query
 *         name: limit
 *         description: Clamped to the maximum rather than rejected
 *         schema: { type: integer, default: 25, maximum: 100 }
 *       - in: query
 *         name: offset
 *         schema: { type: integer, default: 0 }
 *     responses:
 *       200:
 *         description: Paginated list of job cards
 *       400:
 *         description: VALIDATION_ERROR — a filter value was not valid
 *       403:
 *         description: DEPOT_FORBIDDEN
 */
jobCardsRouter.get(
  "/depots/:depotId/job-cards",
  async (req: Request<{ depotId: string }>, res: Response) => {
    const depotId = assertUuid(req.params.depotId, "depotId");
    const query = parseOrThrow(listJobCardsQuerySchema, req.query);
    // The path wins over a depot_id in the query: this route is scoped by the
    // depot requireDepotAccess already checked, and honouring the query
    // parameter here would be a way around that check.
    res.json(await jobCardsService.listJobCardsPage({ ...listInput(query), depotId }));
  },
);

/**
 * @openapi
 * /job-cards/{jobCardId}:
 *   get:
 *     tags: [Job Cards]
 *     summary: Read one job card
 *     description: >
 *       Includes `can_edit`, computed for the calling context from the card's
 *       lock state. A submitted card stays readable and reports `can_edit: false`.
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: jobCardId
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: >
 *           The job card, plus `media` (each entry carrying a short-lived
 *           signed URL) and `signature`, the same verification result
 *           `/signature/verify` returns — so one request renders the whole card.
 *       400:
 *         description: VALIDATION_ERROR — the id is not a UUID
 *       403:
 *         description: DEPOT_FORBIDDEN
 *       404:
 *         description: No such card, or it is invisible to the caller
 */
jobCardsRouter.get(
  "/job-cards/:jobCardId",
  async (req: Request<{ jobCardId: string }>, res: Response) => {
    const id = assertUuid(req.params.jobCardId, "jobCardId");
    if (!req.user) throw new AppError(500, "Route reached without an authenticated user");

    // The spec has this endpoint return everything needed to render the card in
    // one request. Media arrived in Phase 3, signature status in Phase 4; line
    // items follow in Phase 5.
    const [card, media, signature] = await Promise.all([
      jobCardsService.getJobCardById(id),
      mediaService.listWithUrlsForJobCard(id, req.user.id),
      // Verification is a SHA-256 and an HMAC over a few hundred bytes, so
      // running it on every read costs less than making the client ask
      // separately -- and it means a client can never render a card while
      // believing a stale "signed" flag.
      signaturesService.verifySignature(id),
    ]);
    res.json({ ...card, media, signature });
  },
);

/**
 * @openapi
 * /job-cards/{jobCardId}:
 *   patch:
 *     tags: [Job Cards]
 *     summary: Update intake details
 *     description: >
 *       JSON Merge Patch semantics: an omitted field is left alone, an explicit
 *       null clears it. Unknown fields are rejected rather than ignored, so a
 *       misspelled key is a 400 instead of a silently dropped edit. Send the
 *       `updated_at` you last read as `If-Unmodified-Since` to be told when a
 *       colleague has edited the card in the meantime.
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: jobCardId
 *         required: true
 *         schema: { type: string, format: uuid }
 *       - in: header
 *         name: If-Unmodified-Since
 *         required: false
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: The updated job card
 *       400:
 *         description: VALIDATION_ERROR
 *       403:
 *         description: >
 *           DEPOT_FORBIDDEN if the depot is outside the caller's active membership,
 *           or DEPOT_DISABLED if the depot is closed to new work
 *       404:
 *         description: No such card
 *       409:
 *         description: JOB_CARD_LOCKED if the card was submitted, STALE_WRITE if it changed since you read it
 */
jobCardsRouter.patch(
  "/job-cards/:jobCardId",
  requireUnlockedJobCard,
  async (req: Request<{ jobCardId: string }>, res: Response) => {
    const id = assertUuid(req.params.jobCardId, "jobCardId");
    const patch = parseOrThrow(patchJobCardSchema, req.body);
    res.json(
      await jobCardsService.updateJobCardById(
        id,
        patch,
        actorId(req),
        req.get("If-Unmodified-Since"),
      ),
    );
  },
);

/**
 * @openapi
 * /job-cards/{jobCardId}/submit:
 *   post:
 *     tags: [Job Cards]
 *     summary: Submit the card for estimation
 *     description: >
 *       Validates the card, then locks it: `status` becomes `SUBMITTED`, and
 *       `submitted_at`, `submitted_by` and `locked_at` are set in one
 *       transaction with the `job_card_events` row recording the move.
 *
 *       **Re-submitting is a 200, not a conflict.** A double tap on a tablet or
 *       a client retrying a timed-out request gets the card's current state
 *       back, and no second event is written. For the same reason this route
 *       deliberately does not carry the lock guard the other mutating routes
 *       do — that guard would turn the retry into a 409.
 *
 *       A 422 lists **every** violation at once, so a gatekeeper is not fixing
 *       one field per round trip. The signature violation says what to do:
 *       "must be re-signed" and "Do NOT re-sign — this is an incident" are
 *       different instructions and are never collapsed into one.
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: jobCardId
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: The submitted card, with can_edit false
 *       400:
 *         description: VALIDATION_ERROR — the id is not a UUID
 *       403:
 *         description: DEPOT_FORBIDDEN, or DEPOT_DISABLED if the depot is closed to new work
 *       404:
 *         description: No such card
 *       422:
 *         description: SUBMISSION_INCOMPLETE — `violations` lists everything still missing
 */
jobCardsRouter.post(
  "/job-cards/:jobCardId/submit",
  async (req: Request<{ jobCardId: string }>, res: Response) => {
    const id = assertUuid(req.params.jobCardId, "jobCardId");
    if (!req.user) throw new AppError(500, "Route reached without an authenticated user");
    res.json(await submissionService.submitJobCard(id, req.user.id));
  },
);

/**
 * @openapi
 * /job-cards/{jobCardId}/events:
 *   get:
 *     tags: [Job Cards]
 *     summary: The card's status history
 *     description: >
 *       Every transition, **oldest first** — an audit trail is read forward,
 *       unlike the signature history, which answers "what holds now" and reads
 *       backward. `from_status` is null for a transition with no prior status.
 *       Readable on a submitted card: that is when it is most wanted.
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: jobCardId
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: The transitions, oldest first
 *       403:
 *         description: DEPOT_FORBIDDEN
 *       404:
 *         description: No such card
 */
jobCardsRouter.get(
  "/job-cards/:jobCardId/events",
  async (req: Request<{ jobCardId: string }>, res: Response) => {
    const id = assertUuid(req.params.jobCardId, "jobCardId");
    res.json(await submissionService.listJobCardEventsFor(id));
  },
);

/**
 * @openapi
 * /job-cards:
 *   get:
 *     tags: [Job Cards]
 *     summary: The cross-depot estimator queue
 *     description: >
 *       Every depot's cards in one list, for the estimators who work across
 *       yards. Restricted to ESTIMATOR, ADMIN and SUPERUSER — a mechanic reads
 *       their own depot through `/depots/{depotId}/job-cards` instead.
 *
 *       Same filters, same `{ data, pagination }` envelope as the depot list,
 *       because it is the same query with no depot bound to it. Narrow it with
 *       `depot_id`, and note that `from`/`to` filter `created_at` while
 *       `inspected_from`/`inspected_to` filter `inspected_at` — a card that has
 *       never been inspected is excluded by the second pair and included by the
 *       first.
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: query
 *         name: status
 *         description: Typically SUBMITTED — the cards waiting for an estimate
 *         schema:
 *           type: string
 *           enum: [DRAFT, IN_INSPECTION, SUBMITTED, IN_ESTIMATION, ESTIMATED, REPORTED, VOID]
 *       - in: query
 *         name: depot_id
 *         schema: { type: string, format: uuid }
 *       - in: query
 *         name: direction
 *         schema: { type: string, enum: [INBOUND, OUTBOUND] }
 *       - in: query
 *         name: q
 *         schema: { type: string }
 *       - in: query
 *         name: from
 *         description: Lower bound on created_at
 *         schema: { type: string, format: date-time }
 *       - in: query
 *         name: to
 *         description: Upper bound on created_at
 *         schema: { type: string, format: date-time }
 *       - in: query
 *         name: inspected_from
 *         description: Lower bound on inspected_at; excludes never-inspected cards
 *         schema: { type: string, format: date-time }
 *       - in: query
 *         name: inspected_to
 *         description: Upper bound on inspected_at; excludes never-inspected cards
 *         schema: { type: string, format: date-time }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 25, maximum: 100 }
 *       - in: query
 *         name: offset
 *         schema: { type: integer, default: 0 }
 *     responses:
 *       200:
 *         description: Paginated list of job cards across every depot
 *       400:
 *         description: VALIDATION_ERROR — a filter value was not valid
 *       401:
 *         description: Missing or invalid access token
 *       403:
 *         description: The caller's role does not read across depots
 */
// requireRole is the whole authorization here, deliberately. This route has no
// depot in its path, so requireDepotAccess would have nothing to resolve — and
// a route with nothing to resolve silently ends up with no scoping at all,
// which is how Phase 3's URL signing lost its guard. Cross-depot reading is
// the point of this endpoint, so the role check is the correct rule rather
// than a weaker substitute for a missing one.
jobCardsRouter.get(
  "/job-cards",
  requireAuth,
  requireRole("ESTIMATOR", "ADMIN", "SUPERUSER"),
  async (req: Request, res: Response) => {
    const query = parseOrThrow(listJobCardsQuerySchema, req.query);
    res.json(await jobCardsService.listJobCardsPage(listInput(query)));
  },
);
