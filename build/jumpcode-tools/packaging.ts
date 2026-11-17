/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Builds and signs JumpCode tool packages. Packing only reads and hashes files: nothing from the
// tool is imported or run, and the same sources always produce the same bytes.

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import {
	type IJumpCodeToolCrypto, type IJumpCodeToolPackageManifest, type IJumpCodeToolSignature, JumpCodeToolPackageError,
	isJumpCodeToolPackagePath, jumpCodeToolKeyId, jumpCodeToolManifestName, jumpCodeToolPackageLimits, jumpCodeToolSignedBytes,
	peekJumpCodeToolDocument, readJumpCodeToolManifest,
} from '../../contract/tool-package.ts';

export const sourceDescriptorName = 'jumpcode-tool.source.json';

const spkiPrefix = Buffer.from('302a300506032b6570032100', 'hex');
const pkcs8Prefix = Buffer.from('302e020100300506032b657004220420', 'hex');

function publicKeyObject(publicKey: string): crypto.KeyObject {
	return crypto.createPublicKey({ key: Buffer.concat([spkiPrefix, Buffer.from(publicKey, 'hex')]), format: 'der', type: 'spki' });
}

/** SHA-256 and Ed25519 from Node, in the shape the shared contract asks for. */
export const nodeToolCrypto: IJumpCodeToolCrypto = {
	sha256: bytes => crypto.createHash('sha256').update(bytes).digest('hex'),
	verify: (publicKey, message, signature) => {
		try { return crypto.verify(null, message, publicKeyObject(publicKey), Buffer.from(signature, 'hex')); } catch { return false; }
	},
};

export interface ToolSigningKey {
	readonly keytype: 'ed25519';
	readonly public: string;
	readonly private: string;
}

/** A new Ed25519 key as raw hexadecimal; the private half must stay off the distribution server. */
export function generateToolKey(): ToolSigningKey {
	const pair = crypto.generateKeyPairSync('ed25519');
	const publicKey = pair.publicKey.export({ format: 'der', type: 'spki' }).subarray(spkiPrefix.length).toString('hex');
	const privateKey = pair.privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(pkcs8Prefix.length).toString('hex');
	return { keytype: 'ed25519', public: publicKey, private: privateKey };
}

export function readToolKey(value: unknown): ToolSigningKey {
	const key = value as Partial<ToolSigningKey> | null;
	if (!key || key.keytype !== 'ed25519' || typeof key.public !== 'string' || !/^[a-f0-9]{64}$/.test(key.public) || typeof key.private !== 'string' || !/^[a-f0-9]{64}$/.test(key.private)) {
		throw new Error('Not a JumpCode tool signing key');
	}
	const derived = crypto.createPublicKey(crypto.createPrivateKey({ key: Buffer.concat([pkcs8Prefix, Buffer.from(key.private, 'hex')]), format: 'der', type: 'pkcs8' }));
	if (derived.export({ format: 'der', type: 'spki' }).subarray(spkiPrefix.length).toString('hex') !== key.public) { throw new Error('The signing key halves do not belong together'); }
	return { keytype: 'ed25519', public: key.public, private: key.private };
}

/** Signs the `signed` part with each key and returns the document text; existing signatures by other keys are kept. */
export function signToolDocument(signed: object, keys: readonly ToolSigningKey[], existing: readonly IJumpCodeToolSignature[] = []): string {
	const message = jumpCodeToolSignedBytes(signed);
	const signatures = new Map(existing.map(signature => [signature.keyid, signature.sig]));
	for (const key of keys) {
		const privateKey = crypto.createPrivateKey({ key: Buffer.concat([pkcs8Prefix, Buffer.from(key.private, 'hex')]), format: 'der', type: 'pkcs8' });
		signatures.set(jumpCodeToolKeyId(key.public, nodeToolCrypto), crypto.sign(null, message, privateKey).toString('hex'));
	}
	return JSON.stringify({ signed, signatures: [...signatures].sort(([a], [b]) => a < b ? -1 : 1).map(([keyid, sig]) => ({ keyid, sig })) });
}

/** Adds signatures to a document that may already carry some (a root signed by the old and the new keys). */
export function addToolSignatures(document: string, keys: readonly ToolSigningKey[]): string {
	const parsed = peekJumpCodeToolDocument(document);
	return signToolDocument(parsed.signed, keys, parsed.signatures);
}

