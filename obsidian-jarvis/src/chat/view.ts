/** Die Chat-Oberfläche im Obsidian-Fenster. */
import { App, ItemView, MarkdownRenderer, Notice, TFile, WorkspaceLeaf, setIcon } from 'obsidian';
import type { ChatMessage, JarvisSettings, ModelInfo, ProviderId, RouteMode } from '../types';
import type { Brain } from '../brain';
import type { IndexStats, VaultIndex } from '../rag/vault-index';
import type { Assistant } from './assistant';
import type { ChatSession, ChatTurn, SessionStore } from './session';
import type { AnswerMode } from '../rag/prompt';
import { MODE_LABELS } from '../rag/prompt';
import { estimateCostUsd, estimateTokens, formatCost, formatDuration, sanitizeModelOutput } from '../util/format';

export const JARVIS_VIEW_TYPE = 'jarvis-ai-chat';

export interface JarvisChatHost {
  app: App;
  settings: JarvisSettings;
  brain: Brain;
  assistant: Assistant;
  index: VaultIndex;
  sessions: SessionStore;
  saveSettings(): Promise<void>;
  listAllModels(): Promise<ModelInfo[]>;
  insertText(text: string, mode: 'cursor' | 'replaceSelection' | 'newNote'): Promise<void>;
  openSettings(): void;
  notify(message: string, timeout?: number): void;
  refreshIndex(force: boolean): Promise<IndexStats>;
  activeNotePath(): string | undefined;
}

const MODE_CHOICES: AnswerMode[] = ['vault', 'chat', 'note', 'summarize', 'tasks', 'rewrite', 'translate', 'plan', 'critique', 'deep'];

export class JarvisChatView extends ItemView {
  private host: JarvisChatHost;
  private messagesEl!: HTMLElement;
  private statusEl!: HTMLElement;
  private inputEl!: HTMLTextAreaElement;
  private sendButton!: HTMLButtonElement;
  private stopButton!: HTMLButtonElement;
  private modelSelect!: HTMLSelectElement;
  private modeSelect!: HTMLSelectElement;
  private sessionSelect!: HTMLSelectElement;
  private includeNoteToggle!: HTMLInputElement;
  private controller: AbortController | null = null;
  private busy = false;
  private models: ModelInfo[] = [];
  private currentMode: AnswerMode = 'vault';

  constructor(leaf: WorkspaceLeaf, host: JarvisChatHost) {
    super(leaf);
    this.host = host;
    this.currentMode = 'vault';
  }

  getViewType(): string {
    return JARVIS_VIEW_TYPE;
  }

  getDisplayText(): string {
    return 'Jarvis KI';
  }

  getIcon(): string {
    return 'sparkles';
  }

  async onOpen(): Promise<void> {
    const root = this.contentEl;
    root.empty();
    root.addClass('jarvis-root');

    this.buildToolbar(root);
    this.statusEl = root.createDiv({ cls: 'jarvis-status' });
    this.messagesEl = root.createDiv({ cls: 'jarvis-messages' });
    this.buildComposer(root);

    await this.refreshModels();
    this.renderSession();
    this.updateStatus();
    this.inputEl.focus();
  }

  async onClose(): Promise<void> {
    this.controller?.abort();
  }

  // ---------------------------------------------------------------- Aufbau

