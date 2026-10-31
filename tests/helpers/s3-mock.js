'use strict';

const http = require('http');
const { URL } = require('url');

function createS3Mock() {
  const buckets = new Map();

  function bucketMap(name) {
    if (!buckets.has(name)) buckets.set(name, new Map());
    return buckets.get(name);
  }

  function parse(req) {
    const url = new URL(req.url, 'http://127.0.0.1');
    const parts = url.pathname.split('/').filter(Boolean);
    return { bucket: decodeURIComponent(parts[0] || ''), key: parts.slice(1).map(decodeURIComponent).join('/') };
  }

  const server = http.createServer((req, res) => {
    const { bucket, key } = parse(req);
    if (!bucket) {
      res.writeHead(400);
      res.end('missing bucket');
      return;
    }

    if (req.method === 'HEAD' && !key) {
      res.writeHead(buckets.has(bucket) ? 200 : 404);
      res.end();
      return;
    }

    if (req.method === 'PUT' && !key) {
      buckets.set(bucket, buckets.get(bucket) || new Map());
      res.writeHead(200);
      res.end();
      return;
    }

    const objects = bucketMap(bucket);

    if (req.method === 'HEAD' && key) {
      res.writeHead(objects.has(key) ? 200 : 404);
      res.end();
      return;
    }

    if (req.method === 'GET' && key) {
      const object = objects.get(key);
      if (!object) {
        res.writeHead(404, { 'Content-Type': 'application/xml' });
        res.end('<Error><Code>NoSuchKey</Code></Error>');
        return;
      }
      res.writeHead(200, { 'Content-Type': object.contentType });
      res.end(object.body);
      return;
    }

    if (req.method === 'DELETE' && key) {
      objects.delete(key);
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method === 'PUT' && key) {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        objects.set(key, {
          body: Buffer.concat(chunks),
          contentType: req.headers['content-type'] || 'application/octet-stream',
        });
        res.writeHead(200);
        res.end();
      });
      return;
    }

    res.writeHead(404);
    res.end();
  });

  return {
    server,
    listen(port = 0) {
      return new Promise((resolve) => {
        server.listen(port, '127.0.0.1', () => {
          const address = server.address();
          resolve(`http://127.0.0.1:${address.port}`);
        });
      });
    },
    close() {
      return new Promise((resolve) => server.close(resolve));
    },
  };
}

module.exports = { createS3Mock };
