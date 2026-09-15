import { Request, Response, Router } from "express";
import { requireAuth } from "../middleware/auth";
import { requireDepotAccess, requireUnlockedJobCard } from "../middleware/depotAccess";
import { AppError } from "../middleware/errors";
import {
  attachItemMediaSchema,
  createInspectionItemSchema,
  createInspectionItemsSchema,
  patchInspectionItemSchema,
} from "../schemas/inspectionItem.schemas";
import * as itemsService from "../services/inspectionItems.service";
import { assertUuid } from "../utils/uuid";
import { parseOrThrow } from "../utils/zodError";

export const inspectionItemsRouter = Router();

// Scoped to its path rather than applied router-wide: requireAuth throws
// instead of calling next(), so an unscoped guard on a router mounted at "/"
// rejects requests bound for routers mounted after it. That shipped a 401 on
// the public /app-config in Phase 1.
inspectionItemsRouter.use("/job-cards/:jobCardId/items", requireAuth, requireDepotAccess);

/** The authenticated caller, or a 500 if a route was mounted without requireAuth. */
function actorId(req: Request): string {
  if (!req.user) throw new AppError(500, "Route reached without an authenticated user");
  return req.user.id;
}

/**
 * @openapi
 * /job-cards/{jobCardId}/items:
 *   get:
 *     tags: [Inspection Items]
 *     summary: The card's inspection line items, in display order
 *     description: >
 *       Line items are not embedded in `GET /job-cards/{id}`: a card may carry
 *       hundreds, each with its own damage codes, repair codes and
 *       photographs, and folding them in would make every card read pay for
 *       the largest case. `damage_code_ids` and `repair_code_ids` are id lists
 *       rather than embedded objects — the client already holds the code
 *       tables from `GET /equipment-types/{id}`. `custom_fields` is the
 *       snapshot taken when the answer was written, so a field renamed since
 *       does not rewrite what this card recorded.
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: jobCardId
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: The items, ordered by display_order
 *       403:
 *         description: DEPOT_FORBIDDEN — the card is outside the caller's depot
 *       404:
 *         description: No such job card
 */
inspectionItemsRouter.get(
  "/job-cards/:jobCardId/items",
  async (req: Request<{ jobCardId: string }>, res: Response) => {
    const jobCardId = assertUuid(req.params.jobCardId, "jobCardId");
    res.json(await itemsService.listInspectionItems(jobCardId));
  },
);

/**
 * @openapi
 * /job-cards/{jobCardId}/items:
 *   post:
 *     tags: [Inspection Items]
 *     summary: Record one line item or a whole walkaround
 *     description: >
 *       Accepts either a single object or an array, and **answers in the shape
 *       it was asked**: send one object, get one object; send an array, get an
 *       array. A batch is all-or-nothing — one transaction — so a client never
 *       has to re-read the card to discover what survived; violation paths in
 *       a batch are prefixed with the failing index, as `2.subview_id`.
 *
 *       Every item may carry a `client_uuid`. A batch whose keys are all ones
 *       already stored is a retry and returns what was stored, which is the
 *       seam offline sync uses.
 *
 *       The first successful write to a `DRAFT` card moves it to
 *       `IN_INSPECTION` and records a `job_card_events` row.
 *
 *       `custom_fields` answers require `subview_id`: field definitions are
 *       per subview, and `field_name`, `label` and `widget` are snapshotted by
 *       the server rather than accepted from the client. For an option-backed
 *       field, `option_id` is required and the stored `value` is the option's
 *       own label.
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: jobCardId
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       201:
 *         description: The created item, or the created items in the order sent
 *       400:
 *         description: VALIDATION_ERROR — bad body, a locating chain that does not agree, or an unknown code
 *       403:
 *         description: DEPOT_FORBIDDEN, or DEPOT_DISABLED if the depot is closed to new work
 *       404:
 *         description: No such job card
 *       409:
 *         description: JOB_CARD_LOCKED — the card is submitted and no longer accepts writes
 */
