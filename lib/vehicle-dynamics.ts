import type * as THREE from 'three';
import type { SnowContact } from './snow-surface';

export const MAX_SPEED_KMH = 220;
export const NITRO_SPEED_MULTIPLIER = 1.6;
export const MAX_NITRO_SPEED_KMH = MAX_SPEED_KMH * NITRO_SPEED_MULTIPLIER;
export const PLAYER_STEERING_ASSIST = 1.45;
const MASS = 1950, GRAVITY = 9.81, WHEELBASE = 2.86, AXLE = WHEELBASE / 2;
const CG_HEIGHT = .52, YAW_INERTIA = 3100, CORNERING_STIFFNESS = 105_000, REAR_CORNERING_BIAS = 1.12;
const ROAD_TIRE_GRIP_GAIN = .4;
export const WHEEL_CONTACTS = [
  { x: -.895, z: -1.43 }, { x: -.895, z: 1.43 },
  { x: .895, z: -1.43 }, { x: .895, z: 1.43 },
] as const;
export type VehicleMotion = {
  position: THREE.Vector3; velocity: THREE.Vector3;
  yaw: number; yawRate: number; steeringAngle: number;
  acceleration: number; grip: number; snow: number;
};
export type VehicleInput = {
  throttle: number; steer: number; handbrake: boolean; boost: boolean;
  /** A separate pedal lets the controller hold a stop without engaging reverse. */
  brake?: number;
  /** Road turn-rate multiplier for player controls; traffic keeps its calibrated default. */
  steeringAssist?: number;
  /** Fixed activation-speed target in m/s; never multiply the speed every frame. */
  boostTargetSpeed?: number;
};
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const tireGrip = (surfaceGrip: number) => surfaceGrip * (1 + ROAD_TIRE_GRIP_GAIN * clamp((surfaceGrip - .32) / .63, 0, 1));

