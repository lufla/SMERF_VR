// Copyright 2024 The Google Research Authors.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.


/**
 * @fileoverview Main driver for web viewer.
 */


/**
 * panel for current submodel
 */
import { VRButton } from 'https://cdn.jsdelivr.net/npm/three@0.157.0/examples/jsm/webxr/VRButton.js';

console.log('VRButton loaded:', VRButton);

// Append the VRButton to your document body
document.body.appendChild(VRButton.createButton(gRenderer));


let gSubmodelPanel = null;
let gVMemPanel = null;

/**
 * Number of sample points per voxel.
 * @type {number}
 */
let gStepMult = 1;


/**
 * For large scenes with varying exposure we set this value to be the exposure
 * of the virtual camera (shutter_speed_in_seconds * iso / 1000).
 * @type {number}
 */
let gExposure = null;


/**
 * Loads full scene representation.
 *
 * This includes all submodel assets, including allocation and download.
 *
 * This function should be called exactly once.
 *
 * @param {string} dirUrl Either points to a directory that contains scene files
 *                        or to a json file that maps virtual filenames to
 *                        download links
 * @param {!object} overrideParams A dictionary that contains overrides for the
 *   params in scene_params.json (e.g. combineMode, deferredMode or useBits).
 */

function loadScene(dirUrl, overrideParams) {
    console.log('Loading scene with URL:', dirUrl);

    let filenameToLinkPromise;
    if (dirUrl.includes('.json')) {
        console.log('Detected JSON scene file.');
        filenameToLinkPromise = loadJSONFile(dirUrl);
    } else {
        console.log('Using directory-based scene files.');
        filenameToLinkPromise = Promise.resolve(null);
    }

    filenameToLinkPromise
        .then((filenameToLink) => {
            console.log('Loaded filename-to-link mapping:', filenameToLink);
            const router = new Router(dirUrl, filenameToLink);
            const sceneParamsUrl = router.translate('scene_params.json');
            console.log('Fetching scene parameters from:', sceneParamsUrl);
            const sceneParamsPromise = loadJSONFile(sceneParamsUrl);

            if (overrideParams['loadBenchmarkCameras']) {
                console.log('Loading benchmark cameras with router:', router);
                loadBenchmarkCameras(router);
            } else {
                console.log('Benchmark cameras not loaded (not specified in overrideParams).');
            }

            return Promise.all([sceneParamsPromise, {router, filenameToLink}]);
        })
        .then((parsed) => {
            const [sceneParams, carry] = parsed;
            console.log('Parsed scene parameters:', sceneParams);

            let initialSubmodelIndex = 0;
            gUseSubmodel = sceneParams.hasOwnProperty('num_local_submodels') && sceneParams['num_local_submodels'] > 1;
            console.log('Submodel usage status:', gUseSubmodel);

            if (gUseSubmodel) {
                gSubmodelCount = sceneParams['num_local_submodels'];
                initialSubmodelIndex = sceneParams['sm_to_params'][sceneParams['submodel_idx']];
                console.log('Multiple submodels detected. Total submodels:', gSubmodelCount, 'Initial submodel index:', initialSubmodelIndex);
            } else {
                console.log('Single submodel detected.');
            }

            let sceneParamsPromises = [];
            for (let si = 0; si < gSubmodelCount; ++si) {
                const submodelId = sceneParams['params_to_sm'][si];
                const filePath = carry.router.translate(submodelAssetPath(submodelId, 'scene_params.json'));
                console.log(`Fetching scene_params.json for submodel ${si} at:`, filePath);
                sceneParamsPromises.push(loadJSONFile(filePath));
            }

            console.log('All submodel scene parameter promises created:', sceneParamsPromises.length);
            return Promise.all([{...carry, initialSubmodelIndex}, ...sceneParamsPromises]);
        })
        .then((loaded) => {
            console.log('Scene assets loaded successfully. Loaded content:', loaded);
            let [carry, ...submodelSceneParams] = loaded;

            submodelSceneParams.forEach((params, si) => {
                console.log(`Processing submodel #${si}:`, params);
                try {
                    const submodelContent = initializeSceneContent(params, carry.router);
                    console.log(`Submodel content initialized for #${si}:`, submodelContent);
                    registerSubmodelContent(si, submodelContent);
                } catch (err) {
                    console.error(`Error initializing submodel #${si}:`, err);
                }
            });

            let si = carry.initialSubmodelIndex;
            try {
                console.log('Setting up initial camera pose for submodel:', si);
                setupInitialCameraPose(dirUrl, submodelCenter(si, getSubmodelContent(si).params));
            } catch (err) {
                console.error('Error setting up initial camera pose:', err);
            }

            return Promise.all([si, initializeDeferredMlp(si)]);
        })
        .then(([si]) => {
            console.log('Initializing ping-pong buffers for submodel:', si);
            try {
                return initializePingPongBuffers(si);
            } catch (err) {
                console.error('Error initializing ping-pong buffers:', err);
                throw err;
            }
        })
        .then(() => {
            console.log('Scene rendering setup completed successfully.');
            gRenderer.setAnimationLoop(renderNextFrame);
        })
        .catch((error) => {
            console.error('Error during scene loading:', error);
        });
}


