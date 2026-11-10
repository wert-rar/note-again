import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { initialState } from '../src/quest.ts';

// Exercise the actual distributable; run npm run build before this test suite.
const code = readFileSync(new URL('../dist/note-again/main.js', import.meta.url), 'utf8');
const paths = ['a.md', 'b.md', 'c.md', 'd.md', 'e.md'];

function fixture(saveData: (state: unknown) => Promise<void>, language?: string) {
  const notices: string[] = [];
  const noticeContents: any[] = [];
  const pickers: any[] = [];
  const controls: any[] = [];
  const tabs: any[] = [];
  const commands: { id: string; name: string }[] = [];
  class Element {
    children: Element[] = [];
    text = '';
    tag = '';
    attrs: Record<string, string> = {};
    value = '';
    hidden = false;
    onclick: any;
    style = { setProperty() {} };
    events = new Map<string, () => unknown>();
    get id() { return this.attrs.id; }
    get textContent() { return this.text; }
    get valueAsNumber() { return this.value === '' ? NaN : Number(this.value); }
    createEl(tag: string, options: any = {}) {
      const child = new Element();
      child.tag = tag; child.text = options.text ?? ''; child.attrs = options.attr ?? {};
      this.children.push(child); return child;
    }
    createDiv(options?: any) { return this.createEl('div', options); }
    createSpan(options?: any) { return this.createEl('span', options); }
    empty() { this.children = []; }
    addClass() {}
    focus() {}
    addEventListener(name: string, handler: () => unknown) { this.events.set(name, handler); }
    setText(text: string) { this.text = text; }
    setAttribute(name: string, value: string) { this.attrs[name] = value; }
  }
  class MockModal {
    modalEl = new Element();
    contentEl = new Element();
    onOpen() {}
    onClose() {}
    open() { this.onOpen(); }
    close() { this.onClose(); }
  }
  class Control {
    inputEl = new Element();
    callback: any;
    text = '';
    setButtonText(text: string) { this.text = text; return this; }
    onClick(callback: any) { this.callback = callback; return this; }
    onChange(callback: any) { this.callback = callback; return this; }
    addOption() { return this; }
    setValue(value: unknown) { this.inputEl.value = String(value); return this; }
    setLimits() { return this; }
    setDynamicTooltip() { return this; }
  }
  class MockSetting {
    name = '';
    control!: Control;
    controlEl = new Element();
    descEl = new Element();
    constructor(_container: any) { controls.push(this); }
    setName(name: string) { this.name = name; return this; }
    setDesc(text: string) { this.descEl.setText(text); return this; }
    addButton(callback: any) { this.control = new Control(); callback(this.control); return this; }
    addDropdown(callback: any) { return this.addButton(callback); }
    addToggle(callback: any) { return this.addButton(callback); }
    addSlider(callback: any) { return this.addButton(callback); }
  }
  class MockSettingTab { containerEl = new Element(); app: any; constructor(app: any) { this.app = app; } }
  class MockPicker {
    setPlaceholder() {}
    open() { pickers.push(this); }
  }
  class MockFolder {
    path: string;
    constructor(path: string) { this.path = path; }
    isRoot() { return this.path === ''; }
  }
  class MockFile {
    extension = 'md';
    path: string;
    constructor(path: string) { this.path = path; }
  }
  const files = paths.map(path => new MockFile(path));
  const events = new Map<string, (...args: any[]) => void>();
  const on = (name: string, handler: (...args: any[]) => void) => { events.set(name, handler); };
  const emit = (name: string, ...args: any[]) => events.get(name)!(...args);
  let layoutReady!: () => void;
  let now = new Date();
  const nextDay = () => { now = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 12); };
  class MockNotice {
    constructor(message: any) { noticeContents.push(message); if (typeof message === 'string') notices.push(message); }
    hide() {}
  }
  const module = { exports: {} as { default: new () => any } };
  const fakeDocument = { visibilityState: 'visible', createDocumentFragment: () => new Element() };
  runInNewContext(code, {
    module,
    exports: module.exports,
    require: (name: string) => {
      assert.equal(name, 'obsidian');
      return { Plugin: class {}, Modal: MockModal, PluginSettingTab: MockSettingTab, FuzzySuggestModal: MockPicker,
        Setting: MockSetting, TFolder: MockFolder, setIcon() {}, Notice: MockNotice, TFile: MockFile,
        getLanguage: language === undefined ? undefined : () => language,
        getAllTags: (cache: { tags?: { tag: string }[] }) => cache.tags?.map(entry => entry.tag) ?? [] };
    },
    document: fakeDocument,
    window: { setInterval: (callback: () => void) => on('timer', callback) },
    Date: class extends Date { constructor(value = now) { super(value); } },
    console: { error() {} },
  });
  const plugin = new module.exports.default();
  plugin.state = initialState();
  plugin.app = {
    vault: { on, getMarkdownFiles: () => files, getAllLoadedFiles: () => [...files, new MockFolder(''), new MockFolder('Archive')],
      getAbstractFileByPath: (path: string) => files.find(file => file.path === path) ?? null },
    metadataCache: { on, getFileCache: () => ({ tags: [] }) },
    workspace: { on, onLayoutReady(callback: () => void) { layoutReady = callback; }, getActiveFile: () => null },
  };
  plugin.loadData = async () => plugin.state;
  plugin.addRibbonIcon = () => {};
  plugin.addCommand = (command: { id: string; name: string }) => commands.push(command);
  plugin.addStatusBarItem = () => new Element();
  plugin.registerDomEvent = () => {};
  plugin.registerEvent = plugin.registerInterval = () => {};
  plugin.addSettingTab = (tab: any) => tabs.push(tab);
  plugin.saveData = saveData;
  plugin.render = () => {};
  return { plugin, notices, noticeContents, fakeDocument, pickers, controls, tabs, commands, files, emit, nextDay,
    currentTime: () => now.getTime(),
    addFile(path: string) { const file = new MockFile(path); files.push(file); return file; },
    startLayout: () => { layoutReady(); return plugin.pending; } };
}

