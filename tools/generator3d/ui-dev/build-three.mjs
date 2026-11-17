// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License. See LICENSE in the project root.

// Builds ui/three.min.js: three.js (MIT) with GLTFLoader and OrbitControls as one script that sets
// globalThis.G3D_THREE. Usage: node build-three.mjs <folder that holds node_modules/three>
// The pinned version lives in THREE_VERSION; the build refuses another one.
import { build } from '../../../build/node_modules/esbuild/lib/main.js';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const THREE_VERSION = '0.187.0';
const here = dirname(fileURLToPath(import.meta.url));
const modules = process.argv[2];
if (!modules) {
	console.error('usage: node build-three.mjs <folder with node_modules/three>');
	process.exit(2);
}
const nodeModules = join(modules, 'node_modules');
const version = JSON.parse(readFileSync(join(nodeModules, 'three', 'package.json'), 'utf8')).version;
if (version !== THREE_VERSION) {
	console.error(`three ${version} found; this build expects ${THREE_VERSION}`);
	process.exit(1);
}
const result = await build({
	entryPoints: [join(here, 'three-entry.mjs')],
	bundle: true,
	format: 'iife',
	minify: true,
	target: 'es2022',
	nodePaths: [nodeModules],
	legalComments: 'none',
	write: false,
});
const license = readFileSync(join(nodeModules, 'three', 'LICENSE'), 'utf8').trim().split('\n').map(line => ' * ' + line).join('\n');
const banner = `/**\n * three.js ${THREE_VERSION} (GLTFLoader, OrbitControls), bundled for the 3D Generator Studio.\n${license}\n */\n`;
const target = join(here, '..', 'src', 'jumpcode_generator3d', 'ui', 'three.min.js');
writeFileSync(target, banner + result.outputFiles[0].text);
console.log('wrote', target, result.outputFiles[0].text.length, 'chars');
