'use strict';

const path = require('path');
const yauzl = require('yauzl');
const config = require('./config');

const ALLOWED_EXTENSIONS = new Set([
  'html',
  'htm',
  'css',
  'js',
  'mjs',
  'map',
  'json',
  'txt',
  'md',
  'svg',
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'ico',
  'bmp',
  'avif',
  'woff',
  'woff2',
  'ttf',
  'otf',
  'eot',
  'wasm',
  'mp3',
  'wav',
  'ogg',
  'mp4',
  'webm',
  'csv',
  'xml',
  'webmanifest',
]);

const BLOCKED_BASENAMES = new Set([
  'dockerfile',
  'docker-compose.yml',
  'docker-compose.yaml',
  'procfile',
  'makefile',
  'vagrantfile',
  '.htaccess',
  '.env',
  'gemfile',
  'rakefile',
  'package.json',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'requirements.txt',
  'pipfile',
  'go.mod',
  'go.sum',
  'cargo.toml',
  'composer.json',
  'pom.xml',
  'build.gradle',
  'server.js',
  'app.py',
  'main.py',
  'main.go',
  'manage.py',
]);

const BLOCKED_DIRECTORIES = new Set(['node_modules', '.git', 'server', 'backend', 'api', 'bin', 'cmd']);

const EXECUTABLE_MAGIC = [
  { name: 'ELF executable', bytes: Buffer.from([0x7f, 0x45, 0x4c, 0x46]) },
  { name: 'Windows PE executable', bytes: Buffer.from([0x4d, 0x5a]) },
  { name: 'Mach-O executable', bytes: Buffer.from([0xfe, 0xed, 0xfa, 0xce]) },
  { name: 'Mach-O 64 executable', bytes: Buffer.from([0xfe, 0xed, 0xfa, 0xcf]) },
];

function normalizeZipPath(entryName) {
  const replaced = entryName.replace(/\\/g, '/');
  return replaced.replace(/^\/+/, '');
}

function isUnsafePath(entryName) {
  if (!entryName || entryName.includes('\0')) return true;
  if (entryName.startsWith('/') || /^[a-zA-Z]:/.test(entryName)) return true;
  const parts = entryName.split('/');
  return parts.includes('..');
}

function extensionOf(filePath) {
  const ext = path.posix.extname(filePath).slice(1).toLowerCase();
  return ext;
}

function looksLikeShebang(buffer) {
  return buffer.length >= 2 && buffer[0] === 0x23 && buffer[1] === 0x21;
}

function matchesMagic(buffer) {
  return EXECUTABLE_MAGIC.find((sig) => buffer.length >= sig.bytes.length && buffer.subarray(0, sig.bytes.length).equals(sig.bytes));
}

function collectEntry(entry, buffer, errors, files) {
  const name = normalizeZipPath(entry.fileName);
  if (!name) return;
  if (name.endsWith('/')) return;

  if (isUnsafePath(name)) {
    errors.push(`Unsafe path rejected: ${entry.fileName}`);
    return;
  }

  const unixMode = (entry.externalFileAttributes >>> 16) & 0xffff;
  if ((unixMode & 0o170000) === 0o120000) {
    errors.push(`Symbolic links are not allowed: ${name}`);
    return;
  }

  const posix = name.toLowerCase();
  const parts = posix.split('/');
  if (parts.some((part) => BLOCKED_DIRECTORIES.has(part))) {
    errors.push(`Server or build directory is not allowed: ${name}`);
    return;
  }

  const base = path.posix.basename(posix);
  if (BLOCKED_BASENAMES.has(base)) {
    errors.push(`Build or server file is not allowed: ${name}`);
    return;
  }

  const ext = extensionOf(posix);
  if (!ext || !ALLOWED_EXTENSIONS.has(ext)) {
    errors.push(`File type is not allowed for a static release: ${name}`);
    return;
  }

  if (looksLikeShebang(buffer)) {
    errors.push(`Executable script rejected: ${name}`);
    return;
  }

  const magic = matchesMagic(buffer);
  if (magic) {
    errors.push(`${magic.name} rejected: ${name}`);
    return;
  }

  files.push({
    path: name,
    body: buffer,
    size: buffer.length,
  });
}

function readEntry(zip, entry) {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (err, stream) => {
      if (err) {
        reject(err);
        return;
      }
      const chunks = [];
      stream.on('data', (chunk) => chunks.push(chunk));
      stream.on('error', reject);
      stream.on('end', () => resolve(Buffer.concat(chunks)));
    });
  });
}

async function validateZip(buffer, limits = config.limits) {
  const errors = [];
  const warnings = [];
  const files = [];

  if (!buffer || buffer.length < 4 || buffer[0] !== 0x50 || buffer[1] !== 0x4b) {
    return {
      ok: false,
      errors: ['Upload must be a ZIP archive'],
      warnings,
      files: [],
      fileCount: 0,
      uncompressedBytes: 0,
    };
  }

  if (buffer.length > limits.maxUploadBytes) {
    return {
      ok: false,
      errors: [`ZIP exceeds the ${limits.maxUploadBytes} byte upload quota`],
      warnings,
      files: [],
      fileCount: 0,
      uncompressedBytes: 0,
    };
  }

  let zip;
  try {
    zip = await yauzl.fromBufferPromise(buffer, { lazyEntries: true, validateEntrySizes: true });
  } catch (err) {
    return {
      ok: false,
      errors: [`ZIP could not be read: ${err.message}`],
      warnings,
      files: [],
      fileCount: 0,
      uncompressedBytes: 0,
    };
  }

  await new Promise((resolve, reject) => {
    let uncompressed = 0;
    let count = 0;

    zip.on('error', reject);
    zip.on('end', resolve);
    zip.readEntry();
    zip.on('entry', async (entry) => {
      try {
        count += 1;
        if (count > limits.maxZipFiles) {
          errors.push(`ZIP contains more than ${limits.maxZipFiles} files`);
          zip.close();
          resolve();
          return;
        }
        uncompressed += entry.uncompressedSize || 0;
        if (uncompressed > limits.maxUncompressedBytes) {
          errors.push(`Uncompressed contents exceed ${limits.maxUncompressedBytes} bytes`);
          zip.close();
          resolve();
          return;
        }
        if (entry.fileName && !entry.fileName.endsWith('/')) {
          const body = await readEntry(zip, entry);
          collectEntry(entry, body, errors, files);
        }
        zip.readEntry();
      } catch (err) {
        reject(err);
      }
    });
  });

  const hasIndex = files.some((file) => file.path === 'index.html');
  if (!hasIndex) {
    errors.push('A static release must include index.html at the ZIP root');
  }

  const uncompressedBytes = files.reduce((sum, file) => sum + file.size, 0);

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    files,
    fileCount: files.length,
    uncompressedBytes,
  };
}

module.exports = {
  validateZip,
  isUnsafePath,
  ALLOWED_EXTENSIONS,
  BLOCKED_BASENAMES,
};
