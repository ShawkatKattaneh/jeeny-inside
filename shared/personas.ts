import { Persona } from "./schemas.js";

/**
 * Sample data: seeded demo personas used instead of a real login (D4).
 * One driver per cart; carts themselves arrive with the engine in Phase 1.
 */
export const PERSONAS: Persona[] = Persona.array().parse([
  { id: "stu-lina", name: "Lina", role: "student", subtitle: "Engineering, 2nd year" },
  { id: "stu-omar", name: "Omar", role: "student", subtitle: "Business, 3rd year" },
  { id: "stu-sara", name: "Sara", role: "student", subtitle: "Science, 1st year" },
  { id: "drv-yazan", name: "Yazan", role: "driver", subtitle: "Driver, Cart 01", cartId: "CART-01" },
  { id: "drv-rana", name: "Rana", role: "driver", subtitle: "Driver, Cart 02", cartId: "CART-02" },
  { id: "ops-hadi", name: "Hadi", role: "operator", subtitle: "Operations Center" },
]);
