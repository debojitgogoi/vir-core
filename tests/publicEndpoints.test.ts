import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import request from "supertest";
import { app } from "../src/app";
import { closeDb, resetDb } from "./helpers/db";

/**
 * Regression coverage for a router-ordering bug: depotsRouter used to apply
 * requireAuth with no path prefix, and because it was mounted at "/" ahead of
 * appConfigRouter, requireAuth rejected every request — including ones bound
 * for a later, intentionally public router — before it ever got there.
 */

before(async () => {
  await resetDb();
});

after(async () => {
  await closeDb();
});

test("GET /health requires no authentication", async () => {
  const res = await request(app).get("/health");
  assert.equal(res.status, 200);
});

test("GET /app-config requires no authentication", async () => {
  const res = await request(app).get("/app-config");
  assert.equal(res.status, 200);
});

test("a media download URL reaches its handler without an Authorization header", async () => {
  // The token in the path IS the credential, so this route must sit ahead of
  // every router that applies requireAuth. A 401 here would mean a router-wide
  // guard has crept back in; the token is deliberately nonsense, so reaching
  // the handler and being told the token is bad is the passing outcome.
  const res = await request(app).get("/assets/media/not-a-real-token");

  assert.equal(res.status, 401);
  assert.match(
    res.body.error,
    /download token/,
    "the refusal comes from the download handler, not from requireAuth",
  );
});