/**
 * Initializes the application based on the URL parameters.
 */
function initFromParameters() {
    // HTTP GET query parameters
    const params = new URL(window.location.href).searchParams;

    // Base directory for all assets.
    const dirUrl = params.get('dir');

    // Screen size: <width>,<height>
    const size = params.get('s');

    // Controls platform-specific defaults: phone, low, medium, high. Not
    // const as benchmark=true can override it.
    let quality = params.get('quality');

    // Number of samples per voxel. Increase for slower rendering and fewer
    // artifacts.

    const stepMult = params.get('stepMult');
    if (stepMult) {
        gStepMult = parseInt(stepMult, 10);
    }
    const frameMult = params.get('frameMult');
    if (frameMult) {
        gFrameMult = parseInt(frameMult, 10);
    }

    // Manually specify exposure for exposure-aware models.
    const exposure = params.get('exposure');
    if (exposure) {
        gExposure = parseFloat(exposure);
    }

    // For manually overriding parameters in scene_params.json.
    let overrideParams = {};

    const benchmarkParam = params.get('benchmark');
    const benchmark = benchmarkParam &&
        (benchmarkParam.toLowerCase() === 'time' ||
            benchmarkParam.toLowerCase() === 'quality');
    if (benchmark) {
        overrideParams['loadBenchmarkCameras'] = true;
        quality = 'high';
        const sceneNameChunks = dirUrl.split('/').slice(-2);
        setupBenchmarkStats(
            sceneNameChunks[0] + '_' + sceneNameChunks[1],
            benchmarkParam.toLowerCase() === 'quality');
    }

    // snerg, vfr
    const deferredMode = params.get('deferredMode');
    if (deferredMode) {
        overrideParams['deferred_rendering_mode'] = deferredMode;
    }

    // sum, concat_and_sum
    const combineMode = params.get('combineMode');
    if (combineMode && combineMode === 'concat_and_sum') {
        overrideParams['merge_features_combine_op'] = 'coarse_sum';
    }

    // are occupancy grids bitpacked?
    const useBits = params.get('useBits');
    if (useBits) {
        overrideParams['useBits'] = useBits.toLowerCase() === 'true';
    }

    // Use distance grid for calculating step sizes.
    const useDistanceGrid = params.get('useDistanceGrid');
    if (useDistanceGrid) {
        overrideParams['useDistanceGrid'] =
            useDistanceGrid.toLowerCase() === 'true';
    }

    // Load legacy scenes, where the distance & occupancy grids are stored
    // as a single monolithic file.
    const legacyGrids = params.get('legacyGrids');
    if (legacyGrids) {
        overrideParams['legacyGrids'] = legacyGrids.toLowerCase() === 'true';
    }

    // Sets the activation function of the DeferredMLP. Either "relu" or "elu".
    // Defaults to elu.
    const activation = params.get('activation');
    if (activation) {
        overrideParams['activation'] = activation;
    }

    // Whether to use feature gating for the triplanes. Either "true" or "false".
    // Defaults to true.
    const featureGating = params.get('featureGating');
    if (featureGating) {
        overrideParams['feature_gating'] = featureGating.toLowerCase() === 'true';
    }

    // Limit the number of cached submodel payloads.
    const submodelCacheSize = params.get('submodelCacheSize');
    if (submodelCacheSize) {
        gSubmodelCacheSize = Number(submodelCacheSize);
    }

    // Merge slices of assets together before binding to WebGL texture.
    const mergeSlices = params.get('mergeSlices');
    if (mergeSlices) {
        overrideParams['merge_slices'] = mergeSlices == 'true';
    }

    // The background color (in hex, e.g. #FF0000 for red) that the scene is
    // rendered on top of. Defaults to medium grey.
    const backgroundColor = params.get('backgroundColor');
    if (backgroundColor) {
        overrideParams['backgroundColor'] = '#' + backgroundColor;
    }

    const usageString =
        'To view a MERF scene, specify the following parameters in the URL:\n' +
        'dir: (Required) The URL to a MERF scene directory.\n' +
        'quality: (Optional) A quality preset (phone, low, medium or high).\n' +
        'mouseMode:  (Optional) How mouse navigation works: "orbit" for object' +
        ' centric scenes, "fps" for large scenes on a device with a mouse, or' +
        ' "map" for large scenes on a touchscreen device.\n' +
        'stepMult:  (Optional) Multiplier on how many steps to take per ray.\n' +
        'frameMult:  (Optional) For benchmarking with vsync on: render ' +
        ' frameMult redudant images per frame.\n' +
        'backgroundColor: (Optional) The background color (in hex, e.g. red is' +
        ' FF0000) the scene is rendered on top of. Defaults to grey.\n' +
        'exposure: (Optional, only for large scenes) The exposure value of the' +
        ' virtual camera (shutter_speed_seconds * iso / 1000).\n' +
        'deferredMode (Optional, internal) The deferred rendering mode for' +
        ' view-dependence. Either "snerg" or "vfr".\n' +
        'combineMode (Optional, internal) How to combine the features from' +
        ' the triplanes with the features from the sparse 3D grid. Either ' +
        ' "sum" or "concat_and_sum".\n' +
        'useBits (Optional, internal) If true, use bit packing for a higher' +
        ' resolution occupancy grid.\n' +
        'useDistanceGrid (Optional, internal) If true, use a distance grid for' +
        ' empty space skipping instead of a hierarchy of occupancy grids.\n' +
        'activation (Optional, internal) The activation function for the' +
        ' DeferredMLP: "elu" (default) or "relu" (for older models).\n' +
        'featureGating (Optional, internal) If true, use feature gating for the' +
        ' triplanes. Set to false for older MERF scenes.\n' +
        'benchmark (Optional) If "time" or "quality", sets quality=high and' +
        ' renders the viewpoints in [scene_dir]/test_frames.json. If set to' +
        ' "time", only frame times are reported. If set to "quality", then' +
        ' the rendered images are also downloaded as "%04d.png".\n' +
        's: (Optional) The dimensions as width,height. E.g. 640,360.\n' +
        'vfovy:  (Optional) The vertical field of view of the viewer.\n';

    if (!dirUrl) {
        error('dir is a required parameter.\n\n' + usageString);
        return;
    }

    // Default to filling the browser window, and rendering at full res.
    let frameBufferWidth = window.innerWidth -
        13;  // Body has a padding of 6 + 5px, we have a border of 2px.
    let frameBufferHeight = window.innerHeight - 19;
    let lowResFactor = parseInt(params.get('downscale') || 1, 10);

    if (size) {
        const match = size.match(/([\d]+),([\d]+)/);
        frameBufferWidth = parseInt(match[1], 10);
        frameBufferHeight = parseInt(match[2], 10);
    } else if (quality) {
        // No size specified, clip the max viewport size based on quality.
        if (quality == 'phone') {  // For iPhones.
            frameBufferWidth = Math.min(350, frameBufferWidth);
            frameBufferHeight = Math.min(600, frameBufferHeight);
        } else if (quality == 'low') {  // For laptops with integrated GPUs.
            frameBufferWidth = Math.min(1280, frameBufferWidth);
            frameBufferHeight = Math.min(800, frameBufferHeight);
        } else if (quality == 'medium') {  // For laptops with dicrete GPUs.
            frameBufferWidth = Math.min(1920, frameBufferWidth);
            frameBufferHeight = Math.min(1080, frameBufferHeight);
        }  // else assume quality is 'high' and render at full res.
    }

    // No downscale factor specified, estimate it from the quality setting.
    let stepSizeVisibilityDelay = 0.99;
    if (!params.get('downscale') && quality) {
        let maxPixelsPerFrame = frameBufferWidth * frameBufferHeight;
        if (quality == 'phone') {  // For iPhones.
            maxPixelsPerFrame = 300 * 450;
            stepSizeVisibilityDelay = 0.8;
        } else if (quality == 'low') {  // For laptops with integrated GPUs.
            maxPixelsPerFrame = 600 * 250;
            stepSizeVisibilityDelay = 0.8;
        } else if (quality == 'medium') {  // For laptops with dicrete GPUs.
            maxPixelsPerFrame = 1200 * 640;
            stepSizeVisibilityDelay = 0.95;
        }  // else assume quality is 'high' and render at full res.

        while (frameBufferWidth * frameBufferHeight / lowResFactor >
        maxPixelsPerFrame) {
            lowResFactor++;
        }

        console.log('Automatically chose a downscaling factor of ' + lowResFactor);
    }
    overrideParams['useLargerStepsWhenOccluded'] = true;
    overrideParams['step_size_visibility_delay'] = stepSizeVisibilityDelay;

    // Near plane distance in world coordinates.
    const nearPlane = parseFloat(params.get('near') || 0.2);

    // FOV along screen height. Specified in degrees.
    const vfovy = parseFloat(params.get('vfovy') || 40.0);

    // Create container for viewport.
    const view = create('div', 'view');
    setDims(view, frameBufferWidth, frameBufferHeight);
    view.textContent = '';

    const viewSpaceContainer = document.getElementById('viewspacecontainer');
    viewSpaceContainer.style.display = 'inline-block';

    const viewSpace = document.querySelector('.viewspace');
    viewSpace.textContent = '';
    viewSpace.appendChild(view);

    let canvas = document.createElement('canvas');
    view.appendChild(canvas);

    // Add tool for visualizing framerate.
    gStats = Stats();
    gStats.dom.style.position = 'absolute';
    viewSpace.appendChild(gStats.dom);

    gSubmodelPanel = gStats.addPanel(new Stats.Panel('SM', '#0ff', '#002'));
    gSubmodelPanel.update(getActiveSubmodelIndex());

    gVMemPanel = gStats.addPanel(new Stats.Panel('MB VRAM', '#0ff', '#002'));
    gVMemPanel.update(0);

    // Show FPS; hide other panels.
    gStats.showPanel(0);

    // Set up a high performance WebGL context, making sure that anti-aliasing is
    // turned off.
    let gl = canvas.getContext('webgl2', {
        powerPreference: 'high-performance',
        alpha: false,
        stencil: false,
        precision: 'highp',
        depth: false,
        antialias: false,
        desynchronized: false,
        preserveDrawingBuffer:
            benchmarkParam && benchmarkParam.toLowerCase() === 'quality',
    });
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gRenderer = new THREE.WebGLRenderer({
        canvas: canvas,
        context: gl,
    });
    gRenderer.xr.enabled = true; // Enable VR mode
    document.body.appendChild(VRButton.createButton(gRenderer));


    // Set up the normal scene used for rendering.
    gCamera = new THREE.PerspectiveCamera(
        vfovy,
        Math.trunc(view.offsetWidth / lowResFactor) /
        Math.trunc(view.offsetHeight / lowResFactor),
        nearPlane, 100.0);
    gCamera.position.set(0, 1.6, 3); // Default VR camera position (1.6m above ground)

    setupProgressiveRendering(view, lowResFactor);
    gRenderer.autoClear = false;
    gRenderer.setSize(view.offsetWidth, view.offsetHeight);

    // Disable camera controls if we're benchmarking, since both OrbitControls
    // and PointerLockControls take ownership of the camera poses, making it
    // impossible to change programatically.
    if (!benchmark) {
        const mouseMode = params.get('mouseMode');
        setupCameraControls(mouseMode, view);
    }

    let width = Math.trunc(view.offsetWidth / lowResFactor);
    let height = Math.trunc(view.offsetHeight / lowResFactor);
    setupViewport(width, height);

    loadScene(dirUrl, overrideParams);
}

