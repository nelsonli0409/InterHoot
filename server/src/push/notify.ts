// Build guide C6: the call pipeline calls notifyVerdict() when a screened call ends.
// Yellow and red calls send a Time Sensitive push to the protected user; green sends nothing.
import type { Flag } from '../contract.js';
import { sendPush, type PushResult } from './apns.js';

const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** Reads protected_user.apns_token over SpacetimeDB's HTTP SQL API. Empty when not registered yet. */
async function lookupDeviceToken(userId: string): Promise<string | undefined> {
  // The id goes straight into the SQL text, so only plain ids are accepted.
  if (!SAFE_ID.test(userId)) throw new Error(`Unsafe user id: "${userId}"`);
  const base = process.env.SPACETIMEDB_URI ?? 'https://maincloud.spacetimedb.com';
  const database = process.env.SPACETIMEDB_DATABASE ?? 'interhoot';
  const response = await fetch(`${base}/v1/database/${database}/sql`, {
    method: 'POST',
    body: `SELECT apns_token FROM protected_user WHERE id = '${userId}'`,
  });
  if (!response.ok) throw new Error(`SpacetimeDB SQL failed: ${response.status} ${await response.text()}`);
  const sets = (await response.json()) as { rows: string[][] }[];
  return sets[0]?.rows[0]?.[0] || undefined;
}

export interface VerdictNotice {
  userId: string;
  flag: Flag;
  callerE164: string;
  summary: string;
  callId: string;
}

export async function notifyVerdict(notice: VerdictNotice): Promise<PushResult | 'skipped'> {
  if (notice.flag === 'green') return 'skipped';
  const token = await lookupDeviceToken(notice.userId);
  if (!token) throw new Error(`No apns_token registered for user "${notice.userId}"`);
  const red = notice.flag === 'red';
  return sendPush(token, {
    title: red ? 'Scam call stopped' : 'Suspicious call screened',
    body: `${notice.callerE164}: ${notice.summary}`,
    level: 'time-sensitive',
    callId: notice.callId,
  });
}

export { lookupDeviceToken };
