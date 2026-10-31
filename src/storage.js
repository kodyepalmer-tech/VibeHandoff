'use strict';

const {
  S3Client,
  CreateBucketCommand,
  HeadBucketCommand,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
} = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const config = require('./config');
const logger = require('./logger');
const { publicObjectUrl } = require('./storage-profile');

function createS3Client(overrides = {}) {
  const s3 = { ...config.s3, ...overrides };
  const clientConfig = {
    region: s3.region,
    forcePathStyle: s3.forcePathStyle,
    credentials: {
      accessKeyId: s3.accessKey,
      secretAccessKey: s3.secretKey,
    },
  };
  if (s3.endpoint) {
    clientConfig.endpoint = s3.endpoint;
  }
  return new S3Client(clientConfig);
}

let client = createS3Client();

function setClient(next) {
  client = next;
}

function getClient() {
  return client;
}

function bucket() {
  return config.s3.bucket;
}

function profile() {
  return config.s3.profile;
}

function accessMode() {
  return profile().serve;
}

async function ensureBucket() {
  try {
    await client.send(new HeadBucketCommand({ Bucket: bucket() }));
    return;
  } catch (err) {
    if (err.$metadata?.httpStatusCode !== 404 && err.name !== 'NotFound' && err.Code !== 'NoSuchBucket') {
      if (err.$metadata?.httpStatusCode !== 403 && err.name !== 'NoSuchBucket') {
        logger.warn({ err }, 'head bucket failed; attempting create');
      }
    }
  }
  try {
    await client.send(new CreateBucketCommand({ Bucket: bucket() }));
    logger.info({ bucket: bucket() }, 'created artifact bucket');
  } catch (err) {
    if (err.name === 'BucketAlreadyOwnedByYou' || err.name === 'BucketAlreadyExists') return;
    throw err;
  }
}

async function putObject(key, body, contentType = 'application/octet-stream') {
  const input = {
    Bucket: bucket(),
    Key: key,
    Body: body,
    ContentType: contentType,
    CacheControl: profile().cacheControl,
  };
  if (profile().encryption) {
    input.ServerSideEncryption = profile().encryption;
  }
  await client.send(new PutObjectCommand(input));
}

async function signedReadUrl(key, expiresIn = profile().signedUrlTtlSeconds) {
  return getSignedUrl(
    client,
    new GetObjectCommand({
      Bucket: bucket(),
      Key: key,
    }),
    { expiresIn }
  );
}

function missingObject(key) {
  const error = new Error(`Object not found: ${key}`);
  error.name = 'NoSuchKey';
  error.$metadata = { httpStatusCode: 404 };
  return error;
}

async function readSignedObject(key) {
  const url = await signedReadUrl(key);
  const response = await fetch(url);
  if (response.status === 404) throw missingObject(key);
  if (!response.ok) {
    const error = new Error(`Signed read failed (${response.status})`);
    error.$metadata = { httpStatusCode: response.status };
    throw error;
  }
  return {
    body: Buffer.from(await response.arrayBuffer()),
    contentType: response.headers.get('content-type') || 'application/octet-stream',
  };
}

async function readSdkObject(key) {
  const result = await client.send(
    new GetObjectCommand({
      Bucket: bucket(),
      Key: key,
    })
  );
  const bytes = await result.Body.transformToByteArray();
  return {
    body: Buffer.from(bytes),
    contentType: result.ContentType || 'application/octet-stream',
  };
}

async function getObject(key) {
  if (profile().serve === 'signed-url') return readSignedObject(key);
  return readSdkObject(key);
}

async function listObjects(prefix) {
  const normalized = prefix.endsWith('/') ? prefix : `${prefix}/`;
  const keys = [];
  let token;
  do {
    const result = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket(),
        Prefix: normalized,
        ContinuationToken: token,
      })
    );
    for (const item of result.Contents || []) {
      if (item.Key && !item.Key.endsWith('/')) keys.push(item.Key);
    }
    token = result.IsTruncated ? result.NextContinuationToken : undefined;
  } while (token);
  return keys;
}

function distributionUrl(key) {
  return publicObjectUrl(profile(), key);
}

async function deleteObject(key) {
  await client.send(
    new DeleteObjectCommand({
      Bucket: bucket(),
      Key: key,
    })
  );
}

async function headObject(key) {
  return client.send(
    new HeadObjectCommand({
      Bucket: bucket(),
      Key: key,
    })
  );
}

function quarantineKey(organizationId, releaseId) {
  return `quarantine/${organizationId}/${releaseId}.zip`;
}

function immutablePrefix(organizationId, applicationId, releaseId) {
  return `releases/${organizationId}/${applicationId}/${releaseId}`;
}

function immutableObjectKey(prefix, relativePath) {
  return `${prefix}/${relativePath}`;
}

async function healthcheck() {
  await ensureBucket();
  return true;
}

module.exports = {
  createS3Client,
  setClient,
  getClient,
  ensureBucket,
  putObject,
  getObject,
  signedReadUrl,
  listObjects,
  distributionUrl,
  accessMode,
  deleteObject,
  headObject,
  quarantineKey,
  immutablePrefix,
  immutableObjectKey,
  healthcheck,
};
