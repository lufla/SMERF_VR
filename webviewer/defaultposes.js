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
 * @fileoverview Defines default camera pose for each scene.
 */

/**
 *  Set initial camera pose depending on the scene.
 * @param {string} dirUrl The url where scene files are stored.
 * @param {!THREE.Vector3} submodelCenter The world-space center of the
 *   current submodel.
 */
function setupInitialCameraPose(dirUrl, submodelCenter) {
  console.log('Setting up initial camera pose...');

  // Validate gCamera and gRenderer
  if (!gCamera) {
    console.error('Camera (gCamera) is not initialized!');
    return;
  }
  if (!gRenderer) {
    console.error('Renderer (gRenderer) is not initialized!');
    return;
  }

  // Ensure camera controls are initialized
  if (!gOrbitControls && !gMapControls) {
    console.warn('No camera controls found. Initializing default orbit controls...');
    gOrbitControls = new THREE.OrbitControls(gCamera, gRenderer.domElement);
    gOrbitControls.target.set(0, 0, 0); // Default look-at target
    gOrbitControls.update();
  }

  const initialPoses = {
    'default': {
      'position': [0.0, 0.0, 0.0],
      'lookat': [0.0, 0.0, 1.0],
    },
    'gardenvase': {
      'position': [-1.1869, 0.1899, -0.0492],
      'lookat': [-0.0558, -0.4020, 0.0299],
    },
    'stump': {
      'position': [0.0, 0.4, -0.8],
      'lookat': [0.0, -0.3, 0.0],
    },
    'flowerbed': {
      'position': [-0.0240, 0.1183, 0.9075],
      'lookat': [0.0163, -0.1568, -0.0162],
    },
    'treehill': {
      'position': [-0.7099, 0.1944, 0.3083],
      'lookat': [0.0633, -0.1330, 0.0038],
    },
    'bicycle': {
      'position': [-0.4636, 0.4962, 0.8458],
      'lookat': [0.0172, -0.2465, -0.0779],
    },
    'kitchenlego': {
      'position': [-0.5873, 0.0563, -0.9472],
      'lookat': [0.0718, -0.4020, 0.0485],
    },
    'fulllivingroom': {
      'position': [1.1540, -0.0068, -0.0973],
      'lookat': [-0.0558, -0.4020, 0.0299],
    },
    'kitchencounter': {
      'position': [-0.7007, 0.2256, -0.4694],
      'lookat': [0.1320, -0.4020, 0.0922],
    },
    'officebonsai': {
      'position': [-0.4773, 0.0541, 1.0143],
      'lookat': [0.1197, -0.4043, -0.0198],
    },
  };

  function setCameraPose(pose) {
    gCamera.position.set(
        pose['position'][0] + submodelCenter.x,
        pose['position'][1] + submodelCenter.y,
        pose['position'][2] + submodelCenter.z
    );
    gOrbitControls.target.set(
        pose['lookat'][0] + submodelCenter.x,
        pose['lookat'][1] + submodelCenter.y,
        pose['lookat'][2] + submodelCenter.z
    );
    gOrbitControls.update();
  }

  // Default pose
  setCameraPose(initialPoses['default']);
  for (let sceneName in initialPoses) {
    if (dirUrl.includes(sceneName)) {
      console.log(`Applying camera pose for scene: ${sceneName}`);
      setCameraPose(initialPoses[sceneName]);
      break;
    }
  }

  gCamera.updateProjectionMatrix();
  console.log('Camera pose set successfully.');
}

