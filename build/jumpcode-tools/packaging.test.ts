/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, test } from 'node:test';
import {
	type IJumpCodeToolTarget, type IJumpCodeToolTrustState, type IJumpCodeToolTrustUpdate, JumpCodeToolPackageError, buildJumpCodeToolPointer, buildJumpCodeToolRoot,
	buildJumpCodeToolTargets, checkJumpCodeToolIdentity, findJumpCodeToolTarget, isJumpCodeToolPackagePath, jumpCodeInstalledToolId, jumpCodeToolIncompatibility,
	jumpCodeToolMatchesTarget, jumpCodeToolReadsData, jumpCodeToolVersions, readJumpCodeToolManifest, readJumpCodeToolTrust, updateJumpCodeToolTrust,
} from '../../contract/tool-package.ts';
import { main } from './cli.ts';
import { type ToolSigningKey, generateToolKey, nodeToolCrypto, packTool, readToolArchive, signToolDocument, sourceDescriptorName } from './packaging.ts';

// Test-only package: executing it would throw; packing must only inspect bytes.
const webstudio = fs.mkdtempSync(path.join(os.tmpdir(), 'jumpcode-tool-fixture-'));
after(() => fs.rmSync(webstudio, { recursive: true, force: true }));
fs.mkdirSync(path.join(webstudio, 'src/jumpcode_webstudio'), { recursive: true });
fs.writeFileSync(path.join(webstudio, 'src/jumpcode_webstudio/__init__.py'), 'raise RuntimeError("fixture must never be imported")');
fs.writeFileSync(path.join(webstudio, 'tool.json'), JSON.stringify({ id: 'webstudio', version: '1.0.0', name: 'WebStudio', description: 'Packaging fixture', icon: 'globe', instructions: 'Test only', inputSchema: { type: 'object', properties: {} } }));
fs.writeFileSync(path.join(webstudio, sourceDescriptorName), JSON.stringify({ format: 1, id: 'webstudio', publisher: 'jumpcode', version: '1.0.0', contract: 1,
 compatibility: { python: { minimum: '3.13' }, platforms: ['win32-x64'] }, entry: { kind: 'python', root: 'code', module: 'jumpcode_webstudio' },
 isolation: 'container', capabilities: { suppliedText: true, projectFiles: false, network: false }, tool: 'tool.json', dependencies: [],
 include: [{ from: 'src/jumpcode_webstudio', to: 'code/jumpcode_webstudio' }] }));
const hash = (text: string) => nodeToolCrypto.sha256(Buffer.from(text));

/** The refusal code of an operation, or what it returned. */
function outcome(action: () => unknown): unknown {
	try { return action(); } catch (error) { return error instanceof JumpCodeToolPackageError ? error.code : `unexpected: ${(error as Error).message}`; }
}

function temporary(context: { after(action: () => void): void }): string {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jumpcode-tool-packaging-'));
	context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
	return directory;
}

function manifest(change: (value: Record<string, any>) => void = () => { }): unknown {
	const value: Record<string, any> = {
		format: 1, id: 'sample', publisher: 'jumpcode', version: '1.2.3', contract: 1,
		compatibility: { python: { minimum: '3.13' }, platforms: ['win32-x64'] },
		entry: { kind: 'python', root: 'code', module: 'sample' }, isolation: 'container',
		capabilities: { suppliedText: true, projectFiles: false, network: false },
		tool: { name: 'Sample', description: 'A sample tool.', icon: 'globe', instructions: 'Use it.', inputSchema: { type: 'object', properties: {} }, studio: { title: 'Sample', description: 'Sample', ui: true } },
		studio: { ui: { scripts: ['code/sample/ui/app.js'], styles: ['code/sample/ui/app.css'] }, data: { format: 2, reads: [1, 2] } },
		dependencies: [{ kind: 'python-vendored', name: 'attrs', version: '25.1.0', root: 'vendor/attrs', origin: 'https://files.pythonhosted.org/packages/attrs-25.1.0.tar.gz', sha256: 'a'.repeat(64) }],
		files: [
			{ path: 'code/sample/__init__.py', size: 10, sha256: 'b'.repeat(64) }, { path: 'code/sample/ui/app.js', size: 10, sha256: 'c'.repeat(64) },
			{ path: 'code/sample/ui/app.css', size: 10, sha256: 'd'.repeat(64) }, { path: 'vendor/attrs/attr/__init__.py', size: 10, sha256: 'e'.repeat(64) },
		],
	};
	change(value);
	return value;
}