  private buildToolbar(root: HTMLElement): void {
    const bar = root.createDiv({ cls: 'jarvis-toolbar' });

    const routeGroup = bar.createDiv({ cls: 'jarvis-routes' });
    const routes: Array<{ id: RouteMode; label: string; hint: string }> = [
      { id: 'local', label: '🏠 Lokal', hint: 'Nur Ollama auf diesem Rechner - keine Daten verlassen den PC.' },
      { id: 'auto', label: '⚡ Auto', hint: 'Lokal antworten, bei Bedarf automatisch auf ein Top-Cloud-Modell ausweichen.' },
      { id: 'cloud', label: '☁️ Cloud', hint: 'Immer das stärkste Cloud-Modell verwenden (beste Qualität).' },
    ];
    for (const route of routes) {
      const button = routeGroup.createEl('button', {
        cls: 'jarvis-route-button',
        text: route.label,
        attr: { title: route.hint },
      });
      button.dataset.route = route.id;
      button.onclick = async () => {
        this.host.settings.routeMode = route.id;
        await this.host.saveSettings();
        this.updateStatus();
      };
    }

    this.sessionSelect = bar.createEl('select', { cls: 'dropdown jarvis-session-select', attr: { title: 'Unterhaltung wählen' } });
    this.sessionSelect.onchange = () => {
      this.host.sessions.select(this.sessionSelect.value);
      this.renderSession();
    };

    const newButton = bar.createEl('button', { cls: 'jarvis-icon-button', attr: { title: 'Neue Unterhaltung' } });
    setIcon(newButton, 'plus');
    newButton.onclick = () => {
      this.host.sessions.startNew();
      this.renderSession();
    };

    const indexButton = bar.createEl('button', { cls: 'jarvis-icon-button', attr: { title: 'Wissensindex aufbauen/aktualisieren' } });
    setIcon(indexButton, 'refresh-cw');
    indexButton.onclick = async () => {
      const notice = new Notice('Jarvis: Index wird aufgebaut …', 0);
      try {
        const stats = await this.host.refreshIndex(true);
        notice.hide();
        new Notice(
          `Jarvis-Index: ${stats.files} Notizen, ${stats.chunks} Abschnitte, ${stats.embedded} mit Vektoren${
            stats.embeddingModel ? ` (${stats.embeddingModel})` : ' (ohne Embedding-Modell)'
          }.`,
          8000,
        );
      } catch (error) {
        notice.hide();
        new Notice(`Jarvis-Index fehlgeschlagen: ${(error as Error).message}`, 10000);
      }
      this.updateStatus();
    };

    const settingsButton = bar.createEl('button', { cls: 'jarvis-icon-button', attr: { title: 'Jarvis-Einstellungen' } });
    setIcon(settingsButton, 'settings');
    settingsButton.onclick = () => this.host.openSettings();
  }

