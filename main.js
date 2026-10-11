// Forage for Obsidian: a thin client. The Forage server does the feeds, extraction and state;
// this only lists entries, renders one with Obsidian's own markdown renderer, and saves it into the vault.
const { Plugin, ItemView, MarkdownRenderer, Notice, PluginSettingTab, Setting, requestUrl, normalizePath, setIcon } = require("obsidian");

const LIST = "forage-list";
const ARTICLE = "forage-article";
const DEFAULTS = { server: "https://ubik.tailc994b1.ts.net", inbox: "inbox" };

class ForagePlugin extends Plugin {
  async onload() {
    this.settings = Object.assign({}, DEFAULTS, await this.loadData());
    this.entries = [];
    this.feeds = [];
    this.filter = "unread";
    this.currentId = null;
    this.listeners = new Set();

    this.registerView(LIST, (leaf) => new ListView(leaf, this));
    this.registerView(ARTICLE, (leaf) => new ArticleView(leaf, this));
    this.addRibbonIcon("rss", "Forage", () => this.showList());
    this.addSettingTab(new ForageSettings(this.app, this));

    const cmd = (id, name, callback) => this.addCommand({ id, name, callback });
    cmd("open", "Open feed list", () => this.showList());
    cmd("next", "Next article", () => this.step(1));
    cmd("previous", "Previous article", () => this.step(-1));
    cmd("save", "Save article to vault", () => this.articleView()?.save());
    cmd("star", "Toggle star", () => this.articleView()?.toggle("starred"));
    cmd("read", "Toggle read", () => this.articleView()?.toggle("is_read"));
    cmd("original", "Open original in browser", () => this.articleView()?.openOriginal());
    cmd("refresh", "Check feeds for new articles", () => this.refreshFeeds());
  }

  async saveSettings() { await this.saveData(this.settings); }

  async api(path, method = "GET", body) {
    const res = await requestUrl({
      url: this.settings.server.replace(/\/+$/, "") + path, method,
      contentType: body ? "application/json" : undefined, body: body ? JSON.stringify(body) : undefined,
    });
    return res.json;
  }

  changed() { this.listeners.forEach((fn) => fn()); }

  async loadFeeds() {
    try { this.feeds = await this.api("/api/feeds"); } catch (e) { this.feeds = []; }
  }

  async loadEntries(more = false) {
    const q = new URLSearchParams({ limit: "60" });
    const [kind, val] = this.filter.split(":");
    if (kind === "unread") q.set("unread", "true");
    else if (kind === "starred") q.set("starred", "true");
    else if (kind === "folder") q.set("folder", val);
    else if (kind === "feed") q.set("feed", val);
    if (more && this.entries.length) { const l = this.entries[this.entries.length - 1]; q.set("before", `${l.published}|${l.id}`); }
    try {
      const rows = await this.api("/api/entries?" + q);
      this.entries = more ? this.entries.concat(rows) : rows;
      this.hasMore = rows.length === 60;
    } catch (e) {
      new Notice("Forage: can't reach " + this.settings.server);
    }
    this.changed();
  }

  async refreshFeeds() {
    try { await this.api("/api/refresh", "POST"); } catch (e) { new Notice("Forage: refresh failed"); return; }
    await this.loadFeeds();
    await this.loadEntries();
  }

  async showList() {
    let leaf = this.app.workspace.getLeavesOfType(LIST)[0];
    if (!leaf) { leaf = this.app.workspace.getLeftLeaf(false); await leaf.setViewState({ type: LIST, active: true }); }
    this.app.workspace.revealLeaf(leaf);
  }

  // One article tab, reused, so a note stays open in the other pane while you click through articles.
  async openEntry(id) {
    this.currentId = id;
    let leaf = this.app.workspace.getLeavesOfType(ARTICLE)[0] || this.app.workspace.getLeaf("tab");
    await leaf.setViewState({ type: ARTICLE, state: { id }, active: true });
    this.app.workspace.revealLeaf(leaf);
    this.changed();
  }

