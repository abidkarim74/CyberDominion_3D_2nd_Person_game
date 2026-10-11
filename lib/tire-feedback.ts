import { CITY_EDGE, ROAD_WIDTH, roadDistance } from './city-layout';
import type { SnowContact } from './snow-surface';

const smooth = (value: number) => {
  const t = Math.max(0, Math.min(1, value));
  return t * t * (3 - 2 * t);
};

export function isAsphaltContact(contact: SnowContact) {
  return Math.max(Math.abs(contact.x), Math.abs(contact.z)) <= CITY_EDGE &&
    Math.min(roadDistance(contact.x), roadDistance(contact.z)) < ROAD_WIDTH / 2 - .18 &&
    contact.height < .05 && contact.coverage < .25;
}

/** Shared wheel feedback keeps road rubber and audible tire scrub in sync. */
export function createTireFeedback() {
  let hardStop = false;
  const wheels = [0, 0, 0, 0];
  const feedback = { wheels, squeal: 0 };
  return {
    update(speed: number, lateralSpeed: number, brake: number, handbrake: boolean, contacts: readonly SnowContact[]) {
      // Latch a hard stop above 60 km/h, so its marks continue as speed falls.
      if (brake < .35 || speed < .5) hardStop = false;
      else if (brake >= .65 && speed >= 60 / 3.6) hardStop = true;
      const moving = smooth((speed - .5) / 4);
      const braking = hardStop ? brake * (.45 + .45 * Math.min(1, speed / 40)) * moving : 0;
      const sliding = smooth((lateralSpeed - Math.max(1.8, speed * .12)) / 3) * moving;
      let total = 0;
      for (let i = 0; i < wheels.length; i++) {
        const rear = i % 2 === 1;
        const locked = handbrake ? (rear ? .95 : .28) * moving : 0;
        wheels[i] = isAsphaltContact(contacts[i]) ? Math.max(braking * (rear ? .85 : 1), sliding, locked) : 0;
        total += wheels[i];
      }
      feedback.squeal = total / wheels.length;
      return feedback;
    },
    reset() { hardStop = false; wheels.fill(0); feedback.squeal = 0; },
  };
}