inspectionItemsRouter.post(
  "/job-cards/:jobCardId/items",
  requireUnlockedJobCard,
  async (req: Request<{ jobCardId: string }>, res: Response) => {
    const jobCardId = assertUuid(req.params.jobCardId, "jobCardId");
    // The body's shape picks both the schema and the response shape. Parsing a
    // single object with the single schema keeps its violation paths free of an
    // index the client never sent; a batch keeps the index that says which item
    // was wrong. And a client that sends one object gets one object back, so it
    // never has to special-case the API.
    const sentMany = Array.isArray(req.body);
    const inputs = sentMany
      ? parseOrThrow(createInspectionItemsSchema, req.body)
      : [parseOrThrow(createInspectionItemSchema, req.body)];
    const items = await itemsService.createInspectionItems(jobCardId, inputs, actorId(req));
    res.status(201).json(sentMany ? items : items[0]);
  },
);

/**
 * @openapi
 * /job-cards/{jobCardId}/items/{itemId}:
 *   get:
 *     tags: [Inspection Items]
 *     summary: One inspection line item
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: jobCardId
 *         required: true
 *         schema: { type: string, format: uuid }
 *       - in: path
 *         name: itemId
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: The item
 *       404:
 *         description: No such job card, or no such item on it
 */
inspectionItemsRouter.get(
  "/job-cards/:jobCardId/items/:itemId",
  async (req: Request<{ jobCardId: string; itemId: string }>, res: Response) => {
    const jobCardId = assertUuid(req.params.jobCardId, "jobCardId");
    const itemId = assertUuid(req.params.itemId, "itemId");
    res.json(await itemsService.getInspectionItem(jobCardId, itemId));
  },
);

/**
 * @openapi
 * /job-cards/{jobCardId}/items/{itemId}:
 *   patch:
 *     tags: [Inspection Items]
 *     summary: Change one line item
 *     description: >
 *       A patch replaces what it names and leaves the rest alone; an explicit
 *       `null` clears a column. `damage_code_ids` and `repair_code_ids` are
 *       **wholesale replacements** — send the list you want, and an empty
 *       array clears it. `custom_fields` is re-validated against whichever
 *       subview the item ends up on, so moving an item and re-answering it in
 *       one request cannot store answers belonging to the subview it left.
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: jobCardId
 *         required: true
 *         schema: { type: string, format: uuid }
 *       - in: path
 *         name: itemId
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: The updated item
 *       400:
 *         description: VALIDATION_ERROR
 *       403:
 *         description: DEPOT_FORBIDDEN or DEPOT_DISABLED
 *       404:
 *         description: No such job card, or no such item on it
 *       409:
 *         description: JOB_CARD_LOCKED
 */
inspectionItemsRouter.patch(
  "/job-cards/:jobCardId/items/:itemId",
  requireUnlockedJobCard,
  async (req: Request<{ jobCardId: string; itemId: string }>, res: Response) => {
    const jobCardId = assertUuid(req.params.jobCardId, "jobCardId");
    const itemId = assertUuid(req.params.itemId, "itemId");
    const patch = parseOrThrow(patchInspectionItemSchema, req.body);
    res.json(await itemsService.updateInspectionItem(jobCardId, itemId, patch));
  },
);

/**
 * @openapi
 * /job-cards/{jobCardId}/items/{itemId}:
 *   delete:
 *     tags: [Inspection Items]
 *     summary: Remove a line item
 *     description: >
 *       Removes the item along with its damage codes, repair codes and
 *       photograph links. The photographs themselves survive: media assets are
 *       content-addressed and may be shared, so only a reaper that has checked
 *       every link removes the bytes.
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: jobCardId
 *         required: true
 *         schema: { type: string, format: uuid }
 *       - in: path
 *         name: itemId
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       204:
 *         description: Removed
 *       403:
 *         description: DEPOT_FORBIDDEN or DEPOT_DISABLED
 *       404:
 *         description: No such job card, or no such item on it
 *       409:
 *         description: JOB_CARD_LOCKED
 */
inspectionItemsRouter.delete(
  "/job-cards/:jobCardId/items/:itemId",
  requireUnlockedJobCard,
  async (req: Request<{ jobCardId: string; itemId: string }>, res: Response) => {
    const jobCardId = assertUuid(req.params.jobCardId, "jobCardId");
    const itemId = assertUuid(req.params.itemId, "itemId");
    await itemsService.deleteInspectionItem(jobCardId, itemId);
    res.status(204).end();
  },
);

/** Who is asking, and the depot their request resolved to. */
function mediaActor(req: Request): itemsService.ItemMediaActor {
  if (!req.user) throw new AppError(500, "Route reached without an authenticated user");
  if (!req.depot) throw new AppError(500, "Route reached without a resolved depot");
  return { id: req.user.id, depotId: req.depot.id };
}

