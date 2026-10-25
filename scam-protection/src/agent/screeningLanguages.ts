
export type ScreeningLanguage =
  | "en"
  | "es"
  | "ru"
  | "ko";

export const DEFAULT_LANGUAGE: ScreeningLanguage = "en";

export const screeningQuestions: Record<
  ScreeningLanguage,
  string[]
> = {
  en: [
    "Hello! This is InterHoot. May I ask who's calling and why?",
    "What organization are you calling from?",
    "Can you explain why you need to contact this person?",
    "Is there an official phone number where your organization can be reached?",
  ],

  es: [
    "¡Hola! Soy InterHoot. ¿Me puede decir quién llama y por qué?",
    "¿De qué organización llama?",
    "¿Puede explicar por qué necesita contactar a esta persona?",
    "¿Hay algún número de teléfono oficial donde podamos contactar a su organización?",
  ],

  ru: [
    "Здравствуйте! Это InterHoot. Скажите, пожалуйста, кто звонит и по какому вопросу?",
    "Из какой организации вы звоните?",
    "Можете объяснить, почему вам нужно связаться с этим человеком?",
    "Есть ли официальный номер телефона, по которому можно связаться с вашей организацией?",
  ],

  ko: [
    "안녕하세요! InterHoot입니다. 누구시며 어떤 일로 전화하셨는지 말씀해 주시겠어요?",
    "어느 기관에서 전화하셨나요?",
    "이분께 연락하셔야 하는 이유를 설명해 주시겠어요?",
    "해당 기관에 연락할 수 있는 공식 전화번호가 있나요?",
  ],
};

export function getScreeningQuestion(
  language: ScreeningLanguage,
  questionIndex: number
): string {
  const questions = screeningQuestions[language];

  if (
    questionIndex < 0 ||
    questionIndex >= questions.length
  ) {
    throw new Error("Invalid screening question index.");
  }

  return questions[questionIndex];
}

// Yellow calls (build guide section 7): the agent takes a short message before it hangs up.
export const messagePrompts: Record<ScreeningLanguage, string> = {
  en: "Thank you. They can't take your call right now. Please leave a short message, and I will pass it on.",
  es: "Gracias. No puede atender su llamada en este momento. Por favor, deje un mensaje breve y se lo haré llegar.",
  ru: "Спасибо. Сейчас этот человек не может ответить на звонок. Пожалуйста, оставьте короткое сообщение, и я его передам.",
  ko: "감사합니다. 지금은 전화를 받을 수 없습니다. 짧은 메시지를 남겨 주시면 전달해 드리겠습니다.",
};

/** "es-MX" → "es". Empty when there is no code. */
export function baseLanguage(code: string | undefined | null): string {
  return (code ?? "").trim().split(/[-_]/)[0].toLowerCase();
}

/** The fixed-line language for a code, or null when there are no fixed lines for it. */
export function toScreeningLanguage(code: string | undefined | null): ScreeningLanguage | null {
  const base = baseLanguage(code);
  return base in screeningQuestions ? (base as ScreeningLanguage) : null;
}

// Languages the sonic-3 TTS model speaks (Cartesia's older-models page, snapshot sonic-3-2026-01-12).
export const TTS_LANGUAGES = new Set([
  "en", "de", "es", "fr", "ja", "pt", "zh", "hi", "ko", "it", "nl", "pl", "ru", "sv", "tr", "tl", "bg",
  "ro", "ar", "cs", "el", "fi", "hr", "ms", "sk", "da", "ta", "uk", "hu", "no", "vi", "bn", "th", "he",
  "ka", "id", "te", "gu", "kn", "ml", "mr", "pa",
]);

export type SpeechPart = { text: string; language: string };

/** Section 4: the greeting is in the user's language, then English. */
export function getGreetingParts(language: ScreeningLanguage): SpeechPart[] {
  const english = { text: screeningQuestions.en[0], language: "en" };
  return language === "en"
    ? [english]
    : [{ text: screeningQuestions[language][0], language }, english];
}
