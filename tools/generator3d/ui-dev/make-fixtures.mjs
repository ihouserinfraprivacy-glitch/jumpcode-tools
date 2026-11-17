/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Dev only: builds the Studio files (state.json, image.json, model.json, as CONTRACT.md defines them) for the
// harness, from real data the engine produced on this computer: the GLBs, the input and prepared images, the
// keypoints and the timings. Images and models are copied into fixtures/glb and fixtures/assets.json once (thumbnails
// and the prepared 512 × 512 images are drawn by chromium); model.json holds "@<name>" in place of the base64, which
// serve.mjs expands. Run from this folder: node make-fixtures.mjs [--assets] (--assets redraws the thumbnails).
import { chromium } from 'file:///C:/Projects/jumpcode/node_modules/playwright/index.mjs';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('./', import.meta.url));
const fixtures = `${here}fixtures/`;
const RIG = 'C:/Projects/foto-para-rig/saida/';
const TRIPO = 'C:/Projects/jumpcode/_triposr-evaluation/TripoSR/examples/';
const THREE_JS = `${here}../src/jumpcode_generator3d/ui/three.min.js`;

/** The project "aventura-na-vila": five images, the GLB each one became and where they came from. */
const IMAGES = {
	jay: { path: 'arte/personagens/jay.png', file: `${RIG}teste-jay/entrada-jay.png`, prepared: `${RIG}teste-jay/depurar/entrada-preparada.png`, joints: `${RIG}teste-jay/depurar/juntas-na-foto.png`, glb: `${RIG}teste-jay/jay.glb` },
	arqueira: { path: 'arte/personagens/arqueira.png', file: `${RIG}teste-sintel/entrada-sintel.png`, prepared: `${RIG}teste-sintel/depurar/entrada-preparada.png`, joints: `${RIG}teste-sintel/depurar/juntas-na-foto.png`, glb: `${RIG}teste-sintel/sintel.glb` },
	tigresa: { path: 'arte/personagens/tigresa.png', file: `${TRIPO}tiger_girl.png`, prepared: `${RIG}teste/depurar/entrada-preparada.png`, joints: `${RIG}teste/depurar/juntas-na-foto.png`, glb: `${RIG}teste/tiger_girl.glb` },
	policial: { path: 'arte/personagens/policial.png', file: `${TRIPO}police_woman.png`, prepared: null, joints: null, glb: `${RIG}police_woman.glb` },
	cavalo: { path: 'arte/animais/cavalo.png', file: `${TRIPO}horse.png`, prepared: null, joints: null, glb: `${RIG}horse.glb` },
};

const ANIMATIONS = [
	['walk', 'andar'], ['greeting', 'acenar'], ['dance-simple', 'dançar'], ['jump-2', 'pular'], ['run-anime', 'correr'], ['jog', 'trotar'],
	['sprint', 'disparar'], ['idle-a', 'parado'], ['idle-subtle', 'parado, leve'], ['victory', 'comemorar'], ['clapping', 'bater palmas'],
	['yes', 'dizer sim'], ['reject', 'dizer não'], ['punch-jab', 'soco'], ['kick-front', 'chute'], ['fighting-idle', 'em guarda'],
	['crouch-idle', 'agachado'], ['sitting-idle', 'sentado'], ['pick-up', 'pegar do chão'], ['death-a', 'cair'], ['dance-charleston', 'charleston'],
	['walk-female', 'andar 2'], ['run-female', 'correr 2'], ['rest-pose', 'pose de descanso'],
].sort((a, b) => a[0].localeCompare(b[0])).map(([id, label]) => ({ id, label }));

