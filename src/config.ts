import type { CommandedLevel } from './domain/level.ts';
import type { MeasurementKind } from './domain/measurement.ts';

// The sole source of truth for topology. There is no `rooms` or `sensors` table:
// config gives literal union types for ids, git records *why* a sensor moved in
// a way a database row never could, and a mirrored table would need a startup
// reconciliation step that can drift.
//
// Two conventions keep that safe for historical data:
//   1. Sensors are never deleted. Decommissioning takes the sensor out of the
//      precedence lists and sets isActive: false; the entry itself stays forever,
//      so old readings stay interpretable.
//   2. Relocating a sensor means a NEW sensor id. Editing the room of an existing
//      id would retroactively relabel every reading it ever produced.

export const ROOM_IDS = ['living_room', 'kids_room', 'bedroom'] as const;
export type RoomId = (typeof ROOM_IDS)[number];

export interface SensorConfig {
  readonly room: RoomId;
  readonly kinds: readonly MeasurementKind[];

  // Descriptive, and reported by /api/sensors so a client can tell a retired
  // instrument from a live one. It does *not* decide whether the instrument is
  // consulted — the precedence lists below are the only thing that does.
  //
  // Two switches for one question is one too many, and this was the weaker of
  // the two: the ranked list also says in what *order*, so it has to be edited
  // anyway. A test asserts the two never disagree.
  readonly isActive: boolean;
  // Per-source, never global. This is load-bearing: one staleness window cannot
  // judge a 30-second-old Tado reading and a 6-minute-old Netatmo reading, and
  // getting it wrong in either direction is a safety bug.
  readonly freshnessWindow: Temporal.Duration;
}

// Polled every 60 s; one missed poll is tolerated, two is not.
const TADO_FRESHNESS = Temporal.Duration.from({ seconds: 90 });
// Netatmo refreshes on their side every 7-8 minutes, so this has to cover two
// of those before we call the instrument dead. Polling faster gains nothing.
const NETATMO_FRESHNESS = Temporal.Duration.from({ minutes: 15 });

export const SENSORS = {
  living_room_tado: {
    room: 'living_room',
    kinds: ['temperature', 'humidity'],
    isActive: true,
    freshnessWindow: TADO_FRESHNESS,
  },
  // Two radiators, two valves. They disagree by around a degree because they sit
  // at different ends of the room, and a mean would describe neither.
  kids_room_tado_left: {
    room: 'kids_room',
    kinds: ['temperature', 'humidity'],
    isActive: true,
    freshnessWindow: TADO_FRESHNESS,
  },
  kids_room_tado_right: {
    room: 'kids_room',
    kinds: ['temperature', 'humidity'],
    isActive: true,
    freshnessWindow: TADO_FRESHNESS,
  },
  bedroom_tado: {
    room: 'bedroom',
    kinds: ['temperature', 'humidity'],
    isActive: true,
    freshnessWindow: TADO_FRESHNESS,
  },
  // The only CO2 instrument in the flat today, which makes it the only thing
  // between the controller and the safe default.
  bedroom_netatmo: {
    room: 'bedroom',
    kinds: ['temperature', 'humidity', 'co2'],
    isActive: true,
    freshnessWindow: NETATMO_FRESHNESS,
  },
} as const satisfies Record<string, SensorConfig>;

export type SensorId = keyof typeof SENSORS;

// The runtime companion of SensorId, for the places that must iterate every
// sensor once the types are stripped. `Object.keys` forgets literal key types
// by design (an object may carry extra keys at runtime); this one cannot,
// because SENSORS is the closed `as const` object the type was derived from —
// the assertion restates a fact the compiler just proved.
export const SENSOR_IDS = Object.keys(SENSORS) as readonly SensorId[];

/**
 * Ordered per (room, kind): the first *fresh* source wins, and two sources are
 * never averaged. Trust is what an order encodes, and it only matters while
 * there is a choice between live instruments.
 *
 * A kind with no entry for a room is genuinely absent — living-room CO2 has no
 * instrument until the SEN66 arrives, and `missing` is the honest answer.
 */
