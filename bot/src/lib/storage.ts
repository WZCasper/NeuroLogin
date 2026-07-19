import fs from 'fs';
import path from 'path';
import {
  SurveyStep,
  UsersDb,
  SessionsDb,
  GroupsDb,
  GroupRecord,
  TriggerRule,
  BasesDb,
  BaseRecord,
} from './types';

const DATA_DIR = path.resolve(__dirname, '..', '..', '..', 'data');
const GROUPS_DIR = path.join(DATA_DIR, 'groups');
const GROUPS_FILE = path.join(DATA_DIR, 'groups.json');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');
const BASES_DIR = path.join(DATA_DIR, 'bases');
const BASES_FILE = path.join(DATA_DIR, 'bases.json');
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

function baseDir(baseId: string): string {
  return path.join(BASES_DIR, baseId);
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

// ---------- Shared bases (triggers + survey + users, usable by many groups) ----------

export function loadBases(): BasesDb {
  return readJson<BasesDb>(BASES_FILE, {});
}

export function saveBases(db: BasesDb): void {
  writeJson(BASES_FILE, db);
}

export function getBase(baseId: string): BaseRecord | undefined {
  return loadBases()[baseId];
}

export function createBase(name: string, ownerUserId: number, ownerUsername?: string): BaseRecord {
  const bases = loadBases();
  const id = 'base_' + Math.random().toString(36).slice(2, 10);
  const record: BaseRecord = { id, name, ownerUserId, ownerUsername, createdAt: new Date().toISOString() };
  bases[id] = record;
  saveBases(bases);
  ensureDir(baseDir(id));
  return record;
}

export function attachGroupToBase(groupChatId: number, baseId: string): void {
  const groups = loadGroups();
  const g = groups[String(groupChatId)];
  if (!g) return;
  g.baseId = baseId;
  groups[String(groupChatId)] = g;
  saveGroups(groups);
}

export function detachGroupFromBase(groupChatId: number): void {
  const groups = loadGroups();
  const g = groups[String(groupChatId)];
  if (!g) return;
  delete g.baseId;
  groups[String(groupChatId)] = g;
  saveGroups(groups);
}

/**
 * Resolves where a group's survey/triggers/users/media actually live: its
 * own private storage, or — if it's attached to a shared base — the base's
 * storage instead. Centralizing this here means callers (survey engine,
 * trigger matching, finalizeSurvey) never need to know bases exist.
 */
function storageRoot(groupChatId: number): string {
  const group = getGroup(groupChatId);
  if (group?.baseId) {
    return baseDir(group.baseId);
  }
  return groupDir(groupChatId);
}

// ---------- Per-group (or per-base) users ----------

export function loadUsers(groupChatId: number): UsersDb {
  return readJson<UsersDb>(path.join(storageRoot(groupChatId), 'users.json'), {});
}

export function saveUsers(groupChatId: number, db: UsersDb): void {
  writeJson(path.join(storageRoot(groupChatId), 'users.json'), db);
}

// ---------- Global sessions (one active survey per Telegram user in DM) ----------

export function loadSessions(): SessionsDb {
  return readJson<SessionsDb>(SESSIONS_FILE, {});
}

export function saveSessions(db: SessionsDb): void {
  writeJson(SESSIONS_FILE, db);
}

// ---------- Survey configuration (global default, per-group/per-base override) ----------

export function loadSurvey(groupChatId: number): SurveyStep[] {
  const overridePath = path.join(storageRoot(groupChatId), 'survey.json');
  if (fs.existsSync(overridePath)) {
    return readJson<SurveyStep[]>(overridePath, []);
  }
  if (fs.existsSync(DEFAULT_SURVEY_OVERRIDE_FILE)) {
    return readJson<SurveyStep[]>(DEFAULT_SURVEY_OVERRIDE_FILE, []);
  }
  return readJson<SurveyStep[]>(DEFAULT_SURVEY_FILE, []);
}

export function saveSurveyOverride(groupChatId: number, survey: SurveyStep[]): void {
  writeJson(path.join(storageRoot(groupChatId), 'survey.json'), survey);
}

// ---------- Keyword triggers (per group or per shared base) ----------

export function loadTriggers(groupChatId: number): TriggerRule[] {
  return readJson<TriggerRule[]>(path.join(storageRoot(groupChatId), 'triggers.json'), []);
}

export function saveTriggers(groupChatId: number, triggers: TriggerRule[]): void {
  writeJson(path.join(storageRoot(groupChatId), 'triggers.json'), triggers);
}

// ---------- Media ----------

export function saveMediaFile(
  groupChatId: number,
  userId: number,
  field: string,
  buffer: Buffer,
  extension: string
): string {
  const userMediaDir = path.join(storageRoot(groupChatId), 'media', String(userId));
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
  BASES_DIR,
  BASES_FILE,
};
