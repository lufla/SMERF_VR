import * as THREE from 'https://unpkg.com/three@0.113.1/build/three.module.js';

window.THREE = THREE;
console.log('THREE version:', THREE.REVISION);
import {OrbitControls} from 'https://unpkg.com/three@0.113.1/examples/jsm/controls/OrbitControls.js';

console.log('OrbitControls:', OrbitControls ? 'Loaded' : 'Not loaded');
import {PointerLockControls} from 'https://unpkg.com/three@0.113.1/examples/jsm/controls/PointerLockControls.js';

console.log('PointerLockControls:', PointerLockControls ? 'Loaded' : 'Not loaded');
import {VRButton} from 'https://unpkg.com/three@0.113.1/examples/jsm/webxr/VRButton.js';

console.log('VRButton:', VRButton ? 'Loaded' : 'Not loaded');

// index.js
import { setupInitialCameraPose } from './defaultposes.js';

const NEEDS_NEW_SUBMODEL = -1;
const LOADING = 0;
const READY = 1;


let gSubmodelSceneContents = {};
let gSubmodelCacheSize = 10;
let gRayMarchTextureBuffers = [
    {si: 0, state: NEEDS_NEW_SUBMODEL, texture: null},
    {si: 0, state: NEEDS_NEW_SUBMODEL, texture: null},
];

let gActiveRayMarchTextureBuffer = 0;
let gRayMarchScene = null;


function getRayMarchScene() {
    if (gRayMarchScene == null) {
        throw new Error('gRayMarchScene has not been initialized yet!');
    }
    return gRayMarchScene;
}

function getActiveSubmodelIndex() {
    return gRayMarchTextureBuffers[gActiveRayMarchTextureBuffer].si;
}

function getActiveSubmodelContent() {
    return getSubmodelContent(getActiveSubmodelIndex());
}

function getSubmodelScale(si) {
    let content = getSubmodelContent(si);
    let submodelScale = content.params['submodel_scale'];
    return submodelScale;
}

function getSubmodelScaleFactor(si) {
    let content = getSubmodelContent(si);
    let submodelScale = getSubmodelScale(si);
    let submodelResolution = Math.cbrt(content.params['num_submodels']);
    let submodelScaleFactor = submodelScale / submodelResolution;
    return submodelScaleFactor;
}

function getSubmodelContent(si) {
    return gSubmodelSceneContents[si];
}

function registerSubmodelContent(i, content) {
    gSubmodelSceneContents[i] = content;
}

function getDeferredMlp() {
    console.assert(gDeferredMlp != null);
    return gDeferredMlp;
}

function registerDeferredMlp(deferredMlp) {
    validateDeferredMlp(deferredMlp);
    gDeferredMlp = deferredMlp;
}

function getCurrentTextureUsageInBytes() {
    let numBytes = 0;
    for (rmtb of gRayMarchTextureBuffers) {
        numBytes += getTextureSizeInBytes(rmtb.texture);
    }
    return numBytes;
}

function setCurrentRayMarchScene(si) {
    let activeBufferIdx = gActiveRayMarchTextureBuffer;
    let activeBuffer = gRayMarchTextureBuffers[activeBufferIdx];
    let otherBufferIdx = (activeBufferIdx + 1) % 2;
    let otherBuffer = gRayMarchTextureBuffers[otherBufferIdx];

    if (getSubmodelContent(si) == null) {
        return Promise.resolve();
    }
    getSubmodelContent(si).lastTouched = Date.now();

    if (si === activeBuffer.si && activeBuffer.state >= LOADING) {
        return Promise.resolve();
    }

    if (si === otherBuffer.si && otherBuffer.state === READY) {
        console.log(`Switching to buffer ${otherBufferIdx} for submodel #${si}`);
        let sceneContent = getSubmodelContent(si);
        setTextureUniforms(sceneContent.params, otherBuffer.texture);
        gActiveRayMarchTextureBuffer = otherBufferIdx;
        return Promise.resolve();
    }

    if (otherBuffer.state >= LOADING && otherBuffer.state < READY) {
        return Promise.resolve();
    }

    console.log(
        `Preparing texture buffer #${otherBufferIdx} for submodel #${si}`);
    otherBuffer.si = si;
    otherBuffer.state = LOADING;
    showLoading();

    return Promise.resolve()
        .then(() => {
            reinitializeSparseGridTextures(otherBuffer);
            let content = getSubmodelContent(otherBuffer.si);
            if (content.payload == null) {
                console.log(`Fetching assets for submodel #${otherBuffer.si}`);
                let asset = fetchAsset(content.spec, content.router);
                let payload = prepareTexturePayload(asset);
                content.payload = payload;
            }
            console.log(`Populating textures for submodel #${
                otherBuffer.si} into buffer #${otherBufferIdx}`);
            return populateTexture(otherBuffer.texture, content.payload);
        }).then(() => {
            otherBuffer.state = READY;
            console.log(`Submodel #${otherBuffer.si} is ready for rendering`);
            hideLoading();
        });
}

