/**
 * Shared domain types and Zod schemas.
 * Used by client, server and engine, so one change breaks the build everywhere it matters.
 * Phase 0 defines the shapes only; behaviour arrives in later phases.
 */
import { z } from "zod";

// ---------- Campus: Location + Path (loaded from a campus config file) ----------

export const LocationType = z.enum(["gate", "building", "parking", "pickup", "depot"]);
export type LocationType = z.infer<typeof LocationType>;

/** Map coordinates are abstract units in the campus's own viewBox, not GPS. */
export const Point = z.object({ x: z.number(), y: z.number() });
export type Point = z.infer<typeof Point>;

export const LocationId = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]*$/, "Location ids are lowercase kebab-case");

export const Location = z.object({
  id: LocationId,
  name: z.string().min(1),
  shortName: z.string().min(1).max(12).optional(),
  type: LocationType,
  position: Point,
  /** Whether a cart can stop here to pick up or drop off. */
  canStop: z.boolean(),
  /** Optional building footprint drawn on the map (width/height in map units, centred on position). */
  footprint: z.object({ w: z.number().positive(), h: z.number().positive() }).optional(),
});
export type Location = z.infer<typeof Location>;

export const PathId = z.string().min(1);

export const Path = z.object({
  id: PathId,
  from: LocationId,
  to: LocationId,
  lengthMeters: z.number().positive("Path length must be greater than 0 meters"),
  /** Typical speed on this segment. Carts never exceed it. */
  speedKmh: z.number().positive("Speed limit must be greater than 0 km/h").max(40, "Speed limit must be 40 km/h or less"),
  /** Paths are two-way unless marked otherwise. */
  oneWay: z.boolean().default(false),
});
export type Path = z.infer<typeof Path>;

export const CampusConfig = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    /** Shown on screen so nobody mistakes sample data for a real campus. */
    fictional: z.boolean(),
    description: z.string().optional(),
    map: z.object({ width: z.number().positive(), height: z.number().positive() }),
    locations: z.array(Location).min(2),
    paths: z.array(Path).min(1),
  })
  .superRefine((c, ctx) => {
    // Structural errors only. Graph and map checks live in engine/campusValidation.ts.
    const ids = new Map<string, number>();
    c.locations.forEach((l, i) => {
      const first = ids.get(l.id);
      if (first !== undefined) ctx.addIssue({ code: "custom", path: ["locations", i, "id"], message: `Duplicate location id "${l.id}" (first used by locations.${first})` });
      else ids.set(l.id, i);
    });
    const pathIds = new Map<string, number>();
    c.paths.forEach((p, i) => {
      const first = pathIds.get(p.id);
      if (first !== undefined) ctx.addIssue({ code: "custom", path: ["paths", i, "id"], message: `Duplicate path id "${p.id}" (first used by paths.${first})` });
      else pathIds.set(p.id, i);
      if (!ids.has(p.from)) ctx.addIssue({ code: "custom", path: ["paths", i, "from"], message: `Unknown location "${p.from}" in path "${p.id}"` });
      if (!ids.has(p.to)) ctx.addIssue({ code: "custom", path: ["paths", i, "to"], message: `Unknown location "${p.to}" in path "${p.id}"` });
      if (p.from === p.to) ctx.addIssue({ code: "custom", path: ["paths", i], message: `Path "${p.id}" cannot start and end at the same location` });
    });
  });
export type CampusConfig = z.infer<typeof CampusConfig>;
export type CampusConfigInput = z.input<typeof CampusConfig>;

// ---------- Carts ----------

export const CartId = z.string().regex(/^CART-\d{2}$/, "Cart ids look like CART-07");

/**
 * Cart operational states (Phase 1 Part 2, plus "assigned" from Part 3).
 * - idle:        in service, no passengers on board, not committed to anything else.
 * - assigned:    reserved for one trip with no passengers on board yet; may be driving to the pickup,
 *                or finishing its current path after a cancellation. Not available for other rides.
 * - occupied:    in service with at least one passenger on board.
 * - charging:    charging, or set aside to charge. Not available for rides.
 * - offline:     out of service (for example no driver). Not available.
 * - maintenance: out of service for repair or inspection. Not available.
 */
