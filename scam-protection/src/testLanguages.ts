
import "dotenv/config";
import { writeFile } from "node:fs/promises";
import { generateSpeech } from "./agent/cartesiaTTS.js";
import type {
  ScreeningLanguage,
} from "./agent/screeningLanguages.js";

const tests: {
  language: ScreeningLanguage;
  text: string;
}[] = [
  {
    language: "en",
    text: "Hello! This is InterHoot.",
  },
  {
    language: "es",
    text: "¡Hola! Soy InterHoot.",
  },
  {
    language: "ru",
    text: "Здравствуйте! Это InterHoot.",
  },
  {
    language: "ko",
    text: "안녕하세요! InterHoot입니다.",
  },
];

async function main() {
  for (const test of tests) {
    try {
      console.log(`Testing ${test.language}...`);

      const audio = await generateSpeech(
        test.text,
        undefined,
        test.language
      );

      const filename = `test-${test.language}.ulaw`;

      await writeFile(filename, audio);

      console.log(
        `${test.language}: SUCCESS (${audio.length} bytes)`
      );
    } catch (error) {
      console.error(
        `${test.language}: FAILED`,
        error
      );
    }
  }
}

void main();