/**
 * The main update function that gets called every frame.
 *
 * @param {number} t elapsed time between frames (ms).
 */
function renderNextFrame(t) {
    console.log('--- Starting Frame Render ---');
    console.log('Timestamp:', t);

    try {
        // Step 1: Garbage Collection
        console.log('Garbage collecting old submodels...');
        garbageCollectSubmodelPayloads();

        // Step 2: Determine Submodel Index
        console.log('Calculating submodel index based on camera position...');
        let submodelIndex = positionToSubmodel(
            gCamera.position,
            getActiveSubmodelContent().params
        );
        console.log('Calculated submodel index:', submodelIndex);

        // Step 3: Set Current Ray March Scene
        console.log('Setting current ray march scene for submodel index:', submodelIndex);
        setCurrentRayMarchScene(submodelIndex);

        // Confirm the active submodel index
        submodelIndex = getActiveSubmodelIndex();
        console.log('Active submodel index after setting:', submodelIndex);

        // Step 4: Get Scene Parameters
        const sceneParams = getSubmodelContent(submodelIndex).params;
        console.log('Scene parameters for active submodel:', sceneParams);

        // Step 5: Frame Multiplier Loop
        for (let i = 0; i < gFrameMult; ++i) {
            console.log(`Processing frame multiplier ${i + 1}/${gFrameMult}...`);

            // Compute Submodel Transform
            gSubmodelTransform = submodelTransform(submodelIndex, sceneParams);
            console.log('Computed submodel transform:', gSubmodelTransform);

            // Update Panels
            console.log('Updating submodel and memory usage panels...');
            gSubmodelPanel.update(submodelIndex);
            gVMemPanel.update(getCurrentTextureUsageInBytes() / 1e6);

            // Update Camera Controls
            console.log('Updating camera controls...');
            updateCameraControls();

            // Update Camera Matrices
            if (!gBenchmark) {
                console.log('Updating camera projection matrix...');
                gCamera.updateProjectionMatrix();
            }
            console.log('Updating camera world matrix...');
            gCamera.updateMatrixWorld();

            // Calculate Submodel Camera Position
            const currentSubmodelCenter = submodelCenter(submodelIndex, sceneParams);
            const submodelScale = getSubmodelScale(submodelIndex);
            let submodelCameraPosition = new THREE.Vector3().copy(gCamera.position);
            submodelCameraPosition.sub(currentSubmodelCenter);
            submodelCameraPosition.multiplyScalar(submodelScale);
            console.log('Calculated submodel camera position:', submodelCameraPosition);

            // Shader Uniforms
            console.log('Accessing shader uniforms...');
            let shaderUniforms = getRayMarchScene().children[0].material.uniforms;

            // Free GPU Memory from Previous Frames
            console.log('Disposing of previous shader uniform values...');
            if (shaderUniforms['weightsZero']['value']) {
                shaderUniforms['weightsZero']['value'].dispose();
            }
            if (shaderUniforms['weightsOne']['value']) {
                shaderUniforms['weightsOne']['value'].dispose();
            }
            if (shaderUniforms['weightsTwo']['value']) {
                shaderUniforms['weightsTwo']['value'].dispose();
            }

            // Update Shader Uniforms
            console.log('Updating shader uniform biases and weights...');
            shaderUniforms['bias_0']['value'] = trilerpDeferredMlpBiases(
                submodelIndex,
                0,
                submodelCameraPosition
            );
            shaderUniforms['bias_1']['value'] = trilerpDeferredMlpBiases(
                submodelIndex,
                1,
                submodelCameraPosition
            );
            shaderUniforms['bias_2']['value'] = trilerpDeferredMlpBiases(
                submodelIndex,
                2,
                submodelCameraPosition
            );

            shaderUniforms['weightsZero']['value'] = trilerpDeferredMlpKernel(
                submodelIndex,
                0,
                submodelCameraPosition
            );
            shaderUniforms['weightsOne']['value'] = trilerpDeferredMlpKernel(
                submodelIndex,
                1,
                submodelCameraPosition
            );
            shaderUniforms['weightsTwo']['value'] = trilerpDeferredMlpKernel(
                submodelIndex,
                2,
                submodelCameraPosition
            );
            console.log('Shader uniforms updated successfully.');

            // Render Progressively
            console.log('Rendering frame progressively...');
            renderProgressively();
        }

        // Step 6: Update Stats
        console.log('Updating performance stats...');
        gStats.update();

        // Step 7: Schedule Next Frame
        console.log('Scheduling the next frame...');
        let scheduleNextFrame = () => {
            console.log('Using WebXR-compatible animation loop...');
            gRenderer.setAnimationLoop(renderNextFrame); // WebXR-compatible rendering
        };

        if (gBenchmark) {
            console.log('Benchmark mode enabled, adjusting schedule...');
            scheduleNextFrame = benchmarkPerformance(scheduleNextFrame);
        }

        scheduleNextFrame();
        console.log('--- Frame Rendered Successfully ---');
    } catch (error) {
        console.error('Error during frame rendering:', error);
    }
}



