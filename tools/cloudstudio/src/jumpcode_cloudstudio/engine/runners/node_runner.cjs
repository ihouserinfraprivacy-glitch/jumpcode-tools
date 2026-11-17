/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Runs one Lambda invocation of a Node.js handler: reads the event on stdin, awaits handler(event, context)
// (or its callback) and writes the result or the error as JSON to the file CloudStudio named.
'use strict';

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const resultPath = process.env._CLOUDSTUDIO_RESULT;
const taskRoot = process.env.LAMBDA_TASK_ROOT || process.cwd();
const handlerName = process.env._HANDLER || 'index.handler';
const deadline = Date.now() + Number(process.env._CLOUDSTUDIO_TIMEOUT || 3) * 1000;

function finish(outcome) {
	fs.writeFileSync(resultPath, JSON.stringify(outcome));
	process.exit(0);
}

function failure(error) {
	const value = error instanceof Error ? error : new Error(String(error));
	console.error(value.stack || String(value));
	return { ok: false, errorType: value.name || 'Error', errorMessage: value.message, stackTrace: String(value.stack || '').split('\n').slice(1).map(line => line.trim()) };
}

async function load(modulePath) {
	for (const extension of ['.js', '.mjs', '.cjs']) {
		const file = path.resolve(taskRoot, modulePath + extension);
		if (fs.existsSync(file)) {
			if (extension === '.cjs') { return require(file); }
			try {
				return require(file);
			} catch (error) {
				if (error && (error.code === 'ERR_REQUIRE_ESM' || error.code === 'ERR_REQUIRE_ASYNC_MODULE' || /Cannot use import statement|Unexpected token 'export'/.test(String(error.message)))) {
					return import(pathToFileURL(file).href);
				}
				throw error;
			}
		}
	}
	const error = new Error(`Cannot find module '${modulePath}'`);
	error.name = 'Runtime.ImportModuleError';
	throw error;
}

async function main() {
	let input = '';
	for await (const chunk of process.stdin) { input += chunk; }
	const event = input ? JSON.parse(input) : null;
	const cut = handlerName.lastIndexOf('.');
	const modulePath = handlerName.slice(0, cut);
	const functionName = handlerName.slice(cut + 1);
	const context = {
		functionName: process.env.AWS_LAMBDA_FUNCTION_NAME,
		functionVersion: process.env.AWS_LAMBDA_FUNCTION_VERSION || '$LATEST',
		invokedFunctionArn: process.env._CLOUDSTUDIO_ARN,
		memoryLimitInMB: process.env.AWS_LAMBDA_FUNCTION_MEMORY_SIZE,
		awsRequestId: process.env._CLOUDSTUDIO_REQUEST,
		logGroupName: process.env.AWS_LAMBDA_LOG_GROUP_NAME,
		logStreamName: process.env.AWS_LAMBDA_LOG_STREAM_NAME,
		callbackWaitsForEmptyEventLoop: true,
		getRemainingTimeInMillis: () => Math.max(0, deadline - Date.now()),
	};
	let loaded;
	try {
		loaded = await load(modulePath);
	} catch (error) {
		const outcome = failure(error);
		if (outcome.errorType !== 'Runtime.ImportModuleError') { outcome.errorType = 'Runtime.ImportModuleError'; outcome.errorMessage = `Error: ${outcome.errorMessage}`; }
		return finish(outcome);
	}
	const handler = loaded && (loaded[functionName] || (loaded.default && loaded.default[functionName]));
	if (typeof handler !== 'function') {
		return finish({ ok: false, errorType: 'Runtime.HandlerNotFound', errorMessage: `${handlerName} is undefined or not exported`, stackTrace: [] });
	}
	try {
		const value = await new Promise((resolve, reject) => {
			const returned = handler(event, context, (error, result) => error ? reject(error) : resolve(result));
			if (returned && typeof returned.then === 'function') { returned.then(resolve, reject); }
			else if (handler.length < 3) { resolve(returned); }
		});
		finish({ ok: true, result: value === undefined ? null : value });
	} catch (error) {
		finish(failure(error));
	}
}

main().catch(error => finish(failure(error)));
