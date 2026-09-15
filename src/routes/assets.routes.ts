import { Router } from "express";
import { env } from "../config/env";
import { AppError } from "../middleware/errors";
import * as equipmentModelsService from "../services/equipmentModels.service";
import * as mediaService from "../services/media.service";
import { verifyGlbToken, verifyMediaToken } from "../utils/assetToken";

export const assetsRouter = Router();

/**
 * @openapi
 * /assets/glb/{token}:
 *   get:
 *     tags: [Equipment 3D Models]
 *     summary: Download a GLB via a signed, short-lived URL
 *     description: >
 *       Deliberately unauthenticated in the usual sense — the token in the path
 *       IS the credential. That lets a GLTFLoader, a <model-viewer> element, or
 *       a native downloader fetch the asset without setting an Authorization
 *       header. Obtain the URL from GET /equipment-types/{id}/model. Range
 *       requests and conditional GETs (ETag) are supported, so a partial
 *       download can be resumed.
 *     parameters:
 *       - in: path
 *         name: token
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: The GLB file
 *         content:
 *           model/gltf-binary:
 *             schema: { type: string, format: binary }
 *       401:
 *         description: Token is invalid, expired, or was minted for another purpose
 *       404:
 *         description: The model the token points at no longer exists
 *       410:
 *         description: The model row exists but its file is gone from storage
 */
// The handler's params type is inferred from the path literal; annotating req
// as a bare Request would widen it to string | string[] under Express 5.
assetsRouter.get("/assets/glb/:token", async (req, res) => {
  const payload = verifyGlbToken(req.params.token);
  if (!payload) throw new AppError(401, "Invalid or expired download token");

  const { row, absolutePath } = await equipmentModelsService.resolveGlbForDownload(payload.mid);

  res.type(row.content_type);
  res.setHeader("ETag", `"${row.checksum_sha256}"`);
  // The response is user-specific only insofar as the URL is; the bytes are
  // immutable for a given checksum, so caching it privately for the life of
  // the token is safe and saves re-downloading a large model.
  res.setHeader("Cache-Control", `private, max-age=${env.glbUrlTtlSeconds}`);

  // sendFile handles Range requests, conditional GETs and streaming for us,
  // which matters for multi-megabyte models on a flaky site connection.
  res.sendFile(absolutePath, { headers: { "Content-Disposition": `attachment; filename="${row.original_filename}"` } }, (err) => {
    if (!err) return;
    // The client aborting mid-download is normal, not an error worth logging.
    if (res.headersSent || res.destroyed) return;
    console.error("Failed to send GLB file:", err);
    res.status(500).json({ error: "Failed to read the GLB file" });
  });
});

/**
 * @openapi
 * /assets/media/{token}:
 *   get:
 *     tags: [Media]
 *     summary: Download a photograph via a signed, short-lived URL
 *     description: >
 *       Deliberately unauthenticated in the usual sense — the token in the path
 *       IS the credential, so an <img> tag or a native downloader can fetch the
 *       file without setting an Authorization header. Obtain the URL from
 *       GET /depots/{depotId}/media/{mediaId}/url. A token minted for a GLB
 *       model cannot be redeemed here, and vice versa.
 *     parameters:
 *       - in: path
 *         name: token
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: The image
 *       401:
 *         description: Token is invalid, expired, or was minted for another purpose
 *       404:
 *         description: The asset the token points at no longer exists
 *       410:
 *         description: The asset row exists but its file is gone from storage
 */
assetsRouter.get("/assets/media/:token", async (req, res) => {
  const payload = verifyMediaToken(req.params.token);
  if (!payload) throw new AppError(401, "Invalid or expired download token");

  const { row, absolutePath } = await mediaService.resolveMediaForDownload(payload.mid);

  res.type(row.content_type);
  res.setHeader("ETag", `"${row.checksum_sha256}"`);
  // The bytes are immutable for a given checksum, so caching privately for the
  // life of the token is safe and saves re-fetching on every render.
  res.setHeader("Cache-Control", `private, max-age=${env.mediaUrlTtlSeconds}`);

  // inline rather than attachment: these are photographs a client displays in
  // place, not files a user is expected to save.
  res.sendFile(absolutePath, { headers: { "Content-Disposition": "inline" } }, (err) => {
    if (!err) return;
    // A client aborting mid-download is normal, not an error worth logging.
    if (res.headersSent || res.destroyed) return;
    console.error("Failed to send media file:", err);
    res.status(500).json({ error: "Failed to read the media file" });
  });
});