test('the bundle follows the Obsidian language and uses English for unsupported languages', async () => {
  const english = {
    commands: ["Show today's quest", 'Open the next find'],
    sourceFolder: 'Source folder',
    goal: 'Daily note goal',
    increase: 'Increase daily goal by 1',
    nextButton: 'Open the next find →',
    credited: 'Find counted: 1/5',
  };
  const russian = {
    commands: ['Показать сегодняшний квест', 'Открыть следующую находку'],
    sourceFolder: 'Папка с заметками',
    goal: 'Дневная цель',
    increase: 'Увеличить дневную цель на 1',
    nextButton: 'Открыть следующую находку →',
    credited: 'Находка засчитана: 1/5',
  };
  for (const [language, expected] of [[undefined, english], ['en', english], ['de', english], ['ru', russian]] as const) {
    const { plugin, tabs, controls, commands, notices } = fixture(async () => {}, language);
    await plugin.onload();
    tabs[0].display();
    await plugin.showQuest();
    await plugin.update(undefined, 'a.md');

    assert.deepEqual(commands.map(command => command.id), ['show-quest', 'open-next']);
    assert.deepEqual(commands.map(command => command.name), expected.commands);
    assert.ok(controls.some(control => control.name === expected.sourceFolder));
    const goal = controls.find(control => control.name === expected.goal);
    assert.equal(goal.controlEl.children[0].children[2].attrs['aria-label'], expected.increase);
    assert.ok(plugin.questModal.contentEl.children.some((child: { text: string }) => child.text === expected.nextButton));
    assert.deepEqual(notices, [expected.credited]);
  }
});

test('rapid file-open events are serialized and persist all five notes exactly once', async () => {
  const saves: unknown[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const { plugin, notices, files, emit, startLayout, nextDay } = fixture(async state => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise(resolve => setTimeout(resolve, 2));
    saves.push(JSON.parse(JSON.stringify(state)));
    inFlight--;
  });
  let scans = 0;
  let metadataReads = 0;
  plugin.app.vault.getMarkdownFiles = () => { scans++; return files; };
  plugin.app.metadataCache.getFileCache = () => { metadataReads++; return { tags: [] }; };
  plugin.state.settings.reminders = false;
  await plugin.onload();
  await startLayout();
  for (const file of [...files, ...files]) emit('file-open', file);
  await plugin.pending;
  assert.equal(maxInFlight, 1);
  assert.equal(plugin.state.quest.opened.length, 5);
  assert.equal(plugin.state.completedDays, 1);
  assert.equal(saves.length, 6);
  assert.equal(notices.filter(text => text.startsWith('Quest complete!')).length, 1);
  const date = plugin.state.quest.date;
  nextDay();
  emit('timer');
  await plugin.pending;
  assert.notEqual(plugin.state.quest.date, date);
  assert.equal(plugin.state.quest.notes.length, 5);
  assert.equal(plugin.state.quest.opened.length, 0);
  assert.equal(scans, 1);
  assert.equal(metadataReads, 0);
});