  step(dir) {
    const i = this.entries.findIndex((e) => e.id === this.currentId);
    const next = this.entries[i + dir] || (i < 0 ? this.entries[0] : null);
    if (next) this.openEntry(next.id);
  }

  articleView() {
    const v = this.app.workspace.getActiveViewOfType(ArticleView) || this.app.workspace.getLeavesOfType(ARTICLE)[0]?.view;
    if (!v) new Notice("Forage: no article open");
    return v;
  }

  async saveClip(id) {
    const clip = await this.api(`/api/entries/${id}/clip`);
    if (clip.saved_path) { new Notice("Already saved: " + clip.saved_path); return clip.saved_path; }
    const dir = normalizePath(this.settings.inbox || "inbox");
    if (!(await this.app.vault.adapter.exists(dir))) await this.app.vault.createFolder(dir);
    const base = clip.filename.replace(/\.md$/, "");
    let name = base + ".md", n = 2;
    while (await this.app.vault.adapter.exists(`${dir}/${name}`)) name = `${base} ${n++}.md`;
    await this.app.vault.create(`${dir}/${name}`, clip.markdown);
    await this.api(`/api/entries/${id}/saved`, "POST", { path: name });
    new Notice("Saved to " + dir + "/" + name);
    return name;
  }
}

class ListView extends ItemView {
  constructor(leaf, plugin) { super(leaf); this.plugin = plugin; this.render = () => this.draw(); }
  getViewType() { return LIST; }
  getDisplayText() { return "Forage"; }
  getIcon() { return "rss"; }

  async onOpen() {
    this.contentEl.addClass("forage-list");
    this.plugin.listeners.add(this.render);
    await this.plugin.loadFeeds();
    await this.plugin.loadEntries();
  }
  async onClose() { this.plugin.listeners.delete(this.render); }

  draw() {
    const p = this.plugin, el = this.contentEl;
    el.empty();
    const nav = el.createDiv("nav-header").createDiv("nav-buttons-container");
    const btn = (icon, label, fn) => {
      const b = nav.createDiv({ cls: "clickable-icon nav-action-button", attr: { "aria-label": label } });
      setIcon(b, icon); b.onclick = fn; return b;
    };
    btn("refresh-cw", "Check for new articles", () => p.refreshFeeds());
    btn("check-check", "Mark all as read (or the selected folder or feed)", async () => {
      const [kind, val] = p.filter.split(":");
      const body = kind === "feed" ? { feed: +val } : kind === "folder" ? { folder: val } : { older_than: "9999" };
      await p.api("/api/mark-read", "POST", body); await p.loadFeeds(); await p.loadEntries();
    });

    const sel = el.createEl("select", { cls: "dropdown forage-filter" });
    const opt = (v, t) => sel.createEl("option", { value: v, text: t });
    opt("unread", "Unread"); opt("all", "All"); opt("starred", "Starred");
    [...new Set(p.feeds.map((f) => f.folder).filter(Boolean))].sort().forEach((f) => opt("folder:" + f, "Folder: " + f));
    p.feeds.forEach((f) => opt("feed:" + f.id, f.title + (f.unread ? ` (${f.unread})` : "")));
    sel.value = p.filter;
    sel.onchange = () => { p.filter = sel.value; p.loadEntries(); };

    const box = el.createDiv("nav-files-container");
    if (!p.entries.length) box.createDiv({ cls: "forage-empty", text: "Nothing here." });
    for (const e of p.entries) {
      const item = box.createDiv("tree-item nav-file");
      const self = item.createDiv({ cls: "tree-item-self nav-file-title is-clickable" + (e.id === p.currentId ? " is-active" : "") + (e.is_read ? " is-read" : " is-unread") });
      const inner = self.createDiv("tree-item-inner nav-file-title-content");
      inner.createSpan({ text: (e.starred ? "★ " : "") + (e.saved_path ? "✓ " : "") + e.title });
      const when = e.published ? new Date(e.published).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "";
      inner.createSpan({ cls: "forage-meta", text: [e.feed_title, when].filter(Boolean).join(" · ") });
      self.onclick = () => { e.is_read = 1; p.openEntry(e.id); };
    }
    if (p.hasMore) box.createEl("button", { cls: "forage-more", text: "Load more" }).onclick = () => p.loadEntries(true);
  }
}

