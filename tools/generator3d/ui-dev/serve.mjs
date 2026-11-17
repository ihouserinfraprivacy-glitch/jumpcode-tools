/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Dev only: serves the interface the way the JumpCode host builds it (inline <style>, nonce <script>s at the end of an
// empty body, the same Content Security Policy, and three.min.js + app.js as the package's studio_ui() joins them),
// with the Studio files of fixtures/<scenario>/ inlined. A model.json "glb": "@name" is replaced by the base64 of
// fixtures/glb/name.glb. Bound to 127.0.0.1. Run alone with: node serve.mjs [port]
import { createServer } from 'node:http';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

const ui = new URL('../src/jumpcode_generator3d/ui/', import.meta.url);
const here = new URL('./', import.meta.url);
const fixtures = new URL('./fixtures/', import.meta.url);
const read = (base, name) => readFileSync(new URL(name, base), 'utf8');

/** The scenario's Studio files as { 'state.json': text, ... }. */
function fixtureFiles(scenario) {
	const out = {};
	const folder = new URL(`${scenario}/`, fixtures);
	if (!/^[a-z0-9-]+$/.test(scenario) || !existsSync(folder)) {
		return out;
	}
	for (const name of readdirSync(folder).filter(n => n.endsWith('.json'))) {
		out[name] = read(folder, name).replace(/"glb": "@([a-z0-9-]+)"/, (_, glb) => `"glb": "${readFileSync(new URL(`glb/${glb}.glb`, fixtures)).toString('base64')}"`);
	}
	return out;
}

export function page(scenario) {
	const nonce = randomBytes(16).toString('base64');
	const css = read(ui, 'app.css');
	const js = `${read(ui, 'three.min.js')}\n${read(ui, 'app.js')}`;
	const inline = text => text.replace(/<\/(script)/gi, '<\\/$1').replace(/<!--/g, '<\\!--');
	const scripts = [`window.G3D_FIXTURES = ${JSON.stringify(fixtureFiles(scenario))};`, read(here, 'fake-host.js'), js];
	const body = scripts.map(s => `<script nonce="${nonce}">${inline(s)}</script>`).join('\n');
	const csp = `default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; script-src 'nonce-${nonce}';`;
	const base = 'html,body{margin:0;height:100%;overflow:hidden;background:#1F1F1F;color:#CCCCCC;font-family:"Segoe UI",sans-serif;}';
	const html = `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><style>${base}</style><style>${css}</style></head><body>\n${body}\n</body></html>`;
	return { html, csp };
}

export function start(port = 0) {
	return new Promise(resolve => {
		const server = createServer((req, res) => {
			const url = new URL(req.url, 'http://127.0.0.1');
			if (url.pathname !== '/') {
				res.writeHead(404);
				res.end();
				return;
			}
			const { html, csp } = page(url.searchParams.get('s') || 'start');
			res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': csp, 'cache-control': 'no-store' });
			res.end(html);
		});
		server.listen(port, '127.0.0.1', () => resolve(server));
	});
}

if (process.argv[1]?.endsWith('serve.mjs')) {
	const server = await start(Number(process.argv[2]) || 0);
	console.log(`http://127.0.0.1:${server.address().port}/?s=model-archer`);
}
