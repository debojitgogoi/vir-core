import { Request, Response, Router } from "express";
import { env } from "../config/env";
import { AppError } from "../middleware/errors";
import { requireAuth, requireRole } from "../middleware/auth";
import { singleFileUpload } from "../middleware/upload";
import * as equipmentModelsService from "../services/equipmentModels.service";

export const equipmentModelsRouter = Router();

// Scoped to the path rather than applied router-wide: requireAuth throws
// instead of calling next(), so a pathless .use() here would reject every
// request that merely passes through this router on its way to a later one.
equipmentModelsRouter.use("/equipment-types", requireAuth);

const handleUpload = singleFileUpload("glb", env.glbMaxBytes);

/**
 * @openapi
 * /equipment-types/{id}/model:
 *   post:
 *     tags: [Equipment 3D Models]
 *     summary: Upload a GLB model for an equipment type
 *     description: >
 *       SUPERUSER/ADMIN only. Send the .glb only — the manifest is extracted
 *       from the file's own node graph, so the two can never describe different
 *       models. A glTF node joins the manifest when its `extras` carry a
 *       node_type or its name uses an MV_/SV_/LF_ prefix; cameras, lights and
 *       untagged geometry are skipped, and an included node is re-parented to
 *       its nearest included ancestor. slug_id, node_type and display_name come
 *       from `extras` (display_name falling back to the node name); is_leaf is
 *       computed from the resulting hierarchy. The extracted manifest is then
 *       validated structurally — slug_ids are checked for format and
 *       uniqueness but NOT looked up against main_views/subviews, so a model
 *       may be ahead of the equipment data.
 *       Each upload creates a new version and becomes the active model;
 *       previous versions are retained.
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         description: Either the equipment type's UUID or its public slug_id
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required: [glb]
 *             properties:
 *               glb:
 *                 type: string
 *                 format: binary
 *                 description: The .glb file (glTF binary v2)
 *     responses:
 *       201:
 *         description: Model version created and made active
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 id: { type: string, format: uuid }
 *                 slug_id: { type: string }
 *                 equipment_type_id: { type: string, format: uuid }
 *                 version_number: { type: integer }
 *                 is_active: { type: boolean }
 *                 manifest_version: { type: string }
 *                 node_count: { type: integer }
 *                 uploaded_by: { type: string, format: uuid, nullable: true }
 *                 created_at: { type: string, format: date-time }
 *                 glb:
 *                   type: object
 *                   properties:
 *                     original_filename: { type: string }
 *                     content_type: { type: string }
 *                     size_bytes: { type: integer }
 *                     checksum_sha256: { type: string }
 *       400:
 *         description: Missing the glb file field
 *       403:
 *         description: Caller is not SUPERUSER/ADMIN
 *       404:
 *         description: Equipment type not found
 *       413:
 *         description: GLB exceeds the maximum upload size
 *       422:
 *         description: >
 *           The file is not a GLB, holds no taggable nodes, or the manifest
 *           extracted from it fails structural validation. The body carries a
 *           `violations` array listing every problem found.
 */
equipmentModelsRouter.post(
  "/equipment-types/:id/model",
  requireRole("SUPERUSER", "ADMIN"),
  handleUpload,
  // Params are annotated rather than inferred: with several handlers on one
  // route, Express falls back to its loose default where params are
  // string | string[].
  async (req: Request<{ id: string }>, res: Response) => {
    const glbFile = req.file;
    if (!glbFile) throw new AppError(400, "Missing required file field: glb");

    const model = await equipmentModelsService.uploadModel({
      equipmentTypeIdOrSlug: req.params.id,
      glbBuffer: glbFile.buffer,
      originalFilename: glbFile.originalname,
      uploadedBy: req.user?.id ?? null,
    });

    res.status(201).json(model);
  },
);

/**
 * @openapi
 * /equipment-types/{id}/model:
 *   get:
 *     tags: [Equipment 3D Models]
 *     summary: Get an equipment type's 3D manifest and a signed GLB download URL
 *     description: >
 *       Returns the active model by default. The manifest describes the GLB's
 *       node hierarchy — `nodes` is a flat map keyed by the object's name in
 *       the GLB, `roots` lists the top-level main_view nodes, and
 *       `index.by_slug_id` maps an equipment slug_id to the node name that
 *       represents it, so a raycast hit or a UI selection resolves in one
 *       lookup. `glb.download_url` is a short-lived signed URL that needs no
 *       Authorization header.
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         description: Either the equipment type's UUID or its public slug_id
 *         schema: { type: string }
 *       - in: query
 *         name: version
 *         required: false
 *         description: Fetch a specific version instead of the active one
 *         schema: { type: integer, minimum: 1 }
 *     responses:
 *       200:
 *         description: Manifest and signed GLB URL
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 id: { type: string, format: uuid }
 *                 slug_id: { type: string }
 *                 equipment_type_id: { type: string, format: uuid }
 *                 equipment_type_slug_id: { type: string }
 *                 version_number: { type: integer }
 *                 is_active: { type: boolean }
 *                 manifest_version: { type: string }
 *                 node_count: { type: integer }
 *                 manifest:
 *                   type: object
 *                   properties:
 *                     manifest_version: { type: string }
 *                     roots:
 *                       type: array
 *                       items: { type: string }
 *                     nodes:
 *                       type: object
 *                       description: Keyed by the object's name in the GLB.
 *                       additionalProperties:
 *                         type: object
 *                         properties:
 *                           node_name: { type: string }
 *                           slug_id: { type: string, nullable: true }
 *                           node_type: { type: string, enum: [main_view, sub_view, leaf] }
 *                           is_leaf: { type: boolean }
 *                           display_name: { type: string }
 *                           parent: { type: string, nullable: true }
 *                           children:
 *                             type: array
 *                             items: { type: string }
 *                     index:
 *                       type: object
 *                       properties:
 *                         by_slug_id:
 *                           type: object
 *                           description: slug_id -> node name.
 *                           additionalProperties: { type: string }
 *                 glb:
 *                   type: object
 *                   properties:
 *                     download_url: { type: string }
 *                     expires_at: { type: string, format: date-time }
 *                     original_filename: { type: string }
 *                     content_type: { type: string }
 *                     size_bytes: { type: integer }
 *                     checksum_sha256: { type: string }
 *       400:
 *         description: Invalid version query parameter
 *       404:
 *         description: Equipment type not found, or it has no model / no such version
 */
equipmentModelsRouter.get(
  "/equipment-types/:id/model",
  async (req, res) => {
    let versionNumber: number | undefined;
    if (req.query.version !== undefined) {
      versionNumber = Number(req.query.version);
      if (!Number.isInteger(versionNumber) || versionNumber < 1) {
        throw new AppError(400, "version must be a positive integer");
      }
    }

    // requireAuth guarantees req.user, so the download URL is always issued to
    // an identified caller.
    if (!req.user) throw new AppError(401, "Authentication required");

    const details = await equipmentModelsService.getModelDetailsDto(
      req.params.id,
      versionNumber,
      req.user.id,
    );
    res.json(details);
  },
);
