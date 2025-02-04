

const NEEDS_NEW_SUBMODEL = -1;
const LOADING = 0;
const READY = 1;
let gRayMarchScene = null;
let gActiveRayMarchTextureBuffer = 0;
let gSubmodelSceneContents = {};
let gSubmodelCacheSize = 10;
let gRayMarchTextureBuffers = [
    {si: 0, state: NEEDS_NEW_SUBMODEL, texture: null},
    {si: 0, state: NEEDS_NEW_SUBMODEL, texture: null},
];

function getRayMarchScene() {
    if (gRayMarchScene == null) throw new Error('gRayMarchScene has not been initialized yet!');
    return gRayMarchScene;
}

function getActiveSubmodelIndex() {
    return gRayMarchTextureBuffers[gActiveRayMarchTextureBuffer].si;
}

function getActiveSubmodelContent() {
    return getSubmodelContent(getActiveSubmodelIndex());
}

function getSubmodelScale(si) {
    return getSubmodelContent(si).params['submodel_scale'];
}

function getSubmodelScaleFactor(si) {
    let submodelScale = getSubmodelScale(si);
    let submodelResolution = Math.cbrt(getSubmodelContent(si).params['num_submodels']);
    return submodelScale / submodelResolution;
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
    for (rmtb of gRayMarchTextureBuffers) numBytes += getTextureSizeInBytes(rmtb.texture);
    return numBytes;
}

