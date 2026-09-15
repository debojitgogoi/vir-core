import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import * as depotsService from "../services/depots.service";
import * as usersService from "../services/users.service";

export const meRouter = Router();

/**
 * @openapi
 * /me:
 *   get:
 *     tags: [Profile]
 *     summary: Get the current user's profile
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: Current user's profile
 *       401:
 *         description: Missing or invalid access token
 */
meRouter.get("/me", requireAuth, async (req, res) => {
  const user = await usersService.getUserById(req.user!.id);
  res.json(user);
});

/**
 * @openapi
 * /me:
 *   patch:
 *     tags: [Profile]
 *     summary: Update own name/location (onboarding)
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name: { type: string }
 *               location: { type: string }
 *     responses:
 *       200:
 *         description: Updated profile
 *       401:
 *         description: Missing or invalid access token
 */
meRouter.patch("/me", requireAuth, async (req, res) => {
  const { name, location } = req.body ?? {};
  const user = await usersService.updateSelf(req.user!.id, { name, location });
  res.json(user);
});

/**
 * @openapi
 * /me/depot:
 *   get:
 *     tags: [Profile]
 *     summary: Get the current user's active depot
 *     description: Returns null when the user has not been assigned to a depot.
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: The active depot, or null
 *       401:
 *         description: Missing or invalid access token
 */
meRouter.get("/me/depot", requireAuth, async (req, res) => {
  res.json(await depotsService.getActiveDepotForUser(req.user!.id));
});
