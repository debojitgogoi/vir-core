import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import { after, beforeEach, test } from "node:test";
import * as service from "../src/services/media.service";
import { AppError } from "../src/middleware/errors";
import { pool } from "../src/db/pool";
import * as storage from "../src/storage/mediaStorage";
import { closeDb, resetDb } from "./helpers/db";
import { createTestUser } from "./helpers/auth";
import { seedDepot, seedEquipmentType } from "./helpers/fixtures";
import { generateJobNumber } from "../src/utils/jobNumber";

beforeEach(async () => {
  await resetDb();
});

after(async () => {
  await closeDb();
  if (process.env.STORAGE_ROOT) {
    await fs.rm(process.env.STORAGE_ROOT, { recursive: true, force: true });
  }
});

/** Distinct bytes per call, so no two tests share a content-addressed path. */
function photo(): Buffer {
  return Buffer.from(`photo-${crypto.randomUUID()}`);
}

function declare(bytes: Buffer, contentType = "image/jpeg") {
  return {
    content_type: contentType as "image/jpeg",
    size_bytes: bytes.length,
    checksum_sha256: storage.sha256(bytes),
    filename: "shot.jpg",
  };
}

async function context() {
  const depotId = await seedDepot();
  const equipmentTypeId = await seedEquipmentType();
  const user = await createTestUser({ role: "MECHANIC" });
  return { depotId, equipmentTypeId, actorId: user.id };
}

