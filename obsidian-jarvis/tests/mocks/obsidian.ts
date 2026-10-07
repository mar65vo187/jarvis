/**
 * Minimal-Nachbau der Obsidian-Schnittstelle für Tests.
 * `requestUrl` wird auf Node's fetch abgebildet, damit die echten HTTP-Pfade
 * des Plugins gegen lokale Testserver laufen können.
 */

export interface RequestUrlParam {
  url: string;
  method?: string;
  body?: string | ArrayBuffer;
  headers?: Record<string, string>;
  throw?: boolean;
  contentType?: string;
}

export interface RequestUrlResponse {
  status: number;
  headers: Record<string, string>;
  arrayBuffer: ArrayBuffer;
  json: unknown;
  text: string;
}

export async function requestUrl(param: RequestUrlParam): Promise<RequestUrlResponse> {
  const response = await fetch(param.url, {
    method: param.method ?? 'GET',
    headers: param.headers,
    body: param.body as BodyInit | undefined,
  });
  const buffer = await response.arrayBuffer();
  const text = new TextDecoder('utf-8').decode(buffer);
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  if (!param.throw && response.status >= 400) {
    return { status: response.status, headers, arrayBuffer: buffer, json, text };
  }
  return { status: response.status, headers, arrayBuffer: buffer, json, text };
}

export function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\/|\/$/g, '');
}

export class TFile {
  path: string;
  name: string;
  extension: string;
  stat = { ctime: Date.now(), mtime: Date.now(), size: 0 };
  constructor(path: string) {
    this.path = path;
    this.name = path.split('/').pop() ?? path;
    this.extension = this.name.includes('.') ? this.name.split('.').pop() ?? '' : '';
    this.stat.size = 100;
  }
}

export class TFolder {
  path: string;
  children: unknown[] = [];
  constructor(path: string) {
    this.path = path;
  }
}

export class Component {
  register(): void {
    /* no-op */
  }
  registerEvent(): void {
    /* no-op */
  }
  addChild(): void {
    /* no-op */
  }
}

export class App {
  vault = {
    configDir: '.obsidian',
    getName: () => 'Testvault',
    getMarkdownFiles: () => [] as TFile[],
    getAbstractFileByPath: (_path: string): unknown => null,
    getAllLoadedFiles: () => [] as unknown[],
    adapter: {
      exists: async (_path: string) => false,
      read: async (_path: string) => '',
      write: async (_path: string, _data: string) => undefined,
      readBinary: async (_path: string) => new ArrayBuffer(0),
      writeBinary: async (_path: string, _data: ArrayBuffer) => undefined,
      mkdir: async (_path: string) => undefined,
      remove: async (_path: string) => undefined,
    },
    createFolder: async (_path: string) => undefined,
    create: async (_path: string, _data: string) => new TFile(_path),
    modifyBinary: async (_file: TFile, _data: ArrayBuffer) => undefined,
    cachedRead: async (_file: TFile) => '',
    on: () => ({ id: 'x' }),
  };
  workspace = {
    getLeavesOfType: () => [],
    getLeaf: () => ({ openFile: async () => undefined }),
    getRightLeaf: () => null,
    revealLeaf: async () => undefined,
    getActiveViewOfType: () => null,
    on: () => ({ id: 'x' }),
  };
  fileManager = {
    trashFile: async () => undefined,
  };
}

export class Plugin {
  app: App;
  manifest = { id: 'jarvis-ai', version: '1.0.0' };
  constructor(app: App) {
    this.app = app;
  }
  async loadData(): Promise<unknown> {
    return null;
  }
  async saveData(_data: unknown): Promise<void> {
    /* no-op */
  }
  addRibbonIcon(): HTMLElement {
    return document.createElement('div');
  }
  addSettingTab(): void {
    /* no-op */
  }
  addCommand(): void {
    /* no-op */
  }
  registerView(): void {
    /* no-op */
  }
  registerEvent(): void {
    /* no-op */
  }
  registerInterval(): number {
    return 0;
  }
  register(): void {
    /* no-op */
  }
}

export class ItemView extends Component {
  app: App;
  containerEl: HTMLElement;
  contentEl: HTMLElement;
  leaf: unknown;
  constructor(leaf: unknown) {
    super();
    this.leaf = leaf;
    this.app = new App();
    this.containerEl = document.createElement('div');
    this.contentEl = document.createElement('div');
  }
  getViewType(): string {
    return '';
  }
  getDisplayText(): string {
    return '';
  }
  getIcon(): string {
    return '';
  }
}

