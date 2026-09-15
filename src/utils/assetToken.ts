/**
 * Short-lived signed tokens for asset download URLs.
 *
 * The token travels in the URL path rather than an Authorization header, so a
 * GLTFLoader, a <model-viewer>, an <img> tag or a native downloader can fetch
 * the asset directly. This is the same contract an S3 presigned URL provides,
 * which is what lets the storage backend change later without touching any
 * client.
 *
 * Two asset classes share this machinery: GLB models and media photographs.
 * Their signing secrets both fall back to JWT_SECRET, so a shared key is the
 * normal case rather than a misconfiguration — which is why the `typ` claim,
 * not the key, is what stops a token minted for one class from fetching the
 * other.
 */

import jwt from "jsonwebtoken";
import { env } from "../config/env";

const GLB_TOKEN_TYPE = "glb";
const MEDIA_TOKEN_TYPE = "media";

export interface AssetTokenPayload {
  /** Token type, guarding against a token minted for another purpose. */
  typ: string;
  /** The asset's id: equipment_type_models.id for GLB, media_assets.id for media. */
  mid: string;
  /** The user the URL was issued to. */
  sub: string;
}

export interface SignedAssetUrl {
  token: string;
  expiresAt: string;
  ttlSeconds: number;
}

function signAssetToken(
  type: string,
  secret: string,
  ttlSeconds: number,
  assetId: string,
  userId: string,
): SignedAssetUrl {
  const token = jwt.sign({ typ: type, mid: assetId, sub: userId }, secret, {
    expiresIn: ttlSeconds,
  });

  return {
    token,
    expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString(),
    ttlSeconds,
  };
}

/**
 * @returns the payload, or null when the token is expired, tampered with, or
 * was minted for a different purpose.
 */
function verifyAssetToken(
  type: string,
  secret: string,
  token: string,
): AssetTokenPayload | null {
  try {
    const payload = jwt.verify(token, secret) as Partial<AssetTokenPayload>;
    if (
      payload.typ !== type ||
      typeof payload.mid !== "string" ||
      typeof payload.sub !== "string"
    ) {
      return null;
    }
    return { typ: payload.typ, mid: payload.mid, sub: payload.sub };
  } catch {
    return null;
  }
}

export function signGlbToken(modelId: string, userId: string): SignedAssetUrl {
  return signAssetToken(
    GLB_TOKEN_TYPE,
    env.glbUrlSecret,
    env.glbUrlTtlSeconds,
    modelId,
    userId,
  );
}

export function verifyGlbToken(token: string): AssetTokenPayload | null {
  return verifyAssetToken(GLB_TOKEN_TYPE, env.glbUrlSecret, token);
}

export function signMediaToken(mediaId: string, userId: string): SignedAssetUrl {
  return signAssetToken(
    MEDIA_TOKEN_TYPE,
    env.mediaUrlSecret,
    env.mediaUrlTtlSeconds,
    mediaId,
    userId,
  );
}

export function verifyMediaToken(token: string): AssetTokenPayload | null {
  return verifyAssetToken(MEDIA_TOKEN_TYPE, env.mediaUrlSecret, token);
}
