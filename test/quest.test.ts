import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dayKey, eligible, filterNotes, initialState, parseState, recordOpen, refreshQuest, reminderDue, renamePath, yesterdayKey } from '../src/quest.ts';

const files = ['one.md', 'two.md', 'three.md', 'four.md', 'five.md', 'six.md', 'seven.md'];
const today = new Date(2026, 9, 13, 12);
const first = () => 0;
function ready(now = today) {
  const state = initialState();
  refreshQuest(state, files, now, first);
  return state;
}
function finish(state: ReturnType<typeof ready>, now: Date) {
  for (const path of state.quest!.notes) recordOpen(state, path, now);
}

test('selects five distinct notes without changing the source list', () => {
  const source = [...files];
  const state = initialState();
  const draws = [0.9, 0.2, 0.6, 0.1, 0.4];
  refreshQuest(state, source, today, () => draws.shift()!);
  assert.equal(state.quest!.notes.length, 5);
  assert.equal(new Set(state.quest!.notes).size, 5);
  assert.ok(state.quest!.notes.every(path => source.includes(path)));
  assert.deepEqual(source, files);
});

test('persists the daily set and partial progress through a reload', () => {
  const state = ready();
  recordOpen(state, 'one.md', today);
  state.nextReminderAt = today.getTime() + 3_600_000;
  const restored = parseState(JSON.parse(JSON.stringify(state)));
  refreshQuest(restored, files, today, () => { throw new Error('Must not reroll'); });
  assert.deepEqual(restored, state);
});

test('only selected notes count and repeat opens cannot earn duplicate credit or rewards', () => {
  const state = ready();
  assert.equal(recordOpen(state, 'seven.md', today), 'none');
  assert.equal(recordOpen(state, 'one.md', today), 'opened');
  assert.equal(recordOpen(state, 'one.md', today), 'none');
  finish(state, today);
  finish(state, today);
  assert.equal(state.quest!.opened.length, 5);
  assert.equal(state.completedDays, 1);
  assert.equal(state.streak, 1);
  assert.equal(state.quest!.rewarded, true);
});

test('a new local day clears daily progress and preserves a consecutive streak', () => {
  const state = ready();
  finish(state, today);
  const tomorrow = new Date(2026, 9, 14, 0, 1);
  refreshQuest(state, files, tomorrow, first);
  assert.equal(state.quest!.date, '2026-10-14');
  assert.deepEqual(state.quest!.opened, []);
  assert.equal(state.streak, 1);
  finish(state, tomorrow);
  assert.equal(state.streak, 2);
  assert.equal(state.bestStreak, 2);
  assert.equal(state.completedDays, 2);
});

test('a missed day resets the current streak but keeps records', () => {
  const state = ready();
  finish(state, today);
  const next = new Date(2026, 9, 14, 12);
  refreshQuest(state, files, next, first);
  finish(state, next);
  const afterGap = new Date(2026, 9, 16, 12);
  refreshQuest(state, files, afterGap, first);
  assert.equal(state.streak, 0);
  assert.equal(state.bestStreak, 2);
  finish(state, afterGap);
  assert.equal(state.streak, 1);
  assert.equal(state.completedDays, 3);
});

test('fewer than five notes do not award a completed day, and new notes fill empty slots', () => {
  const state = initialState();
  refreshQuest(state, files.slice(0, 3), today, first);
  finish(state, today);
  assert.equal(state.quest!.rewarded, false);
  assert.equal(state.completedDays, 0);
  refreshQuest(state, files, today, first);
  assert.equal(state.quest!.notes.length, 5);
  assert.equal(state.quest!.opened.length, 3);
  finish(state, today);
  assert.equal(state.completedDays, 1);
});

test('empty vault waits for notes without reminders', () => {
  const state = initialState();
  refreshQuest(state, [], today, first);
  assert.equal(reminderDue(state, today.getTime(), true), false);
  assert.equal(state.quest!.rewarded, false);
});

test('folder exclusions honor path boundaries and apply to nested folders', () => {
  assert.equal(eligible('Archive/deep/note.md', ['Archive']), false);
  assert.equal(eligible('Archive2/note.md', ['Archive']), true);
  const state = ready();
  recordOpen(state, 'one.md', today);
  state.settings.excludedFolders = ['one.md', 'two.md'];
  refreshQuest(state, files, today, first);
  assert.ok(state.quest!.opened.includes('one.md'));
  assert.ok(state.quest!.notes.includes('one.md'));
  assert.ok(!state.quest!.notes.includes('two.md'));
  assert.equal(state.quest!.notes.length, 5);
});

test('deleting an unread note replaces it, deleting an opened note preserves credit', () => {
  const state = ready();
  recordOpen(state, 'one.md', today);
  refreshQuest(state, files.filter(path => path !== 'one.md' && path !== 'two.md'), today, first);
  assert.deepEqual(state.quest!.opened, ['one.md']);
  assert.ok(!state.quest!.notes.includes('two.md'));
  assert.equal(state.quest!.notes.length, 5);
  finish(state, today);
  assert.equal(state.completedDays, 1);
});

test('renaming notes and folders preserves both the selection and credit', () => {
  const state = initialState();
  refreshQuest(state, ['Folder/a.md', 'Folder/b.md', 'Folder2/c.md', 'd.md', 'e.md'], today, first);
  recordOpen(state, 'Folder/a.md', today);
  renamePath(state, 'Folder', 'New');
  assert.deepEqual(state.quest!.opened, ['New/a.md']);
  assert.ok(state.quest!.notes.includes('New/b.md'));
  assert.ok(state.quest!.notes.includes('Folder2/c.md'));
  renamePath(state, 'New/a.md', 'New/renamed.md');
  assert.equal(recordOpen(state, 'New/renamed.md', today), 'none');
});

