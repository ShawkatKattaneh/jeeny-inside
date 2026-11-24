/**
 * Campus analytics response (Phase 5 Prompt 2): GET /api/analytics. Shared by the server (which builds
 * it in engine/analytics.ts) and the Operations dashboard (which validates it with this schema).
 *
 * "Campus Intelligence" here means descriptive, explainable counts and durations over the ride state
 * that is actually saved. There is no AI, forecasting or estimation.
 *
 * Rules every field follows:
 * - The counting unit is in the field name: ...Requests (ride requests), ...Trips (cart trips),
 *   ...Riders (rider entries on trips, one per request that was placed on a trip), ...Carts, ...Seats.
 *   Units are never added together.
 * - Times come from the SIMULATED clock (milliseconds or seconds since this database was created; it
 *   moves only when the demo advances it). No record carries wall-clock time, so there are no
 *   calendar windows, dates or time zones, and durations are simulated seconds.
 * - A metric that the saved data cannot support reliably is { status: "unavailable", reason }, never 0.
 * - "current" values describe the state right now; "history" values cover every record since the
 *   database was created (records are never deleted, so that history is complete for this database).
 * - No student ids, names or other personal data are included.
 */
import { z } from "zod";
import { CartStatus, RideRequestStatus, TripStatus } from "./schemas.js";

export const Unavailable = z.object({ status: z.literal("unavailable"), reason: z.string().min(1) }).strict();
export type Unavailable = z.infer<typeof Unavailable>;

const count = z.number().int().min(0);
const seconds = z.number().min(0);

/** Simulated-second durations over a defined population. Stats are null when the population is empty. */
export const DurationStats = z.object({
  status: z.literal("available"),
  /** Number of ride requests measured. */
  measuredRequests: count,
  meanSeconds: seconds.nullable(),
  medianSeconds: seconds.nullable(),
  maxSeconds: seconds.nullable(),
}).strict();
export type DurationStats = z.infer<typeof DurationStats>;

const byStatus = <T extends z.ZodEnum>(e: T) => z.record(e, count);

export const LocationActivity = z.object({
  locationId: z.string(),
  /** The campus file's name, or null when the id is not a location of the loaded campus. */
  name: z.string().nullable(),
  knownLocation: z.boolean(),
  totalRequests: count,
  activeRequests: count,
  completedRequests: count,
  cancelledRequests: count,
}).strict();
export type LocationActivity = z.infer<typeof LocationActivity>;

export const PickupWaiting = z.object({
  locationId: z.string(),
  name: z.string().nullable(),
  knownLocation: z.boolean(),
  requestToTapIn: DurationStats,
  currentElapsedWait: DurationStats,
}).strict();
export type PickupWaiting = z.infer<typeof PickupWaiting>;

export const CartHistory = z.object({
  cartId: z.string(),
  label: z.string(),
  /** Every trip created for this cart (trip.cartId never changes after the trip is created). */
  totalTrips: count,
  completedTrips: count,
  cancelledTrips: count,
  openTrips: count,
  /** Riders dropped off by this cart: one per ride request completed on one of its trips. */
  droppedOffRiders: count,
}).strict();
export type CartHistory = z.infer<typeof CartHistory>;

export const Observation = z.object({
  /** A factual statement about measured data. Never a diagnosis and never based on a threshold. */
  text: z.string(),
  metric: z.string(),
  population: z.string(),
  window: z.string(),
}).strict();
export type Observation = z.infer<typeof Observation>;

export const AnalyticsResponse = z.object({
  /** The committed state revision these figures were computed from. */
  revision: z.number().int().min(0),
  campusId: z.string(),
  clock: z.object({
    basis: z.literal("simulated"),
    /** Simulated seconds since this database was created ("now" for current values). */
    nowSeconds: seconds,
  }).strict(),
  coverage: z.object({
    /** Earliest time any record can have: simulated second 0, when this database was created. */
    historyStartsAtSimulatedSeconds: z.literal(0),
    note: z.string(),
    /** Calendar windows (today, last 7 or 30 days) need wall-clock times, which are not recorded. */
    calendarWindows: Unavailable,
    /** Demand over time needs a time base that means something; see reason. */
    demandOverTime: Unavailable,
  }).strict(),
  demand: z.object({
    /** History: every ride request ever created, by its current status. */
    totalRequests: count,
    requestsByStatus: byStatus(RideRequestStatus),
    /** Current: requested, assigned, arriving or on board. */
    activeRequests: count,
    /** History: completed or cancelled. */
    finishedRequests: count,
    requestsByMode: z.object({ solo: count, shared: count }).strict(),
    /** History: every cart trip, by its current status. One trip can carry several ride requests. */
    totalTrips: count,
    tripsByStatus: byStatus(TripStatus),
    /** Trips that ever had two or more riders (a Ghost Ride join happened), cancelled riders included. */
    tripsWithTwoOrMoreRiders: count,
    /** Rider entries on trips: one per ride request ever placed on a trip. */
    totalRiders: count,
    droppedOffRiders: count,
    /** Rider entries whose ride request is cancelled (whether the trip carried on for others or was cancelled too). */
    cancelledRiders: count,
  }).strict(),
  locations: z.object({
    /** Ride requests counted by their pickup location (history, all statuses). Highest first. */
    pickups: z.array(LocationActivity),
    /** Ride requests counted by their destination (history, all statuses). Highest first. Separate from pickups. */
    destinations: z.array(LocationActivity),
  }).strict(),
  waiting: z.object({
    /** History: createdAt to the rider's Tap-In time (arrival check-in, NOT boarding). Requests with a Tap-In record. */
    requestToTapIn: DurationStats,
    /** Boarding time is not recorded once a ride moves on; see reason. */
    requestToBoarding: Unavailable,
    /** Current: now minus createdAt for requests still requested, assigned or arriving. Elapsed, not completed, waits. */
    currentElapsedWait: DurationStats,
    /** History: createdAt to completion for completed requests (completion time = the request's last update). */
    requestToDropOff: DurationStats,
    byPickup: z.array(PickupWaiting),
  }).strict(),
  fleet: z.object({
    /** Current. */
    totalCarts: count,
    cartsByStatus: byStatus(CartStatus),
    /** Current: carts that cannot take rides in their status (charging, offline, maintenance). */
    outOfServiceCarts: count,
    /** Current: passengers on board ÷ seats of every cart in the fleet. */
    seatOccupancy: z.object({
      status: z.literal("available"),
      onBoardPassengers: count,
      totalSeats: count,
      /** onBoardPassengers / totalSeats, or null with no seats. */
      ratio: z.number().min(0).max(1).nullable(),
    }).strict(),
    dispatchEligibleCarts: Unavailable,
    utilizationOverTime: Unavailable,
    /** History per cart. */
    perCart: z.array(CartHistory),
  }).strict(),
  cancellations: z.object({
    cancelledRequests: count,
    /** Denominator: requests that reached a final status (completed or cancelled). */
    finishedRequests: count,
    /** cancelledRequests / finishedRequests, or null with no finished requests. */
    shareOfFinished: z.number().min(0).max(1).nullable(),
    /** Which step a ride was cancelled at is not recorded; see reason. */
    cancelledAtStage: Unavailable,
  }).strict(),
  observations: z.array(Observation),
}).strict();
export type AnalyticsResponse = z.infer<typeof AnalyticsResponse>;

/** GET /api/analytics takes no query parameters (there are no filters the saved data can honestly support). */
export const AnalyticsQuery = z.object({}).strict();