/** Two-axle rigid-body model in SI units: tire slip, load transfer and combined friction. */
export function stepVehicle(motion: VehicleMotion, input: VehicleInput, contacts: readonly SnowContact[], dt: number) {
  if (dt <= 0) return;
  const { velocity, position } = motion;
  const fx = -Math.sin(motion.yaw), fz = -Math.cos(motion.yaw);
  // Positive lateral velocity and yaw both point into a left turn.
  const lx = -Math.cos(motion.yaw), lz = Math.sin(motion.yaw);
  const longitudinal = velocity.x * fx + velocity.z * fz;
  const lateral = velocity.x * lx + velocity.z * lz;
  const speed = Math.hypot(longitudinal, lateral);
  const frontSurfaceGrip = (contacts[0].grip + contacts[2].grip) / 2;
  const rearSurfaceGrip = (contacts[1].grip + contacts[3].grip) / 2;
  const grip = (frontSurfaceGrip + rearSurfaceGrip) / 2;
  // High-grip road tires give keyboard turns and stops more authority. Blend
  // the gain per axle so snow and mixed surfaces retain their reduced traction.
  const frontGrip = tireGrip(frontSurfaceGrip), rearGrip = tireGrip(rearSurfaceGrip);
  const snow = (contacts[0].coverage + contacts[1].coverage + contacts[2].coverage + contacts[3].coverage) / 4;
  const depth = (contacts[0].depth + contacts[1].depth + contacts[2].depth + contacts[3].depth) / 4;
  motion.grip = grip; motion.snow = snow;
  // Match available grip while allowing the extra wheel angle needed for tire
  // deflection. A purely geometric limit made the car understeer at road speed.
  const pedal = clamp(input.brake ?? (input.throttle < 0 && longitudinal > .15 || input.throttle > 0 && longitudinal < -.15 ? 1 : 0), 0, 1);
  const roadGrip = clamp((Math.min(frontSurfaceGrip, rearSurfaceGrip) - .32) / .63, 0, 1);
  // Keep useful road turn authority as speed rises, including while braking.
  // Fade the player gain in above parking speed. Apply it to the available
  // turn radius and braking budget together, keeping tight brake turns stable.
  const playerSteeringAssist = clamp(input.steeringAssist ?? 1, 1, 2);
  const assistedForward = playerSteeringAssist > 1 && longitudinal > 0;
  const playerSteeringGain = 1 + (playerSteeringAssist - 1) * roadGrip * clamp((longitudinal - 6) / 16, 0, 1);
  const roadSteeringGain = !input.handbrake ? (1 + 1.3 * roadGrip * clamp((Math.abs(longitudinal) - 8) / 35, 0, 1)) * playerSteeringGain : 1;
  const tireCompliance = MASS * .5 / (CORNERING_STIFFNESS * clamp((frontGrip + rearGrip) / (2 * .95), .25, 1.4)) * (1 - 1 / REAR_CORNERING_BIAS);
  const turningScale = WHEELBASE + longitudinal * longitudinal * tireCompliance * (pedal > 0 ? roadGrip : 1);
  // Add road-speed authority progressively so sustained low-speed turns stay planted.
  const turnAuthority = pedal > 0 ? .46 + .36 * roadGrip : .94 + .42 * roadGrip * clamp((Math.abs(longitudinal) - 10) / 10, 0, 1);
  const steeringLimit = Math.atan(Math.min(frontGrip, rearGrip) * GRAVITY * turningScale * turnAuthority * roadSteeringGain / Math.max(1, longitudinal * longitudinal));
  // Avoid an abrupt full-lock turn as a service-brake stop reaches walking speed.
  const mechanicalSteer = (pedal > 0 && !input.handbrake ? .4 + .36 * roadGrip : .82) / (1 + Math.abs(longitudinal) / 65);
  const targetSteer = input.steer * (input.handbrake ? mechanicalSteer : Math.min(mechanicalSteer, steeringLimit));
  // Quicker wheel movement makes taps and direction changes useful immediately.
  const steerResponse = input.steer === 0 || input.steer * motion.steeringAngle < 0 ? 180 : 140;
  motion.steeringAngle += (targetSteer - motion.steeringAngle) * (1 - Math.exp(-dt * steerResponse));
  const steer = motion.steeringAngle, cosine = Math.cos(steer), sine = Math.sin(steer);
  const braking = pedal > 0 || input.handbrake;
  // Deceleration loads the front axle and unloads the rear; tire forces stay within mu*N.
  const transfer = clamp(-motion.acceleration * MASS * CG_HEIGHT / WHEELBASE, -MASS * GRAVITY * .3, MASS * GRAVITY * .3);
  const frontLoad = MASS * GRAVITY * .5 + transfer, rearLoad = MASS * GRAVITY - frontLoad;
  const frontLimit = Math.max(0, frontGrip * frontLoad), rearLimit = Math.max(0, rearGrip * rearLoad);
  // Road assistance supplies extra turn authority; allocate the braking tire
  // budget against its supported radius so a sharp turn still slows the car.
  const assistedBudget = pedal > 0 ? roadSteeringGain : 1;
  const lateralDemand = clamp(longitudinal * longitudinal * Math.abs(Math.tan(steer)) / (turningScale * Math.max(.1, Math.min(frontGrip, rearGrip)) * GRAVITY * assistedBudget), 0, .94);
  const corneringReserve = Math.sqrt(1 - lateralDemand * lateralDemand);
  let frontX = 0, rearX = 0;
  if (!braking && input.throttle !== 0 && (input.boost || input.throttle < 0 || longitudinal < MAX_SPEED_KMH / 3.6)) {
    const drive = (input.throttle > 0 ? (input.boost ? 10.4 : 8.7) / (1 + Math.max(0, longitudinal - 14) / (input.boost ? 60 : 37)) : -3.8) * Math.abs(input.throttle) * MASS;
    // AWD shares demand by load, reserving some tire authority for steering.
    frontX = clamp(drive * frontLoad / (MASS * GRAVITY), -frontLimit * corneringReserve, frontLimit * corneringReserve);
    rearX = clamp(drive * rearLoad / (MASS * GRAVITY), -rearLimit * corneringReserve, rearLimit * corneringReserve);
  }
  const direction = Math.sign(longitudinal);
  const frontLateral = lateral + AXLE * motion.yawRate, rearLateral = lateral - AXLE * motion.yawRate;
  const frontWheelX = longitudinal * cosine + frontLateral * sine;
  const frontWheelY = frontLateral * cosine - longitudinal * sine;
  if (pedal > 0) {
    const demand = MASS * 15.5 * pedal;
    // ABS distributes brake demand by current axle load instead of wasting
    // front traction with a fixed split as braking unloads the rear axle.
    // Reserve lateral force for steered wheels. Oppose wheel-contact motion,
    // including sideways slip, so holding the brake cannot feed a low-speed spin.
    const brakeGrip = .97 * corneringReserve * cosine * cosine;
    frontX = -Math.sign(frontWheelX) * Math.min(demand * frontLoad / (MASS * GRAVITY), frontLimit * brakeGrip);
    rearX = -direction * Math.min(demand * rearLoad / (MASS * GRAVITY), rearLimit * brakeGrip);
  }
  if (input.handbrake) {
    // Drift brake blends front braking with locked rear wheels and overrides the accelerator.
    frontX = -direction * Math.max(Math.abs(frontX), frontLimit * .80);
  }
  const frontSlip = Math.atan2(frontWheelY, Math.max(2, Math.abs(frontWheelX)));
  const rearSlip = Math.atan2(rearLateral, Math.max(2, Math.abs(longitudinal)));
  // At full wheel lock, rear contact motion includes the normal cornering arc.
  // Player stability should fade for a sideways body slide, not that rolling arc.
  const stabilitySlip = assistedForward
    ? Math.atan2(lateral, Math.max(2, Math.abs(longitudinal))) : rearSlip;
  const frontBudget = Math.sqrt(Math.max(0, frontLimit * frontLimit - frontX * frontX));
  const rearBudget = Math.sqrt(Math.max(0, rearLimit * rearLimit - rearX * rearX));
  // Cornering stiffness follows axle load. Keeping the unloaded rear just as
  // stiff as the loaded front made service-brake turns break the rear loose.
  const frontStiffness = CORNERING_STIFFNESS * clamp(frontGrip / .95, .25, 1.4) * Math.pow(frontLoad / (MASS * GRAVITY * .5), .8);
  const rearStiffness = CORNERING_STIFFNESS * REAR_CORNERING_BIAS * clamp(rearGrip / .95, .25, 1.4) * Math.pow(rearLoad / (MASS * GRAVITY * .5), .8);
  let frontY = clamp(-frontStiffness * frontSlip, -frontBudget, frontBudget);
  let rearY = clamp(-rearStiffness * rearSlip, -rearBudget, rearBudget);
  if (input.handbrake) {
    // Locked-tire sliding friction opposes contact-patch velocity, allowing the tail to step out.
    const contactSpeed = Math.hypot(longitudinal, rearLateral);
    if (contactSpeed > .001) {
      rearX = -rearLimit * .88 * longitudinal / contactSpeed;
      rearY = -rearLimit * .88 * rearLateral / contactSpeed;
    }
  }
  const lowSpeed = Math.min(1, speed / 2);
  frontY *= lowSpeed; rearY *= lowSpeed;
  const frontBodyX = frontX * cosine - frontY * sine;
  const frontBodyY = frontX * sine + frontY * cosine;
  const grade = clamp((contacts[0].height + contacts[2].height - contacts[1].height - contacts[3].height) / (2 * WHEELBASE), -.3, .3);
  const slope = clamp((contacts[2].height + contacts[3].height - contacts[0].height - contacts[1].height) / (2 * 1.79), -.3, .3);
  const acceleration = (frontBodyX + rearX) / MASS;
  const sideAcceleration = (frontBodyY + rearY) / MASS + slope * GRAVITY;
  velocity.x += (fx * (acceleration - grade * GRAVITY) + lx * sideAcceleration) * dt;
  velocity.z += (fz * (acceleration - grade * GRAVITY) + lz * sideAcceleration) * dt;
  motion.acceleration = acceleration;
  motion.yawRate += AXLE * (frontBodyY - rearY) / YAW_INERTIA * dt;
  // Give moving road steering a prompt rolling response instead of waiting for
  // both axles to build yaw. Tire forces still steer the momentum; snow, rear
  // slides and the handbrake retain the rigid-body response.
  if (!input.handbrake && speed > 2) {
    const rearRolling = clamp(1 - Math.abs(stabilitySlip) / .35, 0, 1);
    // Keyboard corrections need to build yaw within the same short input, even
    // under throttle and settle promptly after release. Service-brake turns
    // keep a quick rolling response while reserving grip for deceleration.
    const response = (pedal > 0 ? 42 * .65 + 92.7 * roadGrip : input.steer === 0 ? 180 : 140) * roadGrip * rearRolling * clamp((speed - 2) / 2, 0, 1);
    // ABS uses some of the tires' cornering authority. Account for that tire
    // deflection before asking the body to yaw faster than its momentum can turn.
    const rollingScale = turningScale + (pedal > 0 ? longitudinal * longitudinal * tireCompliance * 3 * (1 - roadGrip) : 0);
    const rollingYawRate = longitudinal * Math.tan(steer) / rollingScale;
    motion.yawRate += (rollingYawRate - motion.yawRate) * (1 - Math.exp(-dt * response));
  }
  // Blend to a stable rolling constraint at walking speed; never rotate a stationary car.
  if (speed < 2) motion.yawRate += (longitudinal / WHEELBASE * Math.tan(steer) - motion.yawRate) * (1 - Math.exp(-dt * 12 * (1 - lowSpeed)));
  motion.yaw += motion.yawRate * dt;
  if (!input.handbrake && speed > 2 && roadGrip > 0) {
    // Redirect momentum as well as the body. Rotate velocity without changing
    // its magnitude, keeping short steering taps immediate and energy-neutral.
    // Fade out for a sliding rear axle so an actual drift still needs recovery.
    const rolling = clamp(1 - Math.abs(stabilitySlip) / .35, 0, 1);
    const travelYaw = longitudinal >= 0 ? Math.atan2(-velocity.x, -velocity.z) : Math.atan2(velocity.x, velocity.z);
    const error = Math.atan2(Math.sin(motion.yaw - travelYaw), Math.cos(motion.yaw - travelYaw));
    // Keep an assisted corner planted as coasting brings it down to low speed.
    const alignSlowTurn = pedal > 0 || assistedForward;
    const alignmentRange = assistedForward ? 2 : pedal > 0 ? 4 : 6;
    const correction = error * (1 - Math.exp(-dt * 64 * roadGrip * rolling * clamp((speed - (alignSlowTurn ? 2 : 4)) / alignmentRange, 0, 1)));
    const c = Math.cos(correction), s = Math.sin(correction), vx = velocity.x;
    velocity.x = vx * c + velocity.z * s;
    velocity.z = -vx * s + velocity.z * c;
  }
  const magnitude = Math.hypot(velocity.x, velocity.z);
  const resistance = .13 + snow * .48 + depth * 2.4 + .0009 * magnitude * magnitude;
  const keep = magnitude > 0 ? Math.max(0, 1 - resistance * dt / magnitude) : 0;
  velocity.x *= keep; velocity.z *= keep;
  // Brake impulses must not cross zero into reverse or produce standstill jitter.
  const nextLongitudinal = velocity.x * fx + velocity.z * fz;
  if (braking && (speed < .3 || direction !== 0 && nextLongitudinal * direction < 0)) {
    velocity.x -= fx * nextLongitudinal; velocity.z -= fz * nextLongitudinal;
    if (Math.hypot(velocity.x, velocity.z) < .3) { velocity.x = 0; velocity.z = 0; motion.yawRate = 0; }
  }
  const boostTarget = input.boost && Number.isFinite(input.boostTargetSpeed)
    ? clamp(input.boostTargetSpeed ?? 0, 0, MAX_NITRO_SPEED_KMH / 3.6) : 0;
  if (boostTarget > 0 && !braking && longitudinal >= 0) {
    // A frame-rate-independent surge reaches >99% of the extra speed in .4 s.
    // Preserve the travel direction so steering and tire slip remain continuous.
    const current = Math.hypot(velocity.x, velocity.z);
    const gain = Math.max(0, boostTarget - current) * (1 - Math.exp(-dt * 12));
    if (current > .001) { velocity.x *= 1 + gain / current; velocity.z *= 1 + gain / current; }
    else { velocity.x += fx * gain; velocity.z += fz * gain; }
    motion.acceleration += gain / dt;
  }
  const finalSpeed = Math.hypot(velocity.x, velocity.z);
  // A tail-out drift can point the car against its momentum; that does not select reverse gear.
  // Keep existing momentum when nitro expires: drag and brakes slow the car
  // naturally instead of abruptly cutting 352 km/h back to 220 in one frame.
  const limit = input.throttle < 0 && !braking ? 15
    : boostTarget > 0 ? MAX_NITRO_SPEED_KMH / 3.6 : Math.max(MAX_SPEED_KMH / 3.6, speed);
  if (finalSpeed > limit) { velocity.x *= limit / finalSpeed; velocity.z *= limit / finalSpeed; }
  position.x += velocity.x * dt; position.z += velocity.z * dt;
}