  private buildComposer(root: HTMLElement): void {
    const composer = root.createDiv({ cls: 'jarvis-composer' });

    const optionsRow = composer.createDiv({ cls: 'jarvis-options' });

    this.modeSelect = optionsRow.createEl('select', { cls: 'dropdown', attr: { title: 'Was soll Jarvis tun?' } });
    for (const mode of MODE_CHOICES) {
      const option = this.modeSelect.createEl('option', { text: MODE_LABELS[mode] });
      option.value = mode;
    }
    this.modeSelect.value = this.currentMode;
    this.modeSelect.onchange = () => {
      this.currentMode = this.modeSelect.value as AnswerMode;
      if (this.currentMode !== 'chat') this.includeNoteToggle.checked = true;
    };

    this.modelSelect = optionsRow.createEl('select', { cls: 'dropdown jarvis-model-select', attr: { title: 'Modell' } });
    this.modelSelect.onchange = async () => {
      const value = this.modelSelect.value;
      if (value === '__auto__') {
        this.host.settings.routeMode = 'auto';
      } else if (value.startsWith('ollama:')) {
        this.host.settings.local.defaultModel = value.slice('ollama:'.length);
        this.host.settings.routeMode = 'local';
      } else {
        const [provider, ...rest] = value.split(':');
        const model = rest.join(':');
        const cloud = this.host.settings.cloud[provider as keyof typeof this.host.settings.cloud];
        if (cloud) {
          cloud.defaultModel = model;
          cloud.enabled = true;
          this.host.brain.invalidateModelCache();
        }
        this.host.settings.routeMode = 'cloud';
      }
      await this.host.saveSettings();
      this.updateStatus();
    };

    const noteLabel = optionsRow.createEl('label', { cls: 'jarvis-checkbox' });
    this.includeNoteToggle = noteLabel.createEl('input', { type: 'checkbox' });
    this.includeNoteToggle.checked = true;
    noteLabel.createSpan({ text: 'geöffnete Notiz einbeziehen' });

    const inputRow = composer.createDiv({ cls: 'jarvis-input-row' });
    this.inputEl = inputRow.createEl('textarea', {
      cls: 'jarvis-input',
      attr: { placeholder: 'Frage an deinen Vault … (Enter = senden, Umschalt+Enter = neue Zeile)' },
    });
    this.inputEl.rows = 3;
    this.inputEl.onkeydown = (event) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        void this.send();
      }
    };

    const buttonColumn = inputRow.createDiv({ cls: 'jarvis-buttons' });
    this.sendButton = buttonColumn.createEl('button', { cls: 'mod-cta', text: 'Senden' });
    this.sendButton.onclick = () => void this.send();
    this.stopButton = buttonColumn.createEl('button', { text: 'Stopp' });
    this.stopButton.disabled = true;
    this.stopButton.onclick = () => {
      this.controller?.abort();
      this.host.notify('Anfrage abgebrochen.');
    };
  }

  // ------------------------------------------------------------- Modelle

  async refreshModels(): Promise<void> {
    try {
      this.models = await this.host.listAllModels();
    } catch {
      this.models = [];
    }
    const select = this.modelSelect;
    const previous = select.value;
    select.empty();

    const autoOption = select.createEl('option', { text: 'Automatisch (beste verfügbare)' });
    autoOption.value = '__auto__';

    const localModels = this.models.filter((model) => model.local);
    if (localModels.length) {
      const group = select.createEl('optgroup', { attr: { label: '🏠 Lokal (Ollama)' } });
      for (const model of localModels) {
        const option = group.createEl('option', { text: `${model.id}${model.note ? ` — ${model.note}` : ''}` });
        option.value = `ollama:${model.id}`;
      }
    }
    const byProvider = new Map<ProviderId, ModelInfo[]>();
    for (const model of this.models.filter((item) => !item.local)) {
      const list = byProvider.get(model.providerId) ?? [];
      list.push(model);
      byProvider.set(model.providerId, list);
    }
    for (const [providerId, list] of byProvider) {
      const cloud = this.host.settings.cloud[providerId as keyof typeof this.host.settings.cloud];
      const group = select.createEl('optgroup', { attr: { label: `☁️ ${cloud?.label ?? providerId}` } });
      for (const model of list) {
        const option = group.createEl('option', { text: `${model.label}${model.note ? ` — ${model.note}` : ''}` });
        option.value = `${providerId}:${model.id}`;
      }
    }

    // Aktuelle Auswahl wiederherstellen
    const settings = this.host.settings;
    let match = '';
    if (settings.routeMode === 'local' && settings.local.defaultModel) {
      match = `ollama:${settings.local.defaultModel}`;
    } else if (settings.routeMode === 'cloud') {
      for (const [providerId, cloud] of Object.entries(settings.cloud)) {
        if (cloud?.enabled && cloud.defaultModel) {
          match = `${providerId}:${cloud.defaultModel}`;
          break;
        }
      }
    }
    const candidate = previous && previous !== '__auto__' ? previous : match;
    select.value = Array.from(select.options).some((option) => option.value === candidate) ? candidate : '__auto__';
  }

  private preferredModel(): string | undefined {
    const value = this.modelSelect.value;
    if (!value || value === '__auto__') return undefined;
    const [provider, ...rest] = value.split(':');
    const model = rest.join(':');
    if (provider === 'ollama') return model;
    return model;
  }

  // -------------------------------------------------------------- Status

  private updateStatus(): void {
    const settings = this.host.settings;
    const stats = this.host.index.stats();
    const routeLabels: Record<RouteMode, string> = { local: '🏠 Lokal', auto: '⚡ Auto', cloud: '☁️ Cloud' };
    const bits = [routeLabels[settings.routeMode]];

    if (settings.routeMode !== 'cloud') {
      bits.push(`Ollama: ${settings.local.defaultModel || 'kein Modell gewählt'}`);
    }
    if (settings.routeMode !== 'local') {
      const active = (Object.entries(settings.cloud) as Array<[string, { enabled: boolean; defaultModel: string }]>)
        .filter(([, cloud]) => cloud?.enabled)
        .map(([id, cloud]) => `${id}${cloud.defaultModel ? ` (${cloud.defaultModel})` : ''}`);
      bits.push(active.length ? `Cloud: ${active.join(', ')}` : 'Cloud: nicht eingerichtet');
    }
    bits.push(
      `Index: ${stats.files} Notizen / ${stats.chunks} Abschnitte${stats.embeddingModel ? ` · ${stats.embeddingModel}` : ''}`,
    );
    this.statusEl.setText(bits.join('  ·  '));

    for (const button of Array.from(this.contentEl.querySelectorAll<HTMLElement>('.jarvis-route-button'))) {
      button.toggleClass('is-active', button.dataset.route === settings.routeMode);
    }
  }

  // ------------------------------------------------------------ Verlauf

  private renderSession(): void {
    const sessions = this.host.sessions.list();
    const active = this.host.sessions.active();
    this.sessionSelect.empty();
    for (const session of sessions) {
      const option = this.sessionSelect.createEl('option', { text: session.title || 'Unterhaltung' });
      option.value = session.id;
    }
    if (!sessions.length) {
      const option = this.sessionSelect.createEl('option', { text: 'Neue Unterhaltung' });
      option.value = active.id;
    }
    this.sessionSelect.value = active.id;

    this.messagesEl.empty();
    if (!active.turns.length) {
      this.renderWelcome();
    }
    for (const turn of active.turns) {
      this.appendTurn(turn);
    }
    this.scrollToBottom();
  }

  private renderWelcome(): void {
    const box = this.messagesEl.createDiv({ cls: 'jarvis-welcome' });
    box.createEl('h3', { text: 'Jarvis ist bereit' });
    box.createEl('p', {
      text:
        'Frag etwas zu deinen Notizen, lass zusammenfassen oder Aufgaben herausarbeiten. ' +
        'Mit "🏠 Lokal" bleibt alles auf deinem Rechner, mit "☁️ Cloud" antwortet das stärkste Modell.',
    });
    const tips = box.createEl('ul');
    tips.createEl('li', { text: '„Was steht in meinen Notizen zu …?"' });
    tips.createEl('li', { text: '„Fasse die geöffnete Notiz zusammen und nenne offene Punkte."' });
    tips.createEl('li', { text: '„Mach aus der Notiz eine Aufgabenliste."' });
    tips.createEl('li', { text: '„Prüfe meinen Text auf Widersprüche."' });
  }

  private appendTurn(turn: ChatTurn): void {
    const row = this.messagesEl.createDiv({ cls: `jarvis-turn jarvis-${turn.role}` });
    const bubble = row.createDiv({ cls: 'jarvis-bubble' });
    if (turn.role === 'user') {
      bubble.setText(turn.content);
    } else if (turn.meta?.error) {
      bubble.createDiv({ cls: 'jarvis-error', text: turn.meta.error });
    } else {
      const body = bubble.createDiv({ cls: 'jarvis-md' });
      void this.renderMarkdown(turn.content, body);
      if (turn.sources?.length) this.renderSources(bubble, turn.sources);
      this.renderMeta(bubble, turn);
      this.renderActions(bubble, turn);
    }
    return;
  }

  private renderMeta(container: HTMLElement, turn: ChatTurn): void {
    const meta = turn.meta;
    if (!meta) return;
    const line = container.createDiv({ cls: 'jarvis-meta' });
    const bits: string[] = [];
    if (meta.providerId) bits.push(`${meta.providerId === 'ollama' ? '🏠 lokal' : '☁️ Cloud'} · ${meta.model ?? ''}`);
    if (meta.durationMs) bits.push(formatDuration(meta.durationMs));
    if (meta.inputTokens || meta.outputTokens) {
      bits.push(`${meta.inputTokens ?? '?'} → ${meta.outputTokens ?? '?'} Token`);
    }
    if (meta.costUsd !== undefined && meta.costUsd > 0 && this.host.settings.ui.showCost) {
      bits.push(`ca. ${formatCost(meta.costUsd)}`);
    }
    if (meta.escalated) bits.push('auf Cloud ausgewichen');
    if (meta.buffered) bits.push('ohne Streaming (CORS-Ersatzweg)');
    line.setText(bits.filter(Boolean).join('  ·  '));
  }

  private renderSources(container: HTMLElement, sources: NonNullable<ChatTurn['sources']>): void {
    if (!this.host.settings.ui.showSources) return;
    const wrap = container.createDiv({ cls: 'jarvis-sources' });
    wrap.createSpan({ cls: 'jarvis-sources-label', text: 'Quellen:' });
    for (const source of sources) {
      const chip = wrap.createEl('button', { cls: 'jarvis-source-chip', text: `[${source.id}] ${source.path}` });
      chip.onclick = async () => {
        const file = this.host.app.vault.getAbstractFileByPath(source.path);
        if (file instanceof TFile) {
          await this.host.app.workspace.getLeaf(false).openFile(file);
        } else {
          new Notice(`Notiz nicht gefunden: ${source.path}`);
        }
      };
      if (source.heading) chip.title = source.heading;
    }
  }

  private renderActions(container: HTMLElement, turn: ChatTurn): void {
    const row = container.createDiv({ cls: 'jarvis-actions' });
    const makeButton = (label: string, icon: string, action: () => void | Promise<void>, hint?: string) => {
      const button = row.createEl('button', { cls: 'jarvis-action', attr: { title: hint ?? label } });
      setIcon(button.createSpan({ cls: 'jarvis-action-icon' }), icon);
      button.createSpan({ text: label });
      button.onclick = () => void action();
      return button;
    };

    makeButton('Kopieren', 'copy', async () => {
      await navigator.clipboard.writeText(turn.content);
      new Notice('Antwort kopiert.');
    });
    makeButton('In Notiz einfügen', 'corner-down-left', async () => {
      await this.host.insertText(turn.content, 'cursor');
    });
    makeButton('Neue Notiz', 'file-plus', async () => {
      await this.host.insertText(turn.content, 'newNote');
    });
    if (turn.meta?.providerId === 'ollama') {
      makeButton('Besser machen (Cloud)', 'rocket', async () => {
        await this.reRun(turn, 'cloud');
      }, 'Dieselbe Frage mit dem stärksten Cloud-Modell erneut stellen');
    }
  }

  // --------------------------------------------------------------- Senden

  private async send(): Promise<void> {
    const question = this.inputEl.value.trim();
    if (!question) return;
    if (this.busy) {
      this.host.notify('Es läuft noch eine Anfrage. Bitte kurz warten oder "Stopp" drücken.');
      return;
    }
    this.inputEl.value = '';
    await this.ask(question, this.currentMode);
  }

  private async reRun(previousTurn: ChatTurn, route: RouteMode): Promise<void> {
    const session = this.host.sessions.active();
    const index = session.turns.lastIndexOf(previousTurn);
    const questionTurn = index > 0 ? session.turns[index - 1] : undefined;
    const question = questionTurn?.role === 'user' ? questionTurn.content : '';
    if (!question) return;
    await this.ask(question, this.modeSelect.value as AnswerMode, route);
  }

  private async ask(question: string, mode: AnswerMode, forcedRoute?: RouteMode): Promise<void> {
    const settings = this.host.settings;
    const route = forcedRoute ?? settings.routeMode;
    const host = this.host;
    const session = host.sessions.active();

    // Verlauf ohne die neue Frage (die kommt separat)
    const history: ChatMessage[] = session.turns
      .filter((turn) => !turn.meta?.error)
      .map((turn) => ({ role: turn.role, content: turn.content } satisfies ChatMessage));

    host.sessions.addTurn({ role: 'user', content: question, at: Date.now() });

    const userRow = this.messagesEl.createDiv({ cls: 'jarvis-turn jarvis-user' });
    userRow.createDiv({ cls: 'jarvis-bubble', text: question });

    const assistantRow = this.messagesEl.createDiv({ cls: 'jarvis-turn jarvis-assistant' });
    const bubble = assistantRow.createDiv({ cls: 'jarvis-bubble' });
    const thinking = bubble.createDiv({ cls: 'jarvis-thinking', text: 'Jarvis denkt nach …' });
    const body = bubble.createDiv({ cls: 'jarvis-md' });

    this.busy = true;
    this.sendButton.disabled = true;
    this.stopButton.disabled = false;
    this.scrollToBottom();
    this.controller = new AbortController();

    let streamed = '';
    let lastPaint = 0;
    const onDelta = (chunk: string) => {
      streamed += chunk;
      const now = Date.now();
      if (now - lastPaint > 90) {
        lastPaint = now;
        thinking.setText(`${streamed.length} Zeichen empfangen …`);
        body.setText(streamed);
        this.scrollToBottom();
      }
    };

    try {
      const activePath = host.activeNotePath();
      const result = await host.assistant.ask({
        question,
        mode,
        route,
        history,
        activeNotePath: mode === 'note' || this.includeNoteToggle.checked ? activePath : undefined,
        includeActiveNote: this.includeNoteToggle.checked && Boolean(activePath),
        preferredModel: this.preferredModel(),
        onDelta,
        signal: this.controller.signal,
      });

      thinking.remove();
      const finalText = sanitizeModelOutput(result.answer.text || streamed);
      await this.renderMarkdown(finalText, body);

      const sources = result.sources.map((source) => ({ id: source.id, path: source.path, heading: source.heading }));
      if (sources.length) this.renderSources(bubble, sources);

      const inputTokens = result.answer.usage?.inputTokens ?? estimateTokens(result.system + result.userMessage);
      const outputTokens = result.answer.usage?.outputTokens ?? estimateTokens(finalText);
      const costUsd = estimateCostUsd(result.answer.model, inputTokens, outputTokens);

      const turn: ChatTurn = {
        role: 'assistant',
        content: finalText,
        at: Date.now(),
        sources,
        meta: {
          providerId: result.answer.providerId,
          model: result.answer.model,
          durationMs: result.answer.durationMs,
          inputTokens,
          outputTokens,
          escalated: result.answer.escalated,
          buffered: result.answer.buffered,
          costUsd,
        },
      };
      host.sessions.addTurn(turn);
      this.renderMeta(bubble, turn);
      this.renderActions(bubble, turn);

      if (result.notice) {
        bubble.createDiv({ cls: 'jarvis-hint', text: result.notice });
      }
      if (result.answer.escalated) {
        const attempts = result.answer.attempts.map((attempt) => `${attempt.providerId}/${attempt.model}`).join(' → ');
        bubble.createDiv({ cls: 'jarvis-hint', text: `Ausweichkette: ${attempts}` });
      }
    } catch (error) {
      thinking.remove();
      const message = this.describeError(error, route);
      bubble.createDiv({ cls: 'jarvis-error', text: message });
      if (route !== 'cloud') {
        const retry = bubble.createEl('button', { cls: 'jarvis-action', text: '☁️ Mit Cloud-Modell erneut versuchen' });
        retry.onclick = async () => {
          retry.remove();
          await this.ask(question, mode, 'cloud');
        };
      }
      host.sessions.addTurn({
        role: 'assistant',
        content: '',
        at: Date.now(),
        meta: { error: message },
      });
    } finally {
      this.busy = false;
      this.sendButton.disabled = false;
      this.stopButton.disabled = true;
      this.controller = null;
      await this.refreshModels();
      this.updateStatus();
      this.scrollToBottom();
      const sessions = this.host.sessions.list();
      this.sessionSelect.empty();
      for (const item of sessions) {
        const option = this.sessionSelect.createEl('option', { text: item.title || 'Unterhaltung' });
        option.value = item.id;
      }
      this.sessionSelect.value = this.host.sessions.active().id;
    }
  }

  private describeError(error: unknown, route: RouteMode): string {
    const message = (error as Error)?.message ?? String(error);
    const hints: string[] = [];
    if (/ollama|ECONNREFUSED|Keine Verbindung|fetch failed|Failed to fetch/i.test(message)) {
      hints.push(
        'Läuft Ollama? Terminal: "ollama serve" bzw. Ollama-App starten. Adresse in den Einstellungen prüfen (Standard http://127.0.0.1:11434).',
      );
    }
    if (/401|403|Zugang abgelehnt/i.test(message)) hints.push('API-Schlüssel in den Jarvis-Einstellungen prüfen.');
    if (/429|Limit/i.test(message)) hints.push('Kurz warten; ggf. anderes Modell wählen.');
    if (/kein Modell|nicht gefunden|404/i.test(message)) {
      hints.push('Modellname prüfen: in den Einstellungen "Modelle laden" drücken und ein verfügbares Modell auswählen.');
    }
    if (route === 'local' && this.host.settings.cloud.anthropic.enabled) {
      hints.push('Alternativ oben auf "☁️ Cloud" oder "⚡ Auto" schalten.');
    }
    return `⚠️ ${message}${hints.length ? `\n\n💡 ${hints.join('\n💡 ')}` : ''}`;
  }

  private async renderMarkdown(text: string, element: HTMLElement): Promise<void> {
    element.empty();
    if (!text.trim()) return;
    try {
      await MarkdownRenderer.render(this.host.app, text, element, '', this);
    } catch {
      element.setText(text);
    }
  }

  private scrollToBottom(): void {
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
  }

  /** Von außen aufrufbar: Frage von einer anderen Stelle einspeisen. */
  async askExternal(question: string, mode: AnswerMode, route?: RouteMode): Promise<void> {
    if (this.busy) {
      new Notice('Jarvis ist noch beschäftigt. Bitte kurz warten.');
      return;
    }
    this.modeSelect.value = mode;
    this.currentMode = mode;
    this.includeNoteToggle.checked = true;
    if (route) {
      this.host.settings.routeMode = route;
      await this.host.saveSettings();
      this.updateStatus();
    }
    await this.ask(question, mode, route);
  }

  setInput(text: string): void {
    this.inputEl.value = text;
    this.inputEl.focus();
  }
}

export type { JarvisSettings };
export type { ChatSession };
