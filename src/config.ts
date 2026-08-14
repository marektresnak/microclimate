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
  // Per-source, never global. This is load-bearing: a 20-minute-old Tado
  // reading is healthy (that is its heartbeat) while a Netatmo silent for 20
  // minutes has missed two refreshes, and one window cannot judge both. Getting
  // it wrong in either direction is a safety bug.
  readonly freshnessWindow: Temporal.Duration;
}

// Derived from how Tado publishes, not from how often we ask. A valve measures
// every minute, but the API value only moves when the reading crosses a
// threshold — around 0.5 °C or 5 %RH — with a heartbeat every 20 minutes
// regardless. So a perfectly healthy reading can be 20 minutes old at the
// moment we fetch it, plus up to one 1-minute poll interval older before we
// ask again: the window has to exceed 21 minutes or a healthy instrument
// periodically reads as stale through our own polling. Twenty-five gives slack.
//
// This said 90 seconds until the Tado adapter was built ("one missed poll is
// tolerated, two is not"), which assumed a poll produces a fresh value. It does
// not, and the number was never measured against the vendor.
const TADO_FRESHNESS = Temporal.Duration.from({ minutes: 25 });
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
  // Two radiators and two valves, but one Tado *zone* — and a zone reports one
  // measurement, from whichever device Tado designates. Per-valve readings do
  // not exist in the API, so the readable instrument is the zone and this is one
  // sensor to us. The pair of ids this used to declare (`_left`, `_right`) was
  // written before that was known and never carried a reading from real
  // hardware, so they are gone rather than retired: the convention that keeps
  // ids forever exists to keep historical readings interpretable, and there are
  // none to keep.
  kids_room_tado: {
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
  // The only CO2 instrument in the flat today.
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
    // One instrument, so the list has nothing to decide yet. It gains a second
    // entry when the SEN66 arrives, and that is the whole edit.
    temperature: ['kids_room_tado'],
    humidity: ['kids_room_tado'],
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

/**
 * Which Tado zone answers for which instrument. Topology, so it lives here with
 * the rest of it: a mistyped sourceId is a compile error, and git records why an
 * assignment changed in a way a database row never could.
 *
 * The ids are the real account's, read from `GET /homes/1819708/zones` on
 * 2026-08-14. They are facts about the account rather than about this code, which
 * is why they are not consecutive and why the first guess at them (1, 2, 3) was
 * wrong in every entry. Two things corroborate the mapping beyond the Czech
 * names: Pokojík is the only zone with two valves in it, which is the kids' room
 * and its two radiators, and Ložnice reads 25.6 °C against the Home Coach's 25.7
 * standing in the same room.
 *
 * If an id ever stops matching, the adapter says so at its first poll and lists
 * every zone the account does offer — fixing this is then copy-paste from the log.
 */
export const TADO_ZONES = [
  { zoneId: 2, sourceId: 'living_room_tado' }, // Obývák
  { zoneId: 5, sourceId: 'kids_room_tado' }, // Pokojík — two radiators, one zone
  { zoneId: 1, sourceId: 'bedroom_tado' }, // Ložnice
] as const satisfies readonly { zoneId: number; sourceId: SensorId }[];

// Where the flat is, as an explicit IANA zone. Anything that needs a local
// hour reads it from here, so behaviour never depends on how the host's clock
// is configured and never shifts by an hour twice a year if the host is UTC.
export const TIME_ZONE = 'Europe/Prague';