export interface PackedTool {
	readonly bytes: Buffer;
	readonly sha256: string;
	readonly manifest: IJumpCodeToolPackageManifest;
}

interface SourceEntry { readonly path: string; readonly bytes: Buffer }

const ignored = (name: string) => name === '__pycache__' || name === '.DS_Store' || name === 'Thumbs.db' || name.endsWith('.pyc') || name.endsWith('.pyo');

function collect(root: string, from: string, to: string, entries: SourceEntry[]): void {
	const directory = path.resolve(root, from);
	if (!directory.startsWith(path.resolve(root) + path.sep)) { throw new Error(`include.from leaves the tool folder: ${from}`); }
	const walk = (current: string, prefix: string) => {
		for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : 1)) {
			if (ignored(entry.name)) { continue; }
			const target = path.join(current, entry.name);
			const stat = fs.lstatSync(target);
			if (stat.isSymbolicLink() || fs.realpathSync(target) !== target && fs.realpathSync(target).toLowerCase() !== target.toLowerCase()) { throw new Error(`Links cannot be packaged: ${target}`); }
			if (stat.isDirectory()) { walk(target, `${prefix}${entry.name}/`); }
			else if (stat.isFile()) { entries.push({ path: `${prefix}${entry.name}`, bytes: fs.readFileSync(target) }); }
			else { throw new Error(`Only regular files can be packaged: ${target}`); }
		}
	};
	walk(directory, `${to}/`);
}

/**
 * A ZIP whose bytes depend only on the names and contents: entries sorted, stored without
 * compression (so the result does not vary with the compressor's version), one fixed date and
 * one fixed permission. The manifest goes first.
 */
export function writeToolArchive(entries: readonly SourceEntry[]): Buffer {
	const local: Buffer[] = [];
	const central: Buffer[] = [];
	let offset = 0;
	for (const entry of entries) {
		const name = Buffer.from(entry.path, 'utf8');
		const checksum = zlib.crc32(entry.bytes);
		const header = Buffer.alloc(30);
		header.writeUInt32LE(0x04034b50, 0);
		header.writeUInt16LE(20, 4);
		header.writeUInt16LE(0x0800, 6);
		header.writeUInt16LE(0, 8);
		header.writeUInt16LE(0, 10);
		header.writeUInt16LE(0x0021, 12);
		header.writeUInt32LE(checksum, 14);
		header.writeUInt32LE(entry.bytes.length, 18);
		header.writeUInt32LE(entry.bytes.length, 22);
		header.writeUInt16LE(name.length, 26);
		header.writeUInt16LE(0, 28);
		const record = Buffer.alloc(46);
		record.writeUInt32LE(0x02014b50, 0);
		record.writeUInt16LE(0x0314, 4);
		record.writeUInt16LE(20, 6);
		record.writeUInt16LE(0x0800, 8);
		record.writeUInt16LE(0, 10);
		record.writeUInt16LE(0, 12);
		record.writeUInt16LE(0x0021, 14);
		record.writeUInt32LE(checksum, 16);
		record.writeUInt32LE(entry.bytes.length, 20);
		record.writeUInt32LE(entry.bytes.length, 24);
		record.writeUInt16LE(name.length, 28);
		record.writeUInt32LE((0o100644 << 16) >>> 0, 38);
		record.writeUInt32LE(offset, 42);
		local.push(header, name, entry.bytes);
		central.push(record, name);
		offset += header.length + name.length + entry.bytes.length;
	}
	const directory = Buffer.concat(central);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(entries.length, 8);
	end.writeUInt16LE(entries.length, 10);
	end.writeUInt32LE(directory.length, 12);
	end.writeUInt32LE(offset, 16);
	return Buffer.concat([...local, directory, end]);
}

/**
 * Packs the tool described by `jumpcode-tool.source.json` in `directory`. The descriptor is the
 * manifest without the file list: `include` says which source folders go where, and `tool` may
 * name the JSON file that holds the catalog entry.
 */
