const LOCK = 1.18;
const FREQUENCY = 15;
const MAX_SPEED = 5.6;
const MAX_ACCELERATION = 85;
const STEP = 1 / 240;

type SteeringState = { angle: number; velocity: number };
const clamp = (value: number, minimum: number, maximum: number) => Math.max(minimum, Math.min(maximum, value));

/** A damped steering column; vehicle steering input remains immediate. */
export class CockpitSteering {
  private readonly state: SteeringState = { angle: 0, velocity: 0 };
  private readonly sample: SteeringState = { angle: 0, velocity: 0 };
  private remainder = 0;
  private target = 0;

  get angle() { return this.sample.angle; }
  get velocity() { return this.sample.velocity; }

  update(delta: number, targetNormalized: number) {
    if (!Number.isFinite(delta) || delta <= 0) return this.angle;
    const target = (Number.isFinite(targetNormalized) ? clamp(targetNormalized, -1, 1) : 0) * LOCK;
    if (target !== this.target) {
      // Commit the last displayed fraction before changing direction. The new
      // target cannot rewrite elapsed time or cause a hand/wheel discontinuity.
      this.state.angle = this.sample.angle; this.state.velocity = this.sample.velocity;
      this.remainder = 0; this.target = target;
    }
    // Ignore suspended-tab backlog rather than applying a sudden full-lock turn.
    this.remainder += Math.min(delta, .1);
    const steps = Math.floor((this.remainder + 1e-12) / STEP);
    for (let i = 0; i < steps; i++) this.advance(this.state, STEP);
    this.remainder = Math.max(0, this.remainder - steps * STEP);
    this.sample.angle = this.state.angle; this.sample.velocity = this.state.velocity;
    // Preview the remaining fraction without feeding it back into the fixed
    // simulation. High-refresh displays do not inherit 240 Hz staircase motion.
    if (this.remainder > 1e-12) this.advance(this.sample, this.remainder);
    return this.angle;
  }

  reset() {
    this.state.angle = this.sample.angle = 0;
    this.state.velocity = this.sample.velocity = 0;
    this.remainder = this.target = 0;
  }

  private advance(state: SteeringState, delta: number) {
    // Damping = 2 * frequency is critical damping. Limits keep the first key
    // press and left/right reversals within a plausible human steering rate.
    const acceleration = clamp(FREQUENCY * FREQUENCY * (this.target - state.angle) -
      2 * FREQUENCY * state.velocity, -MAX_ACCELERATION, MAX_ACCELERATION);
    const nextVelocity = clamp(state.velocity + acceleration * delta, -MAX_SPEED, MAX_SPEED);
    state.angle = clamp(state.angle + (state.velocity + nextVelocity) * .5 * delta, -LOCK, LOCK);
    state.velocity = nextVelocity;
    if (Math.abs(state.angle - this.target) < 1e-6 && Math.abs(state.velocity) < 1e-5) {
      state.angle = this.target; state.velocity = 0;
    }
  }
}
