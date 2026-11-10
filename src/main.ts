import { FuzzySuggestModal, MarkdownView, Modal, Notice, Plugin, PluginSettingTab, Setting, TFile, TFolder, getAllTags, getLanguage, setIcon, type App, type WorkspaceLeaf } from 'obsidian';
import { en, messagesFor } from './messages.ts';
import { DEFAULT_GOAL, RECOMMENDED_GOAL_MAX, dayKey, filterNotes, isDailyGoal, parseState, recordOpen, refreshQuest, reminderDue, renamePath, type Settings, type State } from './quest.ts';

const GOAL_CAUTION_MARGIN = 2;

export default class NoteAgainPlugin extends Plugin {
  state!: State;
  messages = en;
  private pending: Promise<void> = Promise.resolve();
  private stopped = false;
  private disposed = false;
  private candidates: Set<string> | null = null;
  private waitingForMetadata = false;
  private status!: HTMLElement;
  private reminder: Notice | null = null;
  private questModal: QuestModal | null = null;
  private navigation = new Map<MarkdownView, { element: HTMLElement; signature: string }>();

  async onload(): Promise<void> {
    // Obsidian versions before 1.8.7 use the English catalog.
    this.messages = messagesFor(getLanguage?.());
    try {
      const saved = await this.loadData();
      this.state = parseState(saved, this.messages);
      if (saved && saved.version !== this.state.version) await this.saveData(this.state);
    } catch (error) {
      new Notice(`${this.messages.loadError} ${String(error)}`, 15000);
      throw error;
    }
    this.addRibbonIcon('compass', this.messages.questRibbon, () => { void this.showQuest(); });
    this.addCommand({ id: 'show-quest', name: this.messages.showQuest, callback: () => { void this.showQuest(); } });
    this.addCommand({ id: 'open-next', name: this.messages.openNext, callback: () => { void this.openNext(); } });
    this.status = this.addStatusBarItem();
    this.status.addClass('note-again-status');
    this.status.setAttribute('role', 'button');
    this.status.tabIndex = 0;
    this.registerDomEvent(this.status, 'click', () => { void this.showQuest(); });
    this.registerDomEvent(this.status, 'keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); void this.showQuest(); }
    });
    this.addSettingTab(new NoteAgainSettings(this.app, this));
    this.app.workspace.onLayoutReady(() => {
      if (this.disposed) return;
      this.registerEvent(this.app.workspace.on('file-open', file => {
        if (file instanceof TFile && file.extension === 'md') void this.update(undefined, file.path);
      }));
      this.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
        const newPath = file.path;
        void this.update(state => {
          renamePath(state, oldPath, newPath);
          this.candidates = null;
        });
      }));
      const vaultChanged = () => {
        this.candidates = null;
        void this.update();
      };
      this.registerEvent(this.app.vault.on('delete', vaultChanged));
      this.registerEvent(this.app.vault.on('create', vaultChanged));
      this.registerEvent(this.app.workspace.on('layout-change', () => this.renderNavigation()));
      this.registerEvent(this.app.metadataCache.on('resolved', () => {
        if (this.waitingForMetadata) vaultChanged();
      }));
      this.registerEvent(this.app.metadataCache.on('changed', (file, _data, cache) => {
        const settings = this.state.settings;
        if (settings.excludedTags.length === 0) return;
        if (this.candidates !== null) {
          const eligible = filterNotes([{ path: file.path, tags: getAllTags(cache) ?? [] }], settings).length > 0;
          if (this.waitingForMetadata || this.candidates.has(file.path) !== eligible) this.candidates = null;
        }
        const quest = this.state.quest;
        if (this.waitingForMetadata || !quest || quest.notes.includes(file.path) || quest.notes.length < quest.goal) {
          void this.update(undefined, this.app.workspace.getActiveFile()?.path);
        }
      }));
      this.registerDomEvent(document, 'visibilitychange', () => { void this.update(undefined, undefined, true); });
      this.registerInterval(window.setInterval(() => { void this.update(undefined, undefined, true); }, 60_000));
      void this.update(undefined, this.app.workspace.getActiveFile()?.path, true);
    });
  }

  updateFilters(mutate: (settings: Settings) => void): Promise<void> {
    return this.update(state => {
      mutate(state.settings);
      this.candidates = null;
    });
  }

  private collectCandidates(): string[] {
    const settings = this.state.settings;
    const files = this.app.vault.getMarkdownFiles();
    const allowedByPath = filterNotes(files.map(file => ({ path: file.path, tags: [] })), settings);
    this.waitingForMetadata = false;
    if (settings.excludedTags.length === 0) return allowedByPath;

    const allowed = new Set(allowedByPath);
    const notes = files.flatMap(file => {
      if (!allowed.has(file.path)) return [];
      const cache = this.app.metadataCache.getFileCache(file);
      if (cache === null) {
        this.waitingForMetadata = true;
        return [];
      }
      return [{ path: file.path, tags: getAllTags(cache) ?? [] }];
    });
    return filterNotes(notes, settings);
  }

  // Serialize events and persistence so rapid file changes cannot overwrite progress.
  update(mutate?: (state: State, now: Date) => void, path?: string, remind = false): Promise<void> {
    this.pending = this.pending.then(async () => {
      if (this.stopped || this.disposed) return;
      const before = JSON.stringify(this.state);
      try {
        const now = new Date();
        mutate?.(this.state, now);
        const candidatesChanged = this.candidates === null;
        const candidates = this.candidates ??= new Set(this.collectCandidates());
        // Preserve the saved daily set while the vault indexes tags after a restart.
        if (!this.waitingForMetadata && (candidatesChanged || this.state.quest?.date !== dayKey(now))) {
          refreshQuest(this.state, [...candidates], now);
        }
        const outcome = path === undefined || this.waitingForMetadata ? 'none' : recordOpen(this.state, path, now);
        const notify = remind && !this.waitingForMetadata && reminderDue(this.state, now.getTime(), document.visibilityState === 'visible');
        if (notify) this.state.nextReminderAt = now.getTime() + this.state.settings.intervalMinutes * 60_000;
        if (before !== JSON.stringify(this.state)) await this.saveData(this.state);
        if (this.disposed) return;
        this.render();
        if (this.state.quest?.rewarded || this.waitingForMetadata || !this.state.settings.reminders) this.reminder?.hide();
        if (outcome === 'completed') {
          new Notice(this.messages.completedNotice(this.state.streak), 7000);
        } else if (outcome === 'opened') {
          const { opened, goal } = this.state.quest!;
          new Notice(this.messages.creditedNotice(opened.length, goal), 2500);
        }
        if (notify) this.showReminder();
      } catch (error) {
        // Keep the last confirmed in-memory state and stop writes until the user reloads.
        this.state = JSON.parse(before) as State;
        this.stopped = true;
        this.reminder?.hide();
        this.render();
        console.error('Note Again stopped after a persistence/update error:', error);
        new Notice(this.messages.saveError, 15000);
      }
    });
    return this.pending;
  }

  private render(): void {
    const m = this.messages;
    const { quest, settings, streak } = this.state;
    this.status.setText(this.stopped ? m.saveStatus : this.waitingForMetadata ? m.indexingStatus :
      m.statusProgress(quest?.opened.length ?? 0, quest?.goal ?? settings.dailyGoal, streak));
    this.status.setAttribute('aria-label', m.openQuest);
    this.questModal?.render();
    this.renderNavigation();
  }

  private renderNavigation(): void {
    const m = this.messages;
    const live = new Set<MarkdownView>();
    const quest = this.state.quest;
    if (quest && !this.stopped && !this.waitingForMetadata) {
      const paths = quest.notes.filter(path => this.app.vault.getAbstractFileByPath(path) instanceof TFile);
      for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
        const view = leaf.view;
        if (!(view instanceof MarkdownView) || !view.file || !paths.includes(view.file.path)) continue;
        live.add(view);
        const index = paths.indexOf(view.file.path);
        const signature = JSON.stringify([quest.date, paths, index, quest.opened.length]);
        let navigation = this.navigation.get(view);
        if (navigation?.signature === signature) continue;
        if (!navigation) {
          const element = view.containerEl.createDiv({ cls: 'note-again-navigation' });
          element.setAttribute('role', 'navigation');
          element.setAttribute('aria-label', m.noteNavigation);
          view.contentEl.before(element);
          navigation = { element, signature };
          this.navigation.set(view, navigation);
        }
        navigation.signature = signature;
        const bar = navigation.element;
        bar.empty();
        const heading = bar.createDiv({ cls: 'note-again-navigation-heading' });
        heading.createEl('button', { text: 'Note Again', cls: 'note-again-quest-link' }).onclick = () => { void this.showQuest(); };
        heading.createEl('span', { text: m.notePosition(index + 1, paths.length, quest.opened.length, quest.goal) });
        const buttons = bar.createDiv({ cls: 'note-again-actions' });
        for (const [step, label] of [[-1, m.previousNote], [1, index === paths.length - 1 ? m.backToQuest : m.nextNote]] as const) {
          const button = buttons.createEl('button', { text: label, cls: step === 1 ? 'mod-cta' : '' });
          button.disabled = step === -1 && paths.length < 2;
          button.onclick = () => { void this.navigate(view, step); };
        }
      }
    }
    for (const [view, navigation] of this.navigation) {
      if (!live.has(view)) { navigation.element.remove(); this.navigation.delete(view); }
    }
  }

  async navigate(view: MarkdownView, step: -1 | 1): Promise<void> {
    await this.update();
    if (this.stopped || this.disposed || this.waitingForMetadata || !view.file) return;
    const paths = this.state.quest!.notes.filter(path => this.app.vault.getAbstractFileByPath(path) instanceof TFile);
    const index = paths.indexOf(view.file.path);
    if (index < 0) return;
    if (step === 1 && index === paths.length - 1) { await this.showQuest(); return; }
    if (paths.length < 2) return;
    await this.openNote(paths[(index + step + paths.length) % paths.length], view.leaf);
  }

  private showReminder(): void {
    const m = this.messages;
    this.reminder?.hide();
    const fragment = document.createDocumentFragment();
    const content = fragment.createDiv({ cls: 'note-again-reminder' });
    const { opened, goal } = this.state.quest!;
    content.createEl('strong', { text: `Note Again · ${opened.length}/${goal}` });
    content.createDiv({ text: m.reminderHint });
    const buttons = content.createDiv({ cls: 'note-again-actions' });
    buttons.createEl('button', { text: m.openFind, cls: 'mod-cta' }).onclick = () => {
      this.reminder?.hide(); void this.openNext();
    };
    buttons.createEl('button', { text: m.snooze }).onclick = () => {
      this.reminder?.hide();
      void this.update((state, now) => { state.nextReminderAt = now.getTime() + 60 * 60_000; });
    };
    this.reminder = new Notice(fragment, 12000);
  }

  async previewReminder(): Promise<void> {
    await this.update();
    if (this.stopped || this.disposed) return;
    const m = this.messages;
    if (this.waitingForMetadata) { new Notice(m.indexingNotice); return; }
    const quest = this.state.quest;
    if (!quest || quest.rewarded || !quest.notes.some(path => !quest.opened.includes(path))) {
      new Notice(quest?.rewarded ? m.allDoneNotice : m.previewReminderUnavailable);
      return;
    }
    this.showReminder();
  }

  async showQuest(): Promise<void> {
    await this.update();
    if (this.disposed) return;
    if (this.questModal) { this.questModal.render(); return; }
    this.questModal = new QuestModal(this.app, this, () => { this.questModal = null; });
    this.questModal.open();
  }

  async openNext(): Promise<void> {
    await this.update();
    if (this.stopped || this.disposed) return;
    if (this.waitingForMetadata) { new Notice(this.messages.indexingNotice); return; }
    const quest = this.state.quest!;
    const next = quest.notes.find(path => !quest.opened.includes(path));
    if (next) await this.openNote(next);
    else new Notice(quest.rewarded ? this.messages.allDoneNotice : this.messages.tooFewNotesHint(quest.notes.length, quest.goal));
  }

  async openNote(path: string, leaf?: WorkspaceLeaf): Promise<void> {
    if (this.stopped || this.disposed || this.waitingForMetadata) return;
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) { await this.update(); return; }
    this.questModal?.close();
    try {
      await (leaf ?? this.app.workspace.getLeaf(false)).openFile(file, { active: true });
      // Opening an already active file may not emit file-open; the domain deduplicates both paths.
      await this.update(undefined, file.path);
    } catch (error) {
      new Notice(`${this.messages.openError} ${String(error)}`, 7000);
    }
  }

  get isStopped(): boolean { return this.stopped; }
  get isIndexing(): boolean { return this.waitingForMetadata; }

  onunload(): void {
    this.disposed = true;
    this.reminder?.hide();
    this.questModal?.close();
    for (const { element } of this.navigation.values()) element.remove();
    this.navigation.clear();
  }
}