export function packTool(directory: string): PackedTool {
	const root = fs.realpathSync(directory);
	const descriptor = JSON.parse(fs.readFileSync(path.join(root, sourceDescriptorName), 'utf8')) as Record<string, unknown>;
	const include = descriptor.include;
	if (!Array.isArray(include) || !include.length) { throw new Error('The descriptor must list the folders to include'); }
	const entries: SourceEntry[] = [];
	for (const item of include as { from?: unknown; to?: unknown }[]) {
		if (typeof item?.from !== 'string' || typeof item.to !== 'string' || !isJumpCodeToolPackagePath(item.to)) { throw new Error('Each include needs a source folder and a package folder'); }
		collect(root, item.from, item.to, entries);
	}
	entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
	let tool = descriptor.tool;
	if (typeof tool === 'string') {
		const file = path.resolve(root, tool);
		if (!file.startsWith(root + path.sep)) { throw new Error('tool must name a file of the tool folder'); }
		const { id, version, ...rest } = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
		// The catalog entry and the package must not disagree about what is being published.
		if (id !== undefined && id !== descriptor.id || version !== undefined && version !== descriptor.version) { throw new Error('The catalog entry names another tool or version than the descriptor'); }
		tool = rest;
	}
	const { include: _include, ...fields } = descriptor;
	const manifest = readJumpCodeToolManifest({
		...fields, tool,
		files: entries.map(entry => ({ path: entry.path, size: entry.bytes.length, sha256: nodeToolCrypto.sha256(entry.bytes) })),
	});
	const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, '\t')}\n`, 'utf8');
	if (manifestBytes.length > jumpCodeToolPackageLimits.manifestBytes) { throw new JumpCodeToolPackageError('invalid_manifest', 'the manifest exceeds the size limit'); }
	const bytes = writeToolArchive([{ path: jumpCodeToolManifestName, bytes: manifestBytes }, ...entries]);
	if (bytes.length > jumpCodeToolPackageLimits.archiveBytes) { throw new JumpCodeToolPackageError('invalid_inventory', 'the package exceeds the size limit'); }
	return { bytes, sha256: nodeToolCrypto.sha256(bytes), manifest };
}

/**
 * Reads the manifest and the members of a package the author holds, for inspection and for
 * building the signed list. It does not replace the validation done by the backend and the
 * application before anything is published or installed.
 */
export function readToolArchive(bytes: Buffer): { readonly manifest: IJumpCodeToolPackageManifest; readonly members: ReadonlyMap<string, Buffer> } {
	const end = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
	if (end < 0 || end + 22 > bytes.length) { throw new JumpCodeToolPackageError('invalid_inventory', 'not a ZIP archive'); }
	const count = bytes.readUInt16LE(end + 10);
	let cursor = bytes.readUInt32LE(end + 16);
	const members = new Map<string, Buffer>();
	for (let index = 0; index < count; index++) {
		if (bytes.readUInt32LE(cursor) !== 0x02014b50) { throw new JumpCodeToolPackageError('invalid_inventory', 'damaged ZIP directory'); }
		const method = bytes.readUInt16LE(cursor + 10);
		const compressed = bytes.readUInt32LE(cursor + 20);
		const size = bytes.readUInt32LE(cursor + 24);
		const nameLength = bytes.readUInt16LE(cursor + 28);
		const local = bytes.readUInt32LE(cursor + 42);
		const name = bytes.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
		const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
		const raw = bytes.subarray(start, start + compressed);
		const content = method === 0 ? Buffer.from(raw) : method === 8 ? zlib.inflateRawSync(raw, { maxOutputLength: jumpCodeToolPackageLimits.fileBytes }) : undefined;
		if (!content || content.length !== size || members.has(name)) { throw new JumpCodeToolPackageError('invalid_inventory', `unreadable member ${name.slice(0, 80)}`); }
		members.set(name, content);
		cursor += 46 + nameLength + bytes.readUInt16LE(cursor + 30) + bytes.readUInt16LE(cursor + 32);
	}
	const manifestBytes = members.get(jumpCodeToolManifestName);
	if (!manifestBytes) { throw new JumpCodeToolPackageError('invalid_manifest', 'the package has no manifest'); }
	const manifest = readJumpCodeToolManifest(JSON.parse(manifestBytes.toString('utf8')));
	members.delete(jumpCodeToolManifestName);
	if (members.size !== manifest.files.length) { throw new JumpCodeToolPackageError('invalid_inventory', 'the package contents differ from the manifest'); }
	for (const file of manifest.files) {
		const content = members.get(file.path);
		if (!content || content.length !== file.size || nodeToolCrypto.sha256(content) !== file.sha256) { throw new JumpCodeToolPackageError('invalid_inventory', `the package contents differ from the manifest at ${file.path}`); }
	}
	return { manifest, members };
}
