// Run from the repository: node tools/webstudio/tests/test-browser.cjs
// Every external request is intercepted and aborted; no third-party service is used.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { build } = require(require.resolve('esbuild', { paths: [path.resolve(__dirname, '../../../build')] }));
const { chromium } = require('playwright');

(async () => {
	const root = path.resolve(__dirname, '../../..');
	const bundled = await build({ entryPoints: [path.join(root, 'src/vs/workbench/contrib/jumpCode/browser/jumpCodeStudioBrowser.ts')], bundle: true, platform: 'node', format: 'cjs', write: false });
	const module = { exports: {} };
	new Function('module', 'exports', 'require', bundled.outputFiles[0].text)(module, module.exports, require);
	const { createStudioBrowserPreview } = module.exports;
	const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'jumpcode-webstudio-browser-'));
	const browser = await chromium.launch({ channel: 'chrome', headless: true });
	try {
		const context = await browser.newContext();
		const requests = [];
		await context.route(/^https?:/, route => { requests.push(route.request().url()); return route.abort(); });
		const page = await context.newPage();
		page.setDefaultTimeout(5000);
		const html = '<!doctype html><html><head><link rel="stylesheet" href="styles.css"></head><body><h1>Home</h1><a href="contact.html">Contato</a><svg viewBox="0 0 20 20"><circle cx="10" cy="10" r="8" fill="red"/></svg></body></html>';
		const site = { css: 'h1{color:rgb(12,34,56)}', pages: [
			{ id: 'index', file: 'index.html', title: 'Home', html },
			{ id: 'contact', file: 'contact.html', title: 'Contato', html: '<h1>Contato</h1><a href="index.html">Voltar</a>' }
		] };
		const open = async site => {
			await fs.writeFile(path.join(folder, 'preview.html'), createStudioBrowserPreview(site, 'index'));
			await page.goto(pathToFileURL(path.join(folder, 'preview.html')).href);
			await page.frameLocator('body > iframe').locator('h1').waitFor();
		};
		await open(site);
		const frame = page.frameLocator('body > iframe');
		assert.equal(await frame.locator('h1').evaluate(node => getComputedStyle(node).color), 'rgb(12, 34, 56)');
		assert.equal(await frame.locator('svg circle').count(), 1);
		await frame.getByRole('link', { name: 'Contato' }).click();
		await frame.getByRole('heading', { name: 'Contato' }).waitFor();
		await frame.getByRole('link', { name: 'Voltar' }).click();
		await frame.getByRole('heading', { name: 'Home' }).waitFor();
		console.log('PASS: CSS, SVG, internal page navigation and return');
		const attacks = [
			'<script>document.body.dataset.executed="yes";fetch("https://blocked.invalid/inline")</script>',
			'<script src="https://blocked.invalid/script.js"></script>',
			'<img src="https://blocked.invalid/image" onerror="document.body.dataset.executed=1">',
			'<link rel="stylesheet" href="https://blocked.invalid/style.css">',
			'<iframe src="https://blocked.invalid/frame"></iframe>',
			'<meta http-equiv="refresh" content="0;url=https://blocked.invalid/redirect">',
			'<form action="https://blocked.invalid/form"><button>Enviar</button></form>',
			'<a href="https://blocked.invalid/link">External</a>',
		];
		for (const attack of attacks) {
			console.log('Checking:', attack.slice(0, 90));
			requests.length = 0;
			await open({ ...site, css: site.css + ';@import url(https://blocked.invalid/import);body{background:url(https://blocked.invalid/bg)}', pages: [{ ...site.pages[0], html: html.replace('</body>', attack + '</body>') }] });
			if (attack.includes('<form')) { await frame.getByRole('button', { name: 'Enviar' }).click(); }
			if (attack.includes('>External')) { await frame.getByRole('link', { name: 'External' }).click(); }
			await page.waitForTimeout(150);
			assert.equal(await frame.locator('body').getAttribute('data-executed'), null, attack);
			assert.deepEqual(requests, [], attack);
		}
		console.log('PASS: 8 active-content/network vectors, zero outgoing requests');
		// Untrusted JSON/text must not break out of the wrapper's script or style element.
		await open({ ...site, css: '</style><script>fetch("https://blocked.invalid/css")</script>', pages: [{ ...site.pages[0], title: '</script><script>fetch("https://blocked.invalid/title")</script>' }] });
		assert.equal(await page.locator('body > script').count(), 1);
		assert.deepEqual(requests, []);
		console.log('PASS: CSS and title delimiters cannot escape the sandbox');
		const shell = body => '<!doctype html><html><head><link rel="stylesheet" href="styles.css"></head><body>' + body + '</body></html>';
		const linked = { css: 'body{margin:0}.literal::after{content:"$& $$ $1"}', pages: [
			{ id: 'index', file: 'index.html', title: 'Home', html: shell('<h1>Home</h1><p class="literal">Literal</p><a id="relative" href="./contact.html">Relative</a><a id="anchor" href="contact.html#caf%C3%A9">Anchor</a>') },
			{ id: 'contact', file: 'contact.html', title: 'Contact', html: shell('<h1>Contact</h1><a id="local" href="#caf%C3%A9">Local anchor</a><div style="height:1800px"></div><p id="café">Target</p><a href="./index.html">Return</a>') },
		] };
		for (const link of ['relative', 'anchor']) {
			await open(linked);
			await frame.locator('#' + link).click();
			await frame.getByRole('heading', { name: 'Contact', exact: true }).waitFor();
			if (link === 'relative') { await frame.locator('#local').click(); }
			await page.waitForFunction(() => document.querySelector('iframe').contentDocument.scrollingElement.scrollTop > 1000);
		}
		console.log('PASS: external relative links and Unicode fragments');

		// Exercise the actual generated in-app document, with only the IDE message transport mocked.
		const helper = await build({ entryPoints: [path.join(root, 'src/vs/workbench/contrib/jumpCode/browser/jumpCodeStudioLinks.ts')], bundle: true, platform: 'node', format: 'cjs', write: false });
		const helpers = { exports: {} };
		new Function('module', 'exports', 'require', helper.outputFiles[0].text)(helpers, helpers.exports, require);
		const source = await fs.readFile(path.join(root, 'src/vs/workbench/contrib/jumpCode/browser/jumpCodeStudioPreview.ts'), 'utf8');
		const start = source.indexOf('return `<!DOCTYPE html>') + 'return '.length;
		const end = source.indexOf('`;', start) + 1;
		const htmlPreview = new Function('nonce', 'labels', 'resolveStudioLink', 'scrollStudioFragment', 'return ' + source.slice(start, end))('testnonce', {}, helpers.exports.resolveStudioLink, helpers.exports.scrollStudioFragment);
		await page.addInitScript(() => {
			window.messages = [];
			window.acquireVsCodeApi = () => ({ postMessage: message => {
				window.messages.push(message);
				if (message.type === 'page') {
					window.snapshot = { ...window.snapshot, page: message.page, hash: message.hash || '', navigation: window.snapshot.navigation + 1 };
					window.postMessage(window.snapshot, '*');
				}
			} });
		});
		await fs.writeFile(path.join(folder, 'internal.html'), htmlPreview);
		await page.goto(pathToFileURL(path.join(folder, 'internal.html')).href);
		const send = async site => page.evaluate(site => { window.snapshot = { ...site, type: 'site', page: 'index', navigation: 0, hash: '', device: 'desktop' }; window.postMessage(window.snapshot, '*'); }, site);
		const inside = page.frameLocator('.frame > iframe');
		await send(linked);
		await inside.locator('.literal').waitFor();
		assert.equal(await inside.locator('style').first().textContent(), linked.css);
		assert.equal(await inside.locator('.literal').evaluate(node => getComputedStyle(node, '::after').content), '"$& $$ $1"');
		for (const link of ['relative', 'anchor']) {
			await send(linked);
			await inside.locator('#' + link).click();
			await inside.getByRole('heading', { name: 'Contact', exact: true }).waitFor();
			if (link === 'relative') { await inside.locator('#local').click(); }
			await page.waitForTimeout(100);
			assert.ok(await inside.locator('body').evaluate(node => node.ownerDocument.scrollingElement.scrollTop > 1000));
		}
		// Both replacement branches must insert text literally, including every JS replacement token.
		for (const hasLink of [true, false]) {
			const css = 'a::after{content:"$& $$ $1 $` $\'"}';
			await send({ css, pages: [{ ...linked.pages[0], html: hasLink ? linked.pages[0].html : linked.pages[0].html.replace('<link rel="stylesheet" href="styles.css">', '') }] });
			await inside.locator('h1').waitFor();
			assert.equal(await inside.locator('style').first().textContent(), css);
		}
		for (const href of ['https://blocked.invalid/link', '//blocked.invalid/link', 'javascript:alert(1)', '../outside.html', 'file:///outside.html']) {
			await send({ css: '', pages: [{ ...linked.pages[0], html: shell('<h1>Home</h1><a id="blocked" href="' + href + '">Blocked</a>') }] });
			await page.evaluate(() => { window.messages = []; });
			await inside.locator('#blocked').click();
			await page.waitForTimeout(50);
			assert.deepEqual(await page.evaluate(() => window.messages.filter(message => message.type === 'page')), []);
		}
		assert.deepEqual(requests, []);
		console.log('PASS: internal navigation, fragment scrolling, literal CSS and denied destinations; zero network requests');
		await context.close();
	} finally {
		await browser.close();
		if (path.dirname(folder) !== path.resolve(os.tmpdir()) || !path.basename(folder).startsWith('jumpcode-webstudio-browser-')) { throw new Error('Invalid test cleanup path'); }
		await fs.rm(folder, { recursive: true, force: true });
	}
})().catch(error => { console.error(error); process.exitCode = 1; });
