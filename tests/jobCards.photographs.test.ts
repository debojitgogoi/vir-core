import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import request from "supertest";
import { app } from "../src/app";
import { closeDb, resetDb } from "./helpers/db";
import { bearerFor, createTestUser } from "./helpers/auth";
import { isS3Enabled } from "../src/storage/s3Client";
import {
  addDepotMember,
  seedDepot,
  seedEquipmentType,
  seedJobCard,
  seedMediaAsset,
} from "./helpers/fixtures";

beforeEach(async () => {
  await resetDb();
});

after(async () => {
  await closeDb();
});

const readyAsset = (depotId: string) => seedMediaAsset(depotId, { status: "READY", sizeBytes: 4096 });

test("photographs lists two line shots in item order then the chassis shot", async () => {
  const depotId = await seedDepot();
  const jobCardId = await seedJobCard(depotId, await seedEquipmentType());
  const user = await createTestUser({ role: "MECHANIC" });
  await addDepotMember(depotId, user.id);
  const auth = bearerFor(user.id, user.role);

  const first = await request(app)
    .post(`/job-cards/${jobCardId}/items`)
    .set("Authorization", auth)
    .send({ notes: "first line" });
  const second = await request(app)
    .post(`/job-cards/${jobCardId}/items`)
    .set("Authorization", auth)
    .send({ notes: "second line" });
  assert.equal(first.status, 201);
  assert.equal(second.status, 201);

  const firstPhoto = await readyAsset(depotId);
  const secondPhoto = await readyAsset(depotId);
  const chassis = await readyAsset(depotId);

  assert.equal(
    (
      await request(app)
        .post(`/job-cards/${jobCardId}/items/${second.body.id}/media`)
        .set("Authorization", auth)
        .send({ media_id: secondPhoto })
    ).status,
    201,
  );
  assert.equal(
    (
      await request(app)
        .post(`/job-cards/${jobCardId}/items/${first.body.id}/media`)
        .set("Authorization", auth)
        .send({ media_id: firstPhoto })
    ).status,
    201,
  );
  assert.equal(
    (
      await request(app)
        .post(`/job-cards/${jobCardId}/media`)
        .set("Authorization", auth)
        .send({ media_id: chassis, kind: "CHASSIS" })
    ).status,
    201,
  );

  const res = await request(app)
    .get(`/job-cards/${jobCardId}/photographs`)
    .set("Authorization", auth);

  assert.equal(res.status, 200);
  assert.equal(res.body.length, 3);
  assert.equal(res.body[0].id, firstPhoto);
  assert.equal(res.body[0].item_id, first.body.id);
  assert.match(res.body[0].url, /^\/assets\/media\/.+/);
  if (isS3Enabled()) {
    assert.match(res.body[0].download_url, /^https:\/\//);
  } else {
    assert.equal(res.body[0].download_url, undefined);
  }
  assert.equal(res.body[1].id, secondPhoto);
  assert.equal(res.body[1].item_id, second.body.id);
  assert.equal(res.body[2].id, chassis);
  assert.equal(res.body[2].item_id, null);
  assert.equal(res.body[2].kind, "CHASSIS");
  assert.equal(res.body[2].component_code, null);
});
