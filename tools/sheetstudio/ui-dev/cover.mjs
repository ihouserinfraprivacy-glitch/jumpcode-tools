/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Dev only: renders the tool's cover (assets/cover.png, 1440×672) from the panel with the scenario's real files.
// Run from this folder: node cover.mjs
import { chromium } from 'file:///C:/Projects/jumpcode/node_modules/playwright/index.mjs';
import { statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { start } from './serve.mjs';

const target = fileURLToPath(new URL('../src/jumpcode_sheetstudio/assets/cover.png', import.meta.url));
const server = await start();
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 672 }, deviceScaleFactor: 1 });
await page.goto(`http://127.0.0.1:${server.address().port}/?state=barbearia&view=panel`);
await page.waitForSelector('.ss-studio');
await page.waitForTimeout(300);
await page.mouse.move(1, 1);
await page.screenshot({ path: target });
await browser.close();
server.close();
console.log(target, statSync(target).size, 'bytes');