export const PRECEDENCE: Record<RoomId, Partial<Record<MeasurementKind, readonly SensorId[]>>> = {
  living_room: {
    temperature: ['living_room_tado'],
    humidity: ['living_room_tado'],
  },
  kids_room: {
    // Which valve leads is a preference, not a measurement. Fixed and visible
    // beats averaged; revisit once there is a reason to prefer the other.
    temperature: ['kids_room_tado_left', 'kids_room_tado_right'],
    humidity: ['kids_room_tado_left', 'kids_room_tado_right'],
  },
  bedroom: {
    // The valve head sits on the radiator and reads warm, so the Home Coach
    // leads for the two kinds both instruments report.
    temperature: ['bedroom_netatmo', 'bedroom_tado'],
    humidity: ['bedroom_netatmo', 'bedroom_tado'],
    // When the SEN66 arrives it goes in front here and nothing else changes.
    co2: ['bedroom_netatmo'],
  },
};

export interface ControlConfig {
  readonly bandLowPpm: number;
  readonly bandHighPpm: number;
  readonly hysteresisPpm: number;
  readonly sleepCo2Ppm: number;
  readonly quietHoursStartHour: number;
  readonly quietHoursEndHour: number;
  readonly timeZone: string;
  readonly sleepMaxLevel: CommandedLevel;
  readonly safeDefaultLevel: CommandedLevel;
  readonly minDwell: Temporal.Duration;
  readonly evaluationInterval: Temporal.Duration;
  readonly ceilingDiagnosticPpm: number;
  readonly ceilingDiagnosticWindow: Temporal.Duration;
}

// The band bottom and top are named here because the ceiling diagnostic is
// derived from the top, and two places holding 1250 is one place too many.
const BAND_LOW_PPM = 550;
const BAND_HIGH_PPM = 1250;

/**
 * Tuning. Every number here is a preference to be adjusted against real
 * readings — unlike MIN_LEVEL and MAX_COMMANDED_LEVEL, which describe the world.
 *
 * The band width is the one that decides whether the loop settles or hunts: it
 * must be at least as wide as the CO2 swing the fan can itself produce, which
 * for this flat is somewhere between 350 and 1100 ppm and has never been
 * measured. 700 is a middle bet. Recompute it from a week of logged settling
 * points; the test suite pins the current belief so that narrowing it fails loudly.
 */
export const CONTROL = {
  bandLowPpm: BAND_LOW_PPM,
  bandHighPpm: BAND_HIGH_PPM,
  // Half a step: the band spans six steps, so a step is 700/6 ≈ 117 ppm.
  // 50-100 ppm at switching points is standard practice.
  hysteresisPpm: 60,

  // Rests on a fact about this flat: nobody sits in the bedroom, so CO2 above
  // this in that room means someone is still asleep. It only ever *extends* a
  // sleep that quiet hours asserted — see policy.ts for why it may not assert one.
  sleepCo2Ppm: 700,

  quietHoursStartHour: 22,
  quietHoursEndHour: 7,
  // Explicit, so the night cap does not depend on the host's clock settings and
  // does not shift by an hour twice a year if the host is ever UTC.
  timeZone: 'Europe/Prague',

  sleepMaxLevel: 50,
  // When blind, ventilate moderately: quieter than boosting, safer than idling.
  // Never fall back to the minimum.
  safeDefaultLevel: 40,

  // One step down per this interval. It may never be shorter than the slowest
  // CO2 source's refresh (8 minutes for Netatmo), or the controller steps down
  // again before it could observe the last step.
  minDwell: Temporal.Duration.from({ minutes: 10 }),
  evaluationInterval: Temporal.Duration.from({ seconds: 30 }),

  // ASHRAE Guideline 36's pinned-at-the-ceiling alarm: this far above the band
  // for this long, at full power, is a capacity problem and not something the
  // controller can fix by trying harder.
  ceilingDiagnosticPpm: BAND_HIGH_PPM * 1.1,
  ceilingDiagnosticWindow: Temporal.Duration.from({ minutes: 10 }),
} as const satisfies ControlConfig;