test('packing a fixture reads no code, is reproducible and produces a package the contract accepts', context => {
	const directory = temporary(context);
	const first = packTool(webstudio);
	const second = packTool(webstudio);
	const out = path.join(directory, 'webstudio.jctool');
	const report = JSON.parse(main(['pack', webstudio, '--out', out]));
	const { manifest: read, members } = readToolArchive(fs.readFileSync(out));
	assert.deepEqual({
		reproducible: first.sha256 === second.sha256 && first.sha256 === report.sha256, identity: [read.id, read.publisher, read.version, read.isolation], capabilities: read.capabilities,
		entry: members.has('code/jumpcode_webstudio/__init__.py'), compiled: [...members.keys()].filter(name => name.includes('__pycache__') || name.endsWith('.pyc')),
		catalogEntry: [read.tool.name, typeof read.tool.instructions, Object.hasOwn(read.tool, 'id'), Object.hasOwn(read.tool, 'version')], overwrite: outcome(() => main(['pack', webstudio, '--out', out])),
		inspect: JSON.parse(main(['inspect', out])).sha256 === first.sha256,
	}, {
		reproducible: true, identity: ['webstudio', 'jumpcode', '1.0.0', 'container'], capabilities: { suppliedText: true, projectFiles: false, network: false },
		entry: true, compiled: [], catalogEntry: ['WebStudio', 'string', false, false], overwrite: `unexpected: EEXIST: file already exists, open '${out}'`, inspect: true,
	});
});

test('a descriptor that disagrees with its catalog entry or reaches outside its folder is not packed', context => {
	const directory = temporary(context);
	const write = (name: string, value: unknown) => { fs.mkdirSync(path.dirname(path.join(directory, name)), { recursive: true }); fs.writeFileSync(path.join(directory, name), typeof value === 'string' ? value : JSON.stringify(value)); };
	const descriptor = { format: 1, id: 'sample', publisher: 'jumpcode', version: '1.0.0', contract: 1, compatibility: { python: { minimum: '3.13' }, platforms: ['win32-x64'] }, entry: { kind: 'python', root: 'code', module: 'sample' }, isolation: 'container', capabilities: { suppliedText: true, projectFiles: false, network: false }, tool: 'src/sample/tool.json', dependencies: [], include: [{ from: 'src/sample', to: 'code/sample' }] };
	const tool = { id: 'sample', version: '1.0.0', name: 'Sample', description: 'Sample.', icon: 'globe', instructions: 'Use it.', inputSchema: { type: 'object' } };
	write('src/sample/__init__.py', '');
	write('src/sample/tool.json', tool);
	const attempt = (change: (value: Record<string, any>) => void, toolChange: Record<string, unknown> = {}) => {
		const value: Record<string, any> = structuredClone(descriptor);
		change(value);
		write(sourceDescriptorName, value);
		write('src/sample/tool.json', { ...tool, ...toolChange });
		try { return packTool(directory).manifest.files.map(file => file.path); } catch (error) { return (error as Error).message.split(':')[0]; }
	};
	assert.deepEqual({
		valid: attempt(() => { }), otherVersion: attempt(() => { }, { version: '2.0.0' }), outside: attempt(value => { value.include[0].from = '..'; }),
		unsafeTarget: attempt(value => { value.include[0].to = '../code'; }), promisesLess: attempt(() => { }, { details: { access: { suppliedText: true, projectFiles: false, network: true } } }),
	}, {
		valid: ['code/sample/__init__.py', 'code/sample/tool.json'], otherVersion: 'The catalog entry names another tool or version than the descriptor', outside: 'include.from leaves the tool folder',
		unsafeTarget: 'Each include needs a source folder and a package folder', promisesLess: 'invalid_manifest',
	});
});