class QuestModal extends Modal {
  constructor(app: App, private plugin: NoteAgainPlugin, private closed: () => void) { super(app); }
  onOpen(): void { this.modalEl.addClass('note-again-modal'); this.render(); }
  onClose(): void { this.contentEl.empty(); this.closed(); }

  render(): void {
    const { contentEl } = this;
    const m = this.plugin.messages;
    contentEl.empty();
    contentEl.addClass('note-again-quest');
    const { quest, streak, bestStreak, completedDays } = this.plugin.state;
    contentEl.createEl('h2', { text: 'Note Again' });
    if (this.plugin.isStopped) {
      contentEl.createEl('p', { text: m.saveError });
      return;
    }
    if (this.plugin.isIndexing) {
      contentEl.createEl('p', { text: m.indexingHint, cls: 'note-again-hint' });
      return;
    }
    if (!quest) return;
    const { goal } = quest;
    const callout = contentEl.createDiv({ cls: 'callout note-again-intro' });
    callout.setAttribute('data-callout', quest.rewarded ? 'success' : 'tip');
    const calloutTitle = callout.createDiv({ cls: 'callout-title' });
    setIcon(calloutTitle.createDiv({ cls: 'callout-icon' }), quest.rewarded ? 'circle-check' : 'sparkles');
    calloutTitle.createDiv({ cls: 'callout-title-inner', text: quest.rewarded ? m.completedTitle : m.questTitle });
    callout.createDiv({ cls: 'callout-content', text: quest.rewarded ? m.completedHint : m.questHint(goal) });
    const progress = contentEl.createDiv({ cls: 'note-again-progress' });
    progress.setAttribute('role', 'progressbar');
    progress.setAttribute('aria-label', m.openedToday);
    progress.setAttribute('aria-valuemin', '0');
    progress.setAttribute('aria-valuemax', String(goal));
    progress.setAttribute('aria-valuenow', String(quest.opened.length));
    if (goal <= RECOMMENDED_GOAL_MAX) {
      const columns = goal <= 6 ? goal : Math.ceil(goal / 2);
      progress.style.setProperty('--note-again-progress-columns', String(columns));
      for (let i = 0; i < goal; i++) progress.createSpan({ text: i < quest.opened.length ? '✦' : '◇',
        cls: i < quest.opened.length ? 'is-found' : '' });
    } else {
      progress.createEl('progress', { attr: { max: String(goal), value: String(quest.opened.length), 'aria-hidden': 'true' } });
    }
    contentEl.createDiv({ text: m.questCount(quest.opened.length, goal, quest.date), cls: 'note-again-count' });
    const stats = contentEl.createDiv({ cls: 'note-again-stats' });
    for (const [label, value, icon] of [[m.streak, streak, 'flame'], [m.bestStreak, bestStreak, 'trophy'], [m.total, completedDays, 'flag']]) {
      const stat = stats.createDiv();
      setIcon(stat.createSpan({ cls: 'note-again-stat-icon' }), String(icon));
      stat.createEl('strong', { text: String(value) });
      stat.createEl('span', { text: String(label) });
    }
    if (quest.notes.length < goal) contentEl.createEl('p', { cls: 'note-again-hint',
      text: m.tooFewNotesHint(quest.notes.length, goal) });
    const list = contentEl.createDiv({ cls: 'note-again-notes' });
    const opened = new Set(quest.opened);
    for (const path of quest.notes) {
      const done = opened.has(path);
      const button = list.createEl('button', { cls: `note-again-note${done ? ' is-found' : ''}` });
      button.createSpan({ text: done ? '✓' : '◇', cls: 'note-again-note-icon' });
      const label = button.createSpan();
      label.createEl('strong', { text: path.split('/').pop()!.replace(/\.md$/, '') });
      label.createEl('small', { text: path });
      button.setAttribute('aria-label', done ? m.noteOpened(path) : m.openNote(path));
      button.onclick = () => { void this.plugin.openNote(path); };
    }
    if (!quest.rewarded) {
      const next = contentEl.createEl('button', { text: m.openNextButton, cls: 'mod-cta note-again-next' });
      next.disabled = !quest.notes.some(path => !opened.has(path));
      next.onclick = () => { void this.plugin.openNext(); };
    }
  }
}

