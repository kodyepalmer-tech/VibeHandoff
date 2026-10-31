'use strict';

const yazl = require('yazl');

function zipFiles(entries) {
  return new Promise((resolve, reject) => {
    const zipfile = new yazl.ZipFile();
    for (const [name, content] of Object.entries(entries)) {
      const body = Buffer.isBuffer(content) ? content : Buffer.from(String(content));
      zipfile.addBuffer(body, name);
    }
    const chunks = [];
    zipfile.outputStream.on('data', (chunk) => chunks.push(chunk));
    zipfile.outputStream.on('end', () => resolve(Buffer.concat(chunks)));
    zipfile.outputStream.on('error', reject);
    zipfile.end();
  });
}

module.exports = { zipFiles };