test('the manifest contract refuses unsafe paths, borrowed identities and anything it cannot honour', () => {
	const refused = (change: (value: Record<string, any>) => void) => outcome(() => { readJumpCodeToolManifest(manifest(change)); return 'accepted'; });
	const file = (filePath: string) => (value: Record<string, any>) => { value.files.push({ path: filePath, size: 1, sha256: 'f'.repeat(64) }); };
	assert.deepEqual({
		valid: refused(() => { }),
		format: refused(value => { value.format = 2; }), unknownField: refused(value => { value.postinstall = 'run.py'; }), script: refused(value => { value.entry.install = 'setup.py'; }),
		traversal: refused(file('code/../escape.py')), backslash: refused(file('code\\x.py')), drive: refused(file('C:/x.py')), stream: refused(file('code/x.py:hidden')),
		device: refused(file('code/con.txt')), deviceDigit: refused(file('code/COM0')), trailingDot: refused(file('code/x.')), caseTwin: refused(file('code/sample/__INIT__.py')),
		fileAndFolder: refused(file('code/sample/ui/app.js/extra')), absolute: refused(file('/etc/passwd')), manifestTwin: refused(file('jumpcode-tool.json')),
		oversized: refused(value => { value.files[0].size = 65 * 1024 * 1024; }),
		officialNameByOthers: refused(value => { value.publisher = 'acme'; }), prefixOfAnother: refused(value => { value.publisher = 'acme'; value.id = 'other--sample'; }),
		ownPrefix: refused(value => { value.publisher = 'acme'; value.id = 'acme--sample'; }), localPublisher: refused(value => { value.publisher = 'local'; value.id = 'local--sample'; }),
		officialWithPrefix: refused(value => { value.id = 'jumpcode--sample'; }),
		processByOthers: refused(value => { value.publisher = 'acme'; value.id = 'acme--sample'; value.isolation = 'process'; }), processOfficial: refused(value => { value.isolation = 'process'; }),
		missingEntry: refused(value => { value.entry.module = 'other'; }), interfaceNotListed: refused(value => { value.studio.ui.scripts = ['code/sample/ui/missing.js']; }),
		interfaceUndeclared: refused(value => { delete value.studio.ui; }), unknownDependency: refused(value => { value.dependencies[0].kind = 'pip'; }),
		dependencyInsideCode: refused(value => { value.dependencies[0].root = 'code/sample'; }), dependencyOrigin: refused(value => { value.dependencies[0].origin = 'http://example.com/x'; }),
		dataCannotReadItself: refused(value => { value.studio.data.reads = [1]; }), fractional: refused(value => { value.tool.inputSchema.maximum = 1.5; }),
	}, {
		valid: 'accepted',
		format: 'unsupported_format', unknownField: 'invalid_manifest', script: 'invalid_manifest',
		traversal: 'invalid_inventory', backslash: 'invalid_inventory', drive: 'invalid_inventory', stream: 'invalid_inventory',
		device: 'invalid_inventory', deviceDigit: 'invalid_inventory', trailingDot: 'invalid_inventory', caseTwin: 'invalid_inventory',
		fileAndFolder: 'invalid_inventory', absolute: 'invalid_inventory', manifestTwin: 'invalid_inventory', oversized: 'invalid_inventory',
		officialNameByOthers: 'invalid_identity', prefixOfAnother: 'invalid_identity', ownPrefix: 'accepted', localPublisher: 'invalid_identity', officialWithPrefix: 'invalid_identity',
		processByOthers: 'invalid_manifest', processOfficial: 'accepted',
		missingEntry: 'invalid_manifest', interfaceNotListed: 'invalid_manifest', interfaceUndeclared: 'invalid_manifest', unknownDependency: 'incompatible',
		dependencyInsideCode: 'invalid_manifest', dependencyOrigin: 'invalid_manifest', dataCannotReadItself: 'invalid_manifest', fractional: 'accepted',
	});
});

