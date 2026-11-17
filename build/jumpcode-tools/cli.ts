/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Command line for tool authors and for whoever holds the signing keys:
//
//   node build/jumpcode-tools/cli.ts pack <tool folder> --out <file.jctool>
//   node build/jumpcode-tools/cli.ts inspect <file.jctool>
//   node build/jumpcode-tools/cli.ts keygen --out <key.json>
//   node build/jumpcode-tools/cli.ts root --version N --expires <UTC date> --root-key <hex>… --targets-key <hex>… --server-key <hex>… --out <root.json>
//   node build/jumpcode-tools/cli.ts targets --version N --expires <UTC date> [--previous <targets.json>] [--add <file.jctool>]… [--status <id>@<version>=<status>[:reason]]… --out <targets.json>
//   node build/jumpcode-tools/cli.ts sign --key <key.json>… --in <document.json> --out <document.json>
//
// `root` and `targets` write unsigned documents; `sign` adds signatures, on a machine that holds
// the private key. Keys never travel to the distribution server.

import * as fs from 'node:fs';
import {
	type IJumpCodeToolTarget, type JumpCodeToolStatus, buildJumpCodeToolRoot, buildJumpCodeToolTargets, jumpCodeToolPackageExtension, peekJumpCodeToolTargets,
} from '../../contract/tool-package.ts';
import { addToolSignatures, generateToolKey, nodeToolCrypto, packTool, readToolArchive, readToolKey } from './packaging.ts';

function options(argv: readonly string[]): { readonly positional: string[]; readonly named: Map<string, string[]> } {
	const positional: string[] = [];
	const named = new Map<string, string[]>();
	for (let index = 0; index < argv.length; index++) {
		const item = argv[index];
		if (item.startsWith('--')) {
			const value = argv[++index];
			if (value === undefined) { throw new Error(`${item} needs a value`); }
			named.set(item.slice(2), [...(named.get(item.slice(2)) ?? []), value]);
		} else { positional.push(item); }
	}
	return { positional, named };
}

function one(named: Map<string, string[]>, name: string): string {
	const values = named.get(name);
	if (values?.length !== 1) { throw new Error(`--${name} is required once`); }
	return values[0];
}

function expiry(value: string): string {
	if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$/.test(value) || Number.isNaN(Date.parse(value))) { throw new Error('--expires must look like 2027-01-31T00:00:00Z'); }
	return value;
}

function writeNew(file: string, content: string | Buffer, secret = false): void {
	// Never overwrite: a key or a signed document replaced by accident cannot be recovered.
	fs.writeFileSync(file, content, { flag: 'wx', mode: secret ? 0o600 : 0o644 });
}

export function main(argv: readonly string[]): string {
	const [command, ...rest] = argv;
	const { positional, named } = options(rest);
	switch (command) {
		case 'pack': {
			const packed = packTool(positional[0] ?? '.');
			const out = named.get('out')?.[0] ?? `${packed.manifest.id}-${packed.manifest.version}${jumpCodeToolPackageExtension}`;
			writeNew(out, packed.bytes);
			return JSON.stringify({ file: out, id: packed.manifest.id, version: packed.manifest.version, size: packed.bytes.length, sha256: packed.sha256, files: packed.manifest.files.length });
		}
		case 'inspect': {
			const bytes = fs.readFileSync(positional[0]);
			const { manifest } = readToolArchive(bytes);
			const { files, tool, ...summary } = manifest;
			return JSON.stringify({ ...summary, name: tool.name, files: files.length, size: bytes.length, sha256: nodeToolCrypto.sha256(bytes) }, null, '\t');
		}
		case 'keygen': {
			const key = generateToolKey();
			writeNew(one(named, 'out'), `${JSON.stringify(key, null, '\t')}\n`, true);
			return JSON.stringify({ public: key.public });
		}
		case 'root': {
			const server = named.get('server-key') ?? [];
			const root = buildJumpCodeToolRoot(Number(one(named, 'version')), expiry(one(named, 'expires')),
				{ root: named.get('root-key') ?? [], targets: named.get('targets-key') ?? [], snapshot: server, timestamp: server },
				{ root: Number(named.get('root-threshold')?.[0] ?? 1), targets: Number(named.get('targets-threshold')?.[0] ?? 1) }, nodeToolCrypto);
			writeNew(one(named, 'out'), JSON.stringify({ signed: root, signatures: [] }));
			return JSON.stringify({ version: root.version, expires: root.expires, keys: Object.keys(root.keys).length });
		}
		case 'targets': {
			const previous = named.get('previous')?.[0];
			const entries = new Map<string, IJumpCodeToolTarget>((previous ? peekJumpCodeToolTargets(fs.readFileSync(previous, 'utf8')).targets : []).map(target => [`${target.id}@${target.version}`, target]));
			for (const file of named.get('add') ?? []) {
				const bytes = fs.readFileSync(file);
				const { manifest } = readToolArchive(bytes);
				const key = `${manifest.id}@${manifest.version}`;
				const sha256 = nodeToolCrypto.sha256(bytes);
				const listed = entries.get(key);
				// A published identity and version never point at other bytes.
				if (listed && (listed.sha256 !== sha256 || listed.length !== bytes.length)) { throw new Error(`${key} is already listed with other contents; publish a new version`); }
				entries.set(key, {
					path: '', length: bytes.length, sha256, id: manifest.id, version: manifest.version, publisher: manifest.publisher, contract: manifest.contract,
					isolation: manifest.isolation, capabilities: manifest.capabilities, status: listed?.status ?? 'available', ...(listed?.reason === undefined ? {} : { reason: listed.reason }),
				});
			}
			for (const change of named.get('status') ?? []) {
				const match = /^(?<key>[a-z0-9-]+@[0-9.]+)=(?<status>available|withdrawn|revoked)(?::(?<reason>.+))?$/.exec(change);
				const target = match?.groups ? entries.get(match.groups.key) : undefined;
				if (!match?.groups || !target) { throw new Error(`--status ${change} does not name a listed package`); }
				const { reason: _previousReason, ...kept } = target;
				entries.set(match.groups.key, { ...kept, status: match.groups.status as JumpCodeToolStatus, ...(match.groups.reason ? { reason: match.groups.reason } : {}) });
			}
			const version = Number(one(named, 'version'));
			writeNew(one(named, 'out'), JSON.stringify({ signed: buildJumpCodeToolTargets(version, expiry(one(named, 'expires')), [...entries.values()]), signatures: [] }));
			return JSON.stringify({ version, packages: entries.size });
		}
		case 'sign': {
			const keys = (named.get('key') ?? []).map(file => readToolKey(JSON.parse(fs.readFileSync(file, 'utf8'))));
			if (!keys.length) { throw new Error('--key is required'); }
			writeNew(one(named, 'out'), addToolSignatures(fs.readFileSync(one(named, 'in'), 'utf8'), keys));
			return JSON.stringify({ signatures: keys.length });
		}
		default:
			throw new Error('Commands: pack, inspect, keygen, root, targets, sign');
	}
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replaceAll('\\', '/').split('/').pop() ?? '\0')) {
	try { console.log(main(process.argv.slice(2))); }
	catch (error) {
		console.error((error as Error).message);
		process.exitCode = 1;
	}
}
