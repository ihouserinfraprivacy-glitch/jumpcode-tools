/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Dev only: the --vscode-* variables and body class a VS Code webview receives (dark theme).
// TaskStudio keeps its own dark classic palette, so this only mirrors what the host injects.
(function () {
	const vars = {
		'--vscode-font-family': '"Segoe WPC", "Segoe UI", sans-serif',
		'--vscode-font-size': '13px',
		'--vscode-editor-font-family': 'Consolas, "Courier New", monospace',
		'--vscode-editor-background': '#1f1f1f',
		'--vscode-foreground': '#cccccc',
		'--vscode-focusBorder': '#0078d4',
	};
	for (const k of Object.keys(vars)) {
		document.documentElement.style.setProperty(k, vars[k]);
	}
	const apply = () => document.body.classList.add('vscode-dark');
	if (document.body) {
		apply();
	} else {
		document.addEventListener('DOMContentLoaded', apply);
	}
})();