test('identity, compatibility and saved-data rules are decided from the manifest alone', () => {
	const value = readJumpCodeToolManifest(manifest());
	const host = { appVersion: '1.134.2', platform: 'win32-x64', python: '3.13.14' };
	const needsNewer = readJumpCodeToolManifest(manifest(item => { item.compatibility.app = { minimum: '2.0.0' }; item.compatibility.python.below = '3.14'; }));
	assert.deepEqual({
		installedIds: [jumpCodeInstalledToolId('webstudio', 'official'), jumpCodeInstalledToolId('acme--pdf', 'publisher'), jumpCodeInstalledToolId('webstudio', 'local'), jumpCodeInstalledToolId('acme--pdf', 'local')],
		localIsNeverOfficial: outcome(() => checkJumpCodeToolIdentity('local--webstudio', 'jumpcode')),
		compatible: jumpCodeToolIncompatibility(value, host) ?? 'yes', otherPlatform: jumpCodeToolIncompatibility(value, { ...host, platform: 'linux-x64' }),
		olderApp: jumpCodeToolIncompatibility(needsNewer, host), newerPython: jumpCodeToolIncompatibility(needsNewer, { ...host, appVersion: '2.0.0', python: '3.14.0' }),
		olderPython: jumpCodeToolIncompatibility(value, { ...host, python: '3.12.9' }),
		data: [jumpCodeToolReadsData(value, undefined), jumpCodeToolReadsData(value, 1), jumpCodeToolReadsData(value, 2), jumpCodeToolReadsData(value, 3)],
		paths: ['a/b.py', 'a//b', 'a/./b', 'nul', 'a/b ', 'e\u0301.py'].map(item => isJumpCodeToolPackagePath(item)),
	}, {
		installedIds: ['webstudio', 'acme--pdf', 'local--webstudio', 'local--acme--pdf'], localIsNeverOfficial: 'invalid_identity',
		compatible: 'yes', otherPlatform: 'does not support linux-x64', olderApp: 'needs JumpCode 2.0.0 or newer', newerPython: 'needs Python 3.13 up to 3.14', olderPython: 'needs Python 3.13 or newer',
		data: [true, true, true, false], paths: [true, false, false, false, false, false],
	});
});

// --- Trust ----------------------------------------------------------------------------------------

const far = '2099-01-01T00:00:00Z';
const now = Date.parse('2026-11-16T12:00:00Z');
const keys = { root: generateToolKey(), targets: generateToolKey(), server: generateToolKey(), nextRoot: generateToolKey(), nextServer: generateToolKey(), stranger: generateToolKey() };

function root(version: number, signers: readonly ToolSigningKey[], roles: Partial<Record<'root' | 'targets' | 'server', ToolSigningKey>> = {}, expires = far): string {
	const server = (roles.server ?? keys.server).public;
	return signToolDocument(buildJumpCodeToolRoot(version, expires, { root: [(roles.root ?? keys.root).public], targets: [(roles.targets ?? keys.targets).public], snapshot: [server], timestamp: [server] }, {}, nodeToolCrypto), signers);
}

function target(id: string, version: string, sha256: string, change: Partial<IJumpCodeToolTarget> = {}): IJumpCodeToolTarget {
	const publisher = id.includes('--') ? id.split('--')[0] : 'jumpcode';
	return { path: '', length: 1000, sha256, id, version, publisher, contract: 1, isolation: 'container', capabilities: { suppliedText: true, projectFiles: false, network: false }, status: 'available', ...change };
}