class ArticleView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf); this.plugin = plugin; this.id = null; this.entry = null;
    this.addAction("download", "Save to vault", () => this.save());
    this.addAction("star", "Star", () => this.toggle("starred"));
    this.addAction("eye-off", "Mark unread", () => this.toggle("is_read"));
    this.addAction("external-link", "Open original", () => this.openOriginal());
  }
  getViewType() { return ARTICLE; }
  getDisplayText() { return this.entry?.title || "Forage"; }
  getIcon() { return "rss"; }

  getState() { return { id: this.id }; }
  async setState(state, result) {
    this.id = state?.id ?? null;
    await this.load();
    return super.setState(state, result);
  }

  async load() {
    const el = this.contentEl;
    el.empty(); el.addClass("forage-article");
    if (this.id == null) { el.createDiv({ cls: "forage-empty", text: "Pick an article from the Forage list." }); return; }
    try {
      this.entry = await this.plugin.api(`/api/entries/${this.id}`);
      const clip = await this.plugin.api(`/api/entries/${this.id}/clip`);
      const e = this.entry;
      const wrap = el.createDiv("markdown-preview-view markdown-rendered is-readable-line-width");
      const sizer = wrap.createDiv("markdown-preview-sizer markdown-preview-section");
      sizer.createEl("h1", { text: e.title });
      const when = e.published ? new Date(e.published).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" }) : "";
      sizer.createDiv({ cls: "forage-byline", text: [e.feed_title, e.author, when].filter(Boolean).join(" · ") });
      const body = clip.markdown.replace(/^---\n[\s\S]*?\n---\n+/, "").replace(/^# .*\n+/, "");
      await MarkdownRenderer.render(this.app, body, sizer.createDiv(), "", this);
      el.scrollTop = 0;
      this.leaf.updateHeader();
      this.plugin.currentId = this.id;
      const row = this.plugin.entries.find((x) => x.id === this.id);
      if (row) row.is_read = 1;
      this.plugin.changed();
    } catch (err) {
      el.createDiv({ cls: "forage-empty", text: "Couldn't load this article." });
    }
  }

  async save() {
    if (this.id == null) return;
    const name = await this.plugin.saveClip(this.id);
    const row = this.plugin.entries.find((x) => x.id === this.id);
    if (row) row.saved_path = name;
    this.plugin.changed();
  }

  async toggle(field) {
    if (!this.entry) return;
    const key = field === "starred" ? "starred" : "read";
    const val = this.entry[field] ? 0 : 1;
    await this.plugin.api(`/api/entries/${this.id}/state`, "POST", { [key]: !!val });
    this.entry[field] = val;
    const row = this.plugin.entries.find((x) => x.id === this.id);
    if (row) row[field] = val;
    new Notice(field === "starred" ? (val ? "Starred" : "Unstarred") : (val ? "Marked read" : "Marked unread"));
    this.plugin.changed();
  }

  openOriginal() { if (this.entry?.url) window.open(this.entry.url); }
}

class ForageSettings extends PluginSettingTab {
  constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }
  display() {
    const { containerEl: el } = this;
    el.empty();
    const s = this.plugin.settings;
    new Setting(el).setName("Forage server").setDesc("Address of your Forage server.")
      .addText((t) => t.setValue(s.server).onChange(async (v) => { s.server = v.trim(); await this.plugin.saveSettings(); }));
    new Setting(el).setName("Inbox folder").setDesc("Where saved articles are written, relative to the vault.")
      .addText((t) => t.setValue(s.inbox).onChange(async (v) => { s.inbox = v.trim(); await this.plugin.saveSettings(); }));
  }
}

module.exports = ForagePlugin;
