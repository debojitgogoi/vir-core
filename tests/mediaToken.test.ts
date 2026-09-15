import assert from "node:assert/strict";
import { test } from "node:test";
import jwt from "jsonwebtoken";
import { env } from "../src/config/env";
import {
  signGlbToken,
  signMediaToken,
  verifyGlbToken,
  verifyMediaToken,
} from "../src/utils/assetToken";

const MEDIA_ID = "11111111-2222-3333-4444-555555555555";
const USER_ID = "99999999-8888-7777-6666-555555555555";

test("a media token round-trips its subject and media id", () => {
  const signed = signMediaToken(MEDIA_ID, USER_ID);
  const payload = verifyMediaToken(signed.token);

  assert.equal(payload!.mid, MEDIA_ID);
  assert.equal(payload!.sub, USER_ID);
  assert.equal(signed.ttlSeconds, env.mediaUrlTtlSeconds);
  assert.ok(Date.parse(signed.expiresAt) > Date.now());
});

test("a GLB token cannot fetch media, and a media token cannot fetch a GLB", () => {
  const media = signMediaToken(MEDIA_ID, USER_ID);
  const glb = signGlbToken(MEDIA_ID, USER_ID);

  assert.equal(verifyGlbToken(media.token), null, "the typ claim keeps the two apart");
  assert.equal(verifyMediaToken(glb.token), null);
});

test("the typ claim, not the signing key, is what separates the token types", () => {
  // Both secrets fall back to JWT_SECRET when nothing else is configured, so a
  // shared key is the normal case rather than a misconfiguration. If separation
  // depended on the key, the two token types would be interchangeable by
  // default — which is the bug this test exists to prevent.
  assert.equal(
    env.mediaUrlSecret,
    env.glbUrlSecret,
    "test environment shares one secret, as a default deployment would",
  );

  const glb = signGlbToken(MEDIA_ID, USER_ID);
  assert.ok(jwt.verify(glb.token, env.mediaUrlSecret), "the signature alone still checks out");
  assert.equal(verifyMediaToken(glb.token), null, "but the type check refuses it");
});

test("a tampered or malformed media token verifies as null", () => {
  const signed = signMediaToken(MEDIA_ID, USER_ID);

  assert.equal(verifyMediaToken(`${signed.token}x`), null);
  assert.equal(verifyMediaToken("not-a-jwt"), null);
  assert.equal(verifyMediaToken(""), null);
});

test("an expired media token verifies as null", () => {
  const expired = jwt.sign({ typ: "media", mid: MEDIA_ID, sub: USER_ID }, env.mediaUrlSecret, {
    expiresIn: -10,
  });

  assert.equal(verifyMediaToken(expired), null);
});

test("a token missing its claims verifies as null", () => {
  const noMid = jwt.sign({ typ: "media", sub: USER_ID }, env.mediaUrlSecret, { expiresIn: 60 });
  const noSub = jwt.sign({ typ: "media", mid: MEDIA_ID }, env.mediaUrlSecret, { expiresIn: 60 });

  assert.equal(verifyMediaToken(noMid), null);
  assert.equal(verifyMediaToken(noSub), null);
});

test("GLB tokens keep working exactly as before", () => {
  const signed = signGlbToken(MEDIA_ID, USER_ID);
  const payload = verifyGlbToken(signed.token);

  assert.equal(payload!.typ, "glb");
  assert.equal(payload!.mid, MEDIA_ID);
  assert.equal(signed.ttlSeconds, env.glbUrlTtlSeconds);
});
