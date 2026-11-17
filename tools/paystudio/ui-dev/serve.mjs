/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Dev only: serves the interface the way the JumpCode host builds it (inline <style>, nonce <script> at the
// end of an empty body, and the same Content Security Policy), with the real Studio files scenario.py saved.
// Bound to 127.0.0.1. Run alone with: node serve.mjs [port]
import { createServer } from 'node:http';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

const ui = new URL('../src/jumpcode_paystudio/ui/', import.meta.url);
const here = new URL('./', import.meta.url);
const fixtures = new URL('./fixtures/barbearia/', import.meta.url);
const read = (base, name) => readFileSync(new URL(name, base), 'utf8');

function fixtureFiles() {
	const out = {};
	if (existsSync(fixtures)) {
		for (const name of readdirSync(fixtures)) {
			if (name.endsWith('.json')) {
				out[name] = read(fixtures, name);
			}
		}
	}
	return `window.PS_FILES = ${JSON.stringify(out)};`;
}

export function page() {
	const nonce = randomBytes(16).toString('base64');
	const css = read(ui, 'app.css');
	const js = read(ui, 'app.js');
	const scripts = [fixtureFiles(), read(here, 'fake-host.js'), js];
	const body = scripts.map(s => `<script nonce="${nonce}">${s.replace(/<\/script/gi, '<\\/script')}</script>`).join('\n');
	const csp = `default-src 'none'; style-src 'unsafe-inline'; img-src data:; script-src 'nonce-${nonce}'`;
	const base = 'html,body{margin:0;height:100%;overflow:hidden;}';
	const html = `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><style>${base}</style><style>${css}</style></head><body>\n${body}\n</body></html>`;
	return { html, csp };
}

export function start(port = 0) {
	return new Promise(resolve => {
		const server = createServer((req, res) => {
			if (!req.url.startsWith('/?') && req.url !== '/') {
				res.writeHead(404);
				res.end();
				return;
			}
			const { html, csp } = page();
			res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': csp, 'cache-control': 'no-store' });
			res.end(html);
		});
		server.listen(port, '127.0.0.1', () => resolve(server));
	});
}

if (process.argv[1]?.endsWith('serve.mjs')) {
	const server = await start(Number(process.argv[2]) || 0);
	console.log(`http://127.0.0.1:${server.address().port}/?view=overview`);
}
