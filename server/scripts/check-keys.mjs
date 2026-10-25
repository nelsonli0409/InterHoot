// Tests each service once and prints only PASS/FAIL. Never prints key values or response bodies.
// Run from repo root: node --env-file=.env server/scripts/check-keys.mjs
const env = process.env;
const results = [];

async function check(name, required, fn) {
  const missing = required.filter((k) => !env[k]);
  if (missing.length) {
    results.push([name, "SKIP", `missing ${missing.join(", ")}`]);
    return;
  }
  try {
    const detail = await fn();
    results.push([name, "PASS", detail ?? ""]);
  } catch (e) {
    results.push([name, "FAIL", e.message]);
  }
}

async function expectOk(res) {
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

await check("Gemini", ["GEMINI_API_KEY"], async () => {
  const res = await fetch("https://generativelanguage.googleapis.com/v1beta/models", {
    headers: { "x-goog-api-key": env.GEMINI_API_KEY },
  });
  await expectOk(res);
});

await check("Cartesia", ["CARTESIA_API_KEY"], async () => {
  const res = await fetch("https://api.cartesia.ai/voices?limit=1", {
    headers: { Authorization: `Bearer ${env.CARTESIA_API_KEY}`, "Cartesia-Version": "2026-08-14" },
  });
  await expectOk(res);
});

await check("Twilio account", ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN"], async () => {
  const auth = Buffer.from(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`).toString("base64");
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}.json`, {
    headers: { Authorization: `Basic ${auth}` },
  });
  await expectOk(res);
});

await check("Twilio number", ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_PHONE_NUMBER"], async () => {
  if (!/^\+[1-9]\d{6,14}$/.test(env.TWILIO_PHONE_NUMBER)) throw new Error("not E.164 (example +14155552671)");
  const auth = Buffer.from(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`).toString("base64");
  const url = `https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/IncomingPhoneNumbers.json?PhoneNumber=${encodeURIComponent(env.TWILIO_PHONE_NUMBER)}`;
  const res = await fetch(url, { headers: { Authorization: `Basic ${auth}` } });
  await expectOk(res);
  const body = await res.json();
  if (!body.incoming_phone_numbers?.length) throw new Error("number is not on this Twilio account");
});

// One login attempt only: repeated failed CRS logins can disable the account.
await check("CRS sandbox", ["CRS_USERNAME", "CRS_PASSWORD"], async () => {
  const res = await fetch("https://api-sandbox.stitchcredit.com/api/users/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: env.CRS_USERNAME, password: env.CRS_PASSWORD }),
  });
  await expectOk(res);
  const body = await res.json();
  if (!body.token) throw new Error("login returned no token");
});

await check("SpacetimeDB", ["SPACETIMEDB_URI", "SPACETIMEDB_DATABASE"], async () => {
  const res = await fetch(`${env.SPACETIMEDB_URI}/v1/database/${env.SPACETIMEDB_DATABASE}`);
  await expectOk(res);
});

await check("Claude (optional)", ["ANTHROPIC_API_KEY"], async () => {
  const res = await fetch("https://api.anthropic.com/v1/models?limit=1", {
    headers: { "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
  });
  await expectOk(res);
});

for (const [name, status, detail] of results) console.log(`${status.padEnd(5)} ${name}${detail ? ` (${detail})` : ""}`);
process.exitCode = results.some((r) => r[1] === "FAIL") ? 1 : 0;
