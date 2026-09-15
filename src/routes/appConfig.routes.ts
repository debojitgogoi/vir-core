import { Router } from "express";
import * as appConfigService from "../services/appConfig.service";

export const appConfigRouter = Router();

/**
 * @openapi
 * /app-config:
 *   get:
 *     tags: [AppConfig]
 *     summary: Get client app-config (version control, cache invalidation, maintenance status)
 *     description: Public endpoint. No authentication required — clients may need it before or during login.
 *     responses:
 *       200:
 *         description: Current app-config payload
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 force_update_required: { type: boolean, nullable: true }
 *                 minimum_app_version: { type: string, nullable: true }
 *                 latest_app_version: { type: string, nullable: true }
 *                 store_url: { type: string, nullable: true }
 *                 clear_local_cache: { type: boolean, nullable: true }
 *                 cache_epoch: { type: integer, nullable: true }
 *                 catalog_version: { type: string, nullable: true }
 *                 maintenance:
 *                   type: object
 *                   nullable: true
 *                   properties:
 *                     active: { type: boolean, nullable: true }
 *                     message: { type: string, nullable: true }
 *                     until: { type: string, format: date-time, nullable: true }
 */
appConfigRouter.get("/app-config", async (_req, res) => {
  const config = await appConfigService.getAppConfigDto();
  res.json(config);
});
