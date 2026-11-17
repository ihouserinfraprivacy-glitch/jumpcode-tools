/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The JumpCode tool package contract, shared by the desktop application, the backend and the
// packaging tools. This file imports nothing and uses only erasable TypeScript, so each of them
// loads this very file: the application as a module, the packaging tools straight from Node,
// and the backend from a byte-identical copy checked by its tests. Reading a manifest or a trust
// document here never loads or runs anything from a package.

/** Version of the package layout (`jumpcode-tool.json` plus the files it lists). */
export const jumpCodeToolPackageFormat = 1;
/** Versions of the execution contract (the messages between JumpCode and a tool process) this build speaks. */
export const jumpCodeToolContracts: readonly number[] = [1];
export const jumpCodeToolManifestName = 'jumpcode-tool.json';
export const jumpCodeToolPackageExtension = '.jctool';
/** The publisher whose tools use plain identifiers and may ask to run outside the container. */
export const jumpCodeOfficialPublisher = 'jumpcode';
/** Prefix of every tool installed from this computer without established trust; no publisher can own it. */
export const jumpCodeLocalNamespace = 'local';

/**
 * Limits of package format 1. They bound what validation, review and installation must read and
 * hold: a manifest is parsed in memory, every file is hashed, and Windows paths under the install
 * folder must stay below 260 characters. Larger payloads belong in a later format, not in a
 * silent exception.
 */
export const jumpCodeToolPackageLimits = Object.freeze({
	manifestBytes: 1024 * 1024,
	archiveBytes: 128 * 1024 * 1024,
	contentBytes: 128 * 1024 * 1024,
	fileBytes: 64 * 1024 * 1024,
	files: 2000,
	pathLength: 160,
	dependencies: 64,
	interfaceFiles: 32,
	// The tool list travels in one message to the interface, which draws these two images inline.
	markBytes: 16 * 1024,
	coverBytes: 300 * 1024,
	trustDocumentBytes: 4 * 1024 * 1024,
});

export type JumpCodeToolIsolation = 'container' | 'process';
export type JumpCodeToolStatus = 'available' | 'withdrawn' | 'revoked';
/** How far the origin of an installed package is established. */
export type JumpCodeToolTrust = 'official' | 'publisher' | 'local';

export type JumpCodeToolPackageErrorCode =
	| 'invalid_manifest' | 'unsupported_format' | 'invalid_identity' | 'invalid_inventory' | 'incompatible'
	| 'invalid_trust' | 'trust_signature' | 'trust_rollback' | 'trust_expired' | 'trust_mismatch';

/** A package or trust document was refused; nothing from it was loaded or run. */
export class JumpCodeToolPackageError extends Error {
	readonly code: JumpCodeToolPackageErrorCode;
	constructor(code: JumpCodeToolPackageErrorCode, detail: string) {
		super(`${code}: ${detail}`);
		this.code = code;
	}
}

export interface IJumpCodeToolCapabilities {
	/** Works on text the conversation hands to it. */
	readonly suppliedText: boolean;
	/** Asks JumpCode for files of the folder the conversation is allowed to read. */
	readonly projectFiles: boolean;
	/** Asks for network access; granted only under the conversation's approval rules. */
	readonly network: boolean;
}

export interface IJumpCodeToolFile {
	readonly path: string;
	readonly size: number;
	readonly sha256: string;
}

/** Third-party code shipped inside the package, loaded only by this tool's own process. */
export interface IJumpCodeToolVendoredDependency {
	readonly kind: 'python-vendored';
	readonly name: string;
	readonly version: string;
	/** Folder of the package that goes on this tool's import path. */
	readonly root: string;
	/** Where the files came from and the hash of that upstream artifact, so the copy can be checked. */
	readonly origin: string;
	readonly sha256: string;
	readonly license?: string;
}

export type JumpCodeToolDependency = IJumpCodeToolVendoredDependency;

export interface IJumpCodeToolEntry {
	readonly kind: 'python';
	/** Folder of the package that holds the entry module. */
	readonly root: string;
	readonly module: string;
}

export interface IJumpCodeToolStudioContract {
	/** Files of the tool's own interface, joined in this order; reading them never runs the tool. */
	readonly ui?: { readonly scripts: readonly string[]; readonly styles: readonly string[] };
	/** Version of the data this package writes in a Studio folder, and the versions it can open. */
	readonly data?: { readonly format: number; readonly reads: readonly number[] };
}

export interface IJumpCodeToolCompatibility {
	/** Lowest JumpCode version that can run the package. */
	readonly app?: { readonly minimum: string };
	/** Python versions of the executor, as `major.minor`: from `minimum` up to but excluding `below`. */
	readonly python: { readonly minimum: string; readonly below?: string };
	readonly platforms: readonly string[];
}

/** The static catalog entry: texts, instructions for the model and the argument schema. */
export interface IJumpCodeToolDescription {
	readonly name: string;
	readonly description: string;
	readonly icon: string;
	readonly instructions: string;
	readonly inputSchema: object;
	readonly details?: object;
	readonly studio?: { readonly title: string; readonly description: string; readonly ui?: boolean };
}

export interface IJumpCodeToolPackageManifest {
	readonly format: number;
	readonly id: string;
	readonly publisher: string;
	readonly version: string;
	readonly contract: number;
	readonly compatibility: IJumpCodeToolCompatibility;
	readonly entry: IJumpCodeToolEntry;
	readonly isolation: JumpCodeToolIsolation;
	readonly capabilities: IJumpCodeToolCapabilities;
	readonly tool: IJumpCodeToolDescription;
	readonly studio?: IJumpCodeToolStudioContract;
	readonly assets?: { readonly mark?: string; readonly cover?: string };
	/** Optional storefront metadata. Categories are data, never executable UI configuration. */
	readonly store?: { readonly categories: readonly { readonly id: string; readonly name: string }[]; readonly license?: string };
	readonly dependencies: readonly JumpCodeToolDependency[];
	readonly files: readonly IJumpCodeToolFile[];
}

/** What the running application offers a package. */
export interface IJumpCodeToolHostFacts {
	readonly appVersion: string;
	readonly platform: string;
	/** `major.minor.patch` of the executor's Python. */
	readonly python: string;
}

type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };
type Record_ = { readonly [key: string]: unknown };

const namePattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const versionPattern = /^(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})$/;
const pythonPattern = /^3\.(0|[1-9][0-9]?)$/;
const platformPattern = /^(win32|linux|darwin)-(x64|arm64)$/;
const sha256Pattern = /^[a-f0-9]{64}$/;
const modulePattern = /^[a-z_][a-z0-9_]{0,63}$/;
const reservedSegment = /^(con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/i;

function refuse(code: JumpCodeToolPackageErrorCode, detail: string): never { throw new JumpCodeToolPackageError(code, detail); }
function isRecord(value: unknown): value is Record_ { return typeof value === 'object' && value !== null && !Array.isArray(value); }

function record(value: unknown, where: string, allowed: readonly string[], code: JumpCodeToolPackageErrorCode = 'invalid_manifest'): Record_ {
	if (!isRecord(value)) { refuse(code, `${where} must be an object`); }
	for (const key of Object.keys(value)) {
		if (!allowed.includes(key)) { refuse(code, `${where} has the unknown field ${key.slice(0, 40)}`); }
	}
	return value;
}

function text(value: unknown, where: string, maximum: number, code: JumpCodeToolPackageErrorCode = 'invalid_manifest', minimum = 1): string {
	// Control characters never belong in these fields, and their absence keeps signed documents canonical.
	if (typeof value !== 'string' || value.length < minimum || value.length > maximum || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) {
		refuse(code, `${where} must be text of ${minimum} to ${maximum} characters`);
	}
	return value;
}

function integer(value: unknown, where: string, minimum: number, maximum: number, code: JumpCodeToolPackageErrorCode = 'invalid_manifest'): number {
	if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) { refuse(code, `${where} must be a whole number from ${minimum} to ${maximum}`); }
	return value;
}

function flag(value: unknown, where: string, code: JumpCodeToolPackageErrorCode = 'invalid_manifest'): boolean {
	if (typeof value !== 'boolean') { refuse(code, `${where} must be true or false`); }
	return value;
}

function list(value: unknown, where: string, maximum: number, code: JumpCodeToolPackageErrorCode = 'invalid_manifest'): readonly unknown[] {
	if (!Array.isArray(value) || value.length > maximum) { refuse(code, `${where} must be a list of at most ${maximum} items`); }
	return value;
}

/** Compares two `x.y.z` versions; both must already be valid. */
export function compareJumpCodeToolVersions(first: string, second: string): number {
	const a = first.split('.').map(Number);
	const b = second.split('.').map(Number);
	for (let index = 0; index < 3; index++) {
		const difference = (a[index] ?? 0) - (b[index] ?? 0);
		if (difference) { return difference < 0 ? -1 : 1; }
	}
	return 0;
}

export function isJumpCodeToolVersion(value: unknown): value is string { return typeof value === 'string' && versionPattern.test(value); }

/**
 * A path inside a package: forward slashes, no drive, stream, wildcard or control character, no
 * empty, `.` or `..` segment, nothing Windows treats as a device, and no trailing dot or space
 * (Windows drops them, which would make two names one file).
 */