// Copyright 2024 The Google Research Authors.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

/**
 * @fileoverview Input event handling.
 */


/**
 * We control the camera using either orbit controls...
 * @type {?THREE.OrbitControls}
 */
let gOrbitControls = null;

/**
 * Map-controls, which are orbit controls with custom arguments, ...
 * @type {?THREE.OrbitControls}
 */
let gMapControls = null;

/**
 * ...or for large scenes we use FPS-style controls.
 * @type {?THREE.PointerLockControls}
 */
let gPointerLockControls = null;

// With PointerLockControls we have to track key states ourselves.
/** @type {boolean} */
let gKeyW = false;
/** @type {boolean} */
let gKeyA = false;
/** @type {boolean} */
let gKeyS = false;
/** @type {boolean} */
let gKeyD = false;
/** @type {boolean} */
let gKeyQ = false;
/** @type {boolean} */
let gKeyE = false;
/** @type {boolean} */
let gKeyShift = false;

/**
 * Keeps track of frame times for smooth camera motion.
 * @type {!THREE.Clock}
 */
const gClock = new THREE.Clock();

/**
 * Adds event listeners to UI.
 */
function addHandlers() {
    let shaderEditor = document.getElementById('shader-editor');

    document.addEventListener('keypress', function (e) {
        if (document.activeElement === shaderEditor) {
            return;
        }
        if (e.keyCode === 32 || e.key === ' ' || e.key === 'Spacebar') {
            if (gDisplayMode == DisplayModeType.DISPLAY_NORMAL) {
                gDisplayMode = DisplayModeType.DISPLAY_DIFFUSE;
                console.log('Displaying DIFFUSE');
            } else if (gDisplayMode == DisplayModeType.DISPLAY_DIFFUSE) {
                gDisplayMode = DisplayModeType.DISPLAY_FEATURES;
                console.log('Displaying DISPLAY_FEATURES');
            } else if (gDisplayMode == DisplayModeType.DISPLAY_FEATURES) {
                gDisplayMode = DisplayModeType.DISPLAY_VIEW_DEPENDENT;
                console.log('Displaying DISPLAY_VIEW_DEPENDENT');
            } else if (gDisplayMode == DisplayModeType.DISPLAY_VIEW_DEPENDENT) {
                gDisplayMode = DisplayModeType.DISPLAY_COARSE_GRID;
                console.log('Displaying DISPLAY_COARSE_GRID');
            } else /* gDisplayModeType == DisplayModeType.DISPLAY_COARSE_GRID */ {
                gDisplayMode = DisplayModeType.DISPLAY_NORMAL;
                console.log('Displaying DISPLAY_NORMAL');
            }
            e.preventDefault();
        }
        if (e.key === 'r') {
            console.log('Recompile shader.');
            let material = getRayMarchScene().children[0].material;
            material.fragmentShader = shaderEditor.value;
            material.needsUpdate = true;
            e.preventDefault();
        }
        if (e.key === '?') {
            let position = gCamera.getWorldPosition(new THREE.Vector3(0., 0., 0.));
            let direction = gCamera.getWorldQuaternion(new THREE.Quaternion());
            console.log(`
// Camera Info:
gCamera.position.set(${position.x}, ${position.y}, ${position.z});
gCamera.quaternion.set(${direction.x}, ${direction.y}, ${direction.z}, ${
                direction.w});
`);
            e.preventDefault();
        }
    });
    document.addEventListener('keydown', function (e) {
        if (document.activeElement === shaderEditor) {
            return;
        }
        let key = e.key.toLowerCase();
        if (key === 'w') {
            gKeyW = true;
            e.preventDefault();
        }
        if (key === 'a') {
            gKeyA = true;
        }
        if (key === 's') {
            gKeyS = true;
            e.preventDefault();
        }
        if (key === 'd') {
            gKeyD = true;
            e.preventDefault();
        }
        if (key === 'q') {
            gKeyQ = true;
            e.preventDefault();
        }
        if (key === 'e') {
            gKeyE = true;
            e.preventDefault();
        }
        if (e.key === 'Shift') {
            gKeyShift = true;
            e.preventDefault();
        }
    });
    document.addEventListener('keyup', function (e) {
        if (document.activeElement === shaderEditor) {
            return;
        }
        let key = e.key.toLowerCase();
        if (key === 'w') {
            gKeyW = false;
            e.preventDefault();
        }
        if (key === 'a') {
            gKeyA = false;
        }
        if (key === 's') {
            gKeyS = false;
            e.preventDefault();
        }
        if (key === 'd') {
            gKeyD = false;
            e.preventDefault();
        }
        if (key === 'q') {
            gKeyQ = false;
            e.preventDefault();
        }
        if (key === 'e') {
            gKeyE = false;
            e.preventDefault();
        }
        if (e.key === 'Shift') {
            gKeyShift = false;
            e.preventDefault();
        }
    });
}

