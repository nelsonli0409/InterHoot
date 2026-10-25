
import { buildVerdictTwiml } from "./callActions.js";

console.log("=== GREEN ===");

console.log(
  buildVerdictTwiml(
    "GREEN",
    "+15551234567"
  )
);

console.log("\n=== YELLOW ===");

console.log(
  buildVerdictTwiml("YELLOW")
);

console.log("\n=== RED ===");

console.log(
  buildVerdictTwiml("RED")
);
