import { cartMapPoint, routePathIds, type StudentRide } from "../lib/studentRides";
import { Badge } from "../ui/Badge";
import { CampusMap } from "../ui/CampusMap";
import { useStudent } from "./studentContext";

/**
 * The campus map for students: the selected (or booked) pickup and destination, and for an active ride
 * only its own cart at the server-reported position and the leg the server planned. No other carts.
 */
export function StudentMap({ ride, pickupId, destinationId }: { ride: StudentRide | null; pickupId?: string; destinationId?: string }) {
  const { campus } = useStudent();
  const point = ride?.cart ? cartMapPoint(campus, ride.cart.position) : null;
  return (
    <figure className="flex flex-col gap-2">
      <CampusMap
        campus={campus}
        overlay={{
          pickupId: ride ? ride.request.pickupId : pickupId || null,
          destinationId: ride ? ride.request.destinationId : destinationId || null,
          routePathIds: routePathIds(ride),
          cart: ride?.cart && point ? { label: ride.cart.label, point } : null,
        }}
      />
      <figcaption className="flex flex-wrap items-center gap-2 text-[13px] text-muted">
        {campus.fictional && <Badge>Fictional campus</Badge>}
        <span>Demo campus map: schematic, not to scale, not GPS.</span>
        {ride?.cart && <span>Cart position is simulated and moves only when the simulation advances.</span>}
      </figcaption>
    </figure>
  );
}
