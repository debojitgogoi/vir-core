import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import { after, beforeEach, test } from "node:test";
import request from "supertest";
import { app } from "../src/app";
import { pool } from "../src/db/pool";
import { env } from "../src/config/env";
import * as storage from "../src/storage/mediaStorage";
import { signGlbToken, signMediaToken } from "../src/utils/assetToken";
import { closeDb, resetDb } from "./helpers/db";
import { bearerFor, createTestUser } from "./helpers/auth";
import { addDepotMember, seedDepot, seedEquipmentType } from "./helpers/fixtures";
import { Role } from "../src/types";

beforeEach(async () => {
  await resetDb();
});

after(async () => {
  await closeDb();
  if (process.env.STORAGE_ROOT) {
    await fs.rm(process.env.STORAGE_ROOT, { recursive: true, force: true });
  }
});

function photo(): Buffer {
  return Buffer.from(`photo-${crypto.randomUUID()}`);
}

const declare = (bytes: Buffer, contentType = "image/jpeg") => ({
  content_type: contentType,
  size_bytes: bytes.length,
  checksum_sha256: storage.sha256(bytes),
  filename: "shot.jpg",
});

async function memberAt(depotId: string, role: Role = "MECHANIC") {
  const user = await createTestUser({ role });
  await addDepotMember(depotId, user.id);
  return { user, auth: bearerFor(user.id, user.role) };
}

async function scenario() {
  const depotId = await seedDepot();
  const equipmentTypeId = await seedEquipmentType();
  const { auth } = await memberAt(depotId);

  const created = await request(app)
    .post(`/depots/${depotId}/job-cards`)
    .set("Authorization", auth)
    .send({ direction: "INBOUND", equipment_type_id: equipmentTypeId, chassis_number: "CHS-1" });

  return { depotId, equipmentTypeId, auth, cardId: created.body.id as string };
}

function register(depotId: string, auth: string, body: Record<string, unknown>) {
  return request(app).post(`/depots/${depotId}/media`).set("Authorization", auth).send(body);
}

function putBytes(
  depotId: string,
  mediaId: string,
  auth: string,
  bytes: Buffer,
  contentType = "image/jpeg",
) {
  return request(app)
    .put(`/depots/${depotId}/media/${mediaId}/content`)
    .set("Authorization", auth)
    .attach("file", bytes, { filename: "shot.jpg", contentType });
}

/** Register and upload, returning the media id. */
async function uploaded(depotId: string, auth: string, bytes = photo()): Promise<string> {
  const registered = await register(depotId, auth, declare(bytes));
  await putBytes(depotId, registered.body.id, auth, bytes);
  return registered.body.id as string;
}

test("the full round trip: register, upload, attach, read the card", async () => {
  const { depotId, auth, cardId } = await scenario();
  const bytes = photo();

  const registered = await register(depotId, auth, declare(bytes));
  assert.equal(registered.status, 201);
  assert.equal(registered.body.status, "PENDING");

  const put = await putBytes(depotId, registered.body.id, auth, bytes);
  assert.equal(put.status, 200);
  assert.equal(put.body.status, "READY");

  const attached = await request(app)
    .post(`/job-cards/${cardId}/media`)
    .set("Authorization", auth)
    .send({ media_id: registered.body.id, kind: "DRIVER_LICENSE" });
  assert.equal(attached.status, 201);

  const card = await request(app).get(`/job-cards/${cardId}`).set("Authorization", auth);
  assert.equal(card.status, 200);
  assert.equal(card.body.media.length, 1);
  assert.equal(card.body.media[0].kind, "DRIVER_LICENSE");
  assert.ok(card.body.media[0].url, "the card read carries a usable URL per attachment");

  const download = await request(app).get(card.body.media[0].url);
  assert.equal(download.status, 200);
  assert.deepEqual(download.body, bytes, "the bytes come back byte-for-byte");
});

