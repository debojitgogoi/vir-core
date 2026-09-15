import { Request, Response, Router } from "express";
import { requireAuth, requireRole } from "../middleware/auth";
import { requireDepotAccess } from "../middleware/depotAccess";
import * as depotsService from "../services/depots.service";
import { createDepotSchema, patchDepotSchema } from "../schemas/depot.schemas";
import { parsePaging } from "../utils/pagination";
import { assertUuid } from "../utils/uuid";
import { parseOrThrow } from "../utils/zodError";

export const depotsRouter = Router();

// Scoped to the path rather than applied router-wide: requireAuth throws
// instead of calling next(), so an unscoped guard on a router mounted at "/"
// rejects requests bound for routers mounted after it.
depotsRouter.use("/depots", requireAuth);

const requireDepotAdmin = requireRole("ADMIN", "SUPERUSER");

/**
 * @openapi
 * /depots:
 *   get:
 *     tags: [Depots]
 *     summary: List depots
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 25, maximum: 100 }
 *       - in: query
 *         name: offset
 *         schema: { type: integer, default: 0 }
 *       - in: query
 *         name: include_disabled
 *         description: Disabled depots are hidden unless this is "true"
 *         schema: { type: boolean, default: false }
 *     responses:
 *       200:
 *         description: Paginated list of depots
 *       403:
 *         description: Insufficient permissions
 */
depotsRouter.get("/depots", requireDepotAdmin, async (req, res) => {
  const paging = parsePaging(req.query);
  res.json(
    await depotsService.listDepotsPage({
      ...paging,
      includeDisabled: req.query.include_disabled === "true",
    }),
  );
});

/**
 * @openapi
 * /depots:
 *   post:
 *     tags: [Depots]
 *     summary: Create a depot
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [code, name]
 *             properties:
 *               code: { type: string, description: Short depot code, stored uppercase }
 *               name: { type: string }
 *               timezone: { type: string, default: UTC }
 *               address: { type: string }
 *     responses:
 *       201:
 *         description: Depot created
 *       400:
 *         description: Missing code or name
 *       409:
 *         description: Depot code already in use
 */
depotsRouter.post("/depots", requireDepotAdmin, async (req, res) => {
  const input = parseOrThrow(createDepotSchema, req.body ?? {});
  res.status(201).json(await depotsService.createDepot(input));
});

/**
 * @openapi
 * /depots/{depotId}:
 *   get:
 *     tags: [Depots]
 *     summary: Get one depot
 *     description: Readable by any active member of the depot, and by ADMIN or SUPERUSER across depots.
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: depotId
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Depot found
 *       403:
 *         description: DEPOT_FORBIDDEN — the depot is outside the caller's active membership
 *       404:
 *         description: Depot not found
 */
// Any member may read their own depot, as the spec's access matrix grants.
// requireDepotAccess admits ADMIN and SUPERUSER across depots and refuses
// everyone else with DEPOT_FORBIDDEN; the remaining depot routes stay
// admin-only.
depotsRouter.get(
  "/depots/:depotId",
  requireDepotAccess,
  // Params are annotated rather than inferred: with several handlers on one
  // route, Express falls back to its loose default where params are
  // string | string[].
  async (req: Request<{ depotId: string }>, res: Response) => {
    res.json(await depotsService.getDepotById(assertUuid(req.params.depotId, "depotId")));
  },
);

/**
 * @openapi
 * /depots/{depotId}:
 *   patch:
 *     tags: [Depots]
 *     summary: Update a depot
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: depotId
 *         required: true
 *         schema: { type: string, format: uuid }
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name: { type: string }
 *               timezone: { type: string }
 *               address: { type: string }
 *               is_disabled: { type: boolean }
 *     responses:
 *       200:
 *         description: Depot updated
 *       404:
 *         description: Depot not found
 */
depotsRouter.patch(
  "/depots/:depotId",
  requireDepotAdmin,
  // Params are annotated rather than inferred: with several handlers on one
  // route, Express falls back to its loose default where params are
  // string | string[].
  async (req: Request<{ depotId: string }>, res: Response) => {
    res.json(
      await depotsService.updateDepotById(
        assertUuid(req.params.depotId, "depotId"),
        parseOrThrow(patchDepotSchema, req.body ?? {}),
      ),
    );
  },
);

/**
 * @openapi
 * /depots/{depotId}/members:
 *   get:
 *     tags: [Depots]
 *     summary: List the depot's active members
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: depotId
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Active members
 *       404:
 *         description: Depot not found
 */
depotsRouter.get(
  "/depots/:depotId/members",
  requireDepotAdmin,
  async (req: Request<{ depotId: string }>, res: Response) => {
    res.json(await depotsService.listMembers(assertUuid(req.params.depotId, "depotId")));
  },
);

/**
 * @openapi
 * /depots/{depotId}/members:
 *   post:
 *     tags: [Depots]
 *     summary: Assign a user to this depot
 *     description: >
 *       A user holds exactly one active depot. Assigning them here closes any
 *       previous membership in the same transaction.
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: depotId
 *         required: true
 *         schema: { type: string, format: uuid }
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [user_id]
 *             properties:
 *               user_id: { type: string, format: uuid }
 *     responses:
 *       201:
 *         description: Updated member list
 *       400:
 *         description: user_id missing
 *       404:
 *         description: Depot or user not found
 */
depotsRouter.post(
  "/depots/:depotId/members",
  requireDepotAdmin,
  async (req: Request<{ depotId: string }>, res: Response) => {
    const members = await depotsService.assignMember(
      assertUuid(req.params.depotId, "depotId"),
      (req.body ?? {}).user_id,
    );
    res.status(201).json(members);
  },
);

/**
 * @openapi
 * /depots/{depotId}/members/{userId}:
 *   delete:
 *     tags: [Depots]
 *     summary: Remove a user from this depot
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: depotId
 *         required: true
 *         schema: { type: string, format: uuid }
 *       - in: path
 *         name: userId
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       204:
 *         description: Membership ended
 *       404:
 *         description: Not an active member
 */
depotsRouter.delete(
  "/depots/:depotId/members/:userId",
  requireDepotAdmin,
  async (req: Request<{ depotId: string; userId: string }>, res: Response) => {
    await depotsService.removeMember(
      assertUuid(req.params.depotId, "depotId"),
      assertUuid(req.params.userId, "userId"),
    );
    res.status(204).send();
  },
);