class ExclusionPicker extends FuzzySuggestModal<string> {
  constructor(app: App, placeholder: string, noMatches: string, private items: string[], private choose: (item: string) => Promise<void>) {
    super(app);
    this.setPlaceholder(placeholder);
    this.emptyStateText = noMatches;
  }
  getItems(): string[] { return this.items; }
  getItemText(item: string): string { return item; }
  async onChooseItem(item: string): Promise<void> { await this.choose(item); }
}

class NoteAgainSettings extends PluginSettingTab {
  constructor(app: App, private plugin: NoteAgainPlugin) { super(app, plugin); }

  private renderDailyGoal(): void {
    const m = this.plugin.messages;
    const setting = new Setting(this.containerEl).setName(m.dailyGoal);
    setting.descEl.setAttribute('id', 'note-again-goal-description');
    setting.descEl.setAttribute('aria-live', 'polite');
    const control = setting.controlEl.createDiv({ cls: 'note-again-goal-control' });
    const decrease = control.createEl('button', { cls: 'clickable-icon note-again-goal-decrease', text: '<',
      attr: { type: 'button', 'aria-label': m.dailyGoalDecrease, title: m.dailyGoalDecrease } });
    const field = control.createDiv({ cls: 'note-again-goal-field' });
    const input = field.createEl('input', { cls: 'note-again-goal-input', attr: {
      type: 'number', min: '1', step: '1', 'aria-label': m.dailyGoal, 'aria-describedby': setting.descEl.id,
    } });
    input.value = String(this.plugin.state.settings.dailyGoal);
    const increase = control.createEl('button', { cls: 'clickable-icon note-again-goal-increase', text: '>',
      attr: { type: 'button', 'aria-label': m.dailyGoalIncrease, title: m.dailyGoalIncrease } });

    const updateIndicator = () => {
      const value = input.valueAsNumber;
      const noteCount = this.app.vault.getMarkdownFiles().length;
      const validNumber = isDailyGoal(value);
      const invalid = !validNumber || value > noteCount;
      const distance = Math.max(DEFAULT_GOAL - value, value - RECOMMENDED_GOAL_MAX, 0);
      const level = invalid || distance > GOAL_CAUTION_MARGIN ? 'high' : distance > 0 ? 'caution' : 'normal';
      const hint = !validNumber ? m.dailyGoalInvalid : value > noteCount ? m.dailyGoalOverTotal(noteCount) :
        value < DEFAULT_GOAL ? m.dailyGoalLow : value > RECOMMENDED_GOAL_MAX ? m.dailyGoalHigh : '';
      const current = validNumber ? value : this.plugin.state.settings.dailyGoal;
      input.max = String(noteCount);
      input.style.setProperty('--note-again-goal-digits', String(Math.min(input.value.length || 1, 16)));
      input.setAttribute('aria-invalid', String(invalid));
      field.setAttribute('data-level', level);
      decrease.disabled = noteCount === 0 || current <= 1;
      increase.disabled = current >= noteCount;
      const description = hint ? `${m.dailyGoalHint} ${hint}` : m.dailyGoalHint;
      if (setting.descEl.textContent !== description) setting.setDesc(description);
      return invalid ? undefined : value;
    };
    const saveGoal = async () => {
      const value = updateIndicator();
      if (value === undefined) return;
      await this.plugin.update(state => {
        if (value <= this.app.vault.getMarkdownFiles().length) state.settings.dailyGoal = value;
      });
      if (input.valueAsNumber === value) {
        if (this.plugin.isStopped) input.value = String(this.plugin.state.settings.dailyGoal);
        updateIndicator();
      }
    };
    const stepGoal = async (step: -1 | 1) => {
      const current = input.valueAsNumber;
      const value = (isDailyGoal(current) ? current : this.plugin.state.settings.dailyGoal) + step;
      if (!isDailyGoal(value) || (step === 1 && value > this.app.vault.getMarkdownFiles().length)) return;
      input.value = String(value);
      input.focus();
      await saveGoal();
    };
    decrease.onclick = () => stepGoal(-1);
    increase.onclick = () => stepGoal(1);
    input.addEventListener('input', updateIndicator);
    input.addEventListener('change', saveGoal);
    updateIndicator();
  }

