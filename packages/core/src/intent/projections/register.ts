import { activityProjection } from "./activity";
import { goalProjection } from "./goal";
import { heroProjection } from "./hero";
import { registerProjection } from "./index";
import { partyProjection } from "./party";
import { questProjection } from "./quest";

let registered = false;

export function registerAllProjections(): void {
  if (registered) return;
  registerProjection(heroProjection);
  registerProjection(partyProjection);
  registerProjection(goalProjection);
  registerProjection(questProjection);
  registerProjection(activityProjection);
  registered = true;
}
