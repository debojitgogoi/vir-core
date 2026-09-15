import { Router } from "express";
import { requireAuth, requireRole } from "../middleware/auth";
import * as usersService from "../services/users.service";

export const usersRouter = Router();

usersRouter.use("/users", requireAuth, requireRole("SUPERUSER", "ADMIN"));

/**
 * @openapi
 * /users:
 *   post:
 *     tags: [Users]
 *     summary: Create a user (SUPERUSER/ADMIN only)
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email, password, role]
 *             properties:
 *               email: { type: string }
 *               password: { type: string }
 *               role: { type: string, enum: [SUPERUSER, MECHANIC, ESTIMATOR, ADMIN] }
 *               name: { type: string }
 *               location: { type: string }
 *               employeeId: { type: string }
 *               designation: { type: string }
 *     responses:
 *       201:
 *         description: User created
 *       400:
 *         description: Missing/invalid fields
 *       403:
 *         description: Caller is not SUPERUSER/ADMIN
 *       409:
 *         description: Email already exists
 */
usersRouter.post("/users", async (req, res) => {
  const user = await usersService.createUserByAdmin(req.body ?? {});
  res.status(201).json(user);
});

/**
 * @openapi
 * /users:
 *   get:
 *     tags: [Users]
 *     summary: List users, optionally filtered (SUPERUSER/ADMIN only)
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: query
 *         name: role
 *         schema: { type: string }
 *       - in: query
 *         name: location
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: List of users
 *       403:
 *         description: Caller is not SUPERUSER/ADMIN
 */
usersRouter.get("/users", async (req, res) => {
  const { role, location } = req.query;
  const users = await usersService.listAllUsers({
    role: typeof role === "string" ? role : undefined,
    location: typeof location === "string" ? location : undefined,
  });
  res.json(users);
});

/**
 * @openapi
 * /users/{id}:
 *   get:
 *     tags: [Users]
 *     summary: Get a user by id (SUPERUSER/ADMIN only)
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: User found
 *       403:
 *         description: Caller is not SUPERUSER/ADMIN
 *       404:
 *         description: User not found
 */
usersRouter.get("/users/:id", async (req, res) => {
  const user = await usersService.getUserById(req.params.id);
  res.json(user);
});

/**
 * @openapi
 * /users/{id}:
 *   patch:
 *     tags: [Users]
 *     summary: Update any field on a user, including role/employeeId/designation (SUPERUSER/ADMIN only)
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               email: { type: string }
 *               name: { type: string }
 *               location: { type: string }
 *               role: { type: string, enum: [SUPERUSER, MECHANIC, ESTIMATOR, ADMIN] }
 *               employeeId: { type: string }
 *               designation: { type: string }
 *     responses:
 *       200:
 *         description: Updated user
 *       403:
 *         description: Caller is not SUPERUSER/ADMIN
 *       404:
 *         description: User not found
 *       409:
 *         description: Email already in use by another user
 */
usersRouter.patch("/users/:id", async (req, res) => {
  const user = await usersService.updateUserByAdmin(req.params.id, req.body ?? {});
  res.json(user);
});