  private renderExclusions(key: 'excludedFolders' | 'excludedFiles' | 'excludedTags', name: string,
    description: string, placeholder: string, options: () => string[]): void {
    const m = this.plugin.messages;
    const group = this.containerEl.createDiv({ cls: 'note-again-exclusion-setting' });
    const setting = new Setting(group).setName(name).setDesc(description);
    setting.addButton(button => button.setButtonText(m.add).onClick(() => {
      new ExclusionPicker(this.app, placeholder, m.noMatches,
        options().filter(value => !this.plugin.state.settings[key].includes(value)), async value => {
          await this.plugin.updateFilters(settings => { settings[key].push(value); });
          renderSelected();
        }).open();
    }));
    const selected = group.createDiv({ cls: 'note-again-exclusion-list' });
    const renderSelected = () => {
      selected.empty();
      const values = this.plugin.state.settings[key];
      if (values.length === 0) {
        selected.createSpan({ cls: 'note-again-exclusion-empty', text: m.noneSelected });
        return;
      }
      for (const value of values) {
        const chip = selected.createDiv({ cls: 'note-again-exclusion-chip' });
        chip.createSpan({ text: value });
        const label = m.remove(value);
        const remove = chip.createEl('button', { cls: 'clickable-icon', attr: { 'aria-label': label, title: label } });
        setIcon(remove, 'x');
        remove.onclick = async () => {
          await this.plugin.updateFilters(settings => { settings[key] = settings[key].filter(item => item !== value); });
          renderSelected();
        };
      }
    };
    renderSelected();
  }

