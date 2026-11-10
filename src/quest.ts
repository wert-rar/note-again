import { en } from './messages.ts';

export const DEFAULT_GOAL = 5;
export const RECOMMENDED_GOAL_MAX = 12;

export function isDailyGoal(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

export interface Quest {
  date: string;
  goal: number;
  notes: string[];
  opened: string[];
  rewarded: boolean;
}

export interface Settings {
  dailyGoal: number;
  reminders: boolean;
  intervalMinutes: number;
  excludedFolders: string[];
  sourceFolder: string;
  excludedFiles: string[];
  excludedTags: string[];
}

export interface State {
  version: 3;
  settings: Settings;
  quest: Quest | null;
  streak: number;
  bestStreak: number;
  completedDays: number;
  lastCompletedDate: string | null;
  nextReminderAt: number;
}

export function initialState(): State {
  return {
    version: 3,
    settings: { dailyGoal: DEFAULT_GOAL, reminders: true, intervalMinutes: 60, excludedFolders: [], sourceFolder: '', excludedFiles: [], excludedTags: [] },
    quest: null,
    streak: 0,
    bestStreak: 0,
    completedDays: 0,
    lastCompletedDate: null,
    nextReminderAt: 0,
  };
}

// Only persisted external data is validated. Internal calls trust these contracts.
export function parseState(raw: unknown, messages: Pick<typeof en, 'invalidData' | 'corruptData' | 'corruptFilters'> = en): State {
  if (raw === null || raw === undefined) return initialState();
  const isObject = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v);
  const integer = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
  const date = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
  const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every(x => typeof x === 'string' && x.length > 0);
  const unique = (v: string[]) => new Set(v).size === v.length;
  if (!isObject(raw) || (raw.version !== 1 && raw.version !== 2 && raw.version !== 3) || !isObject(raw.settings)) {
    throw new Error(messages.invalidData);
  }
  const s = raw.settings;
  const q = raw.quest;
  const goal = raw.version === 3 && isObject(q) ? q.goal : DEFAULT_GOAL;
  const validQuest = q === null || (isObject(q) && date(q.date) && strings(q.notes) &&
    isDailyGoal(goal) && strings(q.opened) && unique(q.notes) && unique(q.opened) && q.notes.length <= goal &&
    q.opened.every(p => (q.notes as string[]).includes(p)) && typeof q.rewarded === 'boolean' &&
    q.rewarded === (q.opened.length === goal));
  if (typeof s.reminders !== 'boolean' || !integer(s.intervalMinutes) ||
    s.intervalMinutes < 15 || s.intervalMinutes > 240 || !strings(s.excludedFolders) ||
    (raw.version === 3 && !isDailyGoal(s.dailyGoal)) ||
    !validQuest || !integer(raw.streak) || !integer(raw.bestStreak) || !integer(raw.completedDays) ||
    !integer(raw.nextReminderAt) || !(raw.lastCompletedDate === null || date(raw.lastCompletedDate))) {
    throw new Error(messages.corruptData);
  }
  if (raw.version !== 1 && (typeof s.sourceFolder !== 'string' || !strings(s.excludedFiles) || !strings(s.excludedTags))) {
    throw new Error(messages.corruptFilters);
  }
  if (raw.version !== 3) {
    const previous = raw as unknown as State;
    const filters = raw.version === 1 ? { sourceFolder: '', excludedFiles: [], excludedTags: [] } : {};
    return {
      ...previous,
      version: 3,
      settings: { ...previous.settings, ...filters, dailyGoal: DEFAULT_GOAL },
      quest: previous.quest && { ...previous.quest, goal: DEFAULT_GOAL },
    };
  }
  return raw as unknown as State;
}

export function dayKey(now: Date): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

export function yesterdayKey(now: Date): string {
  const previous = new Date(now);
  previous.setDate(previous.getDate() - 1);
  return dayKey(previous);
}

export function eligible(path: string, excludedFolders: string[]): boolean {
  return !excludedFolders.some(folder => path === folder || path.startsWith(`${folder}/`));
}

export function filterNotes(notes: { path: string; tags: string[] }[], settings: Settings): string[] {
  const normalizeTag = (tag: string) => `#${tag.replace(/^#/, '').toLowerCase()}`;
  const ignoredTags = settings.excludedTags.map(normalizeTag);
  return notes.filter(({ path, tags }) =>
    (settings.sourceFolder === '' || path.startsWith(`${settings.sourceFolder}/`)) &&
    eligible(path, settings.excludedFolders) && !settings.excludedFiles.includes(path) &&
    !tags.some(tag => ignoredTags.some(ignored => normalizeTag(tag) === ignored || normalizeTag(tag).startsWith(`${ignored}/`)))
  ).map(note => note.path);
}

// Partial Fisher-Yates: uniformly choose distinct paths without changing the input.
function pick(paths: string[], count: number, random: () => number): string[] {
  const pool = [...paths];
  const take = Math.min(count, pool.length);
  for (let i = 0; i < take; i++) {
    const index = i + Math.floor(random() * (pool.length - i));
    [pool[i], pool[index]] = [pool[index], pool[i]];
  }
  return pool.slice(0, take);
}

export function refreshQuest(state: State, paths: string[], now: Date, random = Math.random): void {
  const today = dayKey(now);
  if (state.quest?.date !== today) {
    if (state.lastCompletedDate !== yesterdayKey(now) && state.lastCompletedDate !== today) state.streak = 0;
    state.quest = { date: today, goal: state.settings.dailyGoal, notes: [], opened: [], rewarded: false };
    state.nextReminderAt = 0;
  }
  const quest = state.quest;
  const candidates = new Set(paths.filter(path => eligible(path, state.settings.excludedFolders)));
  const opened = new Set(quest.opened);
  // Preserve earned credit; replace deleted or newly excluded unopened notes.
  quest.notes = quest.notes.filter(path => opened.has(path) || candidates.has(path));
  for (const path of quest.notes) candidates.delete(path);
  for (const path of pick([...candidates], quest.goal - quest.notes.length, random)) quest.notes.push(path);
}

export function recordOpen(state: State, path: string, now: Date): 'none' | 'opened' | 'completed' {
  const quest = state.quest!;
  if (!quest.notes.includes(path) || quest.opened.includes(path)) return 'none';
  quest.opened.push(path);
  if (quest.opened.length !== quest.goal) return 'opened';
  quest.rewarded = true;
  state.streak = state.lastCompletedDate === yesterdayKey(now) ? state.streak + 1 : 1;
  state.bestStreak = Math.max(state.bestStreak, state.streak);
  state.completedDays++;
  state.lastCompletedDate = quest.date;
  return 'completed';
}

export function renamePath(state: State, oldPath: string, newPath: string): void {
  const rename = (path: string) => path === oldPath ? newPath :
    path.startsWith(`${oldPath}/`) ? `${newPath}${path.slice(oldPath.length)}` : path;
  state.settings.sourceFolder = rename(state.settings.sourceFolder);
  state.settings.excludedFolders = state.settings.excludedFolders.map(rename);
  state.settings.excludedFiles = state.settings.excludedFiles.map(rename);
  if (!state.quest) return;
  state.quest.notes = state.quest.notes.map(rename);
  state.quest.opened = state.quest.opened.map(rename);
}

export function reminderDue(state: State, now: number, visible: boolean): boolean {
  return visible && state.settings.reminders && state.quest !== null && !state.quest.rewarded &&
    state.quest.notes.some(path => !state.quest!.opened.includes(path)) && now >= state.nextReminderAt;
}