export function isJumpCodeToolPackagePath(path: unknown): path is string {
	if (typeof path !== 'string' || !path.length || path.length > jumpCodeToolPackageLimits.pathLength || path !== path.normalize('NFC')) { return false; }
	if (/[\\:<>"|?*\u0000-\u001f\u007f]/.test(path)) { return false; }
	return path.split('/').every(segment => segment.length > 0 && segment !== '.' && segment !== '..' && !/[. ]$/.test(segment) && !reservedSegment.test(segment));
}

/** Whether `path` is `folder` itself is not accepted: it must be a file under that folder. */
function under(path: string, folder: string): boolean { return path.startsWith(`${folder}/`); }

/**
 * The identifier rules that keep one package from taking another's place. The official publisher
 * uses plain names; everyone else carries the publisher as a prefix, joined by a double hyphen
 * that a plain name can never contain; `local` is reserved for packages installed from this
 * computer without established trust.
 */
export function checkJumpCodeToolIdentity(id: unknown, publisher: unknown): void {
	if (typeof publisher !== 'string' || publisher.length > 24 || !namePattern.test(publisher) || publisher === jumpCodeLocalNamespace) { refuse('invalid_identity', 'publisher must be a short lowercase name and cannot be "local"'); }
	if (typeof id !== 'string' || id.length > 48) { refuse('invalid_identity', 'tool id must have at most 48 characters'); }
	const parts = id.split('--');
	if (!parts.every(part => namePattern.test(part))) { refuse('invalid_identity', 'tool id must use lowercase letters, digits and single hyphens'); }
	if (publisher === jumpCodeOfficialPublisher ? parts.length !== 1 : parts.length !== 2 || parts[0] !== publisher) {
		refuse('invalid_identity', publisher === jumpCodeOfficialPublisher ? 'official tool ids are plain names' : `tool id must be ${publisher}--<name>`);
	}
}

/** The identifier a package gets once installed: its own under established trust, `local--…` otherwise. */
export function jumpCodeInstalledToolId(id: string, trust: JumpCodeToolTrust): string {
	return trust === 'local' ? `${jumpCodeLocalNamespace}--${id}` : id;
}

function readCapabilities(value: unknown, where: string, code: JumpCodeToolPackageErrorCode = 'invalid_manifest'): IJumpCodeToolCapabilities {
	const source = record(value, where, ['suppliedText', 'projectFiles', 'network'], code);
	return Object.freeze({
		suppliedText: flag(source.suppliedText, `${where}.suppliedText`, code),
		projectFiles: flag(source.projectFiles, `${where}.projectFiles`, code),
		network: flag(source.network, `${where}.network`, code),
	});
}

function readFiles(value: unknown): readonly IJumpCodeToolFile[] {
	const items = list(value, 'files', jumpCodeToolPackageLimits.files, 'invalid_inventory');
	if (!items.length) { refuse('invalid_inventory', 'files must list the package contents'); }
	const seen = new Set<string>();
	const folders = new Set<string>();
	const files: IJumpCodeToolFile[] = [];
	let total = 0;
	for (const item of items) {
		const source = record(item, 'files[]', ['path', 'size', 'sha256'], 'invalid_inventory');
		if (!isJumpCodeToolPackagePath(source.path) || source.path === jumpCodeToolManifestName) { refuse('invalid_inventory', 'a listed path is unsafe or reserved'); }
		const size = integer(source.size, 'files[].size', 0, jumpCodeToolPackageLimits.fileBytes, 'invalid_inventory');
		if (typeof source.sha256 !== 'string' || !sha256Pattern.test(source.sha256)) { refuse('invalid_inventory', 'files[].sha256 must be a lowercase SHA-256'); }
		// Windows and macOS fold case: two names that differ only by case are one file there.
		const key = source.path.toLowerCase();
		if (seen.has(key)) { refuse('invalid_inventory', 'two listed paths name the same file'); }
		seen.add(key);
		const segments = key.split('/');
		for (let depth = 1; depth < segments.length; depth++) { folders.add(segments.slice(0, depth).join('/')); }
		total += size;
		files.push(Object.freeze({ path: source.path, size, sha256: source.sha256 }));
	}
	for (const path of seen) {
		if (folders.has(path)) { refuse('invalid_inventory', 'a listed path is both a file and a folder'); }
	}
	if (total > jumpCodeToolPackageLimits.contentBytes) { refuse('invalid_inventory', 'the package contents exceed the size limit'); }
	return Object.freeze(files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

function readDescription(value: unknown, capabilities: IJumpCodeToolCapabilities): IJumpCodeToolDescription {
	const source = record(value, 'tool', ['name', 'description', 'icon', 'instructions', 'inputSchema', 'details', 'studio']);
	if (typeof source.icon !== 'string' || source.icon.length > 64 || !/^[a-z][a-z0-9-]*$/.test(source.icon)) { refuse('invalid_manifest', 'tool.icon must be an icon name'); }
	if (!isRecord(source.inputSchema) || source.inputSchema.type !== 'object') { refuse('invalid_manifest', 'tool.inputSchema must describe an object'); }
	// The limits below are the ones the interface applies to every entry of the tool list, so a
	// package that passes here is never the entry that makes the list unreadable.
	let description: object | undefined;
	if (source.details !== undefined) {
		const details = description = record(source.details, 'tool.details', ['about', 'features', 'limitations', 'examples', 'author', 'updatedAt', 'execution', 'access']);
		text(details.about, 'tool.details.about', 2000);
		text(details.author, 'tool.details.author', 120);
		const updatedAt = details.updatedAt;
		if (typeof updatedAt !== 'string' || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(updatedAt) || Number.isNaN(Date.parse(updatedAt)) || new Date(updatedAt).toISOString().slice(0, 10) !== updatedAt) { refuse('invalid_manifest', 'tool.details.updatedAt must be a date'); }
		if (details.execution !== 'local') { refuse('invalid_manifest', 'tool.details.execution must be local'); }
		for (const name of ['features', 'limitations', 'examples']) {
			for (const item of list(details[name], `tool.details.${name}`, 12)) {
				if (!text(item, `tool.details.${name}[]`, 1000).trim()) { refuse('invalid_manifest', `tool.details.${name} holds an empty item`); }
			}
		}
		// The page that describes the tool may not promise less access than the package asks for.
		if (canonicalJumpCodeToolJson(toJson(readCapabilities(details.access, 'tool.details.access'), 'tool.details.access')) !== canonicalJumpCodeToolJson(toJson(capabilities, 'capabilities'))) {
			refuse('invalid_manifest', 'tool.details.access must equal capabilities');
		}
	}
	let studio: IJumpCodeToolDescription['studio'];
	if (source.studio !== undefined) {
		const block = record(source.studio, 'tool.studio', ['title', 'description', 'ui']);
		studio = Object.freeze({ title: text(block.title, 'tool.studio.title', 60), description: text(block.description, 'tool.studio.description', 120), ...(block.ui === undefined ? {} : { ui: flag(block.ui, 'tool.studio.ui') }) });
	}
	if (!text(source.name, 'tool.name', 80).trim() || studio && !studio.title.trim()) { refuse('invalid_manifest', 'tool.name and tool.studio.title cannot be blank'); }
	return Object.freeze({
		name: text(source.name, 'tool.name', 80), description: text(source.description, 'tool.description', 600), icon: source.icon,
		instructions: text(source.instructions, 'tool.instructions', 20000), inputSchema: source.inputSchema,
		...(description ? { details: description } : {}), ...(studio ? { studio } : {}),
	});
}

/**
 * Validates a package manifest and returns a detached, frozen copy. Only data is read: the entry
 * module, the interface files and the dependencies are checked against the file list, never
 * opened or imported.
 */
export function readJumpCodeToolManifest(value: unknown): IJumpCodeToolPackageManifest {
	const source = record(value, 'manifest', ['format', 'id', 'publisher', 'version', 'contract', 'compatibility', 'entry', 'isolation', 'capabilities', 'tool', 'studio', 'assets', 'store', 'dependencies', 'files']);
	if (source.format !== jumpCodeToolPackageFormat) { refuse('unsupported_format', `package format ${String(source.format).slice(0, 12)} is not supported; this build reads format ${jumpCodeToolPackageFormat}`); }
	checkJumpCodeToolIdentity(source.id, source.publisher);
	const id = source.id as string;
	const publisher = source.publisher as string;
	if (!isJumpCodeToolVersion(source.version)) { refuse('invalid_manifest', 'version must be x.y.z'); }
	const contract = integer(source.contract, 'contract', 1, 1000);
	const files = readFiles(source.files);
	const paths = new Set(files.map(file => file.path));
	const sizes = new Map(files.map(file => [file.path, file.size]));
	const listed = (path: unknown, where: string, pattern?: RegExp, maximum = jumpCodeToolPackageLimits.fileBytes): string => {
		if (typeof path !== 'string' || !paths.has(path) || pattern && !pattern.test(path) || (sizes.get(path) ?? 0) > maximum) { refuse('invalid_manifest', `${where} must name a listed file of the expected kind and size`); }
		return path;
	};
	const folder = (path: unknown, where: string): string => {
		if (!isJumpCodeToolPackagePath(path) || !files.some(file => under(file.path, path))) { refuse('invalid_manifest', `${where} must be a folder of the package`); }
		return path;
	};

	const compatibilitySource = record(source.compatibility, 'compatibility', ['app', 'python', 'platforms']);
	const pythonSource = record(compatibilitySource.python, 'compatibility.python', ['minimum', 'below']);
	if (typeof pythonSource.minimum !== 'string' || !pythonPattern.test(pythonSource.minimum) || pythonSource.below !== undefined && (typeof pythonSource.below !== 'string' || !pythonPattern.test(pythonSource.below))) {
		refuse('invalid_manifest', 'compatibility.python uses major.minor versions');
	}
	const platforms = list(compatibilitySource.platforms, 'compatibility.platforms', 8).map(platform => typeof platform === 'string' && platformPattern.test(platform) ? platform : refuse('invalid_manifest', 'compatibility.platforms lists values such as win32-x64'));
	if (!platforms.length || new Set(platforms).size !== platforms.length) { refuse('invalid_manifest', 'compatibility.platforms must list each platform once'); }
	let app: IJumpCodeToolCompatibility['app'];
	if (compatibilitySource.app !== undefined) {
		const minimum = record(compatibilitySource.app, 'compatibility.app', ['minimum']).minimum;
		if (!isJumpCodeToolVersion(minimum)) { refuse('invalid_manifest', 'compatibility.app.minimum must be x.y.z'); }
		app = Object.freeze({ minimum });
	}

	const entrySource = record(source.entry, 'entry', ['kind', 'root', 'module']);
	if (entrySource.kind !== 'python' || typeof entrySource.module !== 'string' || !modulePattern.test(entrySource.module)) { refuse('invalid_manifest', 'entry must name a Python module'); }
	const entryRoot = folder(entrySource.root, 'entry.root');
	listed(`${entryRoot}/${entrySource.module}/__init__.py`, 'entry.module');

	if (source.isolation !== 'container' && source.isolation !== 'process') { refuse('invalid_manifest', 'isolation must be container or process'); }
	// Running outside the container is only ever available to the official publisher.
	if (source.isolation === 'process' && publisher !== jumpCodeOfficialPublisher) { refuse('invalid_manifest', 'only official tools may ask to run outside the container'); }
	const capabilities = readCapabilities(source.capabilities, 'capabilities');
	const tool = readDescription(source.tool, capabilities);

	let studio: IJumpCodeToolStudioContract | undefined;
	if (source.studio !== undefined) {
		const block = record(source.studio, 'studio', ['ui', 'data']);
		let ui: IJumpCodeToolStudioContract['ui'];
		if (block.ui !== undefined) {
			const uiSource = record(block.ui, 'studio.ui', ['scripts', 'styles']);
			const scripts = list(uiSource.scripts, 'studio.ui.scripts', jumpCodeToolPackageLimits.interfaceFiles).map(path => listed(path, 'studio.ui.scripts', /\.js$/));
			const styles = list(uiSource.styles, 'studio.ui.styles', jumpCodeToolPackageLimits.interfaceFiles).map(path => listed(path, 'studio.ui.styles', /\.css$/));
			if (!scripts.length) { refuse('invalid_manifest', 'studio.ui.scripts must list at least one script'); }
			ui = Object.freeze({ scripts: Object.freeze(scripts), styles: Object.freeze(styles) });
		}
		let data: IJumpCodeToolStudioContract['data'];
		if (block.data !== undefined) {
			const dataSource = record(block.data, 'studio.data', ['format', 'reads']);
			const format = integer(dataSource.format, 'studio.data.format', 1, 1000000);
			const reads = list(dataSource.reads, 'studio.data.reads', 64).map(item => integer(item, 'studio.data.reads[]', 1, 1000000));
			if (!reads.includes(format) || new Set(reads).size !== reads.length) { refuse('invalid_manifest', 'studio.data.reads must list each readable format once, including the one written'); }
			data = Object.freeze({ format, reads: Object.freeze(reads.sort((a, b) => a - b)) });
		}
		studio = Object.freeze({ ...(ui ? { ui } : {}), ...(data ? { data } : {}) });
	}
	if ((tool.studio?.ui === true) !== (studio?.ui !== undefined)) { refuse('invalid_manifest', 'tool.studio.ui and studio.ui must agree'); }
	if (studio && !tool.studio) { refuse('invalid_manifest', 'studio requires tool.studio'); }

	let assets: IJumpCodeToolPackageManifest['assets'];
	if (source.assets !== undefined) {
		const block = record(source.assets, 'assets', ['mark', 'cover']);
		assets = Object.freeze({
			...(block.mark === undefined ? {} : { mark: listed(block.mark, 'assets.mark', /\.svg$/, jumpCodeToolPackageLimits.markBytes) }),
			...(block.cover === undefined ? {} : { cover: listed(block.cover, 'assets.cover', /\.png$/, jumpCodeToolPackageLimits.coverBytes) }),
		});
	}

	let storefront: IJumpCodeToolPackageManifest['store'];
	if (source.store !== undefined) {
		const block = record(source.store, 'store', ['categories', 'license']);
		const categories = list(block.categories, 'store.categories', 12).map(value => {
			const category = record(value, 'store.categories[]', ['id', 'name']);
			const id = text(category.id, 'store.categories[].id', 64);
			if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) { refuse('invalid_manifest', 'invalid category id'); }
			return Object.freeze({ id, name: text(category.name, 'store.categories[].name', 80) });
		});
		if (new Set(categories.map(item => item.id)).size !== categories.length) { refuse('invalid_manifest', 'duplicate category'); }
		storefront = Object.freeze({ categories: Object.freeze(categories), ...(block.license === undefined ? {} : { license: text(block.license, 'store.license', 60) }) });
	}
	const roots = new Set<string>([entryRoot]);
	const dependencies = list(source.dependencies, 'dependencies', jumpCodeToolPackageLimits.dependencies).map((item): JumpCodeToolDependency => {
		const dependency = record(item, 'dependencies[]', ['kind', 'name', 'version', 'root', 'origin', 'sha256', 'license']);
		// A kind this build does not know cannot be honoured, so the package is refused rather than half-installed.
		if (dependency.kind !== 'python-vendored') { refuse('incompatible', `this build cannot provide a dependency of kind ${String(dependency.kind).slice(0, 40)}`); }
		const root = folder(dependency.root, 'dependencies[].root');
		for (const other of roots) {
			if (other === root || under(root, other) || under(other, root)) { refuse('invalid_manifest', 'dependency folders must not overlap each other or the entry folder'); }
		}
		roots.add(root);
		if (typeof dependency.origin !== 'string' || dependency.origin.length > 300 || !/^https:\/\/[^\s"<>\\]+$/.test(dependency.origin)) { refuse('invalid_manifest', 'dependencies[].origin must be an HTTPS address'); }
		if (typeof dependency.sha256 !== 'string' || !sha256Pattern.test(dependency.sha256)) { refuse('invalid_manifest', 'dependencies[].sha256 must be the SHA-256 of the upstream artifact'); }
		return Object.freeze({
			kind: 'python-vendored', name: text(dependency.name, 'dependencies[].name', 80), version: text(dependency.version, 'dependencies[].version', 40), root, origin: dependency.origin, sha256: dependency.sha256,
			...(dependency.license === undefined ? {} : { license: text(dependency.license, 'dependencies[].license', 80) }),
		});
	});

	const manifest: IJumpCodeToolPackageManifest = {
		format: jumpCodeToolPackageFormat, id, publisher, version: source.version, contract,
		compatibility: Object.freeze({ ...(app ? { app } : {}), python: Object.freeze({ minimum: pythonSource.minimum, ...(pythonSource.below === undefined ? {} : { below: pythonSource.below as string }) }), platforms: Object.freeze(platforms) }),
		entry: Object.freeze({ kind: 'python', root: entryRoot, module: entrySource.module }), isolation: source.isolation, capabilities, tool,
		...(studio ? { studio } : {}), ...(assets ? { assets } : {}), ...(storefront ? { store: storefront } : {}), dependencies: Object.freeze(dependencies), files,
	};
	// The manifest is data: anything JSON cannot carry is refused. Argument schemas may hold fractional limits;
	// only the signed documents, which are compared in canonical form, are restricted to whole numbers.
	checkData(manifest, 'manifest', 0);
	return Object.freeze(manifest);
}

/** Why this application cannot run the package, or `undefined` when it can. */
export function jumpCodeToolIncompatibility(manifest: IJumpCodeToolPackageManifest, host: IJumpCodeToolHostFacts): string | undefined {
	if (!jumpCodeToolContracts.includes(manifest.contract)) { return `needs execution contract ${manifest.contract}`; }
	if (!manifest.compatibility.platforms.includes(host.platform)) { return `does not support ${host.platform}`; }
	if (manifest.compatibility.app && compareJumpCodeToolVersions(host.appVersion, manifest.compatibility.app.minimum) < 0) { return `needs JumpCode ${manifest.compatibility.app.minimum} or newer`; }
	const minor = (value: string) => Number(value.split('.')[1] ?? 0);
	const python = manifest.compatibility.python;
	if (minor(host.python) < minor(python.minimum) || python.below !== undefined && minor(host.python) >= minor(python.below)) { return `needs Python ${python.minimum}${python.below ? ` up to ${python.below}` : ' or newer'}`; }
	return undefined;
}

/**
 * Whether a Studio's saved data survives switching a tool from one package to another. `current`
 * is the data format last written in that Studio (undefined when nothing was written yet).
 */
export function jumpCodeToolReadsData(manifest: IJumpCodeToolPackageManifest, current: number | undefined): boolean {
	return current === undefined || !manifest.studio?.data || manifest.studio.data.reads.includes(current);
}

// --- Signed trust documents -------------------------------------------------------------------
//
// The documents follow The Update Framework (TUF) 1.0 metadata: a root shipped with the
// application names the keys of four roles; `targets` (signed offline) lists every published
// package with its identity, hash, permissions and status; `snapshot` and `timestamp` (signed by
// the distribution server) say which targets document is current and until when. The server can
// therefore delay or withhold, which the expiry dates expose, but cannot add a package, change a
// hash or permission, or introduce a key: only a root signed by the previous root can.

/** Plain JSON data of bounded depth: no functions, no non-finite numbers, nothing JSON would drop or alter. */
function checkData(value: unknown, where: string, depth: number): void {
	if (value === null || typeof value === 'boolean' || typeof value === 'string' || typeof value === 'number' && Number.isFinite(value)) { return; }
	if (depth > 64) { refuse('invalid_manifest', `${where} is nested too deeply`); }
	if (Array.isArray(value)) { value.forEach((item, index) => checkData(item, `${where}[${index}]`, depth + 1)); return; }
	if (isRecord(value)) {
		for (const key of Object.keys(value)) { checkData(value[key], `${where}.${key.slice(0, 40)}`, depth + 1); }
		return;
	}
	refuse('invalid_manifest', `${where} holds a value JSON cannot carry`);
}

function toJson(value: unknown, where: string): Json {
	if (value === null || typeof value === 'boolean' || typeof value === 'string') { return value; }
	if (typeof value === 'number') {
		if (!Number.isSafeInteger(value)) { refuse('invalid_manifest', `${where} holds a number that is not a whole number`); }
		return value;
	}
	if (Array.isArray(value)) { return value.map((item, index) => toJson(item, `${where}[${index}]`)); }
	if (isRecord(value)) {
		const result: { [key: string]: Json } = {};
		for (const key of Object.keys(value)) { result[key] = toJson(value[key], `${where}.${key.slice(0, 40)}`); }
		return result;
	}
	return refuse('invalid_manifest', `${where} holds a value JSON cannot carry`);
}

/** Canonical JSON as TUF signs it: sorted keys, no spaces, only `\` and `"` escaped, whole numbers. */
export function canonicalJumpCodeToolJson(value: Json): string {
	if (value === null || typeof value === 'boolean' || typeof value === 'number') { return String(value); }
	if (typeof value === 'string') { return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`; }
	if (Array.isArray(value)) { return `[${value.map(item => canonicalJumpCodeToolJson(item)).join(',')}]`; }
	const object = value as { readonly [key: string]: Json };
	return `{${Object.keys(object).sort().map(key => `${canonicalJumpCodeToolJson(key)}:${canonicalJumpCodeToolJson(object[key] ?? null)}`).join(',')}}`;
}

/** The only cryptography the contract needs; each program supplies its platform's implementation. */
export interface IJumpCodeToolCrypto {
	sha256(bytes: Uint8Array): string;
	/** Ed25519: `publicKey` and `signature` are lowercase hexadecimal. */
	verify(publicKey: string, message: Uint8Array, signature: string): boolean;
}

export type JumpCodeToolRole = 'root' | 'targets' | 'snapshot' | 'timestamp';
const roles: readonly JumpCodeToolRole[] = ['root', 'targets', 'snapshot', 'timestamp'];
const specVersion = '1.0.31';
const hexKey = /^[a-f0-9]{64}$/;
const hexSignature = /^[a-f0-9]{128}$/;

export interface IJumpCodeToolKey { readonly keytype: 'ed25519'; readonly scheme: 'ed25519'; readonly keyval: { readonly public: string } }
export interface IJumpCodeToolSignature { readonly keyid: string; readonly sig: string }
export interface IJumpCodeToolSigned<T> { readonly signed: T; readonly signatures: readonly IJumpCodeToolSignature[] }

export interface IJumpCodeToolRoot {
	readonly _type: 'root';
	readonly spec_version: string;
	readonly version: number;
	readonly expires: string;
	readonly consistent_snapshot: false;
	readonly keys: { readonly [keyid: string]: IJumpCodeToolKey };
	readonly roles: { readonly [role in JumpCodeToolRole]: { readonly keyids: readonly string[]; readonly threshold: number } };
}

/** One published package version, as the offline signature binds it. */
export interface IJumpCodeToolTarget {
	readonly path: string;
	readonly length: number;
	readonly sha256: string;
	readonly id: string;
	readonly version: string;
	readonly publisher: string;
	readonly contract: number;
	readonly isolation: JumpCodeToolIsolation;
	readonly capabilities: IJumpCodeToolCapabilities;
	readonly status: JumpCodeToolStatus;
	/** Why a version was withdrawn or revoked, for the person who has it installed. */
	readonly reason?: string;
}

export interface IJumpCodeToolTargets {
	readonly version: number;
	readonly expires: string;
	readonly targets: readonly IJumpCodeToolTarget[];
}

/** The exact texts of the documents a client trusts; versions and keys are always re-read from them. */
export interface IJumpCodeToolTrustState {
	readonly root: string;
	readonly timestamp?: string;
	readonly snapshot?: string;
	readonly targets?: string;
}

/** What a server offers: newer roots in order, then the three current documents, each as its exact text. */
export interface IJumpCodeToolTrustUpdate {
	readonly roots: readonly string[];
	readonly timestamp: string;
	readonly snapshot: string;
	readonly targets: string;
}

export interface IJumpCodeToolTrustView {
	readonly state: IJumpCodeToolTrustState;
	readonly rootVersion: number;
	readonly targets: IJumpCodeToolTargets;
	/** The earliest expiry among the documents in use; past it the list may be stale. */
	readonly expires: string;
}

export function jumpCodeToolTargetPath(id: string, version: string): string { return `${id}/${version}${jumpCodeToolPackageExtension}`; }

/** The identifier of a key: the SHA-256 of its canonical JSON, as TUF defines it. */
export function jumpCodeToolKeyId(publicKey: string, crypto: IJumpCodeToolCrypto): string {
	return crypto.sha256(new TextEncoder().encode(canonicalJumpCodeToolJson({ keytype: 'ed25519', scheme: 'ed25519', keyval: { public: publicKey } })));
}

/** The bytes a signature covers. */
export function jumpCodeToolSignedBytes(signed: object): Uint8Array { return new TextEncoder().encode(canonicalJumpCodeToolJson(toJson(signed, 'signed'))); }

function parseDocument(textValue: unknown, where: string): { readonly signed: Record_; readonly signatures: readonly IJumpCodeToolSignature[] } {
	if (typeof textValue !== 'string' || textValue.length > jumpCodeToolPackageLimits.trustDocumentBytes) { refuse('invalid_trust', `${where} is missing or too large`); }
	let value: unknown;
	try { value = JSON.parse(textValue); } catch { refuse('invalid_trust', `${where} is not JSON`); }
	const document = record(value, where, ['signed', 'signatures'], 'invalid_trust');
	if (!isRecord(document.signed)) { refuse('invalid_trust', `${where} has no signed part`); }
	const signatures = list(document.signatures, `${where}.signatures`, 32, 'invalid_trust').map(item => {
		const signature = record(item, `${where}.signatures[]`, ['keyid', 'sig'], 'invalid_trust');
		if (typeof signature.keyid !== 'string' || !sha256Pattern.test(signature.keyid) || typeof signature.sig !== 'string' || !hexSignature.test(signature.sig)) { refuse('invalid_trust', `${where} has a malformed signature`); }
		return { keyid: signature.keyid, sig: signature.sig };
	});
	return { signed: document.signed, signatures };
}

function header(signed: Record_, type: JumpCodeToolRole, where: string): { readonly version: number; readonly expires: string } {
	if (signed._type !== type || typeof signed.spec_version !== 'string' || !/^1\.[0-9]{1,3}\.[0-9]{1,3}$/.test(signed.spec_version)) { refuse('invalid_trust', `${where} is not a ${type} document of a supported specification`); }
	const expires = signed.expires;
	if (typeof expires !== 'string' || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$/.test(expires) || Number.isNaN(Date.parse(expires))) { refuse('invalid_trust', `${where} has no valid expiry`); }
	return { version: integer(signed.version, `${where}.version`, 1, 2 ** 31, 'invalid_trust'), expires };
}

function readRoot(signed: Record_, where: string, crypto: IJumpCodeToolCrypto): IJumpCodeToolRoot {
	const { version, expires } = header(signed, 'root', where);
	record(signed, where, ['_type', 'spec_version', 'version', 'expires', 'consistent_snapshot', 'keys', 'roles'], 'invalid_trust');
	if (signed.consistent_snapshot !== false || !isRecord(signed.keys) || !isRecord(signed.roles)) { refuse('invalid_trust', `${where} is incomplete`); }
	const keys: { [keyid: string]: IJumpCodeToolKey } = {};
	const publicKeys = new Set<string>();
	for (const keyid of Object.keys(signed.keys)) {
		const key = record(signed.keys[keyid], `${where}.keys[]`, ['keytype', 'scheme', 'keyval'], 'invalid_trust');
		const keyval = record(key.keyval, `${where}.keys[].keyval`, ['public'], 'invalid_trust');
		if (key.keytype !== 'ed25519' || key.scheme !== 'ed25519' || typeof keyval.public !== 'string' || !hexKey.test(keyval.public)) { refuse('invalid_trust', `${where} names a key that is not Ed25519`); }
		// One key under two identifiers would count twice towards a threshold.
		if (jumpCodeToolKeyId(keyval.public, crypto) !== keyid || publicKeys.has(keyval.public)) { refuse('invalid_trust', `${where} names a key under the wrong identifier`); }
		publicKeys.add(keyval.public);
		keys[keyid] = { keytype: 'ed25519', scheme: 'ed25519', keyval: { public: keyval.public } };
	}
	if (Object.keys(keys).length > 32 || Object.keys(signed.roles).length !== roles.length) { refuse('invalid_trust', `${where} must define exactly the four roles`); }
	const assigned: { [role: string]: { keyids: readonly string[]; threshold: number } } = {};
	for (const role of roles) {
		const block = record(signed.roles[role], `${where}.roles.${role}`, ['keyids', 'threshold'], 'invalid_trust');
		const keyids = list(block.keyids, `${where}.roles.${role}.keyids`, 16, 'invalid_trust').map(keyid => typeof keyid === 'string' && keys[keyid] ? keyid : refuse('invalid_trust', `${where} assigns an unknown key to ${role}`));
		const threshold = integer(block.threshold, `${where}.roles.${role}.threshold`, 1, 16, 'invalid_trust');
		if (new Set(keyids).size !== keyids.length || threshold > keyids.length) { refuse('invalid_trust', `${where} asks ${role} for more signatures than it has keys`); }
		assigned[role] = { keyids, threshold };
	}
	// The keys that sign what is published must not be the ones the distribution server holds.
	const online = new Set([...(assigned.snapshot?.keyids ?? []), ...(assigned.timestamp?.keyids ?? [])]);
	if ([...(assigned.root?.keyids ?? []), ...(assigned.targets?.keyids ?? [])].some(keyid => online.has(keyid))) { refuse('invalid_trust', `${where} gives a server key the power to sign packages or keys`); }
	return { _type: 'root', spec_version: signed.spec_version as string, version, expires, consistent_snapshot: false, keys, roles: assigned as IJumpCodeToolRoot['roles'] };
}

function verifyRole(document: { readonly signed: Record_; readonly signatures: readonly IJumpCodeToolSignature[] }, role: JumpCodeToolRole, root: IJumpCodeToolRoot, crypto: IJumpCodeToolCrypto, where: string): void {
	const { keyids, threshold } = root.roles[role];
	const message = jumpCodeToolSignedBytes(document.signed);
	const valid = new Set<string>();
	for (const signature of document.signatures) {
		const key = keyids.includes(signature.keyid) ? root.keys[signature.keyid] : undefined;
		if (key && !valid.has(signature.keyid) && crypto.verify(key.keyval.public, message, signature.sig)) { valid.add(signature.keyid); }
	}
	if (valid.size < threshold) { refuse('trust_signature', `${where} is not signed by enough ${role} keys`); }
}

function expired(expires: string, now: number): boolean { return Date.parse(expires) <= now; }

function metaVersion(signed: Record_, name: string, where: string, body: string | undefined, crypto: IJumpCodeToolCrypto): number {
	const meta = record(signed.meta, `${where}.meta`, [name], 'invalid_trust');
	const entry = record(meta[name], `${where}.meta[]`, ['version', 'length', 'hashes'], 'invalid_trust');
	const version = integer(entry.version, `${where}.meta[].version`, 1, 2 ** 31, 'invalid_trust');
	if (body !== undefined) {
		const bytes = new TextEncoder().encode(body);
		const hashes = entry.hashes === undefined ? undefined : record(entry.hashes, `${where}.meta[].hashes`, ['sha256'], 'invalid_trust');
		if (entry.length !== undefined && entry.length !== bytes.length || hashes && hashes.sha256 !== crypto.sha256(bytes)) { refuse('trust_mismatch', `${where} does not describe the document that came with it`); }
	}
	return version;
}

function readTargets(signed: Record_, where: string): IJumpCodeToolTargets {
	const { version, expires } = header(signed, 'targets', where);
	record(signed, where, ['_type', 'spec_version', 'version', 'expires', 'targets'], 'invalid_trust');
	if (!isRecord(signed.targets) || Object.keys(signed.targets).length > 20000) { refuse('invalid_trust', `${where} has no package list`); }
	const targets: IJumpCodeToolTarget[] = [];
	for (const path of Object.keys(signed.targets).sort()) {
		const entry = record(signed.targets[path], `${where}.targets[]`, ['length', 'hashes', 'custom'], 'invalid_trust');
		const hashes = record(entry.hashes, `${where}.targets[].hashes`, ['sha256'], 'invalid_trust');
		const custom = record(entry.custom, `${where}.targets[].custom`, ['id', 'version', 'publisher', 'contract', 'isolation', 'capabilities', 'status', 'reason'], 'invalid_trust');
		try { checkJumpCodeToolIdentity(custom.id, custom.publisher); } catch { refuse('invalid_trust', `${where} lists a package with an invalid identity`); }
		const id = custom.id as string;
		const publisher = custom.publisher as string;
		if (!isJumpCodeToolVersion(custom.version) || path !== jumpCodeToolTargetPath(id, custom.version) || typeof hashes.sha256 !== 'string' || !sha256Pattern.test(hashes.sha256)) { refuse('invalid_trust', `${where} lists a package under the wrong name`); }
		if (custom.isolation !== 'container' && custom.isolation !== 'process' || custom.isolation === 'process' && publisher !== jumpCodeOfficialPublisher) { refuse('invalid_trust', `${where} lists a package with an invalid isolation`); }
		if (custom.status !== 'available' && custom.status !== 'withdrawn' && custom.status !== 'revoked') { refuse('invalid_trust', `${where} lists a package with an unknown status`); }
		targets.push(Object.freeze({
			path, length: integer(entry.length, `${where}.targets[].length`, 1, jumpCodeToolPackageLimits.archiveBytes, 'invalid_trust'), sha256: hashes.sha256, id, version: custom.version, publisher,
			contract: integer(custom.contract, `${where}.targets[].contract`, 1, 1000, 'invalid_trust'), isolation: custom.isolation, capabilities: readCapabilities(custom.capabilities, `${where}.targets[].capabilities`, 'invalid_trust'), status: custom.status,
			...(custom.reason === undefined ? {} : { reason: text(custom.reason, `${where}.targets[].reason`, 300, 'invalid_trust') }),
		}));
	}
	return Object.freeze({ version, expires, targets: Object.freeze(targets) });
}

/** Reads a root the application ships with or already trusted; its own signatures must hold. */
function trustedRoot(textValue: string, crypto: IJumpCodeToolCrypto): IJumpCodeToolRoot {
	const document = parseDocument(textValue, 'root');
	const root = readRoot(document.signed, 'root', crypto);
	verifyRole(document, 'root', root, crypto, 'root');
	return root;
}

/**
 * Checks that `candidate` is the root that follows `current`: the next version, signed by the
 * current root and by its own keys. Returns its version.
 */
export function nextJumpCodeToolRoot(current: string, candidate: string, crypto: IJumpCodeToolCrypto): number {
	const root = trustedRoot(current, crypto);
	const document = parseDocument(candidate, 'root');
	const next = readRoot(document.signed, 'root', crypto);
	if (next.version !== root.version + 1) { refuse('trust_rollback', 'not the next root version'); }
	verifyRole(document, 'root', root, crypto, 'the next root, by the current root');
	verifyRole(document, 'root', next, crypto, 'the next root, by its own keys');
	return next.version;
}

/**
 * Re-reads the documents a client already trusts, checking every signature again but not the
 * dates: this is what installed tools rely on without a network. `expires` tells the caller how
 * old the list may be; nothing new is accepted here.
 */
export function readJumpCodeToolTrust(state: IJumpCodeToolTrustState, crypto: IJumpCodeToolCrypto): IJumpCodeToolTrustView | undefined {
	const root = trustedRoot(state.root, crypto);
	if (state.timestamp === undefined || state.snapshot === undefined || state.targets === undefined) { return undefined; }
	const timestamp = parseDocument(state.timestamp, 'timestamp');
	const snapshot = parseDocument(state.snapshot, 'snapshot');
	const targets = parseDocument(state.targets, 'targets');
	verifyRole(timestamp, 'timestamp', root, crypto, 'timestamp');
	verifyRole(snapshot, 'snapshot', root, crypto, 'snapshot');
	verifyRole(targets, 'targets', root, crypto, 'targets');
	const timestampHeader = header(timestamp.signed, 'timestamp', 'timestamp');
	const snapshotHeader = header(snapshot.signed, 'snapshot', 'snapshot');
	if (metaVersion(timestamp.signed, 'snapshot.json', 'timestamp', state.snapshot, crypto) !== snapshotHeader.version) { refuse('trust_mismatch', 'timestamp names another snapshot'); }
	const view = readTargets(targets.signed, 'targets');
	if (metaVersion(snapshot.signed, 'targets.json', 'snapshot', state.targets, crypto) !== view.version) { refuse('trust_mismatch', 'snapshot names another package list'); }
	const expires = [root.expires, timestampHeader.expires, snapshotHeader.expires, view.expires].sort()[0] ?? root.expires;
	return { state, rootVersion: root.version, targets: view, expires };
}

/**
 * The TUF client update: walks newer roots one version at a time (each signed by the root before
 * it and by itself), then accepts the timestamp, snapshot and package list only if they are
 * signed by the roles of the current root, are not older than what is already trusted and have
 * not expired. Any refusal leaves the caller's state as it was.
 */
export function updateJumpCodeToolTrust(state: IJumpCodeToolTrustState, update: IJumpCodeToolTrustUpdate, now: number, crypto: IJumpCodeToolCrypto): IJumpCodeToolTrustView {
	let rootText = state.root;
	let root = trustedRoot(rootText, crypto);
	const before = root;
	for (const candidate of list(update.roots, 'roots', 64, 'invalid_trust')) {
		const document = parseDocument(candidate, 'root');
		const next = readRoot(document.signed, 'root', crypto);
		if (next.version <= root.version) { continue; }
		if (next.version !== root.version + 1) { refuse('trust_rollback', 'a root version is missing from the chain'); }
		verifyRole(document, 'root', root, crypto, 'the next root, by the current root');
		verifyRole(document, 'root', next, crypto, 'the next root, by its own keys');
		root = next;
		rootText = candidate as string;
	}
	if (expired(root.expires, now)) { refuse('trust_expired', 'the root has expired'); }
	// Authenticate the cached documents with the root that trusted them, before comparing versions.
	// Replacing online keys can reset their counters, never the offline-signed package history.
	const rotated = (role: 'timestamp' | 'snapshot') => JSON.stringify(before.roles[role]) !== JSON.stringify(root.roles[role]) || before.roles[role].keyids.some(keyid => before.keys[keyid]?.keyval.public !== root.keys[keyid]?.keyval.public);
	const previous = readJumpCodeToolTrust(state, crypto);
	const previousTimestamp = previous && state.timestamp !== undefined && !rotated('timestamp') && !rotated('snapshot') ? parseDocument(state.timestamp, 'timestamp') : undefined;

	const timestamp = parseDocument(update.timestamp, 'timestamp');
	verifyRole(timestamp, 'timestamp', root, crypto, 'timestamp');
	const timestampHeader = header(timestamp.signed, 'timestamp', 'timestamp');
	record(timestamp.signed, 'timestamp', ['_type', 'spec_version', 'version', 'expires', 'meta'], 'invalid_trust');
	const snapshotVersion = metaVersion(timestamp.signed, 'snapshot.json', 'timestamp', update.snapshot, crypto);
	if (previousTimestamp) {
		const trusted = header(previousTimestamp.signed, 'timestamp', 'timestamp');
		if (timestampHeader.version < trusted.version || snapshotVersion < metaVersion(previousTimestamp.signed, 'snapshot.json', 'timestamp', undefined, crypto)) { refuse('trust_rollback', 'the timestamp is older than the one already trusted'); }
	}
	if (expired(timestampHeader.expires, now)) { refuse('trust_expired', 'the timestamp has expired'); }

	const snapshot = parseDocument(update.snapshot, 'snapshot');
	verifyRole(snapshot, 'snapshot', root, crypto, 'snapshot');
	const snapshotHeader = header(snapshot.signed, 'snapshot', 'snapshot');
	record(snapshot.signed, 'snapshot', ['_type', 'spec_version', 'version', 'expires', 'meta'], 'invalid_trust');
	if (snapshotHeader.version !== snapshotVersion) { refuse('trust_mismatch', 'timestamp names another snapshot'); }
	const targetsVersion = metaVersion(snapshot.signed, 'targets.json', 'snapshot', update.targets, crypto);
	if (previous && targetsVersion < previous.targets.version) { refuse('trust_rollback', 'the package list is older than the one already trusted'); }
	if (expired(snapshotHeader.expires, now)) { refuse('trust_expired', 'the snapshot has expired'); }

	const targets = parseDocument(update.targets, 'targets');
	verifyRole(targets, 'targets', root, crypto, 'targets');
	const view = readTargets(targets.signed, 'targets');
	if (view.version !== targetsVersion) { refuse('trust_mismatch', 'snapshot names another package list'); }
	if (previous && view.version === previous.targets.version && canonicalJumpCodeToolJson(toJson(targets.signed, 'targets')) !== canonicalJumpCodeToolJson(toJson(parseDocument(state.targets!, 'targets').signed, 'targets'))) {
		refuse('trust_rollback', 'the same package list version changed content');
	}
	if (expired(view.expires, now)) { refuse('trust_expired', 'the package list has expired'); }
	const expires = [root.expires, timestampHeader.expires, snapshotHeader.expires, view.expires].sort()[0] ?? root.expires;
	return { state: { root: rootText, timestamp: update.timestamp, snapshot: update.snapshot, targets: update.targets }, rootVersion: root.version, targets: view, expires };
}

/** The versions of one tool in a trusted list, newest first. */
export function jumpCodeToolVersions(targets: IJumpCodeToolTargets, id: string): readonly IJumpCodeToolTarget[] {
	return targets.targets.filter(target => target.id === id).sort((a, b) => compareJumpCodeToolVersions(b.version, a.version));
}

/** The entry that vouches for exactly these bytes, whatever name the file was given. */
export function findJumpCodeToolTarget(targets: IJumpCodeToolTargets | undefined, sha256: string, length: number): IJumpCodeToolTarget | undefined {
	return targets?.targets.find(target => target.sha256 === sha256 && target.length === length);
}

/**
 * Whether a manifest is the one a signed entry describes. The hash already binds the bytes; this
 * binds what was reviewed and signed (identity, version, permissions, isolation) to what the
 * package says about itself, so a package cannot be filed under another tool's entry.
 */
export function jumpCodeToolMatchesTarget(manifest: IJumpCodeToolPackageManifest, target: IJumpCodeToolTarget): boolean {
	return manifest.id === target.id && manifest.version === target.version && manifest.publisher === target.publisher && manifest.contract === target.contract
		&& manifest.isolation === target.isolation && canonicalJumpCodeToolJson(toJson(manifest.capabilities, 'capabilities')) === canonicalJumpCodeToolJson(toJson(target.capabilities, 'capabilities'));
}

// --- Building documents (packaging tools and the backend) ---------------------------------------

export function jumpCodeToolKey(publicKey: string): IJumpCodeToolKey { return { keytype: 'ed25519', scheme: 'ed25519', keyval: { public: publicKey } }; }

/** The unsigned root: which key holds which role. */
export function buildJumpCodeToolRoot(version: number, expires: string, keys: { readonly [role in JumpCodeToolRole]: readonly string[] }, thresholds: { readonly [role in JumpCodeToolRole]?: number }, crypto: IJumpCodeToolCrypto): IJumpCodeToolRoot {
	const all: { [keyid: string]: IJumpCodeToolKey } = {};
	const assigned: { [role: string]: { keyids: readonly string[]; threshold: number } } = {};
	for (const role of roles) {
		const keyids = keys[role].map(publicKey => {
			const keyid = jumpCodeToolKeyId(publicKey, crypto);
			all[keyid] = jumpCodeToolKey(publicKey);
			return keyid;
		});
		assigned[role] = { keyids, threshold: thresholds[role] ?? 1 };
	}
	return { _type: 'root', spec_version: specVersion, version, expires, consistent_snapshot: false, keys: all, roles: assigned as IJumpCodeToolRoot['roles'] };
}

/** The unsigned package list. */
export function buildJumpCodeToolTargets(version: number, expires: string, targets: readonly IJumpCodeToolTarget[]): object {
	const entries: { [path: string]: object } = {};
	for (const target of targets) {
		entries[jumpCodeToolTargetPath(target.id, target.version)] = {
			length: target.length, hashes: { sha256: target.sha256 },
			custom: {
				id: target.id, version: target.version, publisher: target.publisher, contract: target.contract, isolation: target.isolation,
				capabilities: { suppliedText: target.capabilities.suppliedText, projectFiles: target.capabilities.projectFiles, network: target.capabilities.network },
				status: target.status, ...(target.reason === undefined ? {} : { reason: target.reason }),
			},
		};
	}
	return { _type: 'targets', spec_version: specVersion, version, expires, targets: entries };
}

/** The unsigned snapshot or timestamp: names the exact text of the document below it. */
export function buildJumpCodeToolPointer(type: 'snapshot' | 'timestamp', version: number, expires: string, document: string, documentVersion: number, crypto: IJumpCodeToolCrypto): object {
	const bytes = new TextEncoder().encode(document);
	return { _type: type, spec_version: specVersion, version, expires, meta: { [type === 'snapshot' ? 'targets.json' : 'snapshot.json']: { version: documentVersion, length: bytes.length, hashes: { sha256: crypto.sha256(bytes) } } } };
}

/** Reads a document's type, version and signed part without trusting it, for tools that route or sign it. */
export function peekJumpCodeToolDocument(textValue: string): { readonly type: string; readonly version: number; readonly signed: object; readonly signatures: readonly IJumpCodeToolSignature[] } {
	const document = parseDocument(textValue, 'document');
	return { type: String(document.signed._type), version: integer(document.signed.version, 'version', 1, 2 ** 31, 'invalid_trust'), signed: document.signed, signatures: document.signatures };
}

/** The package list of a document, without checking who signed it; only for building the next one. */
export function peekJumpCodeToolTargets(textValue: string): IJumpCodeToolTargets { return readTargets(parseDocument(textValue, 'targets').signed, 'targets'); }
