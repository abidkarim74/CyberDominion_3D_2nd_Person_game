import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import * as THREE from 'three';

// Run the production camera method without constructing the renderer, city, or DOM.
const source = await readFile(new URL('../lib/neon-city.ts', import.meta.url), 'utf8');
const ast = ts.createSourceFile('neon-city.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const city = ast.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === 'NeonCityGame');
const method = city?.members.find(node => ts.isMethodDeclaration(node) && node.name.getText(ast) === 'updateCamera');
const collision = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'cameraWallEntry');
assert.ok(method && collision, 'The production person camera and collision helper are present');
const compiled = ts.transpileModule(`${collision.getText(ast)}\nclass CameraHarness { ${method.getText(ast)} }`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;
const CameraHarness = new Function('THREE', `${compiled}\nreturn CameraHarness;`)(THREE);

function createHarness(walls = [], ground = () => 0) {
  const game = new CameraHarness();
  Object.assign(game, {
    camera: new THREE.PerspectiveCamera(66, 16 / 9, .1, 6500),
    cameraView: 'person',
    cameraUp: new THREE.Vector3(0, 1, 0),
    cameraAnchor: new THREE.Vector3(),
    cameraTravel: new THREE.Vector3(),
    cameraTarget: new THREE.Vector3(),
    desiredCamera: new THREE.Vector3(),
    personCameraAnchor: new THREE.Vector3(),
    personCameraTravel: new THREE.Vector3(),
    personCameraTarget: new THREE.Vector3(),
    personCameraYaw: 0,
    personCameraElevation: .22,
    personCameraDistance: 4.5,
    person: { position: new THREE.Vector3() },
    car: new THREE.Group(),
    velocity: new THREE.Vector3(),
    forward: new THREE.Vector3(),
    right: new THREE.Vector3(),
    roadSnow: { sample: (x, z) => ({ height: ground(x, z) }) },
    cameraCollisionWorld: { query: () => walls },
    reflections: { invalidate() {} },
    shadowPosition: new THREE.Vector3(),
    shadowFrame: 0,
  });
  game.updateCamera(0, true);
  return game;
}

const tolerance = 1e-9;
function near(actual, expected, message, epsilon = tolerance) {
  assert.ok(Math.abs(actual - expected) <= epsilon, `${message}: ${actual} versus ${expected}`);
}
function finite(game) {
  assert.ok([...game.camera.position.toArray(), ...game.camera.quaternion.toArray(),
    ...game.cameraTarget.toArray(), ...game.desiredCamera.toArray()].every(Number.isFinite),
  'Camera position, target, and rotation remain finite');
}
function pitch(game) {
  const boom = game.camera.position.clone().sub(game.cameraTarget);
  return Math.atan2(boom.y, Math.hypot(boom.x, boom.z));
}
function expectedBoom(game) {
  const distance = game.personCameraDistance * Math.max(1, .82 / game.camera.aspect);
  return new THREE.Vector3(Math.sin(game.personCameraYaw) * Math.cos(game.personCameraElevation) * distance,
    Math.sin(game.personCameraElevation) * distance,
    Math.cos(game.personCameraYaw) * Math.cos(game.personCameraElevation) * distance);
}
function clearSegment(from, to, walls, message) {
  const direction = to.clone().sub(from), distance = direction.length();
  if (distance < 1e-12) return;
  const ray = new THREE.Ray(from, direction.divideScalar(distance));
  for (const wall of walls) {
    const bounds = new THREE.Box3(
      new THREE.Vector3(wall.x - wall.hx - .2, (wall.minY ?? 0) - .2, wall.z - wall.hz - .2),
      new THREE.Vector3(wall.x + wall.hx + .2, (wall.maxY ?? 1e6) + .2, wall.z + wall.hz + .2));
    const hit = ray.intersectBox(bounds, new THREE.Vector3());
    assert.ok(!hit || hit.distanceTo(from) > distance - 1e-8, message);
  }
}

const report = { movement: [], terrain: {}, controls: {}, collisions: {}, snap: {} };
const cadences = [
  { label: '30 Hz', deltas: [1 / 30] },
  { label: '60 Hz', deltas: [1 / 60] },
  { label: '144 Hz', deltas: [1 / 144] },
  { label: 'uneven 30-240 Hz', deltas: [1 / 30, 1 / 144, 1 / 60, 1 / 240, 1 / 90] },
];
for (const cadence of cadences) {
  const game = createHarness(), boom = game.camera.position.clone().sub(game.cameraTarget);
  const velocity = new THREE.Vector3(), command = new THREE.Vector3(), change = new THREE.Vector3();
  const initialPitch = pitch(game), rotation = game.camera.quaternion.clone();
  let elapsed = 0, frame = 0, maximumBoomError = 0, maximumPitchError = 0;
  while (elapsed < 7) {
    const dt = cadence.deltas[frame++ % cadence.deltas.length];
    // Walk, accelerate to a run, stop, reverse, turn diagonally, and stop again.
    if (elapsed < 1.2) command.set(0, 0, -1.65);
    else if (elapsed < 2.4) command.set(0, 0, -4.3);
    else if (elapsed < 3.1) command.set(0, 0, 0);
    else if (elapsed < 4.4) command.set(0, 0, 4.3);
    else if (elapsed < 5.8) command.set(-1, 0, -1).setLength(4.3);
    else command.set(0, 0, 0);
    change.copy(command).sub(velocity).clampLength(0, 7.5 * dt);
    velocity.add(change);
    game.person.position.addScaledVector(velocity, dt);
    game.updateCamera(dt);
    finite(game);
    maximumBoomError = Math.max(maximumBoomError, game.camera.position.clone().sub(game.cameraTarget).distanceTo(boom));
    maximumPitchError = Math.max(maximumPitchError, Math.abs(pitch(game) - initialPitch));
    assert.ok(rotation.angleTo(game.camera.quaternion) < 1e-7, 'Locomotion does not nod or turn the camera');
    elapsed += dt;
  }
  assert.ok(maximumBoomError < tolerance, `${cadence.label}: walking and running preserve the camera boom`);
  assert.ok(maximumPitchError < tolerance, `${cadence.label}: starts, stops, and reversals preserve camera pitch`);
  const stopped = game.camera.position.clone();
  for (let i = 0; i < 120; i++) game.updateCamera(1 / 60);
  near(stopped.distanceTo(game.camera.position), 0, 'Stopping leaves no residual camera drift');
  report.movement.push({ cadence: cadence.label, maximumBoomError, maximumPitchError });
}

{
  const game = createHarness(), initialPitch = pitch(game);
  let largestHeightStep = 0, largestPitchError = 0;
  for (const terrainHeight of [.24, -.08, .12]) {
    game.person.position.y = terrainHeight;
    const destination = terrainHeight + 1.14;
    const initialTarget = game.cameraTarget.y;
    const sign = Math.sign(destination - initialTarget);
    for (let frame = 0; frame < 180; frame++) {
      const previous = game.cameraTarget.y;
      game.person.position.z -= 1.65 / 60;
      game.updateCamera(1 / 60);
      const step = game.cameraTarget.y - previous;
      largestHeightStep = Math.max(largestHeightStep, Math.abs(step));
      largestPitchError = Math.max(largestPitchError, Math.abs(pitch(game) - initialPitch));
      assert.ok(sign * step >= -tolerance && sign * (destination - game.cameraTarget.y) >= -tolerance,
        'Terrain height follows gradually without overshoot');
      if (frame === 0) assert.ok(Math.abs(step) < Math.abs(destination - initialTarget) * .15,
        'A terrain height discontinuity cannot jerk the camera target');
      finite(game);
    }
    near(game.cameraTarget.y, destination, 'Camera settles onto the new terrain height', .00001);
  }
  assert.ok(largestPitchError < tolerance, 'Terrain following preserves pitch while the shared target rises and falls');
  report.terrain = { largestHeightStep, largestPitchError };

  game.person.position.set(40, .32, -80);
  game.updateCamera(0, true);
  near(game.cameraTarget.y, 1.46, 'A snap immediately resets the terrain target');
  near(game.personCameraAnchor.distanceTo(game.person.position), 0, 'A snap resets the movement anchor');
  near(game.camera.position.clone().sub(game.cameraTarget).distanceTo(expectedBoom(game)), 0, 'A snap uses the new camera boom');
  const resetCamera = game.camera.position.clone();
  game.updateCamera(1 / 60);
  near(resetCamera.distanceTo(game.camera.position), 0, 'The frame after a snap has no stale movement');
  report.snap = { targetHeight: game.cameraTarget.y, position: game.camera.position.toArray() };
}

{
  const game = createHarness(), before = game.camera.position.clone();
  game.personCameraYaw = .85;
  game.personCameraElevation = .48;
  game.personCameraDistance = 6.8;
  game.updateCamera(1 / 60);
  const destination = game.cameraTarget.clone().add(expectedBoom(game));
  assert.ok(game.camera.position.distanceTo(before) > .01, 'Orbit and zoom respond immediately');
  assert.ok(game.camera.position.distanceTo(destination) > .1, 'Orbit and zoom keep their gradual response');
  for (let i = 0; i < 120; i++) game.updateCamera(1 / 60);
  near(game.camera.position.distanceTo(destination), 0, 'Orbit and zoom settle at the requested view');
  game.camera.aspect = .5;
  game.updateCamera(0, true);
  near(game.camera.position.clone().sub(game.cameraTarget).length(), 6.8 * .82 / .5,
    'Portrait framing retains its wider camera distance');
  report.controls = { orbitYaw: game.personCameraYaw, zoomDistance: game.personCameraDistance, portraitDistance: expectedBoom(game).length() };
}

{
  const walls = [
    { x: 0, z: 3, hx: 8, hz: .25, minY: 0, maxY: 8 },
    { x: 3, z: 0, hx: .25, hz: 8, minY: 0, maxY: 8 },
  ];
  const game = createHarness(walls);
  assert.ok(game.camera.position.distanceTo(game.cameraTarget) < game.personCameraDistance - 1,
    'The desired camera pulls in before a nearby wall');
  let checkedFrames = 0;
  for (let frame = 0; frame < 180; frame++) {
    game.person.position.x = Math.sin(frame / 40) * .3;
    game.person.position.z = Math.cos(frame / 40) * .3;
    game.personCameraYaw = frame / 180 * Math.PI * 2;
    game.updateCamera(1 / 60);
    clearSegment(game.cameraTarget, game.desiredCamera, walls, 'The desired orbit stays clear of walls and corners');
    clearSegment(game.cameraTarget, game.camera.position, walls, 'The actual interpolated orbit stays clear of walls and corners');
    finite(game);
    checkedFrames++;
  }
  // The endpoint is clear, but an old camera pose is beyond the wall. This
  // specifically exercises the second collision pass after interpolation.
  game.person.position.set(0, 0, 0);
  game.personCameraYaw = Math.PI;
  game.updateCamera(0, true);
  game.camera.position.set(0, 2, 6);
  game.updateCamera(1 / 240);
  clearSegment(game.cameraTarget, game.desiredCamera, walls, 'The forced-corner destination is clear');
  clearSegment(game.cameraTarget, game.camera.position, walls, 'The actual collision pass corrects an obstructed interpolated pose');
  report.collisions = { checkedFrames, correctedDistance: game.camera.position.distanceTo(game.cameraTarget) };
}

{
  const floor = .55, game = createHarness([], () => floor);
  game.person.position.y = floor;
  game.personCameraElevation = -.10;
  game.personCameraDistance = 7;
  game.updateCamera(0, true);
  for (let frame = 0; frame < 120; frame++) {
    game.person.position.x += 4.3 / 60;
    game.updateCamera(1 / 60);
    finite(game);
    assert.ok(game.camera.position.y >= floor + .22 - tolerance, 'The low camera clears the snow surface');
  }
  report.collisions.lowElevationHeight = game.camera.position.y;
}

console.log(JSON.stringify({ passed: true, ...report }, null, 2));