const KEYPOINT_LABELS = {
	nose: 'nariz', left_eye: 'olho esquerdo', right_eye: 'olho direito', left_ear: 'orelha esquerda', right_ear: 'orelha direita',
	left_shoulder: 'ombro esquerdo', right_shoulder: 'ombro direito', left_elbow: 'cotovelo esquerdo', right_elbow: 'cotovelo direito',
	left_wrist: 'pulso esquerdo', right_wrist: 'pulso direito', left_hip: 'quadril esquerdo', right_hip: 'quadril direito',
	left_knee: 'joelho esquerdo', right_knee: 'joelho direito', left_ankle: 'tornozelo esquerdo', right_ankle: 'tornozelo direito',
};
const kp = rows => rows.map(([name, u, v, score]) => ({ name, label: KEYPOINT_LABELS[name], u, v, score }));

/** RTMPose on the prepared archer (real values). */
const ARCHER_POINTS = kp([['nose', 257, 80, 1.10], ['left_eye', 264, 73, 1.04], ['right_eye', 249, 74, 1.04], ['left_ear', 274, 80, 0.94], ['right_ear', 236, 83, 1.03],
	['left_shoulder', 288, 125, 0.91], ['right_shoulder', 225, 127, 0.93], ['left_elbow', 312, 181, 0.95], ['right_elbow', 202, 179, 0.92], ['left_wrist', 341, 225, 0.89],
	['right_wrist', 172, 222, 0.92], ['left_hip', 276, 232, 0.78], ['right_hip', 235, 233, 0.77], ['left_knee', 276, 332, 0.84], ['right_knee', 235, 333, 0.84],
	['left_ankle', 277, 421, 0.97], ['right_ankle', 235, 420, 0.92]]);
/** Jay: the hat and the glasses hide the face, so the face points land on the collar and both shoulders on one spot. */
const JAY_POINTS = kp([['nose', 256, 196, 0.59], ['left_eye', 265, 190, 0.58], ['right_eye', 247, 189, 0.53], ['left_ear', 273, 192, 0.65], ['right_ear', 240, 193, 0.60],
	['left_shoulder', 233, 222, 0.81], ['right_shoulder', 233, 222, 0.86], ['left_elbow', 306, 257, 0.90], ['right_elbow', 209, 257, 0.88], ['left_wrist', 323, 286, 0.87],
	['right_wrist', 189, 286, 0.86], ['left_hip', 272, 307, 0.80], ['right_hip', 241, 308, 0.79], ['left_knee', 277, 367, 0.86], ['right_knee', 236, 367, 0.85],
	['left_ankle', 280, 418, 0.94], ['right_ankle', 231, 418, 0.93]]);
/** A bust: face and shoulders found, the rest of the body is not in the image. */
const BUST_POINTS = kp([['nose', 256, 214, 0.91], ['left_eye', 281, 186, 0.88], ['right_eye', 231, 186, 0.89], ['left_ear', 318, 196, 0.75], ['right_ear', 195, 197, 0.79],
	['left_shoulder', 366, 380, 0.72], ['right_shoulder', 146, 382, 0.74], ['left_elbow', 404, 486, 0.52], ['right_elbow', 110, 488, 0.50], ['left_wrist', 392, 500, 0.22],
	['right_wrist', 120, 503, 0.11], ['left_hip', 330, 505, 0.15], ['right_hip', 190, 505, 0.14], ['left_knee', 318, 507, 0.20], ['right_knee', 200, 508, 0.06],
	['left_ankle', 300, 509, 0.15], ['right_ankle', 210, 509, 0.10]]);
/** A horse: nothing a human pose detector trusts. */
const HORSE_POINTS = kp([['nose', 168, 186, 0.15], ['left_eye', 176, 170, 0.12], ['right_eye', 170, 172, 0.11], ['left_ear', 190, 150, 0.09], ['right_ear', 183, 152, 0.08],
	['left_shoulder', 228, 252, 0.13], ['right_shoulder', 222, 256, 0.12], ['left_elbow', 232, 330, 0.07], ['right_elbow', 214, 334, 0.06], ['left_wrist', 238, 400, 0.10],
	['right_wrist', 218, 404, 0.09], ['left_hip', 356, 262, 0.11], ['right_hip', 348, 266, 0.10], ['left_knee', 372, 340, 0.08], ['right_knee', 352, 344, 0.07],
	['left_ankle', 380, 410, 0.12], ['right_ankle', 360, 414, 0.11]]);

