import { SurveyStep } from './types';

export function getStep(survey: SurveyStep[], stepId: string): SurveyStep | undefined {
  return survey.find((s) => s.id === stepId);
}

export function getFirstStep(survey: SurveyStep[]): SurveyStep | undefined {
  return survey[0];
}

/**
 * Resolves which step comes next based on the branching rules of the current step.
 * Branch matching is case-insensitive on the raw text answer.
 */
export function resolveNextStepId(step: SurveyStep, rawAnswer: string): string | undefined {
  if (step.branches) {
    const key = rawAnswer.trim().toLowerCase();
    if (step.branches[key]) {
      return step.branches[key];
    }
    if (step.default) {
      return step.default;
    }
  }
  return step.next;
}