test('reminders respect visibility, interval, snooze, disabled setting and completion', () => {
  const state = ready();
  const now = today.getTime();
  assert.equal(reminderDue(state, now, true), true);
  assert.equal(reminderDue(state, now, false), false);
  state.nextReminderAt = now + 3_600_000;
  assert.equal(reminderDue(state, now, true), false);
  assert.equal(reminderDue(state, now + 3_600_000, true), true);
  state.settings.reminders = false;
  assert.equal(reminderDue(state, now + 3_600_000, true), false);
  state.settings.reminders = true;
  finish(state, today);
  assert.equal(reminderDue(state, now + 3_600_000, true), false);
});

test('local calendar day and yesterday work at year, month, and daylight-saving boundaries', () => {
  assert.equal(dayKey(new Date(2026, 0, 1, 0, 5)), '2026-01-01');
  assert.equal(yesterdayKey(new Date(2026, 0, 1, 0, 5)), '2025-12-31');
  assert.equal(yesterdayKey(new Date(2024, 2, 1, 0, 5)), '2024-02-29');
  assert.equal(yesterdayKey(new Date(2026, 2, 30, 0, 5)), '2026-03-29');
});

test('corrupt or unsupported saved data fails explicitly instead of resetting progress', () => {
  assert.deepEqual(parseState(null), initialState());
  for (const raw of [{}, { version: 2 }, { ...ready(), streak: -1 },
    { ...ready(), settings: { reminders: true } },
    { ...ready(), settings: { ...initialState().settings, dailyGoal: 0 } },
    { ...ready(), quest: { date: '2026-10-13', goal: 5, notes: ['a.md', 'a.md'], opened: [], rewarded: false } },
    { ...ready(), quest: { date: '2026-10-13', goal: 5, notes: ['a.md'], opened: ['a.md'], rewarded: true } }]) {
    assert.throws(() => parseState(raw));
  }
});

test('v1 and v2 migrate to a goal of five while preserving progress and reminder settings', () => {
  const current = ready();
  finish(current, today);
  const { goal, ...oldQuest } = current.quest!;
  const { dailyGoal, ...v2Settings } = current.settings;
  const { sourceFolder, excludedFiles, excludedTags, ...v1Settings } = v2Settings;
  assert.deepEqual(parseState({ ...current, version: 1, settings: v1Settings, quest: oldQuest }), current);
  assert.deepEqual(parseState({ ...current, version: 2, settings: v2Settings, quest: oldQuest }), current);
  assert.throws(() => parseState({ ...current, version: 2, settings: v1Settings, quest: oldQuest }));
});

test('a new goal applies on rollover and completion uses the saved quest goal', () => {
  const state = ready();
  recordOpen(state, 'one.md', today);
  state.settings.dailyGoal = 3;
  refreshQuest(state, files, today, first);
  assert.equal(state.quest!.goal, 5);
  assert.deepEqual(state.quest!.opened, ['one.md']);
  finish(state, today);

  const restored = parseState(JSON.parse(JSON.stringify(state)));
  const tomorrow = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1, 12);
  refreshQuest(restored, files, tomorrow, first);
  assert.equal(restored.quest!.goal, 3);
  assert.equal(restored.quest!.notes.length, 3);
  finish(restored, tomorrow);
  assert.equal(restored.quest!.opened.length, 3);
  assert.equal(restored.completedDays, 2);
  assert.equal(restored.streak, 2);
});

test('source folder includes descendants, ignores exact file paths, and respects folder boundaries', () => {
  const settings = initialState().settings;
  settings.sourceFolder = 'Notes';
  settings.excludedFiles = ['Notes/index.md'];
  settings.excludedFolders = ['Notes/templates'];
  const paths = ['Notes/index.md', 'Notes/a.md', 'Notes/sub/b.md', 'Notes/templates/c.md', 'Notes2/d.md', 'Elsewhere/a.md'];
  assert.deepEqual(filterNotes(paths.map(path => ({ path, tags: [] })), settings), ['Notes/a.md', 'Notes/sub/b.md']);
});

test('tag exclusion accepts a hash or no hash, ignores case, and includes nested tags only', () => {
  const settings = initialState().settings;
  settings.excludedTags = ['Archive', '#skip'];
  const notes = [
    { path: 'a.md', tags: ['#ARCHIVE'] }, { path: 'b.md', tags: ['#archive/old'] },
    { path: 'c.md', tags: ['#archived'] }, { path: 'd.md', tags: ['#skip'] }, { path: 'e.md', tags: [] },
  ];
  assert.deepEqual(filterNotes(notes, settings), ['c.md', 'e.md']);
});

test('renaming folders and files updates configured path filters without touching tags', () => {
  const state = ready();
  state.settings.sourceFolder = 'Notes';
  state.settings.excludedFolders = ['Notes/templates', 'Notes2'];
  state.settings.excludedFiles = ['Notes/index.md'];
  state.settings.excludedTags = ['#Notes'];
  renamePath(state, 'Notes', 'New');
  renamePath(state, 'New/index.md', 'New/home.md');
  assert.equal(state.settings.sourceFolder, 'New');
  assert.deepEqual(state.settings.excludedFolders, ['New/templates', 'Notes2']);
  assert.deepEqual(state.settings.excludedFiles, ['New/home.md']);
  assert.deepEqual(state.settings.excludedTags, ['#Notes']);
});