const STEPS = [['background', 'Remover o fundo'], ['encode', 'Forma 3D (TripoSR)'], ['mesh', 'Montar a malha'], ['simplify', 'Simplificar'], ['pose', 'Achar as juntas'],
	['rig', 'Ossos e pesos'], ['clips', 'Copiar animações'], ['texture', 'Textura'], ['write', 'Gravar o GLB']];
const JAY_TIMES = { background: 0.4, encode: 2.9, mesh: 1.5, simplify: 1.5, pose: 0.4, rig: 1.0, clips: 0.1, texture: 7.2, write: 0.1 };
const ARCHER_TIMES = { background: 0.6, encode: 4.0, mesh: 1.5, simplify: 0.9, pose: 0.4, rig: 1.0, clips: 0.1, texture: 9.6, write: 0.1 };
const TIGER_TIMES = { background: 0.5, encode: 3.1, mesh: 1.4, simplify: 1.2, pose: 0.4, rig: 0.9, clips: 0.1, write: 0.1 };
const STATIC_TIMES = { background: 0.4, encode: 2.8, mesh: 1.4, simplify: 1.3, pose: 0.3, write: 0.1 };

const NOW = 1763140000;
const NOT_FULL = 'a imagem não mostra um corpo inteiro (quadris, joelhos e pés precisam aparecer)';
const NOT_HUMAN = 'não encontrei uma pessoa ou personagem humanoide (animais ficam para outra versão)';

function pngSize(file) {
	const b = readFileSync(file);
	return [b.readUInt32BE(16), b.readUInt32BE(20)];
}
const dataUrl = file => `data:image/png;base64,${readFileSync(file).toString('base64')}`;

/** Counts of a GLB read from its JSON chunk (vertices of the first primitive, triangles from its indices). */
function glbCounts(file) {
	const b = readFileSync(file);
	const json = JSON.parse(b.subarray(20, 20 + b.readUInt32LE(12)).toString('utf8'));
	const prim = json.meshes[0].primitives[0];
	return { vertices: json.accessors[prim.attributes.POSITION].count, faces: json.accessors[prim.indices].count / 3, bytes: b.length, clips: (json.animations || []).map(a => a.name), rigged: !!json.skins };
}