export const CartStatus = z.enum(["idle", "assigned", "occupied", "charging", "offline", "maintenance"]);
export type CartStatus = z.infer<typeof CartStatus>;

/**
 * Top speed used when a cart file gives none. Prototype assumption, matching the 15 km/h the
 * existing ETA tests use and the 10-15 km/h path limits on the fictional campuses; not a measured value.
 */
export const DEFAULT_CART_SPEED_KMH = 15;

/**
 * Where a cart is: at a location, or on a path. `progress` is the fraction of the path's length
 * measured from `path.from` towards `path.to` (0 = at `from`, 1 = at `to`), whichever way the cart
 * is driving; a cart driving a two-way path in reverse has decreasing progress.
 */
export const CartPosition = z.union([
  z.object({ kind: z.literal("at"), locationId: LocationId }),
  z.object({ kind: z.literal("on_path"), pathId: PathId, progress: z.number().min(0).max(1) }),
]);
export type CartPosition = z.infer<typeof CartPosition>;

const BatteryPercent = z.number().min(0, "Battery must be between 0 and 100%").max(100, "Battery must be between 0 and 100%");
const PassengerCount = z.number().int("Passenger count must be a whole number").min(0, "Passenger count cannot be negative");

/**
 * Specification fields (id, label, seats, maxSpeedKmh, simulated) describe the cart and never change
 * through a state update. Operational fields change while the cart is in service (see engine/fleet.ts).
 */
const CartFields = z.object({
  // Specification
  id: CartId,
  label: z.string().min(1),
  /** Passenger capacity. */
  seats: z.number().int("Capacity must be a whole number of seats").min(1, "Capacity must be at least 1 seat").max(8, "Capacity must be 8 seats or fewer"),
  /** The cart's own top speed. On each path it also never exceeds the path's limit. */
  maxSpeedKmh: z.number().positive("Cart speed must be greater than 0 km/h").max(40, "Cart speed must be 40 km/h or less").default(DEFAULT_CART_SPEED_KMH),
  /** Simulated carts are labelled as simulated everywhere they appear. */
  simulated: z.boolean(),
  // Operational state
  status: CartStatus,
  /** Last known location, or the path it is on and how far along it is (0..1). */
  position: CartPosition,
  batteryPercent: BatteryPercent,
  rangeKm: z.number().min(0),
  /** Passengers on board now. */
  passengerCount: PassengerCount.default(0),
  driverId: z.string().nullable(),
});

/** A cart's data is consistent: passengers fit, and only an occupied cart carries passengers. */
export const Cart = CartFields.superRefine((c, ctx) => {
  if (c.passengerCount > c.seats) {
    ctx.addIssue({ code: "custom", path: ["passengerCount"], message: `${c.passengerCount} passengers do not fit in ${c.seats} seats` });
  }
  if (c.status === "occupied" && c.passengerCount === 0) {
    ctx.addIssue({ code: "custom", path: ["passengerCount"], message: "An occupied cart must have at least 1 passenger on board" });
  }
  if (c.status !== "occupied" && c.passengerCount > 0) {
    ctx.addIssue({ code: "custom", path: ["status"], message: `A cart with passengers on board must be "occupied", not "${c.status}"` });
  }
});
export type Cart = z.infer<typeof Cart>;
export type CartInput = z.input<typeof Cart>;

/**
 * The fields a state update may change. Unknown or specification fields are rejected.
 * Built without defaults on purpose, so a field left out of an update is never reset.
 */
export const CartStatePatch = z
  .object({
    status: CartStatus,
    position: CartPosition,
    batteryPercent: BatteryPercent,
    passengerCount: PassengerCount,
    rangeKm: z.number().min(0),
    driverId: z.string().nullable(),
  })
  .partial()
  .strict();
export type CartStatePatch = z.infer<typeof CartStatePatch>;

/**
 * A fleet file (campus/fleets/<campus id>.json): the carts a server starts with for one campus.
 * Only the outer shape is checked here; each cart is validated by engine/fleet.ts createFleet,
 * which reports every invalid cart, duplicate id and unknown position at once.
 */
export const FleetConfig = z
  .object({
    /** Must equal the id of the campus the server loaded. */
    campusId: z.string().min(1),
    /** Free text, for example to say the carts are sample data. */
    description: z.string().optional(),
    carts: z.array(z.unknown()).min(1, "A fleet file needs at least one cart"),
  })
  .strict();