function garbageCollectSubmodelPayloads() {
    let candidates = [];
    for (let si of Object.keys(gSubmodelSceneContents)) {
        let content = getSubmodelContent(si);
        if (content.payload == null) {
            continue;
        }
        candidates.push({
            lastTouched: content.lastTouched || 0,
            si: si,
        });
    }

    let oldestFirst = (a, b) => {
        return a.lastTouched - b.lastTouched;
    };
    candidates.sort(oldestFirst);

    for (let i = 0; i < candidates.length - gSubmodelCacheSize; ++i) {
        let si = candidates[i].si;
        console.log(`Deleting payload for submodel #${si}`);
        getSubmodelContent(si).payload = null;
    }
}

function initializeSceneContent(sceneParams, router) {
    return {
        spec: createSceneSpec(sceneParams),
        params: sceneParams,
        router: router,
        payload: null,
    };
}


function reinitializeSparseGridTextures(rmtb) {
    let texture = rmtb.texture.sparseGridTexture;
    texture.blockIndicesTexture.texture.dispose();
    texture.rgbTexture.texture.dispose();
    texture.densityTexture.texture.dispose();
    texture.featuresTexture.texture.dispose();
    let sparseGridSpec = getSubmodelContent(rmtb.si).spec.sparseGridSpec;
    rmtb.texture.sparseGridTexture = createEmptyTexture(sparseGridSpec);
}

async function initializePingPongBuffers(si) {
    let sceneContent = getSubmodelContent(si);
    gRayMarchScene = await initializeRayMarchScene(si, sceneContent);
    for (let rmtb of gRayMarchTextureBuffers) {
        rmtb.texture = createEmptyTexture(sceneContent.spec);
    }

    setTextureUniforms(sceneContent.params, gRayMarchTextureBuffers[0].texture);
    gActiveRayMarchTextureBuffer = 0;
}


async function initializeDeferredMlp(si) {
    let sceneContent = getSubmodelContent(si);
    let sceneParams = sceneContent.params;

    if (sceneParams['export_store_deferred_mlp_separately']) {
        let url = sceneContent.router.translate('deferred_mlp.json');
        return loadJSONFile(url).then(registerDeferredMlp);
    }
    return registerDeferredMlp(sceneParams['deferred_mlp']);
}

function setTextureUniforms(sceneParams, sceneTexture) {
    let rayMarchUniforms = getRayMarchScene().children[0].material.uniforms;
    let occupancyGridTextures = sceneTexture.occupancyGridsTexture.gridTextures;
    let numOccupancyGrids = occupancyGridTextures.length;
    for (let i = 0; i < numOccupancyGrids; ++i) {
        let texture = occupancyGridTextures[i];
        let ri = numOccupancyGrids - i - 1;
        rayMarchUniforms['occupancyGrid_L' + ri]['value'] = texture.texture;
    }
    if (sceneParams['useDistanceGrid']) {
        let texture = sceneTexture.distanceGridsTexture.gridTextures[0].texture;
        rayMarchUniforms['distanceGrid']['value'] = texture;
    }
    let triplaneTexture = sceneTexture.triplaneTexture;
    rayMarchUniforms['planeDensity']['value'] =
        triplaneTexture.densityTexture.texture;
    rayMarchUniforms['planeRgb']['value'] = triplaneTexture.rgbTexture.texture;
    rayMarchUniforms['planeFeatures']['value'] =
        triplaneTexture.featuresTexture.texture;
    let sparseGridTexture = sceneTexture.sparseGridTexture;
    rayMarchUniforms['sparseGridBlockIndices']['value'] =
        sparseGridTexture.blockIndicesTexture.texture;
    rayMarchUniforms['sparseGridDensity']['value'] =
        sparseGridTexture.densityTexture.texture;
    rayMarchUniforms['sparseGridRgb']['value'] =
        sparseGridTexture.rgbTexture.texture;
    rayMarchUniforms['sparseGridFeatures']['value'] =
        sparseGridTexture.featuresTexture.texture;
    rayMarchUniforms['atlasSize']['value'] = new THREE.Vector3(
        sceneParams['atlas_width'],
        sceneParams['atlas_height'],
        sceneParams['atlas_depth'],
    );
}


