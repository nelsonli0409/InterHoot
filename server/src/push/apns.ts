// Build guide C6: APNs sender with token-based auth (HTTP/2, ES256 provider token).
// Reads APNS_KEY_ID, APNS_TEAM_ID, APNS_KEY_PATH (the .p8 file), APNS_TOPIC (the app's bundle id)
// and APNS_ENV (sandbox for Xcode builds, production for TestFlight and the App Store).
import { connect, type ClientHttp2Session } from 'node:http2';
import { createPrivateKey, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';

export interface PushMessage {
  title: string;
  body: string;
  // "time-sensitive" breaks through Focus (needs the Time Sensitive Notifications capability in the app).
  level: 'active' | 'time-sensitive';
  callId?: string;
}

export interface PushResult {
  ok: boolean;
  status: number;
  reason?: string; // APNs error reason, e.g. BadDeviceToken, TopicDisallowed, ExpiredProviderToken
  apnsId?: string;
}

interface ApnsConfig {
  keyId: string;
  teamId: string;
  privateKeyPem: string;
  topic: string;
  host: string;
}

// Apple: refresh the provider token no more than every 20 minutes and no less than every 60.
const TOKEN_MAX_AGE_SECONDS = 50 * 60;

const b64u = (input: string | Buffer) => Buffer.from(input).toString('base64url');

/** Builds the provider token: ES256 JWT, header {alg, kid}, claims {iss: team id, iat}. */
export function makeProviderToken(keyId: string, teamId: string, privateKeyPem: string, nowSeconds: number): string {
  const header = b64u(JSON.stringify({ alg: 'ES256', kid: keyId }));
  const claims = b64u(JSON.stringify({ iss: teamId, iat: nowSeconds }));
  // JWS wants the raw r||s signature, not the DER encoding Node produces by default.
  const signature = sign('sha256', Buffer.from(`${header}.${claims}`), {
    key: createPrivateKey(privateKeyPem),
    dsaEncoding: 'ieee-p1363',
  });
  return `${header}.${claims}.${b64u(signature)}`;
}

function loadConfig(): ApnsConfig {
  const missing = ['APNS_KEY_ID', 'APNS_TEAM_ID', 'APNS_KEY_PATH'].filter((name) => !process.env[name]);
  if (missing.length) throw new Error(`Missing in .env: ${missing.join(', ')}`);
  const environment = process.env.APNS_ENV ?? 'sandbox';
  if (environment !== 'sandbox' && environment !== 'production') {
    throw new Error(`APNS_ENV must be sandbox or production, got "${environment}"`);
  }
  return {
    keyId: process.env.APNS_KEY_ID!,
    teamId: process.env.APNS_TEAM_ID!,
    privateKeyPem: readFileSync(process.env.APNS_KEY_PATH!, 'utf8'),
    topic: process.env.APNS_TOPIC ?? 'com.aslavny.interhoot',
    host: environment === 'production' ? 'api.push.apple.com' : 'api.sandbox.push.apple.com',
  };
}

let config: ApnsConfig | undefined;
let cachedToken: { value: string; issuedAt: number } | undefined;
let session: ClientHttp2Session | undefined;

function providerToken(cfg: ApnsConfig): string {
  const now = Math.floor(Date.now() / 1000);
  if (!cachedToken || now - cachedToken.issuedAt > TOKEN_MAX_AGE_SECONDS) {
    cachedToken = { value: makeProviderToken(cfg.keyId, cfg.teamId, cfg.privateKeyPem, now), issuedAt: now };
  }
  return cachedToken.value;
}

function getSession(host: string): ClientHttp2Session {
  if (session && !session.closed && !session.destroyed) return session;
  const fresh = connect(`https://${host}`);
  // Drop the session on any problem so the next push opens a new one.
  const reset = () => {
    if (session === fresh) session = undefined;
  };
  fresh.on('error', reset);
  fresh.on('close', reset);
  fresh.on('goaway', reset);
  session = fresh;
  return fresh;
}

export async function sendPush(deviceToken: string, message: PushMessage): Promise<PushResult> {
  config ??= loadConfig();
  const cfg = config;
  const payload = JSON.stringify({
    aps: {
      alert: { title: message.title, body: message.body },
      sound: 'default',
      'interruption-level': message.level,
    },
    call_id: message.callId,
  });

  return new Promise<PushResult>((resolve, reject) => {
    const request = getSession(cfg.host).request({
      ':method': 'POST',
      ':path': `/3/device/${deviceToken}`,
      authorization: `bearer ${providerToken(cfg)}`,
      'apns-topic': cfg.topic,
      'apns-push-type': 'alert',
      'apns-priority': '10',
    });
    let status = 0;
    let apnsId: string | undefined;
    let responseBody = '';
    request.on('response', (headers) => {
      status = Number(headers[':status']);
      apnsId = headers['apns-id'] as string | undefined;
    });
    request.setEncoding('utf8');
    request.on('data', (chunk) => (responseBody += chunk));
    request.on('end', () => {
      let reason: string | undefined;
      if (responseBody) {
        try {
          reason = (JSON.parse(responseBody) as { reason?: string }).reason;
        } catch {
          reason = responseBody;
        }
      }
      resolve({ ok: status === 200, status, reason, apnsId });
    });
    request.on('error', reject);
    request.setTimeout(10_000, () => {
      request.close();
      reject(new Error('APNs request timed out'));
    });
    request.end(payload);
  });
}
