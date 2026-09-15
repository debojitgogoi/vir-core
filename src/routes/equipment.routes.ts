import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import * as equipmentService from "../services/equipment.service";

export const equipmentRouter = Router();

equipmentRouter.use(requireAuth);

/**
 * @openapi
 * /equipment-categories:
 *   get:
 *     tags: [Equipment]
 *     summary: List equipment categories with their prefixes and equipment types
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: List of equipment categories
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: object
 *                 properties:
 *                   id: { type: string, format: uuid }
 *                   name: { type: string }
 *                   is_disabled: { type: boolean }
 *                   prefixes:
 *                     type: array
 *                     items:
 *                       type: object
 *                       properties:
 *                         id: { type: string, format: uuid }
 *                         prefix_name: { type: string }
 *                   equipment_types:
 *                     type: array
 *                     items:
 *                       type: object
 *                       properties:
 *                         id: { type: string, format: uuid }
 *                         name: { type: string }
 */
equipmentRouter.get("/equipment-categories", async (_req, res) => {
  const categories = await equipmentService.listEquipmentCategoriesDto();
  res.json(categories);
});

/**
 * @openapi
 * /equipment-categories/{slugId}:
 *   get:
 *     tags: [Equipment]
 *     summary: Get an equipment category by its public slug_id
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: slugId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Equipment category found
 *       404:
 *         description: Equipment category not found
 */
equipmentRouter.get("/equipment-categories/:slugId", async (req, res) => {
  const category = await equipmentService.getEquipmentCategoryBySlugIdDto(req.params.slugId);
  res.json(category);
});

/**
 * @openapi
 * /equipment-types/{id}:
 *   get:
 *     tags: [Equipment]
 *     summary: Get an equipment type's details, including its main-view/subview tree
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         description: Either the equipment type's UUID or its public slug_id
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: >
 *           Equipment type details with a hierarchical view tree. Damage
 *           codes, repair codes, and widget types are normalized into
 *           top-level dictionaries keyed by id (damage_codes, repair_codes,
 *           widget_types); tree nodes reference them by id (damage_code_ids,
 *           repair_code_ids, widget_type_id) instead of embedding the full
 *           object at every usage. main_views is a list of root nodes, each
 *           with a `children` array of subview nodes recursing in the same
 *           shape (id, name, header, component_id, children,
 *           damage_code_ids, repair_code_ids, quick_actions, fields).
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 id: { type: string, format: uuid }
 *                 equipment_category_id: { type: string, format: uuid }
 *                 name: { type: string }
 *                 is_disabled: { type: boolean }
 *                 damage_codes:
 *                   type: object
 *                   description: Keyed by damage code id.
 *                   additionalProperties:
 *                     type: object
 *                     properties:
 *                       damage_code: { type: string }
 *                       damage_description: { type: string, nullable: true }
 *                 repair_codes:
 *                   type: object
 *                   description: Keyed by repair code id.
 *                   additionalProperties:
 *                     type: object
 *                     properties:
 *                       repair_code: { type: string }
 *                       repair_description: { type: string, nullable: true }
 *                 widget_types:
 *                   type: object
 *                   description: Keyed by widget type id.
 *                   additionalProperties:
 *                     type: object
 *                     properties:
 *                       name: { type: string }
 *                 main_views:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id: { type: string, format: uuid }
 *                       name: { type: string }
 *                       bubble_name: { type: string, nullable: true }
 *                       label_name: { type: string, nullable: true }
 *                       sequence_number: { type: integer, nullable: true }
 *                       quick_actions:
 *                         type: array
 *                         items:
 *                           type: object
 *                           properties:
 *                             id: { type: string, format: uuid }
 *                             action_name: { type: string }
 *                             repair_code_id: { type: string, format: uuid, nullable: true }
 *                             component_id: { type: string, format: uuid, nullable: true }
 *                       children:
 *                         type: array
 *                         description: Subview nodes, recursing in the same shape via their own `children`.
 *                         items: { type: object }
 *       404:
 *         description: Equipment type not found
 */
equipmentRouter.get("/equipment-types/:id", async (req, res) => {
  const details = await equipmentService.getEquipmentTypeDetailsDto(req.params.id);
  res.json(details);
});