test("a signed media URL needs no Authorization header", async () => {
  const { depotId, auth } = await scenario();
  const bytes = photo();
  const mediaId = await uploaded(depotId, auth, bytes);

  const signed = await request(app)
    .get(`/depots/${depotId}/media/${mediaId}/url`)
    .set("Authorization", auth);
  assert.equal(signed.status, 200);

  const download = await request(app).get(signed.body.url);
  assert.equal(download.status, 200, "the token in the path is the credential");
});

test("registering with no token is 401", async () => {
  const depotId = await seedDepot();
  const res = await request(app).post(`/depots/${depotId}/media`).send(declare(photo()));
  assert.equal(res.status, 401);
});

test("uploading with no token is 401", async () => {
  const { depotId, auth } = await scenario();
  const bytes = photo();
  const registered = await register(depotId, auth, declare(bytes));

  const res = await request(app)
    .put(`/depots/${depotId}/media/${registered.body.id}/content`)
    .attach("file", bytes, { filename: "shot.jpg", contentType: "image/jpeg" });

  assert.equal(res.status, 401);
});

test("a member of another depot cannot upload to this depot's asset", async () => {
  const { depotId, auth } = await scenario();
  const bytes = photo();
  const registered = await register(depotId, auth, declare(bytes));

  const otherDepot = await seedDepot();
  const { auth: outsider } = await memberAt(otherDepot);

  const res = await putBytes(otherDepot, registered.body.id, outsider, bytes);
  assert.equal(res.status, 404, "404 rather than 403, so the asset's existence is not confirmed");
});

test("uploading the wrong bytes is 422 CHECKSUM_MISMATCH", async () => {
  const { depotId, auth } = await scenario();
  const registered = await register(depotId, auth, declare(photo()));

  const res = await putBytes(depotId, registered.body.id, auth, Buffer.from("not the same bytes"));

  assert.equal(res.status, 422);
  assert.equal(res.body.code, "CHECKSUM_MISMATCH");
});

test("registering an oversized file is refused before any upload", async () => {
  const { depotId, auth } = await scenario();

  const res = await register(depotId, auth, {
    ...declare(photo()),
    size_bytes: env.mediaMaxBytes + 1,
  });

  assert.equal(res.status, 400);
  assert.equal(res.body.code, "VALIDATION_ERROR");
});

test("an unsupported content type is refused at registration", async () => {
  const { depotId, auth } = await scenario();

  const res = await register(depotId, auth, { ...declare(photo()), content_type: "application/pdf" });
  assert.equal(res.status, 400);
});

test("a malformed checksum is refused at registration", async () => {
  const { depotId, auth } = await scenario();

  const res = await register(depotId, auth, { ...declare(photo()), checksum_sha256: "nope" });
  assert.equal(res.status, 400);
});

test("attaching a PENDING asset is 409 MEDIA_NOT_READY", async () => {
  const { depotId, auth, cardId } = await scenario();
  const registered = await register(depotId, auth, declare(photo()));

  const res = await request(app)
    .post(`/job-cards/${cardId}/media`)
    .set("Authorization", auth)
    .send({ media_id: registered.body.id, kind: "CHASSIS" });

  assert.equal(res.status, 409);
  assert.equal(res.body.code, "MEDIA_NOT_READY");
});

test("attaching to a locked card is 409 JOB_CARD_LOCKED", async () => {
  const { depotId, auth, cardId } = await scenario();
  const mediaId = await uploaded(depotId, auth);

  await pool.query("UPDATE job_cards SET locked_at = now(), status = 'SUBMITTED' WHERE id = $1", [
    cardId,
  ]);

  const res = await request(app)
    .post(`/job-cards/${cardId}/media`)
    .set("Authorization", auth)
    .send({ media_id: mediaId, kind: "CHASSIS" });

  assert.equal(res.status, 409);
  assert.equal(res.body.code, "JOB_CARD_LOCKED");
});

