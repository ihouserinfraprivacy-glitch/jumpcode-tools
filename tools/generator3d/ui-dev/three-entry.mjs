// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License. See LICENSE in the project root.

// Entry for the three.js bundle the Studio interface uses (built by build-three.mjs into ui/three.min.js).
// The Studio webview has no network and no module loading, so three.js travels inlined, as one script.
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

globalThis.G3D_THREE = { THREE, GLTFLoader, OrbitControls };