/**
 * Sets up the camera controls.
 * @param {string} mouseMode Either "orbit", "fps" or "map".
 * @param {!HTMLElement} view The view.
 */
function setupCameraControls(mouseMode, view) {
    if (mouseMode && mouseMode == 'fps') {
        gPointerLockControls = new THREE.PointerLockControls(gCamera, view);

        let startButton = document.createElement('button');
        startButton.innerHTML = 'Click to enable mouse navigation';
        startButton.style = 'position: absolute;' +
            'top: 0;' +
            'width: 250px;' +
            'margin: 0 0 0 -125px;';
        startButton.addEventListener('click', function () {
            gPointerLockControls.lock();
            gPointerLockControls.connect();
        }, false);

        const viewSpaceContainer = document.getElementById('viewspacecontainer');
        viewSpaceContainer.appendChild(startButton);
    } else if (mouseMode && mouseMode == 'map') {
        gMapControls = new THREE.OrbitControls(gCamera, view);
        gMapControls.panSpeed = 0.5 / gCamera.near;
        gMapControls.enableZoom = false;
        gMapControls.screenSpacePanning = false;
        gMapControls.mouseButtons = {
            LEFT: THREE.MOUSE.ROTATE,
            RIGHT: THREE.MOUSE.PAN
        };
        gMapControls.touches = {
            ONE: THREE.TOUCH.PAN,
            TWO: THREE.TOUCH.DOLLY_ROTATE,
        };
    } else { // mouseMode == 'orbit'
        gOrbitControls = new THREE.OrbitControls(gCamera, view);
        gOrbitControls.screenSpacePanning = true;
        gOrbitControls.zoomSpeed = 0.5;
        // Disable damping until we have temporal reprojection for upscaling.
        // gOrbitControls.enableDamping = true;
    }
}

