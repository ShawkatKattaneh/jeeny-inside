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
  lengthMeters: z.number().positive(),
  /** Typical speed on this segment. Carts never exceed it. */
  speedKmh: z.number().positive().max(40),
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
    const ids = new Set<string>();
    c.locations.forEach((l, i) => {
      if (ids.has(l.id)) ctx.addIssue({ code: "custom", path: ["locations", i, "id"], message: `Duplicate location id "${l.id}"` });
      ids.add(l.id);
    });
    const pathIds = new Set<string>();
    c.paths.forEach((p, i) => {
      if (pathIds.has(p.id)) ctx.addIssue({ code: "custom", path: ["paths", i, "id"], message: `Duplicate path id "${p.id}"` });
      pathIds.add(p.id);
      if (!ids.has(p.from)) ctx.addIssue({ code: "custom", path: ["paths", i, "from"], message: `Unknown location "${p.from}"` });
      if (!ids.has(p.to)) ctx.addIssue({ code: "custom", path: ["paths", i, "to"], message: `Unknown location "${p.to}"` });
      if (p.from === p.to) ctx.addIssue({ code: "custom", path: ["paths", i], message: "A path cannot start and end at the same location" });
    });
  });
export type CampusConfig = z.infer<typeof CampusConfig>;
export type CampusConfigInput = z.input<typeof CampusConfig>;

// ---------- Fleet and rides (shapes only in Phase 0) ----------

export const CartId = z.string().regex(/^CART-\d{2}$/, "Cart ids look like CART-07");

export const CartStatus = z.enum(["idle", "en_route", "charging", "offline"]);

export const Cart = z.object({
  id: CartId,
  label: z.string().min(1),
  seats: z.number().int().min(1).max(8),
  status: CartStatus,
  /** Last known location, or the path it is on and how far along it is (0..1). */
  position: z.union([
    z.object({ kind: z.literal("at"), locationId: LocationId }),
    z.object({ kind: z.literal("on_path"), pathId: PathId, progress: z.number().min(0).max(1) }),
  ]),
  batteryPercent: z.number().min(0).max(100),
  rangeKm: z.number().min(0),
  /** Simulated carts are labelled as simulated everywhere they appear. */
  simulated: z.boolean(),
  driverId: z.string().nullable(),
});
export type Cart = z.infer<typeof Cart>;

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

export const Trip = z.object({
  id: z.string().min(1),
  cartId: CartId,
  stops: z.array(TripStop),
  /** The passenger list: which requests ride this trip and whether they have boarded. */
  passengers: z.array(z.object({ requestId: z.string().min(1), boarded: z.boolean() })),
  status: z.enum(["planned", "active", "completed", "cancelled"]),
});
export type Trip = z.infer<typeof Trip>;

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
