import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import request from "supertest";
import { app } from "../src/app";
import { closeDb, resetDb } from "./helpers/db";
import { bearerFor, createTestUser } from "./helpers/auth";

before(async () => {
  await resetDb();
});

after(async () => {
  await closeDb();
});

test("GET /health reports a connected database", async () => {
  const res = await request(app).get("/health");
  assert.equal(res.status, 200);
  assert.equal(res.body.db, "connected");
});

test("a minted bearer token is accepted by requireAuth", async () => {
  const user = await createTestUser({ role: "ADMIN" });
  const res = await request(app)
    .get("/me")
    .set("Authorization", bearerFor(user.id, user.role));

  assert.equal(res.status, 200);
  assert.equal(res.body.email, user.email);
});

test("a request without a token is rejected", async () => {
  const res = await request(app).get("/me");
  assert.equal(res.status, 401);
});
