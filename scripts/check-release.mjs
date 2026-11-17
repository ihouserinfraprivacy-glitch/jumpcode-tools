// Rebuild the published archives without signing keys or the JumpCode checkout.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { packTool } from '../build/jumpcode-tools/packaging.ts';
const root = path.resolve(import.meta.dirname, '..');
const release = JSON.parse(fs.readFileSync(path.join(root, 'release/v1.0.1.json'), 'utf8'));
for (const item of release) {
 const packed = packTool(path.join(root, 'tools', item.id));
 assert.equal(packed.sha256, item.sha256, item.id);
 assert.equal(packed.bytes.length, item.size, item.id);
 console.log(`${item.id} ${packed.sha256}`);
}
console.log(`Verified ${release.length} reproducible release archives.`);