test("detaching from a locked card is 409 JOB_CARD_LOCKED", async () => {
  const { depotId, auth, cardId } = await scenario();
  const mediaId = await uploaded(depotId, auth);
  await request(app)
    .post(`/job-cards/${cardId}/media`)
    .set("Authorization", auth)
    .send({ media_id: mediaId, kind: "CHASSIS" });

  await pool.query("UPDATE job_cards SET locked_at = now(), status = 'SUBMITTED' WHERE id = $1", [
    cardId,
  ]);

  const res = await request(app)
    .delete(`/job-cards/${cardId}/media/${mediaId}`)
    .set("Authorization", auth);

  assert.equal(res.status, 409);
  assert.equal(res.body.code, "JOB_CARD_LOCKED");
});

test("detaching an attached asset is 204 and removes it from the card", async () => {
  const { depotId, auth, cardId } = await scenario();
  const mediaId = await uploaded(depotId, auth);
  await request(app)
    .post(`/job-cards/${cardId}/media`)
    .set("Authorization", auth)
    .send({ media_id: mediaId, kind: "CHASSIS" });

  const res = await request(app)
    .delete(`/job-cards/${cardId}/media/${mediaId}`)
    .set("Authorization", auth);
  assert.equal(res.status, 204);

  const listed = await request(app)
    .get(`/job-cards/${cardId}/media`)
    .set("Authorization", auth);
  assert.deepEqual(listed.body, []);
});

test("registering at a disabled depot is 403 DEPOT_DISABLED", async () => {
  const { depotId, auth } = await scenario();
  await pool.query("UPDATE depots SET is_disabled = true WHERE id = $1", [depotId]);

  const res = await register(depotId, auth, declare(photo()));

  assert.equal(res.status, 403);
  assert.equal(res.body.code, "DEPOT_DISABLED", "the depot rule reaches media for free");
});

test("a GLB token cannot fetch media", async () => {
  const { depotId, auth } = await scenario();
  const mediaId = await uploaded(depotId, auth);
  const wrongToken = signGlbToken(mediaId, "00000000-0000-0000-0000-000000000000");

  const res = await request(app).get(`/assets/media/${wrongToken.token}`);
  assert.equal(res.status, 401);
});

test("an expired media token is 401", async () => {
  const { depotId, auth } = await scenario();
  const mediaId = await uploaded(depotId, auth);

  const original = env.mediaUrlTtlSeconds;
  try {
    (env as { mediaUrlTtlSeconds: number }).mediaUrlTtlSeconds = -10;
    const expired = signMediaToken(mediaId, "00000000-0000-0000-0000-000000000000");
    const res = await request(app).get(`/assets/media/${expired.token}`);
    assert.equal(res.status, 401);
  } finally {
    (env as { mediaUrlTtlSeconds: number }).mediaUrlTtlSeconds = original;
  }
});

test("a media token whose asset has lost its bytes is 410", async () => {
  const { depotId, auth } = await scenario();
  const bytes = photo();
  const mediaId = await uploaded(depotId, auth, bytes);

  const key = `media/${storage.sha256(bytes).slice(0, 2)}/${storage.sha256(bytes)}.jpg`;
  await fs.rm(storage.resolvePath(key));

  const signed = signMediaToken(mediaId, "00000000-0000-0000-0000-000000000000");
  const res = await request(app).get(`/assets/media/${signed.token}`);
  assert.equal(res.status, 410);
});

test("a malformed media id is 400, not 500", async () => {
  const { depotId, auth } = await scenario();
  const res = await request(app)
    .get(`/depots/${depotId}/media/not-a-uuid/url`)
    .set("Authorization", auth);
  assert.equal(res.status, 400);
});

test("a member of another depot cannot mint a download URL for this depot's media", async () => {
  const { depotId, auth } = await scenario();
  const mediaId = await uploaded(depotId, auth);

  const otherDepot = await seedDepot();
  const { auth: outsider } = await memberAt(otherDepot);

  const res = await request(app)
    .get(`/depots/${otherDepot}/media/${mediaId}/url`)
    .set("Authorization", outsider);

  assert.equal(
    res.status,
    404,
    "a signed URL needs no further credential to redeem, so minting one must be scoped",
  );
});