async function seedJobCard(depotId: string, equipmentTypeId: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO job_cards (job_number, depot_id, direction, equipment_type_id, chassis_number)
     VALUES ($1, $2, 'INBOUND', $3, 'CHS-1') RETURNING id`,
    [await generateJobNumber(), depotId, equipmentTypeId],
  );
  return rows[0].id;
}

/** Register and upload in one step, for tests about what happens afterwards. */
async function readyAsset(depotId: string, actorId: string, bytes = photo()) {
  const registered = await service.registerMedia(depotId, declare(bytes), actorId);
  return service.storeMediaContent(registered.id, bytes, "image/jpeg", {
    id: actorId,
    depotId,
  });
}

test("registering returns a PENDING asset with no bytes yet", async () => {
  const { depotId, actorId } = await context();
  const bytes = photo();

  const asset = await service.registerMedia(depotId, declare(bytes), actorId);

  assert.equal(asset.status, "PENDING");
  assert.equal(asset.size_bytes, bytes.length);
  assert.equal(asset.checksum_sha256, storage.sha256(bytes));
  assert.equal(asset.uploaded_by, actorId);
});

test("the DTO never exposes storage_key", async () => {
  const { depotId, actorId } = await context();
  const asset = await readyAsset(depotId, actorId);

  assert.ok(
    !("storage_key" in asset),
    "where the bytes live is mediaStorage's business, not a client's",
  );
});

test("uploading bytes whose checksum differs from the declaration is 422", async () => {
  const { depotId, actorId } = await context();
  const bytes = photo();
  const asset = await service.registerMedia(depotId, declare(bytes), actorId);

  await assert.rejects(
    () =>
      service.storeMediaContent(asset.id, Buffer.from("different bytes"), "image/jpeg", {
        id: actorId,
        depotId,
      }),
    (err: AppError) => err.status === 422 && err.code === "CHECKSUM_MISMATCH",
  );

  const still = await service.getMediaAsset(asset.id);
  assert.equal(still.status, "PENDING", "a failed upload must not promote the row");
});

test("a rejected upload writes nothing to disk", async () => {
  const { depotId, actorId } = await context();
  const bytes = photo();
  const wrong = Buffer.from("wrong bytes entirely");
  const asset = await service.registerMedia(depotId, declare(bytes), actorId);

  await assert.rejects(() =>
    service.storeMediaContent(asset.id, wrong, "image/jpeg", { id: actorId, depotId }),
  );

  const wrongKey = `media/${storage.sha256(wrong).slice(0, 2)}/${storage.sha256(wrong)}.jpg`;
  assert.equal(
    await storage.exists(wrongKey),
    false,
    "the checksum is verified before anything is written",
  );
});

test("uploading a content type that disagrees with the registration is 422", async () => {
  const { depotId, actorId } = await context();
  const bytes = photo();
  const asset = await service.registerMedia(depotId, declare(bytes, "image/png"), actorId);

  await assert.rejects(
    () => service.storeMediaContent(asset.id, bytes, "image/jpeg", { id: actorId, depotId }),
    (err: AppError) => err.status === 422,
  );
});

test("a successful upload promotes PENDING to READY and records the real size", async () => {
  const { depotId, actorId } = await context();
  const bytes = photo();
  const registered = await service.registerMedia(depotId, declare(bytes), actorId);

  const ready = await service.storeMediaContent(registered.id, bytes, "image/jpeg", {
    id: actorId,
    depotId,
  });

  assert.equal(ready.status, "READY");
  assert.equal(ready.size_bytes, bytes.length);
});

test("re-uploading identical bytes to a READY asset is idempotent", async () => {
  const { depotId, actorId } = await context();
  const bytes = photo();
  const first = await readyAsset(depotId, actorId, bytes);

  const second = await service.storeMediaContent(first.id, bytes, "image/jpeg", {
    id: actorId,
    depotId,
  });

  assert.equal(second.id, first.id, "a retry after a dropped connection is a retry, not a 409");
  assert.equal(second.status, "READY");
});

test("uploading to an asset registered at another depot is refused", async () => {
  const { depotId, actorId } = await context();
  const otherDepot = await seedDepot();
  const bytes = photo();
  const asset = await service.registerMedia(depotId, declare(bytes), actorId);

  await assert.rejects(
    () =>
      service.storeMediaContent(asset.id, bytes, "image/jpeg", {
        id: actorId,
        depotId: otherDepot,
      }),
    (err: AppError) => err.status === 404,
    "404 rather than 403: a 403 would confirm the asset exists to a caller scoped elsewhere",
  );
});

test("uploading to an unknown asset is 404", async () => {
  const { depotId, actorId } = await context();
  const bytes = photo();

  await assert.rejects(
    () =>
      service.storeMediaContent("00000000-0000-0000-0000-000000000000", bytes, "image/jpeg", {
        id: actorId,
        depotId,
      }),
    (err: AppError) => err.status === 404,
  );
});

test("attaching a PENDING asset is refused with 409 MEDIA_NOT_READY", async () => {
  const { depotId, equipmentTypeId, actorId } = await context();
  const cardId = await seedJobCard(depotId, equipmentTypeId);
  const bytes = photo();
  const pending = await service.registerMedia(depotId, declare(bytes), actorId);

  await assert.rejects(
    () =>
      service.attachToJobCard(cardId, { media_id: pending.id, kind: "CHASSIS" }, {
        id: actorId,
        depotId,
      }),
    (err: AppError) => err.status === 409 && err.code === "MEDIA_NOT_READY",
  );
});

test("attaching an asset registered at another depot is refused", async () => {
  const { depotId, equipmentTypeId, actorId } = await context();
  const cardId = await seedJobCard(depotId, equipmentTypeId);
  const otherDepot = await seedDepot();
  const foreign = await readyAsset(otherDepot, actorId);

  await assert.rejects(
    () =>
      service.attachToJobCard(cardId, { media_id: foreign.id, kind: "CHASSIS" }, {
        id: actorId,
        depotId,
      }),
    (err: AppError) => err.status === 404,
    "one yard's photographs must not reach another's card, nor be confirmed to exist",
  );
});

test("attaching the same asset twice to one card is idempotent", async () => {
  const { depotId, equipmentTypeId, actorId } = await context();
  const cardId = await seedJobCard(depotId, equipmentTypeId);
  const asset = await readyAsset(depotId, actorId);
  const actor = { id: actorId, depotId };

  await service.attachToJobCard(cardId, { media_id: asset.id, kind: "CHASSIS" }, actor);
  await service.attachToJobCard(cardId, { media_id: asset.id, kind: "CHASSIS" }, actor);

  const listed = await service.listForJobCard(cardId);
  assert.equal(listed.length, 1, "a retried attach is a retry, not a duplicate or a 409");
});

test("one asset may be attached to two different cards", async () => {
  const { depotId, equipmentTypeId, actorId } = await context();
  const first = await seedJobCard(depotId, equipmentTypeId);
  const second = await seedJobCard(depotId, equipmentTypeId);
  const asset = await readyAsset(depotId, actorId);
  const actor = { id: actorId, depotId };

  await service.attachToJobCard(first, { media_id: asset.id, kind: "CHASSIS" }, actor);
  await service.attachToJobCard(second, { media_id: asset.id, kind: "CHASSIS" }, actor);

  assert.equal((await service.listForJobCard(first)).length, 1);
  assert.equal((await service.listForJobCard(second)).length, 1);
});

test("listing a card's media returns each asset with its kind", async () => {
  const { depotId, equipmentTypeId, actorId } = await context();
  const cardId = await seedJobCard(depotId, equipmentTypeId);
  const actor = { id: actorId, depotId };

  const licence = await readyAsset(depotId, actorId);
  await service.attachToJobCard(cardId, { media_id: licence.id, kind: "DRIVER_LICENSE" }, actor);
  const chassis = await readyAsset(depotId, actorId);
  await service.attachToJobCard(cardId, { media_id: chassis.id, kind: "CHASSIS" }, actor);

  const listed = await service.listForJobCard(cardId);

  assert.equal(listed.length, 2);
  assert.deepEqual(
    listed.map((m) => m.kind).sort(),
    ["CHASSIS", "DRIVER_LICENSE"],
  );
});

test("detaching removes the link and leaves the asset row", async () => {
  const { depotId, equipmentTypeId, actorId } = await context();
  const cardId = await seedJobCard(depotId, equipmentTypeId);
  const asset = await readyAsset(depotId, actorId);
  await service.attachToJobCard(cardId, { media_id: asset.id, kind: "CHASSIS" }, {
    id: actorId,
    depotId,
  });

  await service.detachFromJobCard(cardId, asset.id);

  assert.deepEqual(await service.listForJobCard(cardId), []);
  assert.ok(
    await service.getMediaAsset(asset.id),
    "content-addressed bytes may be shared, so removing them is a reaper's job",
  );
});

test("detaching something that is not attached is a 404", async () => {
  const { depotId, equipmentTypeId, actorId } = await context();
  const cardId = await seedJobCard(depotId, equipmentTypeId);
  const asset = await readyAsset(depotId, actorId);

  await assert.rejects(
    () => service.detachFromJobCard(cardId, asset.id),
    (err: AppError) => err.status === 404,
  );
});

test("signing a URL for a READY asset yields a working token and an expiry", async () => {
  const { depotId, actorId } = await context();
  const asset = await readyAsset(depotId, actorId);

  const signed = await service.signMediaUrl(asset.id, { id: actorId, depotId });

  assert.match(signed.url, /^\/assets\/media\//);
  assert.ok(Date.parse(signed.expires_at) > Date.now());
});

test("signing a URL for a PENDING asset is refused", async () => {
  const { depotId, actorId } = await context();
  const bytes = photo();
  const pending = await service.registerMedia(depotId, declare(bytes), actorId);

  await assert.rejects(
    () => service.signMediaUrl(pending.id, { id: actorId, depotId }),
    (err: AppError) => err.status === 409 && err.code === "MEDIA_NOT_READY",
    "there is nothing to download yet",
  );
});

test("resolving for download returns the file, and 410s when the bytes are gone", async () => {
  const { depotId, actorId } = await context();
  const asset = await readyAsset(depotId, actorId);

  const resolved = await service.resolveMediaForDownload(asset.id);
  assert.ok(
    resolved.download.kind === "file",
    "the suite runs with no bucket configured, so the disk backend answers",
  );
  assert.ok(resolved.download.absolutePath.endsWith(".jpg"));

  await fs.rm(resolved.download.absolutePath);

  await assert.rejects(
    () => service.resolveMediaForDownload(asset.id),
    (err: AppError) => err.status === 410,
    "a row whose file has vanished is gone, not merely absent",
  );
});