  display(): void {
    const m = this.plugin.messages;
    this.containerEl.empty();
    this.containerEl.createEl('h2', { text: 'Note Again' });
    this.renderDailyGoal();
    const folders = () => this.app.vault.getAllLoadedFiles().filter((file): file is TFolder => file instanceof TFolder && !file.isRoot())
      .map(folder => folder.path).sort((a, b) => a.localeCompare(b));
    new Setting(this.containerEl).setName(m.sourceFolder)
      .setDesc(m.sourceFolderHint)
      .addDropdown(dropdown => {
        dropdown.addOption('', m.entireVault);
        const choices = folders();
        for (const folder of choices) dropdown.addOption(folder, folder);
        const source = this.plugin.state.settings.sourceFolder;
        if (source && !choices.includes(source)) dropdown.addOption(source, m.missingFolder(source));
        dropdown.setValue(source).onChange(async value => {
          await this.plugin.updateFilters(settings => { settings.sourceFolder = value; });
        });
      });
    this.renderExclusions('excludedFiles', m.excludedFiles, m.excludedFilesHint, m.searchFiles,
      () => this.app.vault.getMarkdownFiles().map(file => file.path).sort((a, b) => a.localeCompare(b)));
    this.renderExclusions('excludedTags', m.excludedTags, m.excludedTagsHint, m.searchTags, () => {
      const tags = this.app.vault.getMarkdownFiles().flatMap(file => {
        const cache = this.app.metadataCache.getFileCache(file);
        return cache === null ? [] : getAllTags(cache) ?? [];
      });
      return [...new Set(tags.map(tag => tag.toLowerCase()))].sort((a, b) => a.localeCompare(b));
    });
    this.renderExclusions('excludedFolders', m.excludedFolders, m.excludedFoldersHint, m.searchFolders, folders);
    new Setting(this.containerEl).setName(m.reminders)
      .setDesc(m.remindersHint)
      .addToggle(toggle => toggle.setValue(this.plugin.state.settings.reminders).onChange(async value => {
        await this.plugin.update((state, now) => {
          state.settings.reminders = value;
          state.nextReminderAt = now.getTime() + state.settings.intervalMinutes * 60_000;
        });
      }));
    new Setting(this.containerEl).setName(m.reminderInterval)
      .setDesc(m.reminderIntervalHint)
      .addSlider(slider => slider.setLimits(15, 240, 15)
        .setValue(this.plugin.state.settings.intervalMinutes).setDynamicTooltip()
        .onChange(async value => {
          await this.plugin.update((state, now) => {
            state.settings.intervalMinutes = value;
            state.nextReminderAt = now.getTime() + value * 60_000;
          });
        }));
    new Setting(this.containerEl).setName(m.previewReminder)
      .setDesc(m.previewReminderHint)
      .addButton(button => button.setButtonText(m.showReminder).onClick(() => { void this.plugin.previewReminder(); }));
  }
}