function getTextureSizeInBytes(sceneTexture) {
    let numBytes = 0.0;
    let getTextureSize = (texture) => {
        if (texture == null) {
            return 0;
        }
        let image = texture.texture.image;
        return image.height * image.width * image.depth;
    };
    let occupancyGridTextures = sceneTexture.occupancyGridsTexture.gridTextures;
    let numOccupancyGrids = occupancyGridTextures.length;
    for (let i = 0; i < numOccupancyGrids; ++i) {
        let texture = occupancyGridTextures[i];
        numBytes += getTextureSize(texture) * 1;
    }
    if (sceneTexture.distanceGridsTexture.gridTextures.length > 0) {
        let texture = sceneTexture.distanceGridsTexture.gridTextures[0];
        numBytes += getTextureSize(texture) * 1;
    }
    let triplaneTexture = sceneTexture.triplaneTexture;
    numBytes += getTextureSize(triplaneTexture.rgbTexture) * 3;
    numBytes += getTextureSize(triplaneTexture.densityTexture) * 1;
    numBytes += getTextureSize(triplaneTexture.featuresTexture) * 4;
    let sparseGridTexture = sceneTexture.sparseGridTexture;
    numBytes += getTextureSize(sparseGridTexture.blockIndicesTexture) * 1;
    numBytes += getTextureSize(sparseGridTexture.rgbTexture) * 3;
    numBytes += getTextureSize(sparseGridTexture.densityTexture) * 1;
    numBytes += getTextureSize(sparseGridTexture.featuresTexture) * 4;
    return numBytes;
}