interface Documents { targetsVersion?: number; snapshotVersion?: number; timestampVersion?: number; targetsKey?: ToolSigningKey; serverKey?: ToolSigningKey; timestampExpires?: string; targetsExpires?: string }

function documents(targets: readonly IJumpCodeToolTarget[], options: Documents = {}): IJumpCodeToolTrustUpdate {
	const version = options.targetsVersion ?? 1;
	const server = options.serverKey ?? keys.server;
	const targetsText = signToolDocument(buildJumpCodeToolTargets(version, options.targetsExpires ?? far, targets), [options.targetsKey ?? keys.targets]);
	const snapshotVersion = options.snapshotVersion ?? version;
	const snapshot = signToolDocument(buildJumpCodeToolPointer('snapshot', snapshotVersion, far, targetsText, version, nodeToolCrypto), [server]);
	const timestamp = signToolDocument(buildJumpCodeToolPointer('timestamp', options.timestampVersion ?? snapshotVersion, options.timestampExpires ?? far, snapshot, snapshotVersion, nodeToolCrypto), [server]);
	return { roots: [], timestamp, snapshot, targets: targetsText };
}

const shipped: IJumpCodeToolTrustState = { root: root(1, [keys.root]) };
const web = target('webstudio', '1.0.0', hash('webstudio 1.0.0'));

test('a client accepts only a package list signed offline, current and bound to the exact package', () => {
	const view = updateJumpCodeToolTrust(shipped, documents([web, target('webstudio', '1.1.0', hash('webstudio 1.1.0')), target('acme--pdf', '1.0.0', hash('pdf'))]), now, nodeToolCrypto);
	const packed = packTool(webstudio);
	const listed = target('webstudio', '1.0.0', packed.sha256, { length: packed.bytes.length });
	const refused = (update: IJumpCodeToolTrustUpdate, state = shipped, at = now) => outcome(() => updateJumpCodeToolTrust(state, update, at, nodeToolCrypto).targets.version);
	const good = documents([web]);
	const tampered = { ...good, targets: good.targets.replace(hash('webstudio 1.0.0'), hash('something else')) };
	const otherList = documents([target('webstudio', '9.9.9', hash('other'))]);
	// A server that changes the list and re-signs everything it is able to sign.
	const rewrittenSnapshot = signToolDocument(buildJumpCodeToolPointer('snapshot', 1, far, tampered.targets, 1, nodeToolCrypto), [keys.server]);
	const rewritten = { roots: [], targets: tampered.targets, snapshot: rewrittenSnapshot, timestamp: signToolDocument(buildJumpCodeToolPointer('timestamp', 1, far, rewrittenSnapshot, 1, nodeToolCrypto), [keys.server]) };
	assert.deepEqual({
		versions: jumpCodeToolVersions(view.targets, 'webstudio').map(item => item.version), found: findJumpCodeToolTarget(view.targets, hash('pdf'), 1000)?.id, notFound: findJumpCodeToolTarget(view.targets, hash('pdf'), 999),
		sameBytesAndManifest: jumpCodeToolMatchesTarget(packed.manifest, listed), filedUnderAnotherTool: jumpCodeToolMatchesTarget(packed.manifest, { ...listed, id: 'archstudio' }),
		morePermissionsThanSigned: jumpCodeToolMatchesTarget(packed.manifest, { ...listed, capabilities: { suppliedText: true, projectFiles: false, network: true } }),
		signedByTheServer: refused(documents([web], { targetsKey: keys.server })), signedByAStranger: refused(documents([web], { targetsKey: keys.stranger })),
		serverImpersonated: refused(documents([web], { serverKey: keys.stranger })), changedAfterSigning: refused(tampered), rewrittenByTheServer: refused(rewritten),
		listFromAnotherSnapshot: refused({ ...good, targets: otherList.targets }), snapshotFromAnotherTimestamp: refused({ ...good, snapshot: otherList.snapshot }),
		expiredTimestamp: refused(documents([web], { timestampExpires: '2026-11-16T11:59:59Z' })), expiredList: refused(documents([web], { targetsExpires: '2026-01-01T00:00:00Z' })),
		notJson: refused({ ...good, targets: 'not json' }),
		wrongName: outcome(() => updateJumpCodeToolTrust(shipped, documents([{ ...web, id: 'acme--pdf' }]), now, nodeToolCrypto)),
		processForOthers: outcome(() => updateJumpCodeToolTrust(shipped, documents([target('acme--pdf', '1.0.0', hash('pdf'), { isolation: 'process' })]), now, nodeToolCrypto)),
	}, {
		versions: ['1.1.0', '1.0.0'], found: 'acme--pdf', notFound: undefined, sameBytesAndManifest: true, filedUnderAnotherTool: false, morePermissionsThanSigned: false,
		signedByTheServer: 'trust_signature', signedByAStranger: 'trust_signature', serverImpersonated: 'trust_signature', changedAfterSigning: 'trust_mismatch', rewrittenByTheServer: 'trust_signature',
		listFromAnotherSnapshot: 'trust_mismatch', snapshotFromAnotherTimestamp: 'trust_mismatch', expiredTimestamp: 'trust_expired', expiredList: 'trust_expired', notJson: 'trust_mismatch',
		wrongName: 'invalid_trust', processForOthers: 'invalid_trust',
	});
});

