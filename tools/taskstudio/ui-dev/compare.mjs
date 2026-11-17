/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Dev only: puts each shot next to the Studio area of its approved mockup (the part of the
// 1920×1020 mockup right of the chat, 1342×905) into ./shots/compare/. Run after shoot.mjs.
// Run from this folder: node compare.mjs [02,05,...]
import { chromium } from 'file:///C:/Projects/jumpcode/node_modules/playwright/index.mjs';
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const mockups = new URL('../../../design-mockups/taskstudio-classico-escuro/', import.meta.url);
const shots = new URL('./shots/', import.meta.url);
const out = new URL('./compare/', shots);
mkdirSync(out, { recursive: true });
const only = process.argv[2] ? new Set(process.argv[2].split(',')) : null;
const data = url => `data:image/png;base64,${readFileSync(url).toString('base64')}`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 2704, height: 945 } });
for (const file of readdirSync(mockups).filter(f => /^\d\d-.*\.png$/.test(f)).sort()) {
	const n = file.slice(0, 2);
	const shot = readdirSync(shots).find(f => f.startsWith(`${n}-`) && f.endsWith('.png'));
	if (!shot || (only && !only.has(n)) || n === '00' || n === '01') {
		continue;
	}
	const left = data(new URL(file, mockups));
	const right = data(new URL(shot, shots));
	await page.setContent(`<body style="margin:0;background:#111;display:flex;gap:20px;font:14px sans-serif;color:#ccc"><div><div style="height:30px;line-height:30px">mockup ${file}</div><div style="width:1342px;height:905px;background:url(${left}) -578px -88px no-repeat"></div></div><div><div style="height:30px;line-height:30px">shot ${shot}</div><img src="${right}" style="display:block;width:1344px;height:905px"></div></body>`);
	await page.waitForTimeout(50);
	await page.screenshot({ path: fileURLToPath(new URL(`${n}.png`, out)) });
	console.log(`compare/${n}.png  ${file}  ×  ${shot}`);
}
await browser.close();
if (!existsSync(out)) {
	process.exitCode = 1;
}