async function initializeRayMarchScene(si, sceneContent) {
    let occupancyUniforms;
    let distanceUniforms;
    let exposureUniforms;
    let sceneParams = sceneContent.params;
    let sceneSpec = sceneContent.spec;
    let fragmentShaderSource = kRayMarchFragmentShaderHeader;
    fragmentShaderSource += await loadTextFile('viewdependency.glsl');
    fragmentShaderSource += await loadTextFile('fragment.glsl');
    fragmentShaderSource =
        rewriteViewDependenceDefinitions(sceneParams, fragmentShaderSource);
    let worldspaceROpengl = new THREE.Matrix3();
    worldspaceROpengl.set(-1, 0, 0, 0, 0, 1, 0, 1, 0);
    let minPosition = new THREE.Vector3(-2.0, -2.0, -2.0);
    fragmentShaderSource = '#define kMinPosition vec3(' +
        Number(minPosition.x).toFixed(10) + ', ' +
        Number(minPosition.y).toFixed(10) + ', ' +
        Number(minPosition.z).toFixed(10) + ')\n' + fragmentShaderSource;
    fragmentShaderSource = '#define kSubmodelScale ' +
        Number(getSubmodelScale(si)).toFixed(10) + '\n' + fragmentShaderSource;
    fragmentShaderSource =
        '#define kStepMult ' + gStepMult + '\n' + fragmentShaderSource;
    fragmentShaderSource = '#define kRangeFeaturesMin ' +
        Number(sceneParams['range_features'][0]).toFixed(10) + '\n' +
        fragmentShaderSource;
    fragmentShaderSource = '#define kRangeFeaturesMax ' +
        Number(sceneParams['range_features'][1]).toFixed(10) + '\n' +
        fragmentShaderSource;
    fragmentShaderSource = '#define kRangeDensityMin ' +
        Number(sceneParams['range_density'][0]).toFixed(10) + '\n' +
        fragmentShaderSource;
    fragmentShaderSource = '#define kRangeDensityMax ' +
        Number(sceneParams['range_density'][1]).toFixed(10) + '\n' +
        fragmentShaderSource;

    let rayMarchUniforms = {
        'bias_0': {'value': null},
        'bias_1': {'value': null},
        'bias_2': {'value': null},
        'weightsZero': {'value': null},
        'weightsOne': {'value': null},
        'weightsTwo': {'value': null},
        'displayMode': {'value': gDisplayMode - 0},
        'minPosition': {'value': minPosition},
        'world_T_cam': {'value': new THREE.Matrix4()},
        'cam_T_clip': {'value': new THREE.Matrix4()},
        'worldspaceROpengl': {'value': worldspaceROpengl},
    };
    occupancyUniforms = {};
    let occupancyGridSpecs = sceneSpec.occupancyGridsSpec.gridSpecs;
    let numOccupancyGrids = occupancyGridSpecs.length;
    for (let i = 0; i < numOccupancyGrids; ++i) {
        let spec = occupancyGridSpecs[i];
        let ri = numOccupancyGrids - i - 1;
        fragmentShaderSource = '#define kVoxelSizeOccupancy_L' + ri + ' ' +
            Number(spec.voxelSize).toFixed(10) + '\n' +
            fragmentShaderSource;
        fragmentShaderSource = '#define kGridSizeOccupancy_L' + ri + ' vec3(' +
            Number(spec.shape[0]).toFixed(10) + ', ' +
            Number(spec.shape[1]).toFixed(10) + ', ' +
            Number(spec.shape[2]).toFixed(10) + ')\n' +
            fragmentShaderSource;
        occupancyUniforms['occupancyGrid_L' + ri] = {'value': null};
    }
    rayMarchUniforms = extend(rayMarchUniforms, occupancyUniforms);

    if (sceneParams['useDistanceGrid']) {
        let spec = sceneSpec.distanceGridsSpec.gridSpecs[0];
        fragmentShaderSource = '#define USE_DISTANCE_GRID\n' + fragmentShaderSource;
        fragmentShaderSource = '#define kVoxelSizeDistance ' +
            Number(spec.voxelSize).toFixed(10) + '\n' + fragmentShaderSource;
        fragmentShaderSource = '#define kGridSizeDistance vec3(' +
            Number(spec.shape[0]).toFixed(10) + ', ' +
            Number(spec.shape[1]).toFixed(10) + ', ' +
            Number(spec.shape[2]).toFixed(10) + ')\n' + fragmentShaderSource;
        distanceUniforms = {'distanceGrid': {'value': null}};
        rayMarchUniforms = extend(rayMarchUniforms, distanceUniforms);
    }
    let backgroundColor = new THREE.Color(0.5, 0.5, 0.5);
    if (sceneParams['backgroundColor']) {
        backgroundColor = new THREE.Color(sceneParams['backgroundColor']);
    }
    fragmentShaderSource = '#define kBackgroundColor vec3(' +
        Number(backgroundColor.r).toFixed(10) + ', ' +
        Number(backgroundColor.g).toFixed(10) + ', ' +
        Number(backgroundColor.b).toFixed(10) + ')\n' + fragmentShaderSource;
    if (gExposure || sceneParams['default_exposure']) {
        if (sceneParams['default_exposure']) {
            gExposure = parseFloat(sceneParams['default_exposure']);
        }
        fragmentShaderSource = '#define USE_EXPOSURE\n' + fragmentShaderSource;
        exposureUniforms = {'exposure': {'value': gExposure}};
        rayMarchUniforms = extend(rayMarchUniforms, exposureUniforms);
    }
    const activation =
        sceneParams['activation'] ? sceneParams['activation'] : 'elu';
    fragmentShaderSource =
        '#define ACTIVATION_FN ' + activation + '\n' + fragmentShaderSource;
    if (sceneParams['feature_gating'] === null ||
        sceneParams['feature_gating'] === undefined ||
        sceneParams['feature_gating'] === true) {
        fragmentShaderSource =
            '#define USE_FEATURE_GATING\n' + fragmentShaderSource;
    }
    if (sceneParams['deferred_rendering_mode'] === 'vfr') {
        fragmentShaderSource = '#define USE_VFR\n' + fragmentShaderSource;
    }
    if (sceneParams['merge_features_combine_op'] === 'coarse_sum') {
        fragmentShaderSource =
            '#define USE_FEATURE_CONCAT\n' + fragmentShaderSource;
    }
    if (sceneParams['useBits']) {
        fragmentShaderSource = '#define USE_BITS\n' + fragmentShaderSource;
    }
    if (sceneParams['useLargerStepsWhenOccluded']) {
        fragmentShaderSource =
            '#define LARGER_STEPS_WHEN_OCCLUDED\n' + fragmentShaderSource;
        fragmentShaderSource = '#define kVisibilityDelay ' +
            Number(sceneParams['step_size_visibility_delay']).toFixed(10) + '\n' +
            fragmentShaderSource;
    }
    let triplaneGridSize = new THREE.Vector2(...sceneSpec.triplaneSpec.shape);
    fragmentShaderSource = '#define kTriplaneVoxelSize ' +
        Number(sceneParams['triplane_voxel_size']).toFixed(10) + '\n' +
        fragmentShaderSource;
    fragmentShaderSource = '#define kTriplaneGridSize vec2(' +
        Number(triplaneGridSize.x).toFixed(10) + ', ' +
        Number(triplaneGridSize.y).toFixed(10) + ')\n' + fragmentShaderSource;
    let triplaneUniforms = {
        'planeDensity': {'value': null},
        'planeRgb': {'value': null},
        'planeFeatures': {'value': null},
    };
    rayMarchUniforms = extend(rayMarchUniforms, triplaneUniforms);
    fragmentShaderSource = '#define kDataBlockSize ' +
        Number(sceneParams['data_block_size']).toFixed(10) + '\n' +
        fragmentShaderSource;
    fragmentShaderSource = '#define kSparseGridVoxelSize ' +
        Number(sceneParams['sparse_grid_voxel_size']).toFixed(10) + '\n' +
        fragmentShaderSource;
    fragmentShaderSource = '#define kSparseGridGridSize vec3(' +
        Number(sceneParams['sparse_grid_resolution']).toFixed(10) + ', ' +
        Number(sceneParams['sparse_grid_resolution']).toFixed(10) + ', ' +
        Number(sceneParams['sparse_grid_resolution']).toFixed(10) + ')\n' +
        fragmentShaderSource;
    let sparseGridUniforms = {
        'sparseGridBlockIndices': {'value': null},
        'sparseGridDensity': {'value': null},
        'sparseGridRgb': {'value': null},
        'sparseGridFeatures': {'value': null},
        'atlasSize': {'value': null},
    };
    rayMarchUniforms = extend(rayMarchUniforms, sparseGridUniforms);
    let shaderEditor = document.getElementById('shader-editor');
    shaderEditor.value = fragmentShaderSource;
    let rayMarchMaterial = new THREE.ShaderMaterial({
        uniforms: rayMarchUniforms,
        vertexShader: kRayMarchVertexShader,
        fragmentShader: fragmentShaderSource,
        vertexColors: true,
    });
    rayMarchMaterial.side = THREE.DoubleSide;
    rayMarchMaterial.depthTest = false;
    rayMarchMaterial.needsUpdate = true;
    const plane = new THREE.PlaneBufferGeometry(...gViewportDims);
    let mesh = new THREE.Mesh(plane, rayMarchMaterial);
    mesh.position.z = -100;
    mesh.frustumCulled = false;
    let scene = new THREE.Scene();
    scene.add(mesh);
    scene.autoUpdate = false;
    return scene;
}

