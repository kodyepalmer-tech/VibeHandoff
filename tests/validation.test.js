'use strict';

require('./helpers/env');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { zipFiles } = require('../scripts/zip-files');
const { validateZip, isUnsafePath } = require('../src/validate-zip');

test('accepts a static ZIP with index.html', async () => {
  const zip = await zipFiles({
    'index.html': '<!doctype html><title>ok</title>',
    'app.css': 'body{color:black}',
  });
  const result = await validateZip(zip);
  assert.equal(result.ok, true);
  assert.equal(result.files.length, 2);
});

test('rejects missing index.html', async () => {
  const zip = await zipFiles({ 'readme.md': 'nope' });
  const result = await validateZip(zip);
  assert.equal(result.ok, false);
  assert.match(result.errors.join(' '), /index.html/);
});

test('rejects server and executable payloads', async () => {
  const zip = await zipFiles({
    'index.html': '<!doctype html><title>x</title>',
    'server.js': 'require("http")',
    'bin/tool.exe': Buffer.from([0x4d, 0x5a, 0x00, 0x00]),
    'backend/app.py': 'print("no")',
  });
  const result = await validateZip(zip);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => /server/i.test(error)));
  assert.ok(result.errors.some((error) => /not allowed/i.test(error)));
});

test('rejects zip slip and shebang scripts', async () => {
  assert.equal(isUnsafePath('../escape.js'), true);
  assert.equal(isUnsafePath('/etc/passwd'), true);
  assert.equal(isUnsafePath('assets/app.js'), false);
  const zip = await zipFiles({
    'index.html': '<!doctype html><title>x</title>',
    'run.js': '#!/usr/bin/env node\nconsole.log(1)\n',
  });
  const result = await validateZip(zip);
  assert.equal(result.ok, false);
  assert.match(result.errors.join(' '), /Executable script/);
});

test('rejects a non-zip buffer', async () => {
  const result = await validateZip(Buffer.from('not a zip'));
  assert.equal(result.ok, false);
});
