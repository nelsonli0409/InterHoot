
// phrases that may trigger a response

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
      "give me the one-time password"
    ],
    severity: "critical"
  },
  {
    id: "secrecy_pressure",
    category: "secrecy_pressure",
    phrases: [
      "don't tell your family",
      "keep this a secret",
      "don't tell anyone about this"
    ],
    severity: "high"
  },
  {
    id: "urgent_payment",
    category: "payment_pressure",
    phrases: [
			"you will die",
      "pay immediately",
      "send the money right now",
      "you will be arrested if you don't pay"
    ],
    severity: "high"
  }
];