test('vault events refresh candidates, replace unavailable notes and follow renames', async () => {
  const { plugin, files, emit, addFile, startLayout } = fixture(async () => {});
  let scans = 0;
  plugin.app.vault.getMarkdownFiles = () => { scans++; return files; };
  plugin.state.settings.reminders = false;
  await plugin.onload();
  await startLayout();
  const [opened, removed] = files;
  emit('file-open', opened);
  await plugin.pending;
  const oldPath = opened.path;
  opened.path = 'renamed.md';
  emit('rename', opened, oldPath);
  await plugin.pending;
  assert.ok(plugin.state.quest.notes.includes('renamed.md'));
  assert.deepEqual(Array.from(plugin.state.quest.opened), ['renamed.md']);

  files.splice(files.indexOf(removed), 1);
  emit('delete', removed);
  const replacement = addFile('replacement.md');
  emit('create', replacement);
  await plugin.pending;
  assert.equal(scans, 3);
  assert.equal(plugin.state.quest.notes.length, 5);
  assert.ok(!plugin.state.quest.notes.includes(removed.path));
  assert.ok(plugin.state.quest.notes.includes(replacement.path));

  await plugin.updateFilters((settings: { excludedFiles: string[] }) => {
    settings.excludedFiles.push(opened.path, replacement.path);
  });
  assert.deepEqual(Array.from(plugin.state.quest.opened), ['renamed.md']);
  assert.ok(!plugin.state.quest.notes.includes(replacement.path));
});

test('a failed save rolls back pending credit and stops further writes and success notices', async () => {
  let writes = 0;
  const { plugin, notices } = fixture(async () => {
    if (++writes > 1) throw new Error('Disk full');
  });
  await plugin.update();
  await plugin.update(undefined, 'a.md');
  await plugin.update(undefined, 'b.md');
  assert.equal(plugin.isStopped, true);
  assert.equal(plugin.state.quest.opened.length, 0);
  assert.equal(writes, 2);
  assert.ok(notices.some(text => text.includes('Could not save progress')));
  assert.ok(!notices.some(text => text.startsWith('Find counted:')));
});

test('unloading suppresses late notifications after an in-flight save', async () => {
  let release!: () => void;
  const { plugin, notices } = fixture(() => new Promise<void>(resolve => { release = resolve; }));
  const update = plugin.update(undefined, 'a.md');
  await new Promise(resolve => setImmediate(resolve));
  plugin.onunload();
  release();
  await update;
  assert.equal(notices.length, 0);
});

test('opening the next find from the quest makes its note visible', async () => {
  const { plugin } = fixture(async () => {});
  let openedPath: string | undefined;
  let visiblePath = 'previous.md';
  plugin.app.workspace.getLeaf = () => ({
    async openFile(file: { path: string }, options?: { active?: boolean }) {
      openedPath = file.path;
      if (options?.active) visiblePath = file.path;
    },
  });

  await plugin.showQuest();
  const nextPath = plugin.state.quest.notes[0];
  const next = plugin.questModal.contentEl.children.find((child: { text: string }) =>
    child.text === 'Open the next find →');
  next.onclick();
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(plugin.questModal, null);
  assert.equal(openedPath, nextPath);
  assert.equal(visiblePath, nextPath);
  assert.deepEqual(Array.from(plugin.state.quest.opened), [nextPath]);
});

test('last-note next returns to the quest and previous navigation uses the originating pane', async () => {
  const { plugin } = fixture(async () => {});
  await plugin.update();
  for (const path of paths) await plugin.update(undefined, path);
  const order = [...plugin.state.quest.notes];
  const opened: string[] = [];
  let questReturns = 0;
  plugin.showQuest = async () => { questReturns++; };
  const view: any = { file: { path: order[order.length - 1] } };
  view.leaf = { openFile: async (file: { path: string }) => { opened.push(file.path); view.file = file; } };
  await plugin.navigate(view, 1);
  assert.equal(questReturns, 1);
  assert.equal(opened.length, 0);
  await plugin.navigate(view, -1);
  await plugin.navigate(view, 1);
  assert.deepEqual(opened, [order[order.length - 2], order[order.length - 1]]);
  assert.equal(plugin.state.completedDays, 1);
});

test('a single available note can return to the quest without opening another note', async () => {
  const { plugin } = fixture(async () => {});
  plugin.app.vault.getMarkdownFiles = () => [plugin.app.vault.getAbstractFileByPath('a.md')];
  await plugin.update();
  let questReturns = 0;
  plugin.showQuest = async () => { questReturns++; };
  await plugin.navigate({ file: { path: 'a.md' } }, 1);
  assert.equal(questReturns, 1);
});