export type FleetConfig = z.infer<typeof FleetConfig>;

// ---------- Rides (shapes only) ----------

/**
 * The rider's view of a ride (Part 3, solo rides).
 * - requested: created and validated, no cart yet.
 * - assigned:  a cart was assigned by id; its trip is planned and has not started.
 * - arriving:  the trip started; the cart is driving to the pickup, or waiting there to board.
 * - on_board:  the passenger boarded; the cart is driving to the destination, or waiting there.
 * - completed: the passenger was dropped off.
 * - cancelled: cancelled before boarding.
 */
export const RideRequestStatus = z.enum([
  "requested",
  "assigned",
  "arriving",
  "on_board",
  "completed",
  "cancelled",
]);
export type RideRequestStatus = z.infer<typeof RideRequestStatus>;

export const RideRequest = z
  .object({
    id: z.string().min(1),
    studentId: z.string().min(1),
    pickupId: LocationId,
    destinationId: LocationId,
    mode: z.enum(["solo", "shared"]),
    priority: z.boolean().default(false),
    status: RideRequestStatus,
    createdAt: z.number().int(),
    updatedAt: z.number().int(),
    /** Simulated fare in JOD. Never a real payment. */
    fareJod: z.number().min(0),
    freeLoyaltyRide: z.boolean().default(false),
  })
  .refine((r) => r.pickupId !== r.destinationId, { message: "Pickup and destination must differ", path: ["destinationId"] });
export type RideRequest = z.infer<typeof RideRequest>;

export const TripStop = z.object({
  locationId: LocationId,
  board: z.array(z.string()),
  alight: z.array(z.string()),
});

/** A route on the campus graph, in the same shape `shortestRoute` returns (minus its length). */
export const TripLeg = z.object({
  /** Location ids from the leg's start to its end, inclusive. */
  locationIds: z.array(LocationId).min(1),
  /** Path ids driven, in order; always one fewer than locationIds. */
  pathIds: z.array(PathId),
});
export type TripLeg = z.infer<typeof TripLeg>;

/**
 * Trip statuses: planned (cart assigned, not started), active (driving or waiting at a stop),
 * cancelling (ride cancelled while the cart was mid-path; the cart only finishes that one path),
 * completed, cancelled.
 */
export const TripStatus = z.enum(["planned", "active", "cancelling", "completed", "cancelled"]);
export type TripStatus = z.infer<typeof TripStatus>;

export const Trip = z.object({
  id: z.string().min(1),
  cartId: CartId,
  stops: z.array(TripStop),
  /** The passenger list: which requests ride this trip and whether they have boarded. */
  passengers: z.array(z.object({ requestId: z.string().min(1), boarded: z.boolean() })),
  status: TripStatus,
  /** Index in `stops` of the next stop to handle. Equals stops.length once every stop is done. */
  stopIndex: z.number().int().min(0).default(0),
  /**
   * The route being driven now. Active: ends at stops[stopIndex]. Cancelling: exactly the one path
   * the cart is finishing. Null when planned, completed or cancelled.
   */
  leg: TripLeg.nullable().default(null),
});
export type Trip = z.infer<typeof Trip>;

/**
 * The only fields a client may send to create a ride request (Phase 2). Any other field (ids, cart,
 * fare, status, timestamps, passengers, mode, priority) is rejected, never ignored: the engine and
 * the server create those. Location ids are checked by the engine (createRequest), not here.
 */
export const CreateRideRequestBody = z
  .object({
    studentId: z.string().min(1, "studentId is required"),
    pickupId: z.string().min(1, "pickupId is required"),
    destinationId: z.string().min(1, "destinationId is required"),
  })
  .strict();
export type CreateRideRequestBody = z.infer<typeof CreateRideRequestBody>;

// ---------- Demo personas (no real login) ----------

export const Role = z.enum(["student", "driver", "operator"]);
export type Role = z.infer<typeof Role>;

export const Persona = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  role: Role,
  subtitle: z.string(),
  /** Drivers are linked to one cart. */
  cartId: CartId.optional(),
});
export type Persona = z.infer<typeof Persona>;
