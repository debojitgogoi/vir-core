/**
 * S3 transport for asset bytes.
 *
 * Only the S3 calls live here. Key layout, extension mapping and size limits
 * stay in glbStorage.ts and mediaStorage.ts, which differ enough in all three
 * that sharing them would be guessing at a shape neither has.
 *
 * Credentials come from the environment the process already runs in — the
 * Beanstalk EC2 instance profile in production, the developer's own chain
 * locally. No key is ever read from a variable, so none can leak into a log.
 */

import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { env } from "../config/env";

let client: S3Client | null = null;

/**
 * Whether bytes belong in S3. False means the local-disk backend, which is how
 * development and the test suite run without an AWS account.
 */
export function isS3Enabled(): boolean {
  return env.assetsS3Bucket !== null;
}

export function bucketName(): string {
  if (env.assetsS3Bucket === null) {
    throw new Error("S3 is not configured: no asset bucket is set");
  }
  return env.assetsS3Bucket;
}

function s3(): S3Client {
  // One client per process: it owns a connection pool, and building one per
  // call would discard keep-alive and re-resolve credentials every time.
  if (!client) {
    client = new S3Client({
      // Undefined hands region resolution back to the SDK, which reads
      // AWS_REGION and then the instance metadata service.
      region: env.assetsS3Region ?? undefined,
    });
  }
  return client;
}

function isNotFound(err: unknown): boolean {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return (
    e?.name === "NotFound" ||
    e?.name === "NoSuchKey" ||
    e?.$metadata?.httpStatusCode === 404
  );
}

export async function putObject(
  key: string,
  body: Buffer,
  contentType: string,
): Promise<void> {
  await s3().send(
    new PutObjectCommand({
      Bucket: bucketName(),
      Key: key,
      Body: body,
      ContentType: contentType,
    }),
  );
}

/**
 * @returns false when the object is absent, rather than throwing — callers use
 * this to tell "the row is stale" from "the bucket is broken", and the two
 * deserve different answers.
 */
export async function headObject(key: string): Promise<boolean> {
  try {
    await s3().send(new HeadObjectCommand({ Bucket: bucketName(), Key: key }));
    return true;
  } catch (err) {
    if (isNotFound(err)) return false;
    throw err;
  }
}

/**
 * Remove an object.
 *
 * @returns true when an object was actually removed, false when there was
 * none. DeleteObject reports success for a key that was never there, so the
 * head first is what keeps the media reaper's counter honest.
 */
export async function deleteObject(key: string): Promise<boolean> {
  if (!(await headObject(key))) return false;
  await s3().send(new DeleteObjectCommand({ Bucket: bucketName(), Key: key }));
  return true;
}

export interface PresignGetOptions {
  ttlSeconds: number;
  responseContentType?: string;
  responseContentDisposition?: string;
}

/**
 * A short-lived GET URL. The signature is the credential, so the URL must
 * never be cached beyond `ttlSeconds` — see the no-store header on the
 * redirect that issues these.
 */
export async function presignGet(
  key: string,
  opts: PresignGetOptions,
): Promise<string> {
  return getSignedUrl(
    s3(),
    new GetObjectCommand({
      Bucket: bucketName(),
      Key: key,
      ...(opts.responseContentType
        ? { ResponseContentType: opts.responseContentType }
        : {}),
      ...(opts.responseContentDisposition
        ? { ResponseContentDisposition: opts.responseContentDisposition }
        : {}),
    }),
    { expiresIn: opts.ttlSeconds },
  );
}