test('due reminders appear only while visible, persist their next time, and allow snoozing', async () => {
  const { plugin, noticeContents, fakeDocument, currentTime } = fixture(async () => {});
  await plugin.update();
  fakeDocument.visibilityState = 'hidden';
  await plugin.update(undefined, undefined, true);
  assert.equal(noticeContents.length, 0);
  assert.equal(plugin.state.nextReminderAt, 0);
  fakeDocument.visibilityState = 'visible';
  const before = currentTime();
  await plugin.update(undefined, undefined, true);
  assert.equal(noticeContents.length, 1);
  assert.equal(plugin.state.nextReminderAt, before + 3_600_000);
  await plugin.update(undefined, undefined, true);
  assert.equal(noticeContents.length, 1);
  const actions = noticeContents[0].children[0].children[2];
  plugin.state.nextReminderAt = 0;
  actions.children[1].onclick();
  await plugin.update();
  assert.equal(plugin.state.nextReminderAt, before + 3_600_000);
});

test('reminder preview shows the actual reminder without postponing it, and explains a completed quest', async () => {
  const { plugin, notices, noticeContents } = fixture(async () => {});
  await plugin.update();
  plugin.state.settings.reminders = false;
  plugin.state.nextReminderAt = Date.now() + 7_200_000;
  const nextReminder = plugin.state.nextReminderAt;
  await plugin.previewReminder();
  assert.equal(noticeContents.length, 1);
  assert.equal(plugin.state.nextReminderAt, nextReminder);
  assert.equal(noticeContents[0].children[0].children[0].text, 'Note Again · 0/5');
  for (const path of paths) await plugin.update(undefined, path);
  await plugin.previewReminder();
  assert.ok(notices.includes("Today's quest is complete. Come back tomorrow for new finds!"));
});

test('daily goal settings grade values, step by one and reject goals above the current vault size', async () => {
  const { plugin, tabs, controls, nextDay, files, addFile } = fixture(async () => {});
  for (let number = 6; number <= 16; number++) addFile(`note-${number}.md`);
  plugin.state.settings.excludedFiles = ['note-13.md'];
  await plugin.onload();
  await plugin.update();
  await plugin.update(undefined, plugin.state.quest.notes[0]);
  tabs[0].display();
  const setting = controls.find(control => control.name === 'Daily note goal');
  const [down, field, up] = setting.controlEl.children[0].children;
  const [input] = field.children;
  assert.equal(input.value, '5');
  assert.equal(field.attrs['data-level'], 'normal');
  assert.equal(input.attrs['aria-describedby'], setting.descEl.id);
  await down.onclick();
  assert.equal(input.value, '4');
  assert.equal(plugin.state.settings.dailyGoal, 4);
  await up.onclick();
  assert.equal(input.value, '5');
  assert.equal(plugin.state.settings.dailyGoal, 5);

  for (const [value, expected, level, invalid] of [
    ['2', 2, 'high', false], ['3', 3, 'caution', false], ['4', 4, 'caution', false],
    ['5', 5, 'normal', false], ['12', 12, 'normal', false], ['13', 13, 'caution', false],
    ['14', 14, 'caution', false], ['15', 15, 'high', false], ['16', 16, 'high', false],
    ['17', 16, 'high', true], ['0', 16, 'high', true], ['2.5', 16, 'high', true], ['', 16, 'high', true],
  ] as const) {
    input.value = value;
    input.events.get('input')();
    assert.equal(field.attrs['data-level'], level, value);
    assert.equal(input.attrs['aria-invalid'], String(invalid), value);
    await input.events.get('change')();
    assert.equal(plugin.state.settings.dailyGoal, expected);
    assert.equal(plugin.state.quest.goal, 5);
    assert.equal(plugin.state.quest.opened.length, 1);
  }
  files.splice(12);
  input.value = '13';
  await input.events.get('change')();
  assert.equal(input.max, '12');
  assert.equal(input.attrs['aria-invalid'], 'true');
  assert.match(setting.descEl.text, /Markdown notes in this vault: 12/);
  input.value = '12';
  await input.events.get('change')();
  assert.equal(plugin.state.settings.dailyGoal, 12);
  assert.equal(up.disabled, true);
  assert.doesNotMatch(setting.descEl.text, /Markdown notes in this vault/);

  addFile('another.md');
  input.value = '13';
  await input.events.get('change')();
  nextDay();
  await plugin.showQuest();
  assert.equal(plugin.state.quest.goal, 13);
  const progress = plugin.questModal.contentEl.children.find((child: { attrs: Record<string, string> }) => child.attrs.role === 'progressbar');
  assert.equal(progress.attrs['aria-valuemax'], '13');
  assert.equal(progress.children[0].tag, 'progress');
});