export class WorkspaceLeaf {}

export class MarkdownView {
  file: TFile | null = null;
  editor: unknown = null;
}

export class PluginSettingTab {
  app: App;
  containerEl: HTMLElement;
  constructor(app: App, _plugin: unknown) {
    this.app = app;
    this.containerEl = document.createElement('div');
  }
  display(): void {
    /* no-op */
  }
}

export class Modal {
  app: App;
  contentEl: HTMLElement;
  containerEl: HTMLElement;
  constructor(app: App) {
    this.app = app;
    this.contentEl = document.createElement('div');
    this.containerEl = document.createElement('div');
  }
  open(): void {
    this.onOpen();
  }
  close(): void {
    this.onClose();
  }
  onOpen(): void {
    /* no-op */
  }
  onClose(): void {
    /* no-op */
  }
}

export class Notice {
  constructor(
    public message: string | DocumentFragment,
    public timeout?: number,
  ) {
    /* no-op */
  }
  hide(): void {
    /* no-op */
  }
}

type SettingCallback = (value: unknown) => unknown;

export class Setting {
  settingEl: HTMLElement;
  constructor(_container: HTMLElement) {
    this.settingEl = document.createElement('div');
  }
  setName(): this {
    return this;
  }
  setDesc(): this {
    return this;
  }
  setClass(): this {
    return this;
  }
  addText(cb: (component: TextComponent) => unknown): this {
    cb(new TextComponent());
    return this;
  }
  addTextArea(cb: (component: TextAreaComponent) => unknown): this {
    cb(new TextAreaComponent());
    return this;
  }
  addToggle(cb: (component: ToggleComponent) => unknown): this {
    cb(new ToggleComponent());
    return this;
  }
  addSlider(cb: (component: SliderComponent) => unknown): this {
    cb(new SliderComponent());
    return this;
  }
  addDropdown(cb: (component: DropdownComponent) => unknown): this {
    cb(new DropdownComponent());
    return this;
  }
  addButton(cb: (component: ButtonComponent) => unknown): this {
    cb(new ButtonComponent());
    return this;
  }
  addExtraButton(cb: (component: ExtraButtonComponent) => unknown): this {
    cb(new ExtraButtonComponent());
    return this;
  }
}

class TextComponent {
  inputEl: HTMLInputElement = document.createElement('input');
  private value = '';
  private callback: SettingCallback | null = null;
  setPlaceholder(): this {
    return this;
  }
  setValue(value: string): this {
    this.value = value;
    return this;
  }
  getValue(): string {
    return this.value;
  }
  onChange(callback: SettingCallback): this {
    this.callback = callback;
    return this;
  }
  async trigger(value: string): Promise<void> {
    this.value = value;
    await this.callback?.(value);
  }
}

class TextAreaComponent extends TextComponent {}

class ToggleComponent {
  private value = false;
  private callback: SettingCallback | null = null;
  setValue(value: boolean): this {
    this.value = value;
    return this;
  }
  getValue(): boolean {
    return this.value;
  }
  onChange(callback: SettingCallback): this {
    this.callback = callback;
    return this;
  }
  async trigger(value: boolean): Promise<void> {
    this.value = value;
    await this.callback?.(value);
  }
}

class SliderComponent {
  private value = 0;
  private callback: SettingCallback | null = null;
  setLimits(): this {
    return this;
  }
  setValue(value: number): this {
    this.value = value;
    return this;
  }
  getValue(): number {
    return this.value;
  }
  setDynamicTooltip(): this {
    return this;
  }
  onChange(callback: SettingCallback): this {
    this.callback = callback;
    return this;
  }
  async trigger(value: number): Promise<void> {
    this.value = value;
    await this.callback?.(value);
  }
}

class DropdownComponent {
  selectEl: HTMLSelectElement = document.createElement('select');
  private value = '';
  private callback: SettingCallback | null = null;
  addOption(): this {
    return this;
  }
  addOptions(): this {
    return this;
  }
  setValue(value: string): this {
    this.value = value;
    return this;
  }
  getValue(): string {
    return this.value;
  }
  onChange(callback: SettingCallback): this {
    this.callback = callback;
    return this;
  }
  async trigger(value: string): Promise<void> {
    this.value = value;
    await this.callback?.(value);
  }
}

class ButtonComponent {
  buttonEl: HTMLButtonElement = document.createElement('button');
  setButtonText(): this {
    return this;
  }
  setIcon(): this {
    return this;
  }
  setTooltip(): this {
    return this;
  }
  setCta(): this {
    return this;
  }
  setWarning(): this {
    return this;
  }
  setDisabled(): this {
    return this;
  }
  onClick(_callback: () => unknown): this {
    return this;
  }
}

