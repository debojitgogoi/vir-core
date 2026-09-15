import crypto from "crypto";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { env } from "../config/env";
import { AppError } from "../middleware/errors";
import { findUserByEmail, findUserById, PublicUser, toPublicUser } from "../db/users.repo";
import {
  createRefreshToken,
  findRefreshTokenByHash,
  revokeRefreshToken,
} from "../db/refreshTokens.repo";

const ACCESS_TOKEN_TTL = "15m";
const REFRESH_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

async function issueTokenPair(userId: string, role: string): Promise<TokenPair> {
  const accessToken = jwt.sign({ sub: userId, role }, env.jwtSecret, {
    expiresIn: ACCESS_TOKEN_TTL,
  });
  const refreshToken = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_MS);
  await createRefreshToken(userId, hashToken(refreshToken), expiresAt);
  return { accessToken, refreshToken };
}

export async function login(
  email: string,
  password: string,
): Promise<TokenPair & { user: PublicUser }> {
  const user = await findUserByEmail(email);
  if (!user) throw new AppError(401, "Invalid email or password");

  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) throw new AppError(401, "Invalid email or password");

  const tokens = await issueTokenPair(user.id, user.role);
  return { user: toPublicUser(user), ...tokens };
}

export async function refresh(refreshToken: string): Promise<TokenPair> {
  const tokenHash = hashToken(refreshToken);
  const stored = await findRefreshTokenByHash(tokenHash);
  if (!stored || stored.revoked_at || stored.expires_at < new Date()) {
    throw new AppError(401, "Invalid or expired refresh token");
  }

  const user = await findUserById(stored.user_id);
  if (!user) throw new AppError(401, "Invalid or expired refresh token");

  await revokeRefreshToken(stored.id);
  return issueTokenPair(user.id, user.role);
}

export async function logout(refreshToken: string): Promise<void> {
  const tokenHash = hashToken(refreshToken);
  const stored = await findRefreshTokenByHash(tokenHash);
  if (stored && !stored.revoked_at) {
    await revokeRefreshToken(stored.id);
  }
}