test('older documents are refused, and what is already trusted stays readable without a network', () => {
	const second = updateJumpCodeToolTrust(shipped, documents([web, target('webstudio', '1.1.0', hash('1.1.0'))], { targetsVersion: 2 }), now, nodeToolCrypto);
	const refused = (update: IJumpCodeToolTrustUpdate) => outcome(() => updateJumpCodeToolTrust(second.state, update, now, nodeToolCrypto).targets.version);
	const revoked = updateJumpCodeToolTrust(second.state, documents([target('webstudio', '1.0.0', hash('webstudio 1.0.0'), { status: 'revoked', reason: 'Reads files outside its Studio.' }), target('webstudio', '1.1.0', hash('1.1.0'))], { targetsVersion: 3 }), now, nodeToolCrypto);
	const later = readJumpCodeToolTrust(revoked.state, nodeToolCrypto);
	const stale = updateJumpCodeToolTrust(shipped, documents([web], { timestampExpires: '2026-11-17T00:00:00Z' }), now, nodeToolCrypto);
	assert.deepEqual({
		replayOfTheFirstList: refused(documents([web], { targetsVersion: 1 })), olderTimestamp: refused(documents([web], { targetsVersion: 2, snapshotVersion: 2, timestampVersion: 1 })),
		sameAgain: refused(documents([web, target('webstudio', '1.1.0', hash('1.1.0'))], { targetsVersion: 2 })),
		revocationArrives: revoked.targets.targets.map(item => [item.version, item.status, item.reason ?? '']),
		offline: later?.targets.targets.map(item => item.status), staleButReadable: [readJumpCodeToolTrust(stale.state, nodeToolCrypto)?.expires, readJumpCodeToolTrust(stale.state, nodeToolCrypto)?.targets.version],
		nothingYet: readJumpCodeToolTrust(shipped, nodeToolCrypto), forgedCache: outcome(() => readJumpCodeToolTrust({ ...revoked.state, targets: revoked.state.targets!.replace('revoked', 'available') }, nodeToolCrypto)),
	}, {
		replayOfTheFirstList: 'trust_rollback', olderTimestamp: 'trust_rollback', sameAgain: 2,
		revocationArrives: [['1.0.0', 'revoked', 'Reads files outside its Studio.'], ['1.1.0', 'available', '']],
		offline: ['revoked', 'available'], staleButReadable: ['2026-11-17T00:00:00Z', 1], nothingYet: undefined, forgedCache: 'trust_signature',
	});
});

