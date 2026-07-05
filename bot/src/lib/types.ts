export type StepType = 'text' | 'photo' | 'file';

export interface SurveyStep {
  id: string;
  field: string;
  question: string;
  type: StepType;
  next?: string;
  branches?: Record<string, string>;
  default?: string;
  optional?: boolean;
}

export interface Answer {
  field: string;
  value: string;
  mediaPath?: string;
}

export interface UserSession {
  chatId: number;
  userId: number;
  username?: string;
  currentStepId: string;
  answers: Record<string, Answer>;
  awaitingConfirm: boolean;
  startedAt: string;
}

export interface UserRecord {
  userId: number;
  username?: string;
  chatId: number;
  answers: Record<string, Answer>;
  confirmedAt: string;
  updatedAt: string;
}

export interface UsersDb {
  [userId: string]: UserRecord;
}

export interface SessionsDb {
  [userId: string]: UserSession;
}
