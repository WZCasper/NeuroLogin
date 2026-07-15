import { Answer } from './types';

/**
 * Replaces {Field Name} placeholders in a trigger's response text with the
 * matching survey answer for the user who triggered it. A field with no
 * recorded answer (user never finished the survey, or the name doesn't
 * match) is replaced with an empty string rather than left as raw {…} text,
 * so the message stays readable for everyone else in the group.
 */
export function substituteVariables(
  text: string,
  answers: Record<string, Answer> | undefined
): string {
  return text.replace(/\{([^{}]+)\}/g, (_match, rawName: string) => {
    const fieldName = rawName.trim();
    if (!answers) return '';
    const found = Object.values(answers).find((a) => a.field === fieldName);
    return found ? found.value : '';
  });
}
