import fs from 'fs';
import path from 'path';
import { SurveyStep, UsersDb, SessionsDb } from './types';

const DATA_DIR = path.resolve(__dirname, '..', '..', '..', 'data');
const MEDIA_DIR = path.join(DATA_DIR, 'media');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');
const SURVEY_FILE = path.resolve(__dirname, '..', 'config', 'survey.json');
const SURVEY_OVERRIDE_FILE = path.join(DATA_DIR, 'survey.json');

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function readJson<T>(filePath: string, fallback: T): T {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, 'utf-8');
    if (!raw.trim()) return fallback;
    return JSON.parse(raw) as T;
  } catch (err) {
    console.error(`Failed to read ${filePath}:`, err);
    return fallback;
  }
}

function writeJson(filePath: string, data: unknown): void {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

export function loadUsers(): UsersDb {
  return readJson<UsersDb>(USERS_FILE, {});
}

export function saveUsers(db: UsersDb): void {
  writeJson(USERS_FILE, db);
}

export function loadSessions(): SessionsDb {
  return readJson<SessionsDb>(SESSIONS_FILE, {});
}

export function saveSessions(db: SessionsDb): void {
  writeJson(SESSIONS_FILE, db);
}

export function loadSurvey(): SurveyStep[] {
  // Admin panel can override the survey definition without touching bot code.
  if (fs.existsSync(SURVEY_OVERRIDE_FILE)) {
    return readJson<SurveyStep[]>(SURVEY_OVERRIDE_FILE, []);
  }
  return readJson<SurveyStep[]>(SURVEY_FILE, []);
}

export function saveMediaFile(
  userId: number,
  field: string,
  buffer: Buffer,
  extension: string
): string {
  const userMediaDir = path.join(MEDIA_DIR, String(userId));
  ensureDir(userMediaDir);
  const safeField = field.replace(/[^a-zA-Z0-9_-]/g, '_');
  const fileName = `${safeField}${extension}`;
  const filePath = path.join(userMediaDir, fileName);
  fs.writeFileSync(filePath, buffer);
  return path.relative(path.resolve(__dirname, '..', '..', '..'), filePath);
}

export const paths = {
  DATA_DIR,
  MEDIA_DIR,
  USERS_FILE,
  SESSIONS_FILE,
};
