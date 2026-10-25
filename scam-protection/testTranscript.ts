
import { TranscriptAccumulator } from "./src/agent/transcriptAccumulator.js";

const accumulator = new TranscriptAccumulator();

accumulator.addFragment("Uh");
accumulator.addFragment(", I want your security");
accumulator.addFragment(" number, old man.");
accumulator.addFragment(" I won't take");
accumulator.addFragment(" no for an answer");

console.log("Transcript:", accumulator.getText());

const response = accumulator.flush();

console.log("Submitted response:", response);
console.log("Accumulator empty:", !accumulator.hasText());