/** Thumbnails of the images (128 px), the prepared 512 × 512 image where the engine did not save one, and renders of the models. */
async function drawAssets() {
	const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
	const page = await browser.newPage();
	await page.setContent('<html><body style="margin:0;background:#1E1E1E"></body></html>');
	await page.addScriptTag({ content: readFileSync(THREE_JS, 'utf8') });
	const out = { thumbs: {}, prepared: {}, renders: {} };
	for (const [name, image] of Object.entries(IMAGES)) {
		out.thumbs[name] = await page.evaluate(async url => {
			const img = new Image();
			img.src = url;
			await img.decode();
			const k = 128 / Math.max(img.width, img.height);
			const c = document.createElement('canvas');
			c.width = Math.round(img.width * k);
			c.height = Math.round(img.height * k);
			c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
			return c.toDataURL('image/png');
		}, dataUrl(image.file));
		if (!image.prepared) {
			// What the engine's preparation looks like: the white background turned into its grey, the figure centred in 512.
			out.prepared[name] = await page.evaluate(async url => {
				const img = new Image();
				img.src = url;
				await img.decode();
				const c = document.createElement('canvas');
				c.width = c.height = 512;
				const g = c.getContext('2d');
				g.fillStyle = '#7F7F7F';
				g.fillRect(0, 0, 512, 512);
				const k = 0.85 * 512 / Math.max(img.width, img.height);
				const w = img.width * k, h = img.height * k;
				const t = document.createElement('canvas');
				t.width = Math.round(w);
				t.height = Math.round(h);
				const tg = t.getContext('2d');
				tg.drawImage(img, 0, 0, t.width, t.height);
				const data = tg.getImageData(0, 0, t.width, t.height);
				for (let i = 0; i < data.data.length; i += 4) {
					if (data.data[i] > 236 && data.data[i + 1] > 236 && data.data[i + 2] > 236) { data.data[i + 3] = 0; }
				}
				tg.putImageData(data, 0, 0);
				g.drawImage(t, (512 - t.width) / 2, (512 - t.height) / 2);
				return c.toDataURL('image/png');
			}, dataUrl(image.file));
		}
		out.renders[name] = await page.evaluate(async b64 => {
			const { THREE, GLTFLoader } = globalThis.G3D_THREE;
			const bin = atob(b64);
			const bytes = new Uint8Array(bin.length);
			for (let i = 0; i < bin.length; i++) { bytes[i] = bin.charCodeAt(i); }
			const gltf = await new Promise((resolve, reject) => new GLTFLoader().parse(bytes.buffer, '', resolve, reject));
			const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
			renderer.setSize(256, 256);
			renderer.setClearColor(0x000000, 0);
			const scene = new THREE.Scene();
			scene.add(new THREE.HemisphereLight(0xffffff, 0x3a3a3a, 2.2));
			const key = new THREE.DirectionalLight(0xffffff, 1.6);
			key.position.set(1.5, 2.5, 3);
			scene.add(key);
			scene.add(gltf.scene);
			// The nodes hold the animation skeleton's rest pose; the pose of the image is the bind pose.
			gltf.scene.traverse(o => { if (o.isSkinnedMesh) { o.skeleton.pose(); } });
			gltf.scene.updateMatrixWorld(true);
			const box = new THREE.Box3().setFromObject(gltf.scene);
			const size = box.getSize(new THREE.Vector3());
			const center = box.getCenter(new THREE.Vector3());
			const camera = new THREE.PerspectiveCamera(30, 1, 0.01, 50);
			const d = Math.max(size.y, size.x) / 2 / Math.tan(15 * Math.PI / 180) * 1.12;
			camera.position.set(center.x + d * 0.34, center.y + d * 0.12, center.z + d * 0.94);
			camera.lookAt(center);
			renderer.render(scene, camera);
			const url = renderer.domElement.toDataURL('image/png');
			renderer.dispose();
			return url;
		}, readFileSync(image.glb).toString('base64'));
		console.log('assets', name);
	}
	await browser.close();
	return out;
}

function write(scenario, files) {
	const folder = `${fixtures}${scenario}/`;
	rmSync(folder, { recursive: true, force: true });
	mkdirSync(folder, { recursive: true });
	for (const [name, value] of Object.entries(files)) {
		writeFileSync(`${folder}${name}`, JSON.stringify(value, null, 1), 'utf8');
	}
	console.log('scenario', scenario, Object.keys(files).join(', '));
}

mkdirSync(`${fixtures}glb`, { recursive: true });
for (const [name, image] of Object.entries(IMAGES)) {
	copyFileSync(image.glb, `${fixtures}glb/${name}.glb`);
}
const assetsFile = `${fixtures}assets.json`;
let assets;
if (process.argv.includes('--assets') || !existsSync(assetsFile)) {
	assets = await drawAssets();
	writeFileSync(assetsFile, JSON.stringify(assets), 'utf8');
} else {
	assets = JSON.parse(readFileSync(assetsFile, 'utf8'));
}

const counts = Object.fromEntries(Object.entries(IMAGES).map(([name, image]) => [name, glbCounts(image.glb)]));
const engine = { ready: true, device: 'auto', devices: 'placa de vídeo (DirectML)', version: '0.1.0', problem: null, fix: null, animations: ANIMATIONS };
const settings = { height: 1.7, texture: 1024, faces: 20000, device: 'auto', folder: 'modelos', animations: ['walk', 'greeting', 'dance-simple', 'jump-2'] };