function setCurrentRayMarchScene(si) {
    const activeBufferIdx = gActiveRayMarchTextureBuffer;
    const activeBuffer = gRayMarchTextureBuffers[activeBufferIdx];
    const otherBufferIdx = (activeBufferIdx + 1) % 2;
    const otherBuffer = gRayMarchTextureBuffers[otherBufferIdx];

    const content = getSubmodelContent(si);
    if (!content) return Promise.resolve();
    content.lastTouched = Date.now();

    if (si === activeBuffer.si && activeBuffer.state >= LOADING) return Promise.resolve();
    if (si === otherBuffer.si && otherBuffer.state === READY) {
        console.log(`Switching to buffer ${otherBufferIdx} for submodel #${si}`);
        setTextureUniforms(content.params, otherBuffer.texture);
        gActiveRayMarchTextureBuffer = otherBufferIdx;
        return Promise.resolve();
    }
    if (otherBuffer.state >= LOADING && otherBuffer.state < READY) return Promise.resolve();

    console.log(`Preparing texture buffer #${otherBufferIdx} for submodel #${si}`);
    otherBuffer.si = si;
    otherBuffer.state = LOADING;
    showLoading();

    return Promise.resolve()
        .then(() => {
            reinitializeSparseGridTextures(otherBuffer);
            if (!content.payload) {
                console.log(`Fetching assets for submodel #${si}`);
                content.payload = prepareTexturePayload(fetchAsset(content.spec, content.router));
            }
            console.log(`Populating textures for submodel #${si} into buffer #${otherBufferIdx}`);
            return populateTexture(otherBuffer.texture, content.payload);
        })
        .then(() => {
            otherBuffer.state = READY;
            console.log(`Submodel #${si} is ready for rendering`);
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
    const { sparseGridTexture } = rmtb.texture;
    const { blockIndicesTexture, rgbTexture, densityTexture, featuresTexture } = sparseGridTexture;
    [blockIndicesTexture, rgbTexture, densityTexture, featuresTexture].forEach(texture => texture.texture.dispose());
    const sparseGridSpec = getSubmodelContent(rmtb.si).spec.sparseGridSpec;
    rmtb.texture.sparseGridTexture = createEmptyTexture(sparseGridSpec);
}

async function initializePingPongBuffers(si) {
    let sceneContent = getSubmodelContent(si);
    gRayMarchScene = await initializeRayMarchScene(si, sceneContent);
    for (let rmtb of gRayMarchTextureBuffers) rmtb.texture = createEmptyTexture(sceneContent.spec);
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
    const rayMarchUniforms = getRayMarchScene().children[0].material.uniforms;
    const { occupancyGridsTexture, distanceGridsTexture, triplaneTexture, sparseGridTexture } = sceneTexture;
    occupancyGridsTexture.gridTextures.forEach((texture, index) => {
        const ri = occupancyGridsTexture.gridTextures.length - index - 1;
        rayMarchUniforms[`occupancyGrid_L${ri}`].value = texture.texture;
    });
    if (sceneParams.useDistanceGrid) {
        rayMarchUniforms['distanceGrid'].value = distanceGridsTexture.gridTextures[0].texture;
    }
    rayMarchUniforms['planeDensity'].value = triplaneTexture.densityTexture.texture;
    rayMarchUniforms['planeRgb'].value = triplaneTexture.rgbTexture.texture;
    rayMarchUniforms['planeFeatures'].value = triplaneTexture.featuresTexture.texture;
    rayMarchUniforms['sparseGridBlockIndices'].value = sparseGridTexture.blockIndicesTexture.texture;
    rayMarchUniforms['sparseGridDensity'].value = sparseGridTexture.densityTexture.texture;
    rayMarchUniforms['sparseGridRgb'].value = sparseGridTexture.rgbTexture.texture;
    rayMarchUniforms['sparseGridFeatures'].value = sparseGridTexture.featuresTexture.texture;
    rayMarchUniforms['atlasSize'].value = new THREE.Vector3(
        sceneParams.atlas_width, sceneParams.atlas_height, sceneParams.atlas_depth
    );
}

function getTextureSizeInBytes(sceneTexture) {
    const getTextureSize = (texture) => texture ?
                texture.texture.image.height * texture.texture.image.width * texture.texture.image.depth : 0;

    let numBytes = 0;

    sceneTexture.occupancyGridsTexture.gridTextures.forEach(texture => numBytes += getTextureSize(texture));
    if (sceneTexture.distanceGridsTexture.gridTextures.length > 0) {
        numBytes += getTextureSize(sceneTexture.distanceGridsTexture.gridTextures[0]);
    }

    const { rgbTexture, densityTexture, featuresTexture } = sceneTexture.triplaneTexture;
    numBytes += getTextureSize(rgbTexture) * 3;
    numBytes += getTextureSize(densityTexture);
    numBytes += getTextureSize(featuresTexture) * 4;

    const { blockIndicesTexture, rgbTexture: sparseRgb, densityTexture: sparseDensity,
                    featuresTexture: sparseFeatures } = sceneTexture.sparseGridTexture;
    numBytes += getTextureSize(blockIndicesTexture);
    numBytes += getTextureSize(sparseRgb) * 3;
    numBytes += getTextureSize(sparseDensity);
    numBytes += getTextureSize(sparseFeatures) * 4;

    return numBytes;
}

async function initializeRayMarchScene(si, sceneContent) {
    const { params: p, spec } = sceneContent;
    const addDef = (src, name, val = '') => `#define ${name} ${val}\n${src}`;
    const f10 = (v) => Number(v).toFixed(10);

    let fs = kRayMarchFragmentShaderHeader
        + await loadTextFile('viewdependency.glsl')
        + await loadTextFile('fragment.glsl');
    fs = rewriteViewDependenceDefinitions(p, fs);

    const wR = new THREE.Matrix3().set(-1, 0, 0, 0, 0, 1, 0, 1, 0),
        minPos = new THREE.Vector3(-2, -2, -2),
        baseUniforms = {
            bias_0: { value: null }, bias_1: { value: null }, bias_2: { value: null },
            weightsZero: { value: null }, weightsOne: { value: null }, weightsTwo: { value: null },
            displayMode: { value: gDisplayMode }, minPosition: { value: minPos },
            world_T_cam: { value: new THREE.Matrix4() },
            cam_T_clip: { value: new THREE.Matrix4() },
            worldspaceROpengl: { value: wR }
        };

    let defs = [
        ['kMinPosition', `vec3(${f10(minPos.x)},${f10(minPos.y)},${f10(minPos.z)})`],
        ['kSubmodelScale', f10(getSubmodelScale(si))],
        ['kStepMult', gStepMult],
        ['kRangeFeaturesMin', f10(p.range_features[0])],
        ['kRangeFeaturesMax', f10(p.range_features[1])],
        ['kRangeDensityMin', f10(p.range_density[0])],
        ['kRangeDensityMax', f10(p.range_density[1])]
    ];

    const occupancySpecs = (spec.occupancyGridsSpec && spec.occupancyGridsSpec.gridSpecs) || [];
    let occupancyUniforms = {};
    for (let i = 0; i < occupancySpecs.length; i++) {
        const r = occupancySpecs.length - i - 1, s = occupancySpecs[i];
        defs.push([`kVoxelSizeOccupancy_L${r}`, f10(s.voxelSize)]);
        defs.push([`kGridSizeOccupancy_L${r}`, `vec3(${f10(s.shape[0])},${f10(s.shape[1])},${f10(s.shape[2])})`]);
        occupancyUniforms[`occupancyGrid_L${r}`] = { value: null };
    }

    let distanceUniforms = {};
    if (p.useDistanceGrid) {
        const ds = spec.distanceGridsSpec.gridSpecs[0];
        defs.push(['USE_DISTANCE_GRID']);
        defs.push(['kVoxelSizeDistance', f10(ds.voxelSize)]);
        defs.push(['kGridSizeDistance', `vec3(${f10(ds.shape[0])},${f10(ds.shape[1])},${f10(ds.shape[2])})`]);
        distanceUniforms = { distanceGrid: { value: null } };
    }

    const bg = new THREE.Color(p.backgroundColor || 0x808080);
    defs.push(['kBackgroundColor', `vec3(${f10(bg.r)},${f10(bg.g)},${f10(bg.b)})`]);

    let exposureUniforms = {};
    if (gExposure || p.default_exposure) {
        if (p.default_exposure) gExposure = parseFloat(p.default_exposure);
        defs.push(['USE_EXPOSURE']);
        exposureUniforms = { exposure: { value: gExposure } };
    }

    defs.push(['ACTIVATION_FN', p.activation || 'elu']);
    if (p.feature_gating !== false) defs.push(['USE_FEATURE_GATING']);
    if (p.deferred_rendering_mode === 'vfr') defs.push(['USE_VFR']);
    if (p.merge_features_combine_op === 'coarse_sum') defs.push(['USE_FEATURE_CONCAT']);
    if (p.useBits) defs.push(['USE_BITS']);
    if (p.useLargerStepsWhenOccluded) {
        defs.push(['LARGER_STEPS_WHEN_OCCLUDED']);
        defs.push(['kVisibilityDelay', f10(p.step_size_visibility_delay)]);
    }

    const triSize = new THREE.Vector2(...spec.triplaneSpec.shape),
        triUniforms = {
            planeDensity:  { value: null },
            planeRgb:      { value: null },
            planeFeatures: { value: null },
        };
    defs.push(['kTriplaneVoxelSize', f10(p.triplane_voxel_size)]);
    defs.push(['kTriplaneGridSize', `vec2(${f10(triSize.x)},${f10(triSize.y)})`]);

    const sparseUniforms = {
        sparseGridBlockIndices: { value: null },
        sparseGridDensity:      { value: null },
        sparseGridRgb:          { value: null },
        sparseGridFeatures:     { value: null },
        atlasSize:              { value: null },
    };
    defs.push(['kDataBlockSize', f10(p.data_block_size)]);
    defs.push(['kSparseGridVoxelSize', f10(p.sparse_grid_voxel_size)]);
    defs.push([
        'kSparseGridGridSize',
        `vec3(${f10(p.sparse_grid_resolution)},${f10(p.sparse_grid_resolution)},${f10(p.sparse_grid_resolution)})`
    ]);

    fs = defs.reduce((src, [key, val]) => addDef(src, key, val), fs);

    let rayMarchUniforms = Object.assign(
        {},
        baseUniforms,
        occupancyUniforms,
        distanceUniforms,
        exposureUniforms,
        triUniforms,
        sparseUniforms
    );

    const editor = document.getElementById('shader-editor');
    if (editor) editor.value = fs;
    const rayMarchMaterial = new THREE.ShaderMaterial({
        uniforms: rayMarchUniforms, vertexShader: kRayMarchVertexShader, fragmentShader: fs,
        vertexColors: true, side: THREE.DoubleSide, depthTest: false
    });
    rayMarchMaterial.needsUpdate = true;
    const mesh = new THREE.Mesh(new THREE.PlaneBufferGeometry(...gViewportDims), rayMarchMaterial);
    mesh.position.z = -100;
    mesh.frustumCulled = false;
    const scene = new THREE.Scene();
    scene.add(mesh);
    scene.autoUpdate = false;

    return scene;
}

function validateDeferredMlp(deferredMlp) {
    const mlpName = deferredMlp['ResampleDense_0/kernel'] ? 'ResampleDense' : 'Dense';
    for (let li = 0; li < 3; li++) {
        const layerName = `${mlpName}_${li}`;
        const kernelShape = deferredMlp[`${layerName}/kernel`]['shape'];
        const biasShape = deferredMlp[`${layerName}/bias`]['shape'];
        if (mlpName === 'ResampleDense') {
            const [batchSize, gridSize, height, width] = kernelShape;
            console.assert(gridSize === height && gridSize === width, 'Grid size mismatch');
            console.assert(
                batchSize === biasShape[0] && gridSize === biasShape[1] &&
                height === biasShape[2] && width === biasShape[3],
                'Shape mismatch between kernel and bias'
            );
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

function addHandlers() {
    const shaderEditor = document.getElementById('shader-editor');

    // Key press events for non-movement actions.
    document.addEventListener('keypress', function (e) {
        if (document.activeElement === shaderEditor) return;

        if (e.keyCode === 32 || e.key === ' ' || e.key === 'Spacebar') {
            // Cycle through display modes.
            cycleDisplayMode();
            e.preventDefault();
        } else if (e.key === 'r') {
            console.log('Recompile shader.');
            const material = getRayMarchScene().children[0].material;
            material.fragmentShader = shaderEditor.value;
            material.needsUpdate = true;
            e.preventDefault();
        } else if (e.key === '?') {
            const position = gCamera.getWorldPosition(new THREE.Vector3());
            const quaternion = gCamera.getWorldQuaternion(new THREE.Quaternion());
            console.log(`
        gCamera.position.set(${position.x}, ${position.y}, ${position.z});
        gCamera.quaternion.set(${quaternion.x}, ${quaternion.y}, ${quaternion.z}, ${quaternion.w});
      `);
            e.preventDefault();
        }
    });

    function cycleDisplayMode() {
        const displayModes = [
            DisplayModeType.DISPLAY_NORMAL,
            DisplayModeType.DISPLAY_DIFFUSE,
            DisplayModeType.DISPLAY_FEATURES,
            DisplayModeType.DISPLAY_VIEW_DEPENDENT,
            DisplayModeType.DISPLAY_COARSE_GRID
        ];
        const curIndex = displayModes.indexOf(gDisplayMode);
        const nextIndex = (curIndex + 1) % displayModes.length;
        gDisplayMode = displayModes[nextIndex];
        console.log('Displaying', gDisplayMode);
    }

    function updateKeyState(e, isDown) {
        if (document.activeElement === shaderEditor) return;
        switch (e.key.toLowerCase()) {
            case 'w':
                gKeyW = isDown;
                break;
            case 'a':
                gKeyA = isDown;
                break;
            case 's':
                gKeyS = isDown;
                break;
            case 'd':
                gKeyD = isDown;
                break;
            case 'q':
                gKeyQ = isDown;
                break;
            case 'e':
                gKeyE = isDown;
                break;
            case 'shift':
                gKeyShift = isDown;
                break;
            default:
                return; // Do nothing if the key is not handled.
        }
        e.preventDefault();
    }
    document.addEventListener('keydown', (e) => updateKeyState(e, true));
    document.addEventListener('keyup', (e) => updateKeyState(e, false));
}

function setupCameraControls(mouseMode, view) {
    const controlsOptions = {
        'fps': () => {
            gPointerLockControls = new THREE.PointerLockControls(gCamera, view);
            const startButton = document.createElement('button');
            startButton.innerHTML = 'Click to enable mouse navigation';
            startButton.style = 'position: absolute; top: 0; width: 250px; margin: 0 0 0 -125px;';
            startButton.addEventListener('click', () => {
                gPointerLockControls.lock();
                gPointerLockControls.connect();
            });
            document.getElementById('viewspacecontainer').appendChild(startButton);
        },
        'map': () => {
            gMapControls = new THREE.OrbitControls(gCamera, view);
            gMapControls.panSpeed = 0.5 / gCamera.near;
            gMapControls.enableZoom = false;
            gMapControls.screenSpacePanning = false;
            gMapControls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, RIGHT: THREE.MOUSE.PAN };
            gMapControls.touches = { ONE: THREE.TOUCH.PAN, TWO: THREE.TOUCH.DOLLY_ROTATE };
        },
        'default': () => {
            gOrbitControls = new THREE.OrbitControls(gCamera, view);
            gOrbitControls.screenSpacePanning = true;
            gOrbitControls.zoomSpeed = 0.5;
        }
    };

    (controlsOptions[mouseMode] || controlsOptions['default'])();
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
        if (gKeyW) gCamera.position = gCamera.position.addScaledVector(camForward, elapsed * movementSpeed);
        if (gKeyA) gPointerLockControls.moveRight(-elapsed * movementSpeed);
        if (gKeyS) gCamera.position = gCamera.position.addScaledVector(camForward, -elapsed * movementSpeed);
        if (gKeyD) gPointerLockControls.moveRight(elapsed * movementSpeed);
        if (gKeyQ) gCamera.position = gCamera.position.addScaledVector(upVec, -elapsed * movementSpeed);
        if (gKeyE) gCamera.position = gCamera.position.addScaledVector(upVec, elapsed * movementSpeed);
    }
}

let gSubmodelPanel = null;
let gVMemPanel = null;
let gStepMult = 1;
let gExposure = null;

async function loadScene(dirUrl, overrideParams) {
    const filenameToLink = dirUrl.includes('.json') ? await loadJSONFile(dirUrl) : null;
    const router = new Router(dirUrl, filenameToLink);
    const sceneParamsUrl = router.translate('scene_params.json');
    const sceneParams = await loadJSONFile(sceneParamsUrl);

    if (overrideParams.loadBenchmarkCameras) {
        loadBenchmarkCameras(router);
    }
    let initialSubmodelIndex = 0;
    gUseSubmodel = sceneParams.hasOwnProperty('num_local_submodels') && sceneParams.num_local_submodels > 1;
    if (gUseSubmodel) {
        gSubmodelCount = sceneParams.num_local_submodels;
        initialSubmodelIndex = sceneParams.sm_to_params[sceneParams.submodel_idx];
    }
    const submodelPromises = [];
    for (let si = 0; si < gSubmodelCount; ++si) {
        const submodelId = sceneParams.params_to_sm[si];
        const filePath = router.translate(submodelAssetPath(submodelId, 'scene_params.json'));
        submodelPromises.push(loadJSONFile(filePath));
    }
    const submodelSceneParams = await Promise.all(submodelPromises);
    submodelSceneParams.forEach((params, si) => {
        // Merge parameters with any overrides.
        const extendedParams = extend(params, overrideParams);
        const submodelId = extendedParams.params_to_sm[si];
        let subDirUrl = dirUrl;
        if (gUseSubmodel) {
            subDirUrl = `${dirUrl}/${submodelAssetPath(submodelId)}`;
        }
        const submodelRouter = new Router(subDirUrl, filenameToLink);
        const submodelContent = initializeSceneContent(extendedParams, submodelRouter);
        console.log(`spec for submodel #${si}:`, submodelContent.spec);
        registerSubmodelContent(si, submodelContent);
    });

    const si = initialSubmodelIndex;
    setupInitialCameraPose(dirUrl, submodelCenter(si, getSubmodelContent(si).params));
    await initializeDeferredMlp(si);
    await initializePingPongBuffers(si);
    requestAnimationFrame(renderNextFrame);
}


async function initFromParameters() {
    const params = new URL(window.location.href).searchParams;
    const dirUrl = getRequiredParam(params, 'dir', 'dir is a required parameter.');
    let quality = params.get('quality');

    gStepMult = getIntParam(params, 'stepMult', gStepMult);
    gFrameMult = getIntParam(params, 'frameMult', gFrameMult);
    gExposure = getFloatParam(params, 'exposure', gExposure);
    const nearPlane = getFloatParam(params, 'near', 0.2);
    const vfovy = getFloatParam(params, 'vfovy', 40.0);
    const overrideParams = buildOverrideParams(params, dirUrl, quality);
    quality = overrideParams.benchmark ? 'high' : quality;
    const fbData = computeFrameBuffer(params, quality);
    overrideParams.useLargerStepsWhenOccluded = true;
    overrideParams.step_size_visibility_delay = fbData.stepSizeVisibilityDelay;
    const view = setupView(fbData.frameBufferWidth, fbData.frameBufferHeight);
    const canvas = createCanvas(view);
    setupStats(view);
    const gl = await setupGLContext(canvas, params, overrideParams);
    gRenderer = new THREE.WebGLRenderer({ canvas: canvas, context: gl });

    gCamera = new THREE.PerspectiveCamera(
        vfovy,
        Math.trunc(view.offsetWidth / fbData.lowResFactor) / Math.trunc(view.offsetHeight / fbData.lowResFactor),
        nearPlane,
        100.0
    );

    setupProgressiveRendering(view, fbData.lowResFactor);
    gRenderer.autoClear = false;
    gRenderer.setSize(view.offsetWidth, view.offsetHeight);
    //TODO ADDED
    gRenderer.xr.enabled = true;
    document.body.appendChild(VRButton.createButton(gRenderer));


    if (!overrideParams.benchmark) {
        const mouseMode = params.get('mouseMode');
        setupCameraControls(mouseMode, view);
    }

    const width = Math.trunc(view.offsetWidth / fbData.lowResFactor);
    const height = Math.trunc(view.offsetHeight / fbData.lowResFactor);
    setupViewport(width, height);
    loadScene(dirUrl, overrideParams);
}

function getRequiredParam(params, name, errorMessage) {
    const value = params.get(name);
    if (!value) {
        const usageString =
            'To view a MERF scene, specify the following parameters in the URL:\n' +
            'dir: (Required) The URL to a MERF scene directory.\n' +
            'quality: (Optional) A quality preset (phone, low, medium or high).\n' +
            'mouseMode: (Optional) "orbit", "fps", or "map".\n' +
            // … additional usage text …
            'vfovy:  (Optional) The vertical field of view of the viewer.\n';
        error(`${errorMessage}\n\n${usageString}`);
        throw new Error(errorMessage);
    }
    return value;
}

function getIntParam(params, name, defaultVal) {
    const val = params.get(name);
    return val ? parseInt(val, 10) : defaultVal;
}

function getFloatParam(params, name, defaultVal) {
    const val = params.get(name);
    return val ? parseFloat(val) : defaultVal;
}

function buildOverrideParams(params, dirUrl, quality) {
    const overrideParams = {};
    const benchmarkParam = params.get('benchmark');
    const benchmark = benchmarkParam &&
        (benchmarkParam.toLowerCase() === 'time' || benchmarkParam.toLowerCase() === 'quality');
    overrideParams.benchmark = benchmark;
    if (benchmark) {
        overrideParams.loadBenchmarkCameras = true;
        const sceneNameChunks = dirUrl.split('/').slice(-2);
        setupBenchmarkStats(sceneNameChunks.join('_'), benchmarkParam.toLowerCase() === 'quality');
    }

    [
        { param: 'deferredMode', key: 'deferred_rendering_mode' },
        { param: 'activation', key: 'activation' }
    ].forEach(({ param, key }) => {
        const value = params.get(param);
        if (value) overrideParams[key] = value;
    });

    ['useBits', 'useDistanceGrid', 'legacyGrids', 'featureGating'].forEach(key => {
        const value = params.get(key);
        if (value) {
            overrideParams[key === 'featureGating' ? 'feature_gating' : key] = value.toLowerCase() === 'true';
        }
    });

    if (params.get('combineMode') === 'concat_and_sum') overrideParams.merge_features_combine_op = 'coarse_sum';
    if (params.get('mergeSlices')) overrideParams.merge_slices = params.get('mergeSlices') === 'true';
    if (params.get('backgroundColor')) overrideParams.backgroundColor = '#' + params.get('backgroundColor');

    return overrideParams;
}

function computeFrameBuffer(params, quality) {
    let frameBufferWidth = window.innerWidth - 13;
    let frameBufferHeight = window.innerHeight - 19;
    let lowResFactor = getIntParam(params, 'downscale', 1);

    const sizeParam = params.get('s');
    if (sizeParam) {
        const match = sizeParam.match(/(\d+),(\d+)/);
        if (match) {
            frameBufferWidth = parseInt(match[1], 10);
            frameBufferHeight = parseInt(match[2], 10);
        }
    } else if (quality) {
        if (quality === 'phone') {
            frameBufferWidth = Math.min(350, frameBufferWidth);
            frameBufferHeight = Math.min(600, frameBufferHeight);
        } else if (quality === 'low') {
            frameBufferWidth = Math.min(1280, frameBufferWidth);
            frameBufferHeight = Math.min(800, frameBufferHeight);
        } else if (quality === 'medium') {
            frameBufferWidth = Math.min(1920, frameBufferWidth);
            frameBufferHeight = Math.min(1080, frameBufferHeight);
        }
    }

    let stepSizeVisibilityDelay = 0.99;
    if (!params.get('downscale') && quality) {
        let maxPixelsPerFrame;
        if (quality === 'phone') {
            maxPixelsPerFrame = 300 * 450;
            stepSizeVisibilityDelay = 0.8;
        } else if (quality === 'low') {
            maxPixelsPerFrame = 600 * 250;
            stepSizeVisibilityDelay = 0.8;
        } else if (quality === 'medium') {
            maxPixelsPerFrame = 1200 * 640;
            stepSizeVisibilityDelay = 0.95;
        }
        while (frameBufferWidth * frameBufferHeight / lowResFactor > maxPixelsPerFrame) {
            lowResFactor++;
        }
        console.log('Automatically chose a downscaling factor of ' + lowResFactor);
    }
    return { frameBufferWidth, frameBufferHeight, lowResFactor, stepSizeVisibilityDelay };
}

function setupView(width, height) {
    const view = create('div', 'view');
    setDims(view, width, height);
    view.textContent = '';
    const viewSpaceContainer = document.getElementById('viewspacecontainer');
    viewSpaceContainer.style.display = 'inline-block';
    const viewSpace = document.querySelector('.viewspace');
    viewSpace.textContent = '';
    viewSpace.appendChild(view);
    return view;
}

function createCanvas(view) {
    const canvas = document.createElement('canvas');
    // Set the canvas element’s attributes and styles to match the view’s dimensions.
    canvas.width = view.offsetWidth;
    canvas.height = view.offsetHeight;
    canvas.style.width = view.offsetWidth + 'px';
    canvas.style.height = view.offsetHeight + 'px';
    view.appendChild(canvas);
    return canvas;
}


function setupStats(view) {
    const viewSpace = document.querySelector('.viewspace');
    gStats = Stats();
    gStats.dom.style.position = 'absolute';
    viewSpace.appendChild(gStats.dom);
    gSubmodelPanel = gStats.addPanel(new Stats.Panel('SM', '#0ff', '#002'));
    gSubmodelPanel.update(getActiveSubmodelIndex());
    gVMemPanel = gStats.addPanel(new Stats.Panel('MB VRAM', '#0ff', '#002'));
    gVMemPanel.update(0);
    gStats.showPanel(0);
}

async function setupGLContext(canvas, params, overrideParams) {
    const benchmarkParam = params.get('benchmark');
    const gl = canvas.getContext('webgl2', {
        powerPreference: 'high-performance',
        alpha: false,
        stencil: false,
        precision: 'highp',
        depth: false,
        antialias: false,
        desynchronized: false,
        preserveDrawingBuffer: overrideParams.benchmark && benchmarkParam.toLowerCase() === 'quality'
    });
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    if (gl.makeXRCompatible) {
        // IMPORTANT: Await it, but DO NOT assign its result to gl!
        await gl.makeXRCompatible();
    }
    return gl;
}


function renderNextFrame(t) {
    garbageCollectSubmodelPayloads();
    let submodelIndex = positionToSubmodel(gCamera.position, getActiveSubmodelContent().params);
    setCurrentRayMarchScene(submodelIndex);
    submodelIndex = getActiveSubmodelIndex();
    const sceneParams = getSubmodelContent(submodelIndex).params,
        currentSubmodelCenter = submodelCenter(submodelIndex, sceneParams),
        submodelScale = getSubmodelScale(submodelIndex),
        submodelCameraPosition = gCamera.position.clone().sub(currentSubmodelCenter).multiplyScalar(submodelScale),
        shaderUniforms = getRayMarchScene().children[0].material.uniforms;
    for (let i = 0; i < gFrameMult; i++) {
        gSubmodelTransform = submodelTransform(submodelIndex, sceneParams);
        gSubmodelPanel.update(submodelIndex);
        gVMemPanel.update(getCurrentTextureUsageInBytes() / 1e6);
        updateCameraControls();
        if (!gBenchmark) gCamera.updateProjectionMatrix();
        gCamera.updateMatrixWorld();

        ['weightsZero', 'weightsOne', 'weightsTwo'].forEach(key => {
            if (shaderUniforms[key]?.value) shaderUniforms[key].value.dispose();
        });

        ['bias_0', 'bias_1', 'bias_2'].forEach((key, idx) => {
            shaderUniforms[key].value = trilerpDeferredMlpBiases(submodelIndex, idx, submodelCameraPosition);
        });

        ['weightsZero', 'weightsOne', 'weightsTwo'].forEach((key, idx) => {
            shaderUniforms[key].value = trilerpDeferredMlpKernel(submodelIndex, idx, submodelCameraPosition);
        });
        renderProgressively();
    }
    gStats.update();
    (gBenchmark ? benchmarkPerformance(gRenderer.setAnimationLoop) : gRenderer.setAnimationLoop)(renderNextFrame);
}

async function start() {
    await initFromParameters();
    addHandlers();
}
window.onload = start;