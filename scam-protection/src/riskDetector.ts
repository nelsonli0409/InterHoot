
import { riskRules } from "./riskRules.js";



export type RiskSignal = {
  ruleId: string;
  category: string;
  severity: string;
  matchedPhrases: string[];
};

export function detectRisks(transcript: string): RiskSignal[] {
  const normalizedTranscript = transcript.toLowerCase();

  const signals: RiskSignal[] = [];

  for (const rule of riskRules) {
    const matchedPhrases = rule.phrases.filter((phrase) =>
      normalizedTranscript.includes(phrase.toLowerCase())
    );

    if (matchedPhrases.length > 0) {
      signals.push({
        ruleId: rule.id,
        category: rule.category,
        severity: rule.severity,
        matchedPhrases
      });
    }
  }

  return signals;
}
