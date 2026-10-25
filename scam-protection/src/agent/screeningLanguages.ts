
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