test('settings pickers add and remove saved exclusions, normalize tags, and retain existing selections', async () => {
  const saves: any[] = [];
  const { plugin, pickers, controls, tabs } = fixture(async state => { saves.push(JSON.parse(JSON.stringify(state))); });
  plugin.state.settings.excludedFiles = ['missing.md'];
  let tagReads = 0;
  const tags = [{ tag: '#Skip' }, { tag: '#skip' }, { tag: '#skip/nested' }];
  plugin.app.metadataCache.getFileCache = () => { tagReads++; return { tags }; };
  await plugin.onload();
  const tab = tabs[0];
  tab.display();
  assert.deepEqual(controls.map(control => control.name), ['Daily note goal', 'Source folder', 'Excluded files', 'Excluded tags', 'Excluded folders', 'Gentle reminders', 'Reminder interval', 'Preview reminder']);
  assert.deepEqual(tab.containerEl.children.filter((child: any) => child.tag === 'p'), []);
  const add = (name: string) => controls.find(control => control.name === name).control.callback();
  const descendants = (element: any): any[] => [element, ...element.children.flatMap(descendants)];
  assert.ok(descendants(tab.containerEl).some(element => element.text === 'missing.md'));
  add('Excluded files');
  assert.deepEqual(Array.from(pickers[0].getItems()), paths);
  await pickers[0].onChooseItem('a.md');
  assert.deepEqual(Array.from(plugin.state.settings.excludedFiles), ['missing.md', 'a.md']);
  add('Excluded files');
  assert.equal(pickers[1].getItems().includes('a.md'), false);
  const remove = descendants(tab.containerEl).find(element => element.attrs['aria-label'] === 'Remove a.md');
  await remove.onclick();
  assert.deepEqual(Array.from(plugin.state.settings.excludedFiles), ['missing.md']);
  add('Excluded tags');
  assert.deepEqual(Array.from(pickers[2].getItems()), ['#skip', '#skip/nested']);
  tags.push({ tag: '#new' });
  assert.deepEqual(Array.from(pickers[2].getItems()), ['#skip', '#skip/nested']);
  assert.equal(tagReads, paths.length);
  add('Excluded tags');
  assert.deepEqual(Array.from(pickers[3].getItems()), ['#new', '#skip', '#skip/nested']);
  assert.equal(tagReads, paths.length * 2);
  await pickers[2].onChooseItem('#skip');
  add('Excluded folders');
  assert.deepEqual(Array.from(pickers[4].getItems()), ['Archive']);
  await pickers[4].onChooseItem('Archive');
  assert.deepEqual(saves[saves.length - 1].settings.excludedTags, ['#skip']);
  assert.deepEqual(saves[saves.length - 1].settings.excludedFolders, ['Archive']);
  assert.deepEqual(saves[saves.length - 1].settings.excludedFiles, ['missing.md']);
});

test('tag indexing preserves a saved selection and does not award unverified notes', async () => {
  const { plugin, files, emit, startLayout } = fixture(async () => {});
  let scans = 0;
  plugin.app.vault.getMarkdownFiles = () => { scans++; return files; };
  plugin.state.settings.reminders = false;
  await plugin.onload();
  await startLayout();
  const order = JSON.stringify(plugin.state.quest.notes);
  plugin.app.metadataCache.getFileCache = () => null;
  await plugin.updateFilters((settings: { excludedTags: string[] }) => { settings.excludedTags = ['#skip']; });
  emit('file-open', files[0]);
  await plugin.pending;
  assert.equal(plugin.isIndexing, true);
  assert.equal(JSON.stringify(plugin.state.quest.notes), order);
  assert.equal(plugin.state.quest.opened.length, 0);
  plugin.app.metadataCache.getFileCache = (file: { path: string }) => ({ tags: file.path === 'a.md' ? [{ tag: '#skip/nested' }] : [] });
  emit('resolved');
  await plugin.pending;
  assert.equal(plugin.isIndexing, false);
  assert.equal(plugin.state.quest.notes.includes('a.md'), false);
  assert.equal(plugin.state.quest.opened.length, 0);
  emit('changed', files[1], '', { tags: [{ tag: '#another' }] });
  await plugin.pending;
  assert.equal(scans, 3);
  plugin.app.metadataCache.getFileCache = () => ({ tags: [] });
  emit('changed', files[0], '', { tags: [] });
  await plugin.pending;
  assert.ok(plugin.state.quest.notes.includes('a.md'));
});