function validateDeferredMlp(deferredMlp) {
    const mlpName =
        !!deferredMlp['ResampleDense_0/kernel'] ? 'ResampleDense' : 'Dense';
    for (let li = 0; li < 3; li++) {
        const layerName = `${mlpName}_${li}`;
        let kernelShape = deferredMlp[`${layerName}/kernel`]['shape'];
        let biasShape = deferredMlp[`${layerName}/bias`]['shape'];
        if (mlpName === 'ResampleDense') {
            let gridSize = kernelShape[1];
            console.assert(
                gridSize === kernelShape[2] && gridSize === kernelShape[3]);
            console.assert(
                kernelShape[0] === biasShape[0] && kernelShape[1] === biasShape[1] &&
                kernelShape[2] === biasShape[2] && kernelShape[3] === biasShape[3]);
        }
    }
}

let gOrbitControls = null;
let gMapControls = null;
let gPointerLockControls = null;
let gKeyW = false;
let gKeyA = false;
let gKeyS = false;
let gKeyD = false;
let gKeyQ = false;
let gKeyE = false;
let gKeyShift = false;
const gClock = new THREE.Clock();


window.gOrbitControls = gOrbitControls;
window.gPointerLockControls = gPointerLockControls;

function addHandlers() {
    let shaderEditor = document.getElementById('shader-editor');
    document.addEventListener('keypress', function (e) {
        if (document.activeElement === shaderEditor) {
            return;
        }
        if (e.keyCode === 32 || e.key === ' ' || e.key === 'Spacebar') {
            if (gDisplayMode === DisplayModeType.DISPLAY_NORMAL) {
                gDisplayMode = DisplayModeType.DISPLAY_DIFFUSE;
                console.log('Displaying DIFFUSE');
            } else if (gDisplayMode === DisplayModeType.DISPLAY_DIFFUSE) {
                gDisplayMode = DisplayModeType.DISPLAY_FEATURES;
                console.log('Displaying DISPLAY_FEATURES');
            } else if (gDisplayMode === DisplayModeType.DISPLAY_FEATURES) {
                gDisplayMode = DisplayModeType.DISPLAY_VIEW_DEPENDENT;
                console.log('Displaying DISPLAY_VIEW_DEPENDENT');
            } else if (gDisplayMode === DisplayModeType.DISPLAY_VIEW_DEPENDENT) {
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

function setupCameraControls(mouseMode, view) {
    if (mouseMode && mouseMode === 'fps') {
        gPointerLockControls = new PointerLockControls(gCamera, view);
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
    } else if (mouseMode && mouseMode === 'map') {
        gMapControls = new OrbitControls(gCamera, view);
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
        gOrbitControls = new OrbitControls(gCamera, view);
        gOrbitControls.screenSpacePanning = true;
        gOrbitControls.zoomSpeed = 0.5;
    }
}

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

let gSubmodelPanel = null;
let gVMemPanel = null;
let gStepMult = 1;
let gExposure = null;

function loadScene(dirUrl, overrideParams) {
    let filenameToLinkPromise;
    if (dirUrl.includes('.json')) {
        filenameToLinkPromise = loadJSONFile(dirUrl);
    } else {
        filenameToLinkPromise = Promise.resolve(null);
    }
    filenameToLinkPromise
        .then(filenameToLink => {
            const router = new Router(dirUrl, filenameToLink);
            const sceneParamsUrl = router.translate('scene_params.json');
            const sceneParamsPromise = loadJSONFile(sceneParamsUrl);
            if (overrideParams['loadBenchmarkCameras']) {
                loadBenchmarkCameras(router);
            }
            return Promise.all([sceneParamsPromise, {router, filenameToLink}]);
        })
        .then(parsed => {
            const [sceneParams, carry] = parsed;
            let initialSubmodelIndex = 0;
            gUseSubmodel =
                (sceneParams.hasOwnProperty('num_local_submodels') &&
                    sceneParams['num_local_submodels'] > 1);
            if (gUseSubmodel) {
                gSubmodelCount = sceneParams['num_local_submodels'];
                initialSubmodelIndex =
                    sceneParams['sm_to_params'][sceneParams['submodel_idx']];
            }
            let sceneParamsPromises = [];
            for (let si = 0; si < gSubmodelCount; ++si) {
                const submodelId = sceneParams['params_to_sm'][si];
                const filePath = carry.router.translate(
                    submodelAssetPath(submodelId, 'scene_params.json'));
                sceneParamsPromises.push(loadJSONFile(filePath));
            }
            return Promise.all(
                [{...carry, initialSubmodelIndex}, ...sceneParamsPromises]);
        })
        .then(loaded => {
            let [carry, ...submodelSceneParams] = loaded;
            for (let si = 0; si < submodelSceneParams.length; ++si) {
                submodelSceneParams[si] =
                    extend(submodelSceneParams[si], overrideParams);
                const submodelId = submodelSceneParams[si]['params_to_sm'][si];
                let subDirUrl = dirUrl;
                if (gUseSubmodel) {
                    subDirUrl = `${subDirUrl}/${submodelAssetPath(submodelId)}`;
                }
                let submodelRouter = new Router(subDirUrl, carry.filenameToLink);
                let submodelContent =
                    initializeSceneContent(submodelSceneParams[si], submodelRouter);
                console.log(`spec for submodel #${si}:`, submodelContent.spec);
                registerSubmodelContent(si, submodelContent);
            }
            let si = carry.initialSubmodelIndex;
            setupInitialCameraPose(
                dirUrl,
                submodelCenter(si, getSubmodelContent(si).params),
            );
            return Promise.all([si, initializeDeferredMlp(si)]);
        }).then(([si, _]) => {
        return initializePingPongBuffers(si);
    }).then(() => {
        gRenderer.setAnimationLoop(renderNextFrame);
    })
        .catch(err => {
            console.error("Scene loading error:", err);
        });

}

function initFromParameters() {
    const params = new URL(window.location.href).searchParams;
    const dirUrl = params.get('dir');
    const size = params.get('s');
    let quality = params.get('quality');
    const stepMult = params.get('stepMult');
    if (stepMult) {
        gStepMult = parseInt(stepMult, 10);
    }
    const frameMult = params.get('frameMult');
    if (frameMult) {
        gFrameMult = parseInt(frameMult, 10);
    }
    const exposure = params.get('exposure');
    if (exposure) {
        gExposure = parseFloat(exposure);
    }
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

    const deferredMode = params.get('deferredMode');
    if (deferredMode) {
        overrideParams['deferred_rendering_mode'] = deferredMode;
    }
    const combineMode = params.get('combineMode');
    if (combineMode && combineMode === 'concat_and_sum') {
        overrideParams['merge_features_combine_op'] = 'coarse_sum';
    }
    const useBits = params.get('useBits');
    if (useBits) {
        overrideParams['useBits'] = useBits.toLowerCase() === 'true';
    }
    const useDistanceGrid = params.get('useDistanceGrid');
    if (useDistanceGrid) {
        overrideParams['useDistanceGrid'] =
            useDistanceGrid.toLowerCase() === 'true';
    }
    const legacyGrids = params.get('legacyGrids');
    if (legacyGrids) {
        overrideParams['legacyGrids'] = legacyGrids.toLowerCase() === 'true';
    }
    const activation = params.get('activation');
    if (activation) {
        overrideParams['activation'] = activation;
    }
    const featureGating = params.get('featureGating');
    if (featureGating) {
        overrideParams['feature_gating'] = featureGating.toLowerCase() === 'true';
    }
    const submodelCacheSize = params.get('submodelCacheSize');
    if (submodelCacheSize) {
        gSubmodelCacheSize = Number(submodelCacheSize);
    }
    const mergeSlices = params.get('mergeSlices');
    if (mergeSlices) {
        overrideParams['merge_slices'] = mergeSlices === 'true';
    }
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
    let frameBufferWidth = window.innerWidth -
        13;
    let frameBufferHeight = window.innerHeight - 19;
    let lowResFactor = parseInt(params.get('downscale') || 1, 10);

    if (size) {
        const match = size.match(/([\d]+),([\d]+)/);
        frameBufferWidth = parseInt(match[1], 10);
        frameBufferHeight = parseInt(match[2], 10);
    } else if (quality) {
        if (quality === 'phone') {  // For iPhones.
            frameBufferWidth = Math.min(350, frameBufferWidth);
            frameBufferHeight = Math.min(600, frameBufferHeight);
        } else if (quality === 'low') {  // For laptops with integrated GPUs.
            frameBufferWidth = Math.min(1280, frameBufferWidth);
            frameBufferHeight = Math.min(800, frameBufferHeight);
        } else if (quality === 'medium') {  // For laptops with dicrete GPUs.
            frameBufferWidth = Math.min(1920, frameBufferWidth);
            frameBufferHeight = Math.min(1080, frameBufferHeight);
        }
    }
    let stepSizeVisibilityDelay = 0.99;
    if (!params.get('downscale') && quality) {
        let maxPixelsPerFrame = frameBufferWidth * frameBufferHeight;
        if (quality === 'phone') {  // For iPhones.
            maxPixelsPerFrame = 300 * 450;
            stepSizeVisibilityDelay = 0.8;
        } else if (quality === 'low') {  // For laptops with integrated GPUs.
            maxPixelsPerFrame = 600 * 250;
            stepSizeVisibilityDelay = 0.8;
        } else if (quality === 'medium') {  // For laptops with dicrete GPUs.
            maxPixelsPerFrame = 1200 * 640;
            stepSizeVisibilityDelay = 0.95;
        }
        while (frameBufferWidth * frameBufferHeight / lowResFactor >
        maxPixelsPerFrame) {
            lowResFactor++;
        }
        console.log('Automatically chose a downscaling factor of ' + lowResFactor);
    }
    overrideParams['useLargerStepsWhenOccluded'] = true;
    overrideParams['step_size_visibility_delay'] = stepSizeVisibilityDelay;
    const nearPlane = parseFloat(params.get('near') || 0.2);
    const vfovy = parseFloat(params.get('vfovy') || 40.0);
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
    gStats = Stats();
    gStats.dom.style.position = 'absolute';
    viewSpace.appendChild(gStats.dom);

    gSubmodelPanel = gStats.addPanel(new Stats.Panel('SM', '#0ff', '#002'));
    gSubmodelPanel.update(getActiveSubmodelIndex());

    gVMemPanel = gStats.addPanel(new Stats.Panel('MB VRAM', '#0ff', '#002'));
    gVMemPanel.update(0);
    gStats.showPanel(0);
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
        xrCompatible: true,
    });
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gRenderer = new THREE.WebGLRenderer({
        canvas: canvas,
        context: gl,
    });
    gRenderer.xr.enabled = true;
    document.body.appendChild(VRButton.createButton(gRenderer));
    gCamera = new THREE.PerspectiveCamera(
        vfovy,
        Math.trunc(view.offsetWidth / lowResFactor) /
        Math.trunc(view.offsetHeight / lowResFactor),
        nearPlane, 100.0);
    setupProgressiveRendering(view, lowResFactor);
    gRenderer.autoClear = false;
    gRenderer.setSize(view.offsetWidth, view.offsetHeight);
    if (!benchmark) {
        const mouseMode = params.get('mouseMode');
        setupCameraControls(mouseMode, view);
    }

    let width = Math.trunc(view.offsetWidth / lowResFactor);
    let height = Math.trunc(view.offsetHeight / lowResFactor);
    setupViewport(width, height);

    loadScene(dirUrl, overrideParams);
}

function renderNextFrame(t) {
    garbageCollectSubmodelPayloads();
    let submodelIndex =
        positionToSubmodel(gCamera.position, getActiveSubmodelContent().params);
    setCurrentRayMarchScene(submodelIndex);
    submodelIndex = getActiveSubmodelIndex();
    let sceneParams = getSubmodelContent(submodelIndex).params;

    for (let i = 0; i < gFrameMult; ++i) {
        gSubmodelTransform = submodelTransform(submodelIndex, sceneParams);
        gSubmodelPanel.update(submodelIndex);
        gVMemPanel.update(getCurrentTextureUsageInBytes() / 1e6);
        if (!gRenderer.xr.isPresenting) {
            updateCameraControls(); // Only for non-VR mode
        }
        if (!gBenchmark) {
            gCamera.updateProjectionMatrix();
        }
        gCamera.updateMatrixWorld();
        gRenderer.render(getRayMarchScene(), gCamera);

        const currentSubmodelCenter = submodelCenter(submodelIndex, sceneParams);
        const submodelScale = getSubmodelScale(submodelIndex);
        let submodelCameraPosition = new THREE.Vector3().copy(gCamera.position);
        submodelCameraPosition.sub(currentSubmodelCenter);
        submodelCameraPosition.multiplyScalar(submodelScale);

        let shaderUniforms = getRayMarchScene().children[0].material.uniforms;
        if (!!shaderUniforms['weightsZero']['value']) {
            shaderUniforms['weightsZero']['value'].dispose();
        }
        if (!!shaderUniforms['weightsOne']['value']) {
            shaderUniforms['weightsOne']['value'].dispose();
        }
        if (!!shaderUniforms['weightsTwo']['value']) {
            shaderUniforms['weightsTwo']['value'].dispose();
        }
        shaderUniforms['bias_0']['value'] =
            trilerpDeferredMlpBiases(submodelIndex, 0, submodelCameraPosition);
        shaderUniforms['bias_1']['value'] =
            trilerpDeferredMlpBiases(submodelIndex, 1, submodelCameraPosition);
        shaderUniforms['bias_2']['value'] =
            trilerpDeferredMlpBiases(submodelIndex, 2, submodelCameraPosition);

        shaderUniforms['weightsZero']['value'] =
            trilerpDeferredMlpKernel(submodelIndex, 0, submodelCameraPosition);
        shaderUniforms['weightsOne']['value'] =
            trilerpDeferredMlpKernel(submodelIndex, 1, submodelCameraPosition);
        shaderUniforms['weightsTwo']['value'] =
            trilerpDeferredMlpKernel(submodelIndex, 2, submodelCameraPosition);
        renderProgressively();
    }
    gStats.update();
    let scheduleNextFrame = () => {
        gRenderer.setAnimationLoop(renderNextFrame);
    };
    if (gBenchmark) {
        scheduleNextFrame = benchmarkPerformance(scheduleNextFrame);
    }
    scheduleNextFrame();
}

function start() {
    initFromParameters();   // sets up everything
    addHandlers();
    gRenderer.setAnimationLoop(renderNextFrame);
}

window.onload = start;