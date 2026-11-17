/*---------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Local browser checks; the fake host records requests without executing agent actions.
import assert from 'node:assert/strict';
import { chromium } from '../../../node_modules/playwright/index.mjs';
import { start } from './serve.mjs';

const server = await start();
const url = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1344, height: 905 } });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
let panels = 0;
try {
	for (const view of ['overview', 'resources', 'map', 'calls', 'logs', 'copies', 'catalog', 'settings']) {
		await page.goto(`${url}/?view=${view}`);
		await page.waitForSelector('.cs-studio');
		assert.ok((await page.locator('.cs-body').innerText()).trim());
	}
	const resources = await page.evaluate(() => JSON.parse(window.CS_FILES['resources.json']).resources);
	const kinds = { apigatewayv2: 'api', lambda: 'function', dynamodb: 'table', s3: 'bucket', sqs: 'queue', sns: 'topic', stepfunctions: 'statemachine', scheduler: 'schedule', events: 'rule', secretsmanager: 'secret', ssm: 'parameter', logs: 'logs' };
	for (const resource of resources) {
		const key = JSON.stringify([kinds[resource.service], resource.account || '000000000000', resource.region || '', resource.name]);
		await page.goto(`${url}/?view=resources&sel=${encodeURIComponent(key)}`);
		await page.waitForSelector('.cs-dh');
		assert.equal(await page.locator('.cs-dh b').innerText(), resource.name);
		panels++;
	}
	await page.goto(`${url}/?view=resources`);
	await page.waitForSelector('.cs-dh');
	await page.evaluate(() => {
		const files = { ...window.CS_FILES };
		const template = JSON.parse(files['resources.json']).resources.find(r => r.service === 'dynamodb');
		const first = { ...template, name: 'same-name', account: '111111111111', region: 'us-east-1', items: [{ id: 'FIRST-REGION' }], count: 1 };
		const second = { ...template, name: 'same-name', account: '222222222222', region: 'sa-east-1', items: [{ id: 'SECOND-REGION' }], count: 1 };
		files['resources.json'] = JSON.stringify({ resources: [first, second] });
		files['view.json'] = JSON.stringify({ revision: 50, view: 'resources', select: 'table:same-name' });
		window.dispatchEvent(new MessageEvent('message', { data: { type: 'files', files } }));
	});
	await page.waitForSelector('.cs-dh', { state: 'detached' });
	assert.equal(await page.locator('.cs-dh').count(), 0, 'ambiguous legacy names must not select a different resource');
	await page.locator('.cs-tr[data-key]').nth(1).click();
	await page.waitForSelector('.cs-tr.sel');
	assert.equal(await page.locator('.cs-tr.sel').count(), 1);
	assert.match(await page.locator('.cs-body').innerText(), /SECOND-REGION/);
	assert.doesNotMatch(await page.locator('.cs-body').innerText(), /FIRST-REGION/);
	await page.locator('[data-act="ask-about"]').click();
	let posted = await page.evaluate(() => window.__posted.filter(m => m.type === 'ask').at(-1));
	assert.match(JSON.stringify(posted), /222222222222/);
	assert.match(JSON.stringify(posted), /sa-east-1/);
	await page.evaluate(() => {
		const files = { ...window.CS_FILES };
		const template = JSON.parse(files['resources.json']).resources.find(r => r.service === 'dynamodb');
		const maps = {
			id: 'entry', payload: { $map: { $set: 'ordinary-map-value', $n: 'ordinary-number-key', $b: 'ordinary-binary-key', $map: { $map: { $set: 'nested' } } } },
			legacy: { $set: 'old-ordinary-map' }, precise: { $n: '999999999999999999999999' },
			binary: { $b: 16 }, set: { $set: [{ $n: '123' }] },
		};
		files['resources.json'] = JSON.stringify({ resources: [{ ...template, name: 'valid-map', items: [maps], count: 1 }] });
		files['view.json'] = JSON.stringify({ revision: 51, view: 'resources', select: 'table:valid-map' });
		window.dispatchEvent(new MessageEvent('message', { data: { type: 'files', files } }));
	});
	await page.waitForFunction(() => document.querySelector('.cs-body')?.textContent.includes('ordinary-map-value'));
	const mapText = await page.locator('.cs-body').innerText();
	for (const value of ['ordinary-map-value', 'ordinary-number-key', 'ordinary-binary-key', 'nested', 'old-ordinary-map', '999999999999999999999999']) {
		assert.ok(mapText.includes(value), value);
	}
	// Invoke from a non-default namespace must preserve scope and go through host approval/chat.
	await page.evaluate(() => {
		const files = { ...window.CS_FILES };
		const template = JSON.parse(files['resources.json']).resources.find(r => r.service === 'lambda');
		files['resources.json'] = JSON.stringify({ resources: [{ ...template, account: '222222222222', region: 'sa-east-1' }] });
		files['view.json'] = JSON.stringify({ revision: 52, view: 'resources', select: 'function:' + template.name });
		window.dispatchEvent(new MessageEvent('message', { data: { type: 'files', files } }));
	});
	await page.locator('[data-act="invoke"]').click();
	posted = await page.evaluate(() => window.__posted.filter(m => m.type === 'ask').at(-1));
	assert.match(JSON.stringify(posted), /222222222222/);
	assert.match(JSON.stringify(posted), /sa-east-1/);
	assert.equal(posted.send, true);
	assert.deepEqual(errors, []);
	console.log(JSON.stringify({ views: 8, resourcePanels: panels, namespaceSelection: 'passed', scopedAction: 'passed', typedMaps: 'passed', scriptErrors: errors }));
} finally {
	await browser.close();
	await new Promise(resolve => server.close(resolve));
}
