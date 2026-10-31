'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const roots = ['src', 'scripts', 'tests', 'public'];
const files = [];

function walk(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      walk(full);
    } else if (entry.name.endsWith('.js')) {
      files.push(full);
    }
  }
}

for (const root of roots) walk(root);

for (const file of files) {
  execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
}

console.log(`syntax ok (${files.length} files)`);
