
import "dotenv/config";
import { createTwilioClient } from "./callActions.js";

const client = createTwilioClient();

console.log("Twilio client created successfully.");
console.log("Account SID configured:", Boolean(client.username));
