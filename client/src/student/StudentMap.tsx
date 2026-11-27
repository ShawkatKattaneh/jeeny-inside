import { cartMapPoint, routePathIds, type StudentRide } from "../lib/studentRides";
import { Badge } from "../ui/Badge";
import { CampusMap } from "../ui/CampusMap";
import { LiveStatus } from "./LiveStatus";
import { useStudent } from "./studentContext";

export const MAP_NOTE = "Demo campus map: schematic, not to scale, not GPS.";
export const CART_NOTE = "Cart position is simulated and moves only when the simulation advances.";

/**
 * The campus map for students: the selected (or booked) pickup and destination, and for an active ride
 * only its own cart at the server-reported position and the leg the server planned. No other carts.
 * `hero` (Student Home): edge to edge at the top of the screen with the live status and the fictional
 * campus label floating on it; the honesty note is then shown in the sheet below (`noteId`).
 */
export function StudentMap({ ride, pickupId, destinationId, hero = false, noteId }: { ride: StudentRide | null; pickupId?: string; destinationId?: string; hero?: boolean; noteId?: string }) {
  const { campus, realtime } = useStudent();
  const point = ride?.cart ? cartMapPoint(campus, ride.cart.position) : null;
  const map = (
    <CampusMap
      campus={campus}
      flush={hero}
      overlay={{
        pickupId: ride ? ride.request.pickupId : pickupId || null,
        destinationId: ride ? ride.request.destinationId : destinationId || null,
        routePathIds: routePathIds(ride),
        cart: ride?.cart && point ? { label: ride.cart.label, point } : null,
      }}
    />
  );

  if (hero) {
    return (
      <figure className="relative bg-map-bg pb-6 pt-11" aria-describedby={noteId}>
        {/* The chips sit in their own band above the drawing, so they never cover map content. */}
        <div className="absolute inset-x-3 top-2 flex h-8 items-center justify-between gap-2">
          <LiveStatus status={realtime.status} floating />
          {campus.fictional && (
            <span className="whitespace-nowrap rounded-full shadow-float"><Badge>Fictional campus</Badge></span>
          )}
        </div>
        <div className="mx-auto aspect-[10/7] max-h-[34dvh] w-full">{map}</div>
      </figure>
    );
  }

  return (
    <figure className="flex flex-col gap-2">
      {map}
      <figcaption className="flex flex-wrap items-center gap-2 text-[13px] text-muted">
        {campus.fictional && <Badge>Fictional campus</Badge>}
        <span>{MAP_NOTE}</span>
        {ride?.cart && <span>{CART_NOTE}</span>}
      </figcaption>
    </figure>
  );
}