function imageEntry(name, withModel) {
	const image = IMAGES[name];
	const [width, height] = pngSize(image.file);
	return { path: image.path, bytes: readFileSync(image.file).length, width, height, thumb: assets.thumbs[name], model: withModel ? `modelos/${name}.glb` : null };
}
const images = withModels => ['jay', 'arqueira', 'tigresa', 'policial', 'cavalo'].map(name => imageEntry(name, withModels.includes(name)));

const MODEL_EXTRA = {
	jay: { seconds: 15.1, timings: JAY_TIMES, texture: 1024, created: '2026-11-14T17:19:04', warnings: ['a cabeça tomba para a frente nas animações: o chapéu e os óculos cobrem o rosto e os pontos do rosto ficaram na gola'] },
	arqueira: { seconds: 18.0, timings: ARCHER_TIMES, texture: 1024, created: '2026-11-14T17:52:31', warnings: [] },
	tigresa: { seconds: 7.6, timings: TIGER_TIMES, texture: 0, created: '2026-11-14T13:45:12', warnings: ['o rabo ficou grudado na mão esquerda e acompanha o braço'] },
	policial: { seconds: 6.3, timings: STATIC_TIMES, texture: 0, created: '2026-11-14T13:27:40', warnings: [], reasonKind: 'NotFullBodyError', reason: NOT_FULL },
	cavalo: { seconds: 6.3, timings: STATIC_TIMES, texture: 0, created: '2026-11-14T13:27:02', warnings: [], reasonKind: 'NotHumanoidError', reason: NOT_HUMAN },
};
function modelEntry(name) {
	const c = counts[name];
	const extra = MODEL_EXTRA[name];
	return {
		path: `modelos/${name}.glb`, name, source: IMAGES[name].path, rigged: c.rigged, reason: extra.reason || null, reasonKind: extra.reasonKind || null,
		clips: c.clips, vertices: c.vertices, faces: c.faces, bytes: c.bytes, texture: extra.texture, height: 1.7, seconds: extra.seconds,
		timings: extra.timings, devices: { encoder: 'dml', decoder: 'dml', grid: 'dml' }, created: extra.created, warnings: extra.warnings,
		thumb: assets.renders[name], missing: false,
	};
}
const modelFile = name => ({ path: `modelos/${name}.glb`, bytes: counts[name].bytes, glb: `@${name}` });

function state(over) {
	return { version: 1, updated: NOW, engine, settings, view: 'start', focus: { image: null, model: null, animation: null, bone: null, camera: 'front' }, images: images([]), imagesMore: 0, models: [], job: null, notice: null, ...over };
}

function checks(list) {
	return list.map(([key, label, ok, detail]) => ({ key, label, ok, detail }));
}
const GOOD_CHECKS = [
	['humanoid', 'Personagem humanoide', true, 'duas pernas, dois braços, uma cabeça'],
	['fullBody', 'Corpo inteiro', true, 'cabeça, quadris, joelhos e pés aparecem'],
	['single', 'Um personagem só', true, 'uma silhueta, sem objetos soltos'],
	['arms', 'Braços afastados do corpo', true, 'as mãos não encostam nas coxas'],
	['background', 'Fundo removido', true, 'silhueta limpa, 512 × 512'],
	['size', 'Tamanho bom', true, '1024 × 1024; o gerador usa 512 × 512'],
];
function imageFile(name, o) {
	const image = IMAGES[name];
	const [w, h] = pngSize(image.file);
	return {
		path: image.path, size: [w, h], seconds: o.seconds, original: dataUrl(image.file),
		prepared: image.prepared ? dataUrl(image.prepared) : assets.prepared[name], joints: image.joints ? dataUrl(image.joints) : null,
		keypoints: o.points, verdict: o.verdict, checks: checks(o.checks),
	};
}

