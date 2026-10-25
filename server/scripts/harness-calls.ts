// B7: the scripted calls for scripts/harness.ts. Edit freely: add a scenario, change a line,
// then `npm run harness` re-runs only what changed (Gemini answers are cached by transcript).
//
// Every scenario screens a call to the protected user, P20 DOLORES WHITCOMB, whose six
// tradelines are all paid and closed ("FORMER LENDER 1–6"). So any caller claiming an open
// or past-due account at a named bank contradicts her file.
//
// callerE164 numbers are fictional (555-01xx range). `persona` is the demo_caller_alias
// target: which sandbox persona's CRS answers this caller gets. null = no alias, CRS skipped,
// which is what a real unknown caller looks like.
//   P13 KAYLA BRENNAN  5550101013  no reverse record, fraud risk 88, VoIP, prepaid
//   P12 VICTOR ANAND   5550101012  number registered to someone else (RAJESH MENON), risk 85
//   P01 MARGARET OKAFOR 5550101001 clean: owner matches, risk 11
//
// RED scripts borrow the prototype's phrase rules (scam-protection/src/riskRules.ts) word
// for word, so the phrase-rule reasons fire. Those rules are English-only, which the
// Spanish call shows.

import type { Flag, TranscriptTurn } from "../src/brain/types.js";

export interface Scenario {
  id: string;
  title: string;
  expect: Flag;
  callerE164: string;
  persona: "P13" | "P12" | "P01" | null;
  /** protected_user.language, used for user_summary. */
  userLanguage: string;
  /** Alternating agent/caller turns. Gemini is asked after each caller turn. */
  turns: TranscriptTurn[];
}

const A = (text: string): TranscriptTurn => ({ speaker: "agent", text });
const C = (text: string): TranscriptTurn => ({ speaker: "caller", text });

const GREETING_EN = "Hello, you've reached the call assistant for Dolores. Who's calling, and what is this about?";

export const SCENARIOS: Scenario[] = [
  // ---- RED ------------------------------------------------------------------------------
  {
    id: "red-debt",
    title: "Fake Chase debt collector, gift cards, arrest threat",
    expect: "red",
    callerE164: "+14155550113",
    persona: "P13",
    userLanguage: "en",
    turns: [
      A(GREETING_EN),
      C(
        "This is Officer Mark Daniels with National Recovery Services. I'm calling about Dolores Whitcomb's " +
          "past-due Chase credit card. The balance is $2,340 and it has been sent to collections.",
      ),
      A("Thank you. Can you give me a reference number and a callback number for your company?"),
      C("There's no time for that. She needs to pay immediately or a warrant will be issued. You will be arrested if you don't pay today."),
      A("I understand. How are you asking her to pay?"),
      C(
        "She can settle it right now with Target gift cards. Buy $2,340 in cards and read me the numbers on the back. " +
          "And keep this a secret. Don't tell your family, they'll only slow this down.",
      ),
    ],
  },
  {
    id: "red-bank-code",
    title: "Fake Wells Fargo fraud dept asks for the one-time code and remote access",
    expect: "red",
    callerE164: "+14155550112",
    persona: "P12",
    userLanguage: "en",
    turns: [
      A(GREETING_EN),
      C(
        "Hi, this is David from the Wells Fargo fraud department. Someone is trying to use Dolores's Wells Fargo " +
          "debit card in Miami right now, and we need to lock the account.",
      ),
      A("Which account is this about?"),
      C("Her Wells Fargo checking account. I just sent her a text. Tell me your verification code so I can block the charge. Read me the code you received."),
      A("She'll call Wells Fargo back at the number on her card."),
      C(
        "No, don't hang up, the money will be gone in ten minutes. Open this link I'm texting you and download this software " +
          "so I can protect the account. Don't tell anyone about this, the thief could be someone close to you.",
      ),
    ],
  },

  // ---- YELLOW ---------------------------------------------------------------------------
  {
    id: "yellow-prize",
    title: "Vague sweepstakes win, asks for a callback (aliased to P12)",
    expect: "yellow",
    callerE164: "+14155550122",
    persona: "P12",
    userLanguage: "en",
    turns: [
      A(GREETING_EN),
      C("Good afternoon! This is Linda with the American Seniors Sweepstakes. Dolores has been selected as one of our grand prize winners this year."),
      A("What is the prize, and how was she entered?"),
      C("I can only share the details with her directly. She just needs to call us back at this number before Friday to confirm her prize."),
      A("I'll pass that along. Is there anything else?"),
      C("No, that's all. Just make sure she calls before Friday so she doesn't lose her spot."),
    ],
  },
  {
    id: "yellow-medicare",
    title: "Unaliased 'Medicare benefits' caller wants her Medicare number",
    expect: "yellow",
    callerE164: "+14155550133",
    persona: null,
    userLanguage: "en",
    turns: [
      A(GREETING_EN),
      C("Hi, this is Jenny from the Medicare benefits center. Dolores qualifies for a new Medicare card with extra benefits this year."),
      A("What does she need to do?"),
      C("I just need to confirm her Medicare number and date of birth, and we'll mail the new card out this week."),
      A("She'll contact Medicare herself to confirm."),
      C("That's fine, but the enrollment window closes soon, so she should call us back today."),
    ],
  },

  // ---- GREEN ----------------------------------------------------------------------------
  {
    id: "green-dentist",
    title: "Dentist appointment reminder (aliased to P01)",
    expect: "green",
    callerE164: "+14155550101",
    persona: "P01",
    userLanguage: "en",
    turns: [
      A(GREETING_EN),
      C("Hi, this is Margaret from Bayview Family Dentistry. I'm calling to remind Dolores about her cleaning this Thursday at 10:30 with Dr. Patel."),
      A("Thank you. Does she need to bring anything?"),
      C("No, nothing at all. If she needs to reschedule she can call the front desk. Have a nice day!"),
    ],
  },
  {
    id: "green-library",
    title: "Library hold is ready (unaliased)",
    expect: "green",
    callerE164: "+14155550144",
    persona: null,
    userLanguage: "en",
    turns: [
      A(GREETING_EN),
      C("Hello, this is Tom from the Elmwood branch library. The book Dolores put on hold has come in."),
      A("Thanks. How long will it be held?"),
      C("We'll keep it at the front desk for seven days. No need to call back, she can just pick it up with her library card."),
    ],
  },

  // ---- Spanish --------------------------------------------------------------------------
  {
    id: "es-red-debt",
    title: "Spanish: fake Capital One debt, gift cards and wire, secrecy (user language es)",
    expect: "red",
    callerE164: "+14155550155",
    persona: "P13",
    userLanguage: "es",
    turns: [
      A("Hola, habla el asistente que filtra las llamadas de Dolores. ¿Quién llama y por qué motivo?"),
      C(
        "Buenas tardes, le habla el licenciado Ramírez de la agencia de cobranzas Crédito Nacional. La señora Dolores " +
          "tiene una deuda vencida de 1,800 dólares en su tarjeta de Capital One.",
      ),
      A("¿Me puede dar un número de referencia y un teléfono para devolver la llamada?"),
      C("No hay tiempo. Si no paga hoy mismo, la vamos a reportar a las autoridades y la pueden arrestar. Tiene que pagar inmediatamente."),
      A("¿Cómo pide que se haga el pago?"),
      C(
        "Puede pagar con tarjetas de regalo de Google Play o con una transferencia por Western Union. " +
          "Y no le diga nada a su familia, esto es confidencial.",
      ),
    ],
  },
];
