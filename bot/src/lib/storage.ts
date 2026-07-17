import fs from 'fs';
import path from 'path';
import { SurveyStep, UsersDb, SessionsDb, GroupsDb, GroupRecord, TriggerRule } from './types';

const DATA_DIR = path.resolve(__dirname, '..', '..', '..', 'data');
const GROUPS_DIR = path.join(DATA_DIR, 'groups');
const GROUPS_FILE = path.join(DATA_DIR, 'groups.json');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');
const DEFAULT_SURVEY_FILE = path.resolve(__dirname, '..', 'config', 'survey.json');
const DEFAULT_SURVEY_OVERRIDE_FILE = path.join(DATA_DIR, 'survey.json');

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

function groupDir(groupChatId: number): string {
  return path.join(GROUPS_DIR, String(groupChatId));
}

function groupUsersFile(groupChatId: number): string {
  return path.join(groupDir(groupChatId), 'users.json');
}

function groupSurveyFile(groupChatId: number): string {
  return path.join(groupDir(groupChatId), 'survey.json');
}

function groupTriggersFile(groupChatId: number): string {
  return path.join(groupDir(groupChatId), 'triggers.json');
}

function groupMediaDir(groupChatId: number): string {
  return path.join(groupDir(groupChatId), 'media');
}

// ---------- Groups registry ----------

export function loadGroups(): GroupsDb {
  return readJson<GroupsDb>(GROUPS_FILE, {});
}

export function saveGroups(db: GroupsDb): void {
  writeJson(GROUPS_FILE, db);
}

export function registerGroup(record: GroupRecord): void {
  const groups = loadGroups();
  groups[String(record.chatId)] = record;
  saveGroups(groups);
  ensureDir(groupDir(record.chatId));
}

export function getGroup(chatId: number): GroupRecord | undefined {
  const groups = loadGroups();
  return groups[String(chatId)];
}

export function isKnownGroup(chatId: number): boolean {
  return !!getGroup(chatId);
}

// ---------- Per-group users ----------

export function loadUsers(groupChatId: number): UsersDb {
  return readJson<UsersDb>(groupUsersFile(groupChatId), {});
}

export function saveUsers(groupChatId: number, db: UsersDb): void {
  writeJson(groupUsersFile(groupChatId), db);
}

// ---------- Global sessions (one active survey per Telegram user in DM) ----------

export function loadSessions(): SessionsDb {
  return readJson<SessionsDb>(SESSIONS_FILE, {});
}

export function saveSessions(db: SessionsDb): void {
  writeJson(SESSIONS_FILE, db);
}

// ---------- Survey configuration (global default, optional per-group override) ----------

export function loadSurvey(groupChatId: number): SurveyStep[] {
  const overridePath = groupSurveyFile(groupChatId);
  if (fs.existsSync(overridePath)) {
    return readJson<SurveyStep[]>(overridePath, []);
  }
  if (fs.existsSync(DEFAULT_SURVEY_OVERRIDE_FILE)) {
    return readJson<SurveyStep[]>(DEFAULT_SURVEY_OVERRIDE_FILE, []);
  }
  return readJson<SurveyStep[]>(DEFAULT_SURVEY_FILE, []);
}

export function saveSurveyOverride(groupChatId: number, survey: SurveyStep[]): void {
  writeJson(groupSurveyFile(groupChatId), survey);
}

// ---------- Keyword triggers (per group) ----------

export function loadTriggers(groupChatId: number): TriggerRule[] {
  return readJson<TriggerRule[]>(groupTriggersFile(groupChatId), []);
}

export function saveTriggers(groupChatId: number, triggers: TriggerRule[]): void {
  writeJson(groupTriggersFile(groupChatId), triggers);
}

// ---------- Media ----------

export function saveMediaFile(
  groupChatId: number,
  userId: number,
  field: string,
  buffer: Buffer,
  extension: string
): string {
  const userMediaDir = path.join(groupMediaDir(groupChatId), String(userId));
  ensureDir(userMediaDir);
  const safeField = field.replace(/[^a-zA-Z0-9_-]/g, '_');
  const fileName = `${safeField}${extension}`;
  const filePath = path.join(userMediaDir, fileName);
  fs.writeFileSync(filePath, buffer);
  return path.relative(path.resolve(__dirname, '..', '..', '..'), filePath);
}

export const paths = {
  DATA_DIR,
  GROUPS_DIR,
  GROUPS_FILE,
  SESSIONS_FILE,
};