function job(o) {
	const steps = STEPS.map(([key, label], i) => {
		const state = i < o.at ? 'done' : i === o.at ? 'running' : 'waiting';
		const seconds = state === 'done' ? JAY_TIMES[key] : state === 'running' ? o.runningFor : null;
		return { key, label, state: o.skip?.includes(key) ? 'skipped' : state, seconds: o.skip?.includes(key) ? null : seconds };
	});
	return { id: 'a1b2c3', state: 'running', images: o.images || ['arte/personagens/jay.png'], index: o.index || 0, total: o.total || 1, current: o.current || 'arte/personagens/jay.png', started: NOW - o.elapsed, elapsed: o.elapsed, steps, results: o.results || [], message: null };
}

const focus = (over = {}) => ({ image: null, model: null, animation: null, bone: null, camera: 'front', ...over });
const ALL = ['jay', 'arqueira', 'tigresa', 'policial', 'cavalo'];

// 1. The engine is not installed: status and images still work.
write('noengine', {
	'state.json': state({ engine: { ...engine, ready: false, version: null, devices: null, animations: [], problem: 'O gerador do 3D Generator não está instalado neste computador.', fix: 'Instale o pacote foto-para-rig para Windows em %LOCALAPPDATA%\\JumpCode\\tools\\generator3d\\engine\\ ou indique a pasta em JUMPCODE_GENERATOR3D_ENGINE.' } }),
	'image.json': null, 'model.json': {},
});
// 0. A Studio the tool never wrote to: no Studio files at all.
rmSync(`${fixtures}blank`, { recursive: true, force: true });
mkdirSync(`${fixtures}blank`, { recursive: true });
console.log('scenario blank (no files)');
// 2. First open: the project's images, nothing generated yet.
write('start', { 'state.json': state({}), 'image.json': null, 'model.json': {} });
// 3. The archer opened and checked: full body, ready to generate.
write('image-archer', {
	'state.json': state({ view: 'image', focus: focus({ image: IMAGES.arqueira.path }) }),
	'image.json': imageFile('arqueira', { seconds: 1.2, points: ARCHER_POINTS, verdict: { rig: true, kind: null, reason: null }, checks: GOOD_CHECKS }),
	'model.json': {},
});
// 4. Jay opened: the face is hidden by the hat, the face points are weak.
write('image-jay', {
	'state.json': state({ view: 'image', focus: focus({ image: IMAGES.jay.path }) }),
	'image.json': imageFile('jay', {
		seconds: 1.4, points: JAY_POINTS, verdict: { rig: true, kind: null, reason: null },
		checks: GOOD_CHECKS.slice(0, 5).concat([['face', 'Rosto à mostra', false, 'os 5 pontos do rosto têm nota entre 0,53 e 0,65; chapéu e óculos cobrem o rosto']]),
	}),
	'model.json': {},
});
// 5. A bust: it will be saved without a skeleton.
write('image-bust', {
	'state.json': state({ view: 'image', focus: focus({ image: IMAGES.policial.path }) }),
	'image.json': imageFile('policial', {
		seconds: 0.9, points: BUST_POINTS, verdict: { rig: false, kind: 'NotFullBodyError', reason: NOT_FULL },
		checks: [['humanoid', 'Personagem humanoide', true, 'rosto e ombros de uma pessoa'], ['fullBody', 'Corpo inteiro', false, 'quadris, joelhos e pés não aparecem'],
			['single', 'Um personagem só', true, 'uma silhueta'], ['background', 'Fundo removido', true, 'silhueta limpa, 512 × 512'], ['size', 'Tamanho bom', true, '614 × 614; o gerador usa 512 × 512']],
	}),
	'model.json': {},
});
// 6. A horse: no humanoid found.
write('image-horse', {
	'state.json': state({ view: 'image', focus: focus({ image: IMAGES.cavalo.path }) }),
	'image.json': imageFile('cavalo', {
		seconds: 0.8, points: HORSE_POINTS, verdict: { rig: false, kind: 'NotHumanoidError', reason: NOT_HUMAN },
		checks: [['humanoid', 'Personagem humanoide', false, 'nenhum ponto com nota acima de 0,3'], ['fullBody', 'Corpo inteiro', null, 'não se aplica'], ['single', 'Um personagem só', true, 'uma silhueta'], ['background', 'Fundo removido', true, 'silhueta limpa, 512 × 512']],
	}),
	'model.json': {},
});
// 7. Generating jay: step 8 (texture) running, no model yet.
write('running', {
	'state.json': state({ view: 'model', images: images([]), job: job({ at: 7, elapsed: 11.9, runningFor: 4.1 }), focus: focus({ image: IMAGES.jay.path, model: 'modelos/jay.glb' }) }),
	'image.json': imageFile('jay', { seconds: 1.4, points: JAY_POINTS, verdict: { rig: true, kind: null, reason: null }, checks: GOOD_CHECKS }),
	'model.json': {},
});
// 8. Generating jay again (new animations): the previous model stays in the viewer.
write('running-regen', {
	'state.json': state({ view: 'model', images: images(['jay']), models: [modelEntry('jay')], job: job({ at: 3, elapsed: 5.2, runningFor: 0.4 }), focus: focus({ model: 'modelos/jay.glb' }) }),
	'image.json': null,
	'model.json': modelFile('jay'),
});
// 9. A queue of five images: four done, the horse generating.
write('queue', {
	'state.json': state({
		view: 'model', images: images(['jay', 'arqueira', 'tigresa', 'policial']), models: ['jay', 'arqueira', 'tigresa', 'policial'].map(modelEntry),
		job: {
			...job({ at: 1, elapsed: 22.6, runningFor: 1.8, index: 4, total: 5, current: IMAGES.cavalo.path, images: ALL.map(n => IMAGES[n].path) }),
			results: [
				{ image: IMAGES.jay.path, model: 'modelos/jay.glb', state: 'done', seconds: 7.2, message: null },
				{ image: IMAGES.arqueira.path, model: 'modelos/arqueira.glb', state: 'done', seconds: 4.6, message: null },
				{ image: IMAGES.tigresa.path, model: 'modelos/tigresa.glb', state: 'done', seconds: 4.5, message: 'o rabo ficou grudado na mão' },
				{ image: IMAGES.policial.path, model: 'modelos/policial.glb', state: 'static', seconds: 4.1, message: NOT_FULL },
			],
		},
		focus: focus({ model: 'modelos/policial.glb' }),
	}),
	'image.json': null,
	'model.json': modelFile('policial'),
});
// 10. Jay ready (texture, 4 animations, one warning).
write('model-jay', {
	'state.json': state({ view: 'model', images: images(['jay']), models: [modelEntry('jay')], job: { ...job({ at: 9, elapsed: 15.1, runningFor: null }), state: 'done', results: [{ image: IMAGES.jay.path, model: 'modelos/jay.glb', state: 'done', seconds: 15.1, message: null }] }, focus: focus({ image: IMAGES.jay.path, model: 'modelos/jay.glb' }) }),
	'image.json': imageFile('jay', { seconds: 1.4, points: JAY_POINTS, verdict: { rig: true, kind: null, reason: null }, checks: GOOD_CHECKS }),
	'model.json': modelFile('jay'),
});
// 11. The archer ready (clean).
write('model-archer', {
	'state.json': state({ view: 'model', images: images(['jay', 'arqueira']), models: [modelEntry('arqueira'), modelEntry('jay')], focus: focus({ image: IMAGES.arqueira.path, model: 'modelos/arqueira.glb' }) }),
	'image.json': imageFile('arqueira', { seconds: 1.2, points: ARCHER_POINTS, verdict: { rig: true, kind: null, reason: null }, checks: GOOD_CHECKS }),
	'model.json': modelFile('arqueira'),
});
// 12. The tiger girl: vertex colours, no texture.
write('model-tiger', {
	'state.json': state({ view: 'model', images: images(['tigresa']), models: [modelEntry('tigresa')], settings: { ...settings, texture: 0 }, focus: focus({ model: 'modelos/tigresa.glb' }) }),
	'image.json': null,
	'model.json': modelFile('tigresa'),
});
// 13. Static models: the bust and the horse.
write('static-police', {
	'state.json': state({ view: 'model', images: images(['policial']), models: [modelEntry('policial')], focus: focus({ model: 'modelos/policial.glb' }) }),
	'image.json': imageFile('policial', { seconds: 0.9, points: BUST_POINTS, verdict: { rig: false, kind: 'NotFullBodyError', reason: NOT_FULL }, checks: [['fullBody', 'Corpo inteiro', false, 'quadris, joelhos e pés não aparecem']] }),
	'model.json': modelFile('policial'),
});
write('static-horse', {
	'state.json': state({ view: 'model', images: images(['cavalo']), models: [modelEntry('cavalo')], focus: focus({ model: 'modelos/cavalo.glb' }) }),
	'image.json': null,
	'model.json': modelFile('cavalo'),
});
// 14. The project's models, gallery.
write('models', {
	'state.json': state({
		view: 'models', images: images(ALL), focus: focus({ model: 'modelos/arqueira.glb' }),
		// A GLB someone copied into the folder: the tool lists it without a source or a skeleton verdict.
		models: ['arqueira', 'jay', 'tigresa', 'policial', 'cavalo'].map(modelEntry).concat([{ path: 'modelos/barril.glb', name: 'barril', source: null, external: true, rigged: null, reason: null, reasonKind: null,
			clips: [], vertices: 2312, faces: 4480, bytes: 96412, texture: null, height: null, seconds: null, timings: null, devices: null, created: '2026-11-10T09:12:44', warnings: [], thumb: null, missing: false }]),
	}),
	'image.json': null,
	'model.json': modelFile('arqueira'),
});
// 15. Settings (vertex colours by default, a notice from the agent).
write('settings', {
	'state.json': state({ view: 'settings', images: images(ALL), models: ['arqueira', 'jay'].map(modelEntry), notice: { kind: 'info', text: 'Padrão de textura mudado para cores nos vértices.' }, settings: { ...settings, texture: 0 } }),
	'image.json': null,
	'model.json': {},
});
// 17. The files the Python package itself wrote for a test project (a bust and a horse in a queue, jay without
// texture), kept as they came when the scratch run still exists.
const PYTHON_RUN = process.env.G3_PYTHON_STUDIO || 'C:/Users/luiz/AppData/Local/Temp/claude/b87a7c88b75cc278/d05387b3-3c8f-4e15-b539-70ffb15fad7a/scratchpad/g3dtest/studio/';
if (existsSync(`${PYTHON_RUN}state.json`)) {
	mkdirSync(`${fixtures}python-real`, { recursive: true });
	for (const name of ['state.json', 'image.json', 'model.json']) {
		copyFileSync(`${PYTHON_RUN}${name}`, `${fixtures}python-real/${name}`);
	}
	console.log('scenario python-real (copied from the Python run)');
}

// 16. A failed generation.
write('failed', {
	'state.json': state({
		view: 'model', images: images([]), focus: focus({ image: IMAGES.jay.path }),
		job: { ...job({ at: 1, elapsed: 3.4, runningFor: 3.0 }), state: 'failed', message: 'A placa de vídeo ficou sem memória durante a forma 3D. Feche outros programas ou mude o dispositivo para o processador.' },
		notice: { kind: 'warning', text: 'A geração de arte/personagens/jay.png falhou.' },
	}),
	'image.json': imageFile('jay', { seconds: 1.4, points: JAY_POINTS, verdict: { rig: true, kind: null, reason: null }, checks: GOOD_CHECKS }),
	'model.json': {},
});
