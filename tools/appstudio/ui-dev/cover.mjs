/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Dev only: renders the tool's cover (assets/cover.png, 1440×672) from the Studio with the Barbearia fixture: the
// preview view, the iPhone with its frame on Início, the side panels and the TELAS strip. The package refuses a cover
// above 300 KB; a larger capture is quantized to 256 colours with Pillow from the foto-para-rig development venv.
// Run from this folder: node cover.mjs
import { chromium } from 'file:///C:/Projects/jumpcode/node_modules/playwright/index.mjs';
import { execFileSync } from 'node:child_process';
import { existsSync, statSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { start } from './serve.mjs';

const LIMIT = 300 * 1024;
const PILLOW_PYTHON = 'C:/Projects/foto-para-rig/.venv/Scripts/python.exe';
const target = fileURLToPath(new URL('../src/jumpcode_appstudio/assets/cover.png', import.meta.url));
const server = await start();
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 672 }, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', e => errors.push(e.message));
page.on('console', msg => { if (msg.type() === 'error' || /Refused|Content Security Policy/.test(msg.text())) { errors.push(msg.text()); } });
await page.goto(`http://127.0.0.1:${server.address().port}/?s=ready&view=preview&device=iphone&frame=1&screen=inicio`);
await page.waitForSelector('.as-studio');
await page.waitForFunction(() => document.querySelector('.as-live iframe.as-if.on') && document.querySelectorAll('.as-strip .as-snap iframe').length >= 10, null, { timeout: 20000 });
await page.waitForTimeout(900);
await page.mouse.move(1, 1);
const cdp = await page.context().newCDPSession(page);
const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
writeFileSync(target, Buffer.from(data, 'base64'));
await browser.close();
server.close();
if (errors.length) {
	throw new Error(`errors while rendering the cover: ${errors.join(' | ')}`);
}
let size = statSync(target).size;
if (size > LIMIT) {
	if (!existsSync(PILLOW_PYTHON)) {
		throw new Error(`${target} has ${size} bytes (limit ${LIMIT}) and Pillow was not found at ${PILLOW_PYTHON}`);
	}
	// Median cut keeps the greys of the Studio exact and gives the app's colours most of the 256.
	const script = 'import sys\nfrom PIL import Image\nimage = Image.open(sys.argv[1]).convert("RGB")\nimage.quantize(colors=256, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE).save(sys.argv[1], optimize=True)\n';
	execFileSync(PILLOW_PYTHON, ['-I', '-c', script, target]);
	size = statSync(target).size;
}
console.log(target, size, 'bytes', size > LIMIT ? '(STILL ABOVE THE LIMIT)' : '');
