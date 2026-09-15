import { Router } from "express";
import * as authService from "../services/auth.service";
import { AppError } from "../middleware/errors";

export const authRouter = Router();

/**
 * @openapi
 * /auth/login:
 *   post:
 *     tags: [Auth]
 *     summary: Log in with email and password
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email, password]
 *             properties:
 *               email: { type: string, format: email }
 *               password: { type: string, format: password }
 *     responses:
 *       200:
 *         description: Login successful, returns access/refresh tokens and the user profile
 *       400:
 *         description: Missing email or password
 *       401:
 *         description: Invalid credentials
 */
authRouter.post("/auth/login", async (req, res) => {
  const { email, password } = req.body ?? {};
  if (!email || !password) throw new AppError(400, "email and password are required");
  const result = await authService.login(email, password);
  res.json(result);
});

/**
 * @openapi
 * /auth/refresh:
 *   post:
 *     tags: [Auth]
 *     summary: Rotate a refresh token for a new access/refresh token pair
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [refreshToken]
 *             properties:
 *               refreshToken: { type: string }
 *     responses:
 *       200:
 *         description: New access/refresh token pair issued
 *       400:
 *         description: Missing refreshToken
 *       401:
 *         description: Invalid, expired, or already-used refresh token
 */
authRouter.post("/auth/refresh", async (req, res) => {
  const { refreshToken } = req.body ?? {};
  if (!refreshToken) throw new AppError(400, "refreshToken is required");
  const result = await authService.refresh(refreshToken);
  res.json(result);
});

/**
 * @openapi
 * /auth/logout:
 *   post:
 *     tags: [Auth]
 *     summary: Revoke a refresh token (current session only)
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [refreshToken]
 *             properties:
 *               refreshToken: { type: string }
 *     responses:
 *       204:
 *         description: Logged out (idempotent, always succeeds if refreshToken is present)
 *       400:
 *         description: Missing refreshToken
 */
authRouter.post("/auth/logout", async (req, res) => {
  const { refreshToken } = req.body ?? {};
  if (!refreshToken) throw new AppError(400, "refreshToken is required");
  await authService.logout(refreshToken);
  res.status(204).send();
});
