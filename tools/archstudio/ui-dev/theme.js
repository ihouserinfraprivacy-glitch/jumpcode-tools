/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Dev only: the --vscode-* variables a VS Code webview receives, for the dark and light themes.
(function () {
	const dark = {
		'--vscode-font-family': '"Segoe WPC", "Segoe UI", sans-serif',
		'--vscode-font-size': '13px',
		'--vscode-editor-font-family': 'Consolas, "Courier New", monospace',
		'--vscode-editor-background': '#1f1f1f',
		'--vscode-editor-foreground': '#cccccc',
		'--vscode-foreground': '#cccccc',
		'--vscode-descriptionForeground': '#9d9d9d',
		'--vscode-focusBorder': '#0078d4',
		'--vscode-input-background': '#313131',
		'--vscode-input-foreground': '#cccccc',
		'--vscode-menu-background': '#1f1f1f',
		'--vscode-menu-foreground': '#cccccc',
		'--vscode-menu-border': '#454545',
		'--vscode-menu-selectionBackground': '#0078d4',
		'--vscode-menu-selectionForeground': '#ffffff',
		'--vscode-widget-border': '#313131',
		'--vscode-editorLineNumber-foreground': '#6e7681',
		'--vscode-editorHoverWidget-background': '#202020',
		'--vscode-editorHoverWidget-border': '#454545',
	};
	const light = {
		'--vscode-font-family': '"Segoe WPC", "Segoe UI", sans-serif',
		'--vscode-font-size': '13px',
		'--vscode-editor-font-family': 'Consolas, "Courier New", monospace',
		'--vscode-editor-background': '#ffffff',
		'--vscode-editor-foreground': '#3b3b3b',
		'--vscode-foreground': '#3b3b3b',
		'--vscode-descriptionForeground': '#6f6f6f',
		'--vscode-focusBorder': '#005fb8',
		'--vscode-input-background': '#ffffff',
		'--vscode-input-foreground': '#3b3b3b',
		'--vscode-menu-background': '#ffffff',
		'--vscode-menu-foreground': '#3b3b3b',
		'--vscode-menu-border': '#cecece',
		'--vscode-menu-selectionBackground': '#005fb8',
		'--vscode-menu-selectionForeground': '#ffffff',
		'--vscode-widget-border': '#e5e5e5',
		'--vscode-editorLineNumber-foreground': '#6e7681',
		'--vscode-editorHoverWidget-background': '#f8f8f8',
		'--vscode-editorHoverWidget-border': '#c8c8c8',
	};
	const isLight = new URLSearchParams(location.search).get('theme') === 'light';
	const vars = isLight ? light : dark;
	for (const k of Object.keys(vars)) {
		document.documentElement.style.setProperty(k, vars[k]);
	}
	const apply = () => {
		document.body.classList.add(isLight ? 'vscode-light' : 'vscode-dark');
	};
	if (document.body) {
		apply();
	} else {
		document.addEventListener('DOMContentLoaded', apply);
	}
})();