/**
 * Updates the camera based on user input.
 */
function updateCameraControls() {
    if (gOrbitControls) {
        gOrbitControls.update();
    } else if (gMapControls) {
        gMapControls.update();
    } else if (gPointerLockControls) {
        const elapsed = gClock.getDelta();
        let movementSpeed = 0.25;
        if (gKeyShift) {
            movementSpeed = 1;
        }
        let camForward = gCamera.getWorldDirection(new THREE.Vector3(0., 0., 0.));
        let upVec = new THREE.Vector3(0., 1., 0.);
        if (gKeyW) {
            // gPointerLockControls.moveForward undesirably restricts movement to the
            // X-Z-plane.
            gCamera.position =
                gCamera.position.addScaledVector(camForward, elapsed * movementSpeed);
        }
        if (gKeyA) {
            gPointerLockControls.moveRight(-elapsed * movementSpeed);
        }
        if (gKeyS) {
            gCamera.position = gCamera.position.addScaledVector(
                camForward, -elapsed * movementSpeed);
        }
        if (gKeyD) {
            gPointerLockControls.moveRight(elapsed * movementSpeed);
        }
        if (gKeyQ) {
            gCamera.position =
                gCamera.position.addScaledVector(upVec, -elapsed * movementSpeed);
        }
        if (gKeyE) {
            gCamera.position =
                gCamera.position.addScaledVector(upVec, elapsed * movementSpeed);
        }
    }
}

/**
 * Starts the volumetric scene viewer application.
 */
function start() {
    console.log('Starting the application...');
    try {
        initFromParameters();

        if (navigator.xr) {
            console.log('Initializing VR capabilities...');
            navigator.xr.isSessionSupported('immersive-vr').then((supported) => {
                if (supported) {
                    console.log('Immersive VR supported.');
                    document.body.appendChild(VRButton.createButton(gRenderer));
                } else {
                    console.warn('Immersive VR not supported.');
                }
            }).catch((error) => {
                console.error('Error checking XR support:', error);
            });
        } else {
            console.warn('WebXR not supported in this browser.');
        }
    } catch (error) {
        console.error('Error during application start:', error);
    }
}

window.onload = start;