test('keys change only through a root signed by the root before it; the server cannot introduce one', () => {
	const rotated = root(2, [keys.root, keys.nextRoot], { root: keys.nextRoot, server: keys.nextServer });
	const trustedOld = updateJumpCodeToolTrust(shipped, documents([web], { targetsVersion: 5 }), now, nodeToolCrypto);
	const withNewServer = documents([web], { targetsVersion: 1, serverKey: keys.nextServer });
	const attempt = (roots: readonly string[], update = withNewServer, state: IJumpCodeToolTrustState = shipped) => outcome(() => {
		const view = updateJumpCodeToolTrust(state, { ...update, roots }, now, nodeToolCrypto);
		return [view.rootVersion, view.targets.version];
	});
	const serverTakesTargets = outcome(() => buildAndRead(keys.server));
	assert.deepEqual({
		rotation: attempt([rotated]), oldServerKeyAfterRotation: attempt([rotated], documents([web])),
		// Online counters can reset, but the offline package history cannot.
		recoversFromLostServerKey: attempt([rotated], withNewServer, trustedOld.state),
		onlySignedByItself: attempt([root(2, [keys.nextRoot], { root: keys.nextRoot, server: keys.nextServer })]),
		onlySignedByTheOldRoot: attempt([root(2, [keys.root], { root: keys.nextRoot, server: keys.nextServer })]),
		signedByTheServer: attempt([root(2, [keys.server, keys.nextRoot], { root: keys.nextRoot, server: keys.nextServer })]),
		skipsAVersion: attempt([root(3, [keys.root, keys.nextRoot], { root: keys.nextRoot, server: keys.nextServer })]),
		olderRootIgnored: attempt([shipped.root], documents([web])), expiredRoot: attempt([root(2, [keys.root, keys.nextRoot], { root: keys.nextRoot, server: keys.nextServer }, '2026-01-01T00:00:00Z')]),
		serverKeyAsPackageSigner: serverTakesTargets,
	}, {
		rotation: [2, 1], oldServerKeyAfterRotation: 'trust_signature', recoversFromLostServerKey: 'trust_rollback',
		onlySignedByItself: 'trust_signature', onlySignedByTheOldRoot: 'trust_signature', signedByTheServer: 'trust_signature', skipsAVersion: 'trust_rollback',
		olderRootIgnored: [1, 1], expiredRoot: 'trust_expired', serverKeyAsPackageSigner: 'invalid_trust',
	});
});

test('rotating targets accepts newly signed metadata without forgetting revocations', () => {
	const next = generateToolKey();
	const blocked = { ...web, status: 'revoked' as const, reason: 'Unsafe version' };
	const old = updateJumpCodeToolTrust(shipped, documents([blocked], { targetsVersion: 5 }), now, nodeToolCrypto);
	const nextRoot = root(2, [keys.root], { targets: next });
	const good = updateJumpCodeToolTrust(old.state, { ...documents([blocked], { targetsVersion: 6, targetsKey: next }), roots: [nextRoot] }, now, nodeToolCrypto);
	assert.deepEqual({
		version: good.targets.version, status: good.targets.targets[0].status,
		replayed: outcome(() => updateJumpCodeToolTrust(old.state, { ...documents([web], { targetsVersion: 4, targetsKey: next }), roots: [nextRoot] }, now, nodeToolCrypto)),
		rewritten: outcome(() => updateJumpCodeToolTrust(old.state, documents([web], { targetsVersion: 5 }), now, nodeToolCrypto)),
	}, { version: 6, status: 'revoked', replayed: 'trust_rollback', rewritten: 'trust_rollback' });
});

