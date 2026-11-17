/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// AppStudio runtime: the behaviour of an app made in AppStudio. The same file runs inside the exported app
// (index.html, on the page's own document) and in the Studio preview (called from the Studio's script on the
// preview frame's document), so the app behaves the same in both. It only wires what the HTML declares:
//   data-go="tela"        opens a screen (a modal screen opens over the current one)
//   data-back             goes back; data-close closes a modal
//   data-tab="tela"       switches tab (the tab bar is generated)
//   data-each="colecao"   repeats its content for each row of the example data, filling {{campo}}
//   data-state="vazio"    shows the element only in that state of the screen (normal, carregando, vazio, erro,
//                         sem-internet; "sempre" for every state). Parts without data-state show in the normal state.
// No network, no storage, no eval.
(function (root) {
	'use strict';

	const STATES = ['normal', 'carregando', 'vazio', 'erro', 'sem-internet'];

	function escapeText(value) {
		return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
	}

	function fill(template, row) {
		// Anything between {{ }} that is not a field of the row shows as nothing, never as the raw placeholder.
		return template.replace(/\{\{\s*([^{}]*?)\s*\}\}/g, (match, key) => {
			if (!/^[\w\u00C0-\u024F.-]+$/.test(key)) {
				return '';
			}
			const value = key.split('.').reduce((item, name) => (item && typeof item === 'object' ? item[name] : undefined), row);
			return value === undefined || value === null ? '' : escapeText(value);
		});
	}

	/** Repeats every [data-each] element's first content for each row of its collection. */
	function expand(doc, data) {
		for (const element of doc.querySelectorAll('[data-each]')) {
			if (element.__asTemplate === undefined) {
				element.__asTemplate = element.innerHTML;
			}
			const rows = Array.isArray(data?.[element.getAttribute('data-each')]) ? data[element.getAttribute('data-each')] : [];
			element.innerHTML = rows.map(row => fill(element.__asTemplate, row && typeof row === 'object' ? row : { valor: row })).join('');
		}
	}

	function readData(doc) {
		const node = doc.getElementById('as-dados');
		if (!node) {
			return {};
		}
		try {
			return JSON.parse(node.textContent || '{}') || {};
		} catch {
			return {};
		}
	}

	/**
	 * Starts the app on a document made by AppStudio. Options: data (overrides the embedded example data),
	 * screen (to open first), state, onChange({screen, stack, modal, state, history}), interactive (default true),
	 * hash (follow and update location.hash routes; default false).
	 */
	function start(doc, options = {}) {
		const app = doc.querySelector('.as-app');
		if (!app) {
			return null;
		}
		const screens = new Map([...doc.querySelectorAll('.as-tela[data-screen]')].map(section => [section.getAttribute('data-screen'), section]));
		const tabbar = doc.querySelector('.as-abas');
		const first = options.screen && screens.has(options.screen) ? options.screen : app.getAttribute('data-start') || [...screens.keys()][0];
		const routes = new Map([...screens].map(([id, section]) => [section.getAttribute('data-route') || '/' + id, id]));
		let data = options.data || readData(doc);
		let stack = first ? [first] : [];
		let modal = null;
		let state = STATES.includes(options.state) ? options.state : 'normal';
		const history = [];

		const kind = id => screens.get(id)?.getAttribute('data-kind') || 'stack';

		function applyState() {
			doc.body.setAttribute('data-estado', state);
			const visible = [stack[stack.length - 1], modal].filter(Boolean);
			for (const id of visible) {
				const section = screens.get(id);
				const defined = [...section.querySelectorAll('[data-state]')].some(element => element.getAttribute('data-state').split(/\s+/).includes(state));
				for (const element of section.querySelectorAll('[data-state]')) {
					const names = element.getAttribute('data-state').split(/\s+/);
					element.hidden = !(names.includes('sempre') || names.includes(state));
				}
				for (const part of section.querySelectorAll('.as-parte:not([data-state])')) {
					// A part stays when it holds something for this state (or for every state).
					const own = [...part.querySelectorAll('[data-state]')].some(element => {
						const names = element.getAttribute('data-state').split(/\s+/);
						return names.includes(state) || names.includes('sempre');
					});
					part.hidden = state !== 'normal' && defined && !own;
				}
			}
		}

		function render(reason) {
			const current = stack[stack.length - 1];
			for (const [id, section] of screens) {
				const shown = id === current || id === modal;
				section.hidden = !shown;
				section.classList.toggle('as-modal-aberta', id === modal);
			}
			app.classList.toggle('as-com-modal', !!modal);
			if (tabbar) {
				const onTab = kind(current) === 'tab';
				tabbar.hidden = !onTab;
				for (const button of tabbar.querySelectorAll('[data-tab]')) {
					const active = button.getAttribute('data-tab') === current;
					button.classList.toggle('as-ativa', active);
					button.setAttribute('aria-current', active ? 'page' : 'false');
				}
			}
			applyState();
			if (options.hash && current) {
				const section = screens.get(modal || current);
				const route = section?.getAttribute('data-route') || '/' + (modal || current);
				if (doc.defaultView && doc.defaultView.location.hash !== '#' + route) {
					doc.defaultView.history.replaceState(null, '', '#' + route);
				}
			}
			options.onChange?.({ screen: modal || current, base: current, stack: [...stack], modal, state, history: [...history], reason });
		}

		// The page scrolls (screens are at least one screen tall), so each screen keeps its own scroll position.
		const scrolls = new Map();
		const scroller = () => doc.scrollingElement || doc.documentElement;

		function go(id, how = 'go') {
			if (!screens.has(id)) {
				options.onMissing?.(id);
				return false;
			}
			const from = stack[stack.length - 1];
			history.push({ from: modal || from || null, to: id, how });
			if (kind(id) === 'modal') {
				modal = id;
				state = 'normal';
				render(how);
				screens.get(id).scrollTop = 0;
				return true;
			}
			if (from) {
				scrolls.set(from, scroller().scrollTop);
			}
			if (kind(id) === 'tab') {
				// A tab screen is reached by switching to its tab, from the tab bar or from any button.
				stack = [id];
			} else if (from !== id) {
				stack.push(id);
			}
			modal = null;
			state = 'normal';
			render(how);
			scroller().scrollTop = 0;
			return true;
		}

		function back() {
			if (modal) {
				history.push({ from: modal, to: stack[stack.length - 1], how: 'close' });
				modal = null;
			} else if (stack.length > 1) {
				const from = stack.pop();
				scrolls.delete(from);
				history.push({ from, to: stack[stack.length - 1], how: 'back' });
				state = 'normal';
				render('back');
				scroller().scrollTop = scrolls.get(stack[stack.length - 1]) || 0;
				return true;
			} else {
				return false;
			}
			state = 'normal';
			render('back');
			return true;
		}

		function onClick(event) {
			if (options.interactive === false) {
				return;
			}
			const target = event.target.closest?.('[data-go],[data-back],[data-tab],[data-close],a[href]');
			if (!target || !app.contains(target)) {
				return;
			}
			if (target.hasAttribute('data-tab')) {
				event.preventDefault();
				go(target.getAttribute('data-tab'), 'tab');
			} else if (target.hasAttribute('data-go')) {
				event.preventDefault();
				go(target.getAttribute('data-go'));
			} else if (target.hasAttribute('data-back') || target.hasAttribute('data-close')) {
				event.preventDefault();
				back();
			} else if (target.tagName === 'A') {
				const href = target.getAttribute('href') || '';
				if (href.startsWith('#/') && routes.has(href.slice(1))) {
					event.preventDefault();
					go(routes.get(href.slice(1)));
				} else if (!/^(mailto:|tel:)/.test(href)) {
					event.preventDefault();
				}
			}
		}

		function onSubmit(event) {
			event.preventDefault();
		}

		function onHash() {
			const route = (doc.defaultView?.location.hash || '').slice(1);
			if (routes.has(route) && routes.get(route) !== (modal || stack[stack.length - 1])) {
				go(routes.get(route), 'link');
			}
		}

		doc.addEventListener('click', onClick);
		doc.addEventListener('submit', onSubmit, true);
		if (options.hash) {
			doc.defaultView?.addEventListener('hashchange', onHash);
			const initial = (doc.defaultView?.location.hash || '').slice(1);
			if (routes.has(initial)) {
				stack = kind(routes.get(initial)) === 'modal' ? [first] : [routes.get(initial)];
				modal = kind(routes.get(initial)) === 'modal' ? routes.get(initial) : null;
			}
		}
		expand(doc, data);
		render('start');

		return {
			go: id => go(id),
			tab: id => go(id, 'tab'),
			back,
			setState(name) {
				state = STATES.includes(name) ? name : 'normal';
				render('state');
			},
			setData(next) {
				data = next || {};
				expand(doc, data);
				applyState();
			},
			reset(id) {
				stack = [screens.has(id) ? id : first];
				modal = null;
				state = 'normal';
				render('reset');
			},
			current: () => modal || stack[stack.length - 1],
			screens: () => [...screens.keys()],
			dispose() {
				doc.removeEventListener('click', onClick);
				doc.removeEventListener('submit', onSubmit, true);
				doc.defaultView?.removeEventListener('hashchange', onHash);
			},
		};
	}

	root.AppRuntime = { start, expand, fill, STATES };
})(typeof globalThis !== 'undefined' ? globalThis : this);
