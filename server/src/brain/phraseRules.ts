// The prototype's phrase rules (scam-protection/src/riskRules.ts + riskDetector.ts),
// copied here because /server's tsconfig only compiles server/src. Keep the two lists in
// sync, or delete the prototype once the team is happy with this copy.
//
// These are keyword matches on English text only, so they're a supporting signal, not a verdict.

export type RiskRule = {
  id: string;
  category: string;
  phrases: string[];
  severity: "low" | "medium" | "high" | "critical";
};

export const riskRules: RiskRule[] = [
  {
    id: "request_verification_code",
    category: "authentication_secret",
    phrases: [
      "download this software",
      "open this link",
      "tell me your verification code",
      "read me the code you received",
      "give me the one-time password",
    ],
    severity: "critical",
  },
  {
    id: "secrecy_pressure",
    category: "secrecy_pressure",
    phrases: ["don't tell your family", "keep this a secret", "don't tell anyone about this"],
    severity: "high",
  },
  {
    id: "urgent_payment",
    category: "payment_pressure",
    phrases: ["you will die", "pay immediately", "send the money right now", "you will be arrested if you don't pay"],
    severity: "high",
  },
];

export type RiskSignal = {
  ruleId: string;
  category: string;
  severity: RiskRule["severity"];
  matchedPhrases: string[];
};

/** Same logic as the prototype's detectRisks, plus straight/curly apostrophe folding for STT output. */
export function detectRisks(transcript: string): RiskSignal[] {
  const fold = (s: string) => s.toLowerCase().replace(/[’‘]/g, "'");
  const text = fold(transcript);
  const signals: RiskSignal[] = [];
  for (const rule of riskRules) {
    const matchedPhrases = rule.phrases.filter((p) => text.includes(fold(p)));
    if (matchedPhrases.length > 0) {
      signals.push({ ruleId: rule.id, category: rule.category, severity: rule.severity, matchedPhrases });
    }
  }
  return signals;
}

export const SEVERITY_VALUE: Record<RiskRule["severity"], number> = {
  low: 0.25,
  medium: 0.5,
  high: 0.75,
  critical: 1,
};