/** A root that lets the distribution server's key sign packages is refused even when properly signed. */
function buildAndRead(targetsKey: ToolSigningKey): unknown {
	return readJumpCodeToolTrust({ root: root(1, [keys.root], { targets: targetsKey }) }, nodeToolCrypto);
}

test('the command line produces a root, a signed list and a package that verify together', context => {
	const directory = temporary(context);
	const at = (name: string) => path.join(directory, name);
	const key = (name: string) => JSON.parse(main(['keygen', '--out', at(name)])).public as string;
	const [rootKey, targetsKey, serverKey] = [key('root.key.json'), key('targets.key.json'), key('server.key.json')];
	main(['root', '--version', '1', '--expires', far, '--root-key', rootKey, '--targets-key', targetsKey, '--server-key', serverKey, '--out', at('root.unsigned.json')]);
	main(['sign', '--key', at('root.key.json'), '--in', at('root.unsigned.json'), '--out', at('root.json')]);
	main(['pack', webstudio, '--out', at('webstudio.jctool')]);
	main(['targets', '--version', '1', '--expires', far, '--add', at('webstudio.jctool'), '--out', at('targets.unsigned.json')]);
	main(['sign', '--key', at('targets.key.json'), '--in', at('targets.unsigned.json'), '--out', at('targets.json')]);
	main(['targets', '--version', '2', '--expires', far, '--previous', at('targets.json'), '--status', 'webstudio@1.0.0=revoked:Test revocation', '--out', at('targets2.unsigned.json')]);
	main(['sign', '--key', at('targets.key.json'), '--in', at('targets2.unsigned.json'), '--out', at('targets2.json')]);
	const server = JSON.parse(fs.readFileSync(at('server.key.json'), 'utf8')) as ToolSigningKey;
	const pointers = (targetsText: string, version: number): IJumpCodeToolTrustUpdate => {
		const snapshot = signToolDocument(buildJumpCodeToolPointer('snapshot', version, far, targetsText, version, nodeToolCrypto), [server]);
		return { roots: [], targets: targetsText, snapshot, timestamp: signToolDocument(buildJumpCodeToolPointer('timestamp', version, far, snapshot, version, nodeToolCrypto), [server]) };
	};
	const state = { root: fs.readFileSync(at('root.json'), 'utf8') };
	const first = updateJumpCodeToolTrust(state, pointers(fs.readFileSync(at('targets.json'), 'utf8'), 1), now, nodeToolCrypto);
	const second = updateJumpCodeToolTrust(first.state, pointers(fs.readFileSync(at('targets2.json'), 'utf8'), 2), now, nodeToolCrypto);
	const bytes = fs.readFileSync(at('webstudio.jctool'));
	const found = findJumpCodeToolTarget(first.targets, nodeToolCrypto.sha256(bytes), bytes.length);
	fs.writeFileSync(at('changed.jctool'), Buffer.concat([bytes, Buffer.from('x')]));
	assert.deepEqual({
		listed: found && jumpCodeToolMatchesTarget(readToolArchive(bytes).manifest, found), then: second.targets.targets.map(item => [item.id, item.status, item.reason]),
		unsignedRootRefused: outcome(() => readJumpCodeToolTrust({ root: fs.readFileSync(at('root.unsigned.json'), 'utf8') }, nodeToolCrypto)),
		otherBytesSameVersion: (() => { try { return main(['targets', '--version', '3', '--expires', far, '--previous', at('targets.json'), '--add', at('changed.jctool'), '--out', at('x.json')]); } catch (error) { return (error as Error).message.split(';')[0]; } })(),
		keyFileIsPrivate: process.platform === 'win32' || (fs.statSync(at('root.key.json')).mode & 0o077) === 0,
	}, {
		listed: true, then: [['webstudio', 'revoked', 'Test revocation']], unsignedRootRefused: 'trust_signature',
		otherBytesSameVersion: 'webstudio@1.0.0 is already listed with other contents', keyFileIsPrivate: true,
	});
});
