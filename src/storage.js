'use strict';

const {
  S3Client,
  CreateBucketCommand,
  HeadBucketCommand,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
} = require('@aws-sdk/client-s3');
const config = require('./config');
const logger = require('./logger');

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
  await client.send(
    new PutObjectCommand({
      Bucket: bucket(),
      Key: key,
      Body: body,
      ContentType: contentType,
      ACL: undefined,
    })
  );
}

async function getObject(key) {
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
  deleteObject,
  headObject,
  quarantineKey,
  immutablePrefix,
  immutableObjectKey,
  healthcheck,
};