class ExtraButtonComponent extends ButtonComponent {}

export function setIcon(_el: HTMLElement, _icon: string): void {
  /* no-op */
}

export const MarkdownRenderer = {
  render: async (_app: unknown, markdown: string, el: HTMLElement): Promise<void> => {
    el.setText(markdown);
  },
};

export function debounce<T extends (...args: never[]) => unknown>(fn: T): T {
  return fn;
}

export class Events {
  on(): { id: string } {
    return { id: 'x' };
  }
  off(): void {
    /* no-op */
  }
  trigger(): void {
    /* no-op */
  }
}

/* ---------------------------------------------------------------- DOM-Hilfen
 * Obsidian erweitert HTMLElement.prototype um Hilfsfunktionen. Für Tests
 * werden sie hier nachgebaut, damit die Oberfläche echt aufgebaut werden kann.
 */

interface CreateElOptions {
  cls?: string | string[];
  text?: string;
  attr?: Record<string, string>;
  type?: string;
  placeholder?: string;
  title?: string;
  href?: string;
  value?: string;
}

function applyOptions<T extends HTMLElement>(element: T, options?: CreateElOptions): T {
  if (!options) return element;
  if (options.cls) {
    const classes = Array.isArray(options.cls) ? options.cls : options.cls.split(' ');
    for (const cls of classes) if (cls) element.classList.add(cls);
  }
  if (options.text !== undefined) element.textContent = options.text;
  if (options.attr) {
    for (const [key, value] of Object.entries(options.attr)) element.setAttribute(key, value);
  }
  if (options.type) (element as unknown as HTMLInputElement).type = options.type;
  if (options.placeholder) (element as unknown as HTMLTextAreaElement).placeholder = options.placeholder;
  if (options.title) element.title = options.title;
  if (options.href) (element as unknown as HTMLAnchorElement).href = options.href;
  if (options.value) (element as unknown as HTMLInputElement).value = options.value;
  return element;
}

export function createEl<T extends keyof HTMLElementTagNameMap>(
  tag: T,
  options?: CreateElOptions,
): HTMLElementTagNameMap[T] {
  const element = document.createElement(tag);
  return applyOptions(element, options);
}

if (typeof HTMLElement !== 'undefined') {
  const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
  proto.empty = function empty(this: HTMLElement) {
    this.textContent = '';
    return this;
  };
  proto.detach = function detach(this: HTMLElement) {
    this.remove();
  };
  proto.createEl = function createElOn(this: HTMLElement, tag: string, options?: CreateElOptions, callback?: ((el: HTMLElement) => void) | undefined) {
    const child = applyOptions(document.createElement(tag), options);
    this.appendChild(child);
    callback?.(child);
    return child;
  };
  proto.createDiv = function createDivOn(this: HTMLElement, options?: CreateElOptions, callback?: ((el: HTMLElement) => void) | undefined) {
    return (proto.createEl as (this: HTMLElement, tag: string, o?: CreateElOptions, cb?: (el: HTMLElement) => void) => HTMLElement).call(
      this,
      'div',
      options,
      callback,
    );
  };
  proto.createSpan = function createSpanOn(this: HTMLElement, options?: CreateElOptions, callback?: ((el: HTMLElement) => void) | undefined) {
    return (proto.createEl as (this: HTMLElement, tag: string, o?: CreateElOptions, cb?: (el: HTMLElement) => void) => HTMLElement).call(
      this,
      'span',
      options,
      callback,
    );
  };
  proto.setText = function setText(this: HTMLElement, text: string) {
    this.textContent = text;
    return this;
  };
  proto.appendText = function appendText(this: HTMLElement, text: string) {
    this.appendChild(document.createTextNode(text));
    return this;
  };
  proto.addClass = function addClass(this: HTMLElement, ...classes: string[]) {
    for (const cls of classes) this.classList.add(cls);
    return this;
  };
  proto.removeClass = function removeClass(this: HTMLElement, ...classes: string[]) {
    for (const cls of classes) this.classList.remove(cls);
    return this;
  };
  proto.toggleClass = function toggleClass(this: HTMLElement, cls: string, value: boolean) {
    this.classList.toggle(cls, value);
    return this;
  };
  proto.setAttr = function setAttr(this: HTMLElement, key: string, value: string) {
    this.setAttribute(key, value);
    return this;
  };
}
