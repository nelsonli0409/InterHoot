// Sends one test push to a user's registered device. From the repo root:
//   cd server && npx tsx --env-file=../.env src/push/send-test.ts <user id>
// Prints only the APNs status and reason, never the device token or the key.
import { lookupDeviceToken } from './notify.js';
import { sendPush } from './apns.js';

const userId = process.argv[2];
if (!userId) {
  console.error('Usage: send-test.ts <protected_user id>');
  process.exit(1);
}

const token = await lookupDeviceToken(userId);
if (!token) {
  console.error(`FAIL  no apns_token for user "${userId}" (the app registers it once it has the user id)`);
  process.exit(1);
}
const result = await sendPush(token, {
  title: 'InterHoot test',
  body: 'If you can read this, push works.',
  level: 'time-sensitive',
});
console.log(result.ok ? 'PASS  APNs accepted the push' : `FAIL  APNs ${result.status} ${result.reason ?? ''}`);
process.exit(result.ok ? 0 : 1);