/**
 * @openapi
 * /job-cards/{jobCardId}/items/{itemId}/media:
 *   get:
 *     tags: [Inspection Items]
 *     summary: The photographs attached to a line item
 *     description: >
 *       Each entry carries a short-lived signed URL, so a client renders the
 *       item without fetching a URL per photograph. Not in the spec's route
 *       list, and added for the same reason the signature history route was:
 *       without it, what an item carries is not observable through the API,
 *       since `GET /items` does not embed attachments.
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: jobCardId
 *         required: true
 *         schema: { type: string, format: uuid }
 *       - in: path
 *         name: itemId
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: The photographs, in display order, each with url and expires_at
 *       404:
 *         description: No such job card, or no such item on it
 */
inspectionItemsRouter.get(
  "/job-cards/:jobCardId/items/:itemId/media",
  async (req: Request<{ jobCardId: string; itemId: string }>, res: Response) => {
    const jobCardId = assertUuid(req.params.jobCardId, "jobCardId");
    const itemId = assertUuid(req.params.itemId, "itemId");
    res.json(await itemsService.listItemMediaWithUrls(jobCardId, itemId, actorId(req)));
  },
);

/**
 * @openapi
 * /job-cards/{jobCardId}/items/{itemId}/media:
 *   post:
 *     tags: [Inspection Items]
 *     summary: Attach an uploaded photograph to a line item
 *     description: >
 *       The asset must already be `READY` — registered and uploaded through
 *       `/depots/{depotId}/media` — and must belong to the caller's depot.
 *       Re-attaching the same asset is a retry, not a conflict. Unlike
 *       job-card media there is no `kind`: what the photograph shows is the
 *       item it hangs from.
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: jobCardId
 *         required: true
 *         schema: { type: string, format: uuid }
 *       - in: path
 *         name: itemId
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       201:
 *         description: The attached asset
 *       400:
 *         description: VALIDATION_ERROR
 *       403:
 *         description: DEPOT_FORBIDDEN or DEPOT_DISABLED
 *       404:
 *         description: No such card, item, or asset at this depot
 *       409:
 *         description: MEDIA_NOT_READY, or JOB_CARD_LOCKED
 */
inspectionItemsRouter.post(
  "/job-cards/:jobCardId/items/:itemId/media",
  requireUnlockedJobCard,
  async (req: Request<{ jobCardId: string; itemId: string }>, res: Response) => {
    const jobCardId = assertUuid(req.params.jobCardId, "jobCardId");
    const itemId = assertUuid(req.params.itemId, "itemId");
    const input = parseOrThrow(attachItemMediaSchema, req.body);
    res
      .status(201)
      .json(
        await itemsService.attachMediaToItem(jobCardId, itemId, input.media_id, mediaActor(req)),
      );
  },
);

/**
 * @openapi
 * /job-cards/{jobCardId}/items/{itemId}/media/{mediaId}:
 *   delete:
 *     tags: [Inspection Items]
 *     summary: Detach a photograph from a line item
 *     description: >
 *       Removes the link only. The asset row and its bytes survive: media is
 *       content-addressed and may be attached elsewhere, so removing bytes is
 *       a reaper's job once it has checked every link.
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: jobCardId
 *         required: true
 *         schema: { type: string, format: uuid }
 *       - in: path
 *         name: itemId
 *         required: true
 *         schema: { type: string, format: uuid }
 *       - in: path
 *         name: mediaId
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       204:
 *         description: Detached
 *       403:
 *         description: DEPOT_FORBIDDEN or DEPOT_DISABLED
 *       404:
 *         description: Not attached to this item
 *       409:
 *         description: JOB_CARD_LOCKED
 */
inspectionItemsRouter.delete(
  "/job-cards/:jobCardId/items/:itemId/media/:mediaId",
  requireUnlockedJobCard,
  async (req: Request<{ jobCardId: string; itemId: string; mediaId: string }>, res: Response) => {
    const jobCardId = assertUuid(req.params.jobCardId, "jobCardId");
    const itemId = assertUuid(req.params.itemId, "itemId");
    const mediaId = assertUuid(req.params.mediaId, "mediaId");
    await itemsService.detachMediaFromItem(jobCardId, itemId, mediaId);
    res.status(204).end();
  },
);
