import { goalProjection } from "./goal";
import { heroProjection } from "./hero";
import { registerProjection } from "./index";
import { partyProjection } from "./party";

let registered = false;

export function registerAllProjections(): void {
  if (registered) return;
  registerProjection(heroProjection);
  registerProjection(partyProjection);
  registerProjection(goalProjection);
  registered = true;
}
