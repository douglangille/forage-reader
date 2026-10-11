// Forage for Obsidian: a thin client. The Forage server does the feeds, extraction and state;
// this only lists entries, renders one with Obsidian's own markdown renderer, and saves it into the vault.
const { Plugin, ItemView, Component, MarkdownRenderer, Modal, Notice, PluginSettingTab, Setting, requestUrl, normalizePath, setIcon } = require("obsidian");

const LIST = "forage-list";
const ARTICLE = "forage-article";
const NARROW = 260; // below this width the thumbnails are dropped
const WIDE = 440;   // at this width the feed tree appears beside the list
const PAGE = 60;
const DEFAULTS = { server: "", inbox: "inbox", collapsed: [], scope: "all", unreadOnly: true };

const splitOnce = (s) => { const i = s.indexOf(":"); return i < 0 ? [s, ""] : [s.slice(0, i), s.slice(i + 1)]; };
const httpOnly = (u) => (/^https?:\/\//i.test(u || "") ? u : "");
const sourceOf = (md) => (/^source:\s*"(.*)"\s*$/m.exec(md || "") || [])[1] || "";
const msg = (e) => (e && e.message) || String(e);

class ConfirmModal extends Modal {
  constructor(app, text, onYes) { super(app); this.text = text; this.onYes = onYes; }
  onOpen() {
    this.contentEl.createEl("p", { text: this.text });
    const row = this.contentEl.createDiv("modal-button-container");
    row.createEl("button", { text: "Cancel" }).onclick = () => this.close();
    const ok = row.createEl("button", { cls: "mod-cta", text: "Mark read" });
    ok.onclick = () => { this.close(); this.onYes(); };
  }
}

class ForagePlugin extends Plugin {
  async onload() {
    this.settings = Object.assign({}, DEFAULTS, await this.loadData());
    this.entries = [];
    this.feeds = [];
    this.error = "";
    this.hasMore = false;
    this.currentId = null;
    this.loadSeq = 0;
    this.lastLoad = 0;
    this.listeners = new Set();

    this.registerView(LIST, (leaf) => new ListView(leaf, this));
    this.registerView(ARTICLE, (leaf) => new ArticleView(leaf, this));
    this.addRibbonIcon("rss", "Forage", () => this.showList());
    this.addSettingTab(new ForageSettings(this.app, this));
    this.registerDomEvent(window, "focus", () => this.onFocus());

    const cmd = (id, name, callback) => this.addCommand({ id, name, callback });
    const onArticle = (id, name, fn) => this.addCommand({
      id, name, checkCallback: (checking) => {
        const v = this.articleView();
        if (!v) return false;
        if (!checking) fn(v);
        return true;
      },
    });
    cmd("open", "Open feed list", () => this.showList());
    cmd("next", "Next article", () => this.step(1));
    cmd("previous", "Previous article", () => this.step(-1));
    cmd("refresh", "Check feeds for new articles", () => this.refreshFeeds());
    onArticle("save", "Save article to vault", (v) => v.save());
    onArticle("save-again", "Save article again (write a new copy)", (v) => v.save(true));
    onArticle("star", "Toggle star", (v) => v.toggle("starred"));
    onArticle("read", "Toggle read", (v) => v.toggle("is_read"));
    onArticle("original", "Open original in browser", (v) => v.openOriginal());
  }

  async saveSettings() { await this.saveData(this.settings); }
  configured() { return !!this.settings.server.trim(); }

  async api(path, method = "GET", body) {
    const res = await requestUrl({
      url: this.settings.server.trim().replace(/\/+$/, "") + path, method,
      headers: { "X-Forage": "1" },
      contentType: body ? "application/json" : undefined, body: body ? JSON.stringify(body) : undefined,
    });
    return res.json;
  }

  changed() { this.listeners.forEach((fn) => fn()); }

  onFocus() {
    if (!this.configured() || Date.now() - this.lastLoad < 60000) return;
    this.reload(true);
  }

  async reload(keepCurrent = false) {
    await this.loadFeeds();
    await this.loadEntries({ keepCurrent });
  }

  async loadFeeds() {
    if (!this.configured()) { this.feeds = []; this.changed(); return; }
    try { this.feeds = await this.api("/api/feeds"); this.error = ""; }
    catch (e) { this.error = msg(e); }
    this.changed();
  }

  async loadEntries({ more = false, keepCurrent = false } = {}) {
    if (!this.configured()) { this.entries = []; this.changed(); return; }
    if (more && this.loadingMore) return;
    const seq = more ? this.loadSeq : ++this.loadSeq; // a fresh load supersedes anything still in flight
    if (more) this.loadingMore = true;
    const q = new URLSearchParams({ limit: String(PAGE) });
    const [kind, val] = splitOnce(this.settings.scope);
    if (kind === "feed") q.set("feed", val);
    else if (kind === "folder") q.set("folder", val);
    if (kind === "starred") q.set("starred", "true");
    else if (this.settings.unreadOnly) q.set("unread", "true");
    if (more && this.entries.length) { const l = this.entries[this.entries.length - 1]; q.set("before", `${l.published}|${l.id}`); }
    try {
      const rows = await this.api("/api/entries?" + q);
      if (seq !== this.loadSeq) return;
      if (more) {
        const have = new Set(this.entries.map((e) => e.id));
        this.entries = this.entries.concat(rows.filter((r) => !have.has(r.id)));
      } else {
        const i = this.entries.findIndex((e) => e.id === this.currentId);
        if (keepCurrent && i >= 0 && !rows.some((r) => r.id === this.currentId)) rows.splice(Math.min(i, rows.length), 0, this.entries[i]);
        this.entries = rows;
      }
      this.hasMore = rows.length === PAGE;
      this.error = "";
      this.lastLoad = Date.now();
    } catch (e) {
      if (seq === this.loadSeq) this.error = msg(e);
    } finally {
      if (more) this.loadingMore = false;
    }
    this.changed();
  }

  async setScope(scope) {
    this.settings.scope = scope;
    await this.saveSettings();
    await this.loadEntries();
  }

  async setUnreadOnly(v) {
    this.settings.unreadOnly = v;
    await this.saveSettings();
    await this.loadEntries();
  }

  async refreshFeeds() {
    try {
      const r = await this.api("/api/refresh", "POST");
      new Notice(r.busy ? "Forage: already checking" : r.new ? `Forage: ${r.new} new` : "Forage: nothing new");
    } catch (e) { new Notice("Forage: refresh failed: " + msg(e)); return; }
    await this.reload();
  }

  async markAllRead() {
    const [kind, val] = splitOnce(this.settings.scope);
    if (kind === "starred") { new Notice("Forage: mark all read doesn't apply to Starred"); return; }
    const label = kind === "feed" ? (this.feeds.find((f) => String(f.id) === val)?.title || "this feed") : kind === "folder" ? val : "all items";
    const body = kind === "feed" ? { feed: +val } : kind === "folder" ? { folder: val } : {};
    // Only what arrived before the list was loaded: anything newer is still unseen.
    const newest = this.entries.reduce((m, e) => (e.published > m ? e.published : m), "");
    if (newest) body.older_than = newest;
    new ConfirmModal(this.app, `Mark everything in "${label}" as read?`, async () => {
      try {
        const r = await this.api("/api/mark-read", "POST", body);
        new Notice(`Forage: ${r.marked} marked read`);
        await this.reload();
      } catch (e) { new Notice("Forage: couldn't mark read: " + msg(e)); }
    }).open();
  }

  // Keeps the list rows and the tree's unread counts in step with a change made in the article tab.
  patchEntry(id, patch) {
    const row = this.entries.find((e) => e.id === id);
    if (row) {
      if ("is_read" in patch && !!row.is_read !== !!patch.is_read) {
        const f = this.feeds.find((x) => x.id === row.feed_id);
        if (f) f.unread = Math.max(0, f.unread + (patch.is_read ? -1 : 1));
      }
      Object.assign(row, patch);
    }
    this.changed();
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

  async step(dir) {
    let i = this.entries.findIndex((e) => e.id === this.currentId);
    if (dir > 0 && i + 1 >= this.entries.length && this.hasMore) { await this.loadEntries({ more: true }); i = this.entries.findIndex((e) => e.id === this.currentId); }
    const next = this.entries[i + dir] || (i < 0 ? this.entries[0] : null);
    if (next) this.openEntry(next.id);
  }

  articleView() {
    return this.app.workspace.getActiveViewOfType(ArticleView) || this.app.workspace.getLeavesOfType(ARTICLE)[0]?.view || null;
  }

  async saveClip(id, force = false) {
    const clip = await this.api(`/api/entries/${id}/clip`);
    if (clip.saved_path && !force) {
      new Notice(`Already saved as ${clip.saved_path}. Use "Save article again" for another copy.`);
      return clip.saved_path;
    }
    const dir = normalizePath(this.settings.inbox || "inbox");
    const fs = this.app.vault.adapter;
    if (!(await fs.exists(dir))) await this.app.vault.createFolder(dir);
    const base = clip.filename.replace(/\.md$/, "");
    const source = sourceOf(clip.markdown);
    let name = base + ".md", n = 2;
    for (;;) {
      const path = `${dir}/${name}`;
      if (!(await fs.exists(path))) break;
      // The file is already there from an earlier save whose "saved" call never landed: link it, don't duplicate it.
      if (!force && source && sourceOf(await fs.read(path)) === source) {
        await this.api(`/api/entries/${id}/saved`, "POST", { path: name });
        new Notice("Forage: linked the note already in " + dir);
        return name;
      }
      name = `${base} ${n++}.md`;
    }
    await this.app.vault.create(`${dir}/${name}`, clip.markdown);
    await this.api(`/api/entries/${id}/saved`, "POST", { path: name });
    new Notice(`Saved to ${dir}/${name}`);
    return name;
  }
}

class ListView extends ItemView {
  constructor(leaf, plugin) { super(leaf); this.plugin = plugin; this.wide = false; this.render = () => this.draw(); }
  getViewType() { return LIST; }
  getDisplayText() { return "Forage"; }
  getIcon() { return "rss"; }

  async onOpen() {
    this.contentEl.addClass("forage-list");
    this.plugin.listeners.add(this.render);
    // Wide sidebar: feed tree beside the article list. Narrow: a dropdown above the list.
    const ro = new ResizeObserver(() => {
      const w = this.contentEl.clientWidth;
      this.contentEl.toggleClass("is-narrow", w < NARROW);
      const wide = w >= WIDE;
      if (wide !== this.wide) { this.wide = wide; this.draw(); }
    });
    ro.observe(this.contentEl);
    this.register(() => ro.disconnect());
    this.draw();
    await this.plugin.reload();
  }
  async onClose() { this.plugin.listeners.delete(this.render); }

  draw() {
    const p = this.plugin, el = this.contentEl;
    const keep = [...el.querySelectorAll(".forage-scroll")].map((n) => n.scrollTop);
    el.empty();
    el.toggleClass("is-wide", this.wide);

    const nav = el.createDiv("nav-header").createDiv("nav-buttons-container");
    const btn = (icon, label, fn, on = false) => {
      const b = nav.createDiv({ cls: "clickable-icon nav-action-button" + (on ? " is-active" : ""), attr: { "aria-label": label, role: "button", tabindex: "0" } });
      setIcon(b, icon);
      b.onclick = fn;
      b.onkeydown = (ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); fn(); } };
      return b;
    };
    btn("refresh-cw", "Check for new articles", () => p.refreshFeeds());
    btn(p.settings.unreadOnly ? "eye-off" : "eye", p.settings.unreadOnly ? "Showing unread only. Click to show all" : "Showing read and unread. Click for unread only",
      () => p.setUnreadOnly(!p.settings.unreadOnly), p.settings.unreadOnly);
    btn("check-check", "Mark everything in this view as read", () => p.markAllRead());

    if (!p.configured()) {
      this.notice(el, "Set your Forage server address in Settings → Forage.");
      return;
    }
    if (p.error && !p.entries.length) {
      this.notice(el, "Can't reach the Forage server: " + p.error, "Retry", () => p.reload());
      return;
    }

    let box;
    if (this.wide) {
      const split = el.createDiv("forage-split");
      this.drawTree(split.createDiv("forage-tree forage-scroll"));
      box = split.createDiv("nav-files-container forage-items forage-scroll");
    } else {
      const sel = el.createEl("select", { cls: "dropdown forage-filter", attr: { "aria-label": "Feed or folder" } });
      const opt = (v, t) => sel.createEl("option", { value: v, text: t });
      opt("all", "All items"); opt("starred", "Starred");
      [...new Set(p.feeds.map((f) => f.folder).filter(Boolean))].sort((a, b) => a.localeCompare(b)).forEach((f) => opt("folder:" + f, "Folder: " + f));
      p.feeds.forEach((f) => opt("feed:" + f.id, (f.title || f.url) + (f.unread ? ` (${f.unread})` : "")));
      sel.value = p.settings.scope;
      sel.onchange = () => p.setScope(sel.value);
      box = el.createDiv("nav-files-container forage-items forage-scroll");
    }
    this.drawItems(box);
    el.querySelectorAll(".forage-scroll").forEach((n, i) => { n.scrollTop = keep[i] || 0; });
  }

  notice(el, text, label, fn) {
    const d = el.createDiv("forage-empty");
    d.createDiv({ text });
    if (label) d.createEl("button", { cls: "mod-cta", text: label }).onclick = fn;
  }

  drawTree(tree) {
    const p = this.plugin;
    const press = (el, fn) => {
      el.onclick = fn;
      el.onkeydown = (ev) => { if (ev.target === el && (ev.key === "Enter" || ev.key === " ")) { ev.preventDefault(); fn(ev); } };
    };
    const row = (parent, scope, text, count, cls = "", err = "") => {
      const item = parent.createDiv("tree-item");
      const self = item.createDiv({
        cls: "tree-item-self is-clickable forage-node " + cls + (p.settings.scope === scope ? " is-active" : "") + (err ? " has-error" : ""),
        attr: { role: "button", tabindex: "0", ...(err ? { title: "Last fetch failed: " + err } : {}) },
      });
      self.createDiv({ cls: "tree-item-inner", text });
      if (count) self.createDiv({ cls: "tree-item-flair-outer" }).createSpan({ cls: "tree-item-flair", text: String(count) });
      press(self, () => p.setScope(scope));
      return { item, self };
    };
    const sum = (fs) => fs.reduce((n, f) => n + (f.unread || 0), 0);
    const title = (f) => f.title || f.url;
    row(tree, "all", "All items", sum(p.feeds));
    row(tree, "starred", "Starred");

    const collapsed = new Set(p.settings.collapsed);
    const folders = [...new Set(p.feeds.map((f) => f.folder).filter(Boolean))].sort((a, b) => a.localeCompare(b));
    for (const name of folders) {
      const fs = p.feeds.filter((f) => f.folder === name);
      const { item, self } = row(tree, "folder:" + name, name, sum(fs), "forage-folder");
      const open = !collapsed.has(name);
      const chev = self.createDiv({ cls: "tree-item-icon collapse-icon" + (open ? "" : " is-collapsed"), attr: { role: "button", tabindex: "0", "aria-expanded": String(open), "aria-label": (open ? "Collapse " : "Expand ") + name } });
      setIcon(chev, "right-triangle");
      self.prepend(chev);
      const toggle = async (ev) => {
        ev.stopPropagation();
        const c = new Set(p.settings.collapsed);
        c.has(name) ? c.delete(name) : c.add(name);
        p.settings.collapsed = [...c];
        await p.saveSettings();
        this.draw();
      };
      chev.onclick = toggle;
      chev.onkeydown = (ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); toggle(ev); } };
      if (open) {
        const kids = item.createDiv("tree-item-children");
        fs.forEach((f) => row(kids, "feed:" + f.id, title(f), f.unread, "", f.error || ""));
      }
    }
    p.feeds.filter((f) => !f.folder).forEach((f) => row(tree, "feed:" + f.id, title(f), f.unread, "", f.error || ""));
  }

  drawItems(box) {
    const p = this.plugin;
    if (!p.entries.length) box.createDiv({ cls: "forage-empty", text: p.settings.unreadOnly ? "Nothing unread here." : "Nothing here." });
    for (const e of p.entries) {
      const item = box.createDiv("tree-item nav-file");
      const open = () => p.openEntry(e.id);
      const self = item.createDiv({
        cls: "tree-item-self nav-file-title is-clickable forage-row" + (e.id === p.currentId ? " is-active" : "") + (e.is_read ? " is-read" : " is-unread"),
        attr: { role: "button", tabindex: "0" },
      });
      self.onclick = open;
      self.onkeydown = (ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); open(); } };
      const inner = self.createDiv("tree-item-inner nav-file-title-content");
      const t = inner.createSpan();
      if (e.starred) t.createSpan({ cls: "forage-flag", text: "★ ", attr: { "aria-label": "Starred" } });
      if (e.saved_path) t.createSpan({ cls: "forage-flag", text: "✓ ", attr: { "aria-label": "Saved" } });
      t.appendText(e.title);
      const when = e.published ? new Date(e.published).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "";
      inner.createSpan({ cls: "forage-meta", text: [e.feed_title, when].filter(Boolean).join(" · ") });
      if (e.thumb) self.createEl("img", { cls: "forage-thumb", attr: { src: p.settings.server.trim().replace(/\/+$/, "") + e.thumb, loading: "lazy", alt: "" } });
    }
    if (p.hasMore) box.createEl("button", { cls: "forage-more", text: "Load more" }).onclick = () => p.loadEntries({ more: true });
  }
}

class ArticleView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin; this.id = null; this.entry = null; this.tok = 0; this.comp = null; this.busy = false;
    this.acts = {
      save: this.addAction("download", "Save to vault", () => this.save()),
      star: this.addAction("star", "Star", () => this.toggle("starred")),
      read: this.addAction("eye-off", "Mark unread", () => this.toggle("is_read")),
      original: this.addAction("external-link", "Open original", () => this.openOriginal()),
    };
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
  async onClose() { if (this.comp) this.removeChild(this.comp); }

  // Reflect the article's state in the header buttons, so a star looks starred and a saved article looks saved.
  syncActions() {
    const e = this.entry, a = this.acts;
    const set = (el, icon, label, on) => { setIcon(el, icon); el.setAttribute("aria-label", label); el.toggleClass("forage-on", !!on); };
    set(a.save, e?.saved_path ? "check" : "download", e?.saved_path ? `Saved as ${e.saved_path}. Click to save another copy` : "Save to vault", e?.saved_path);
    set(a.star, "star", e?.starred ? "Unstar" : "Star", e?.starred);
    set(a.read, e?.is_read ? "eye-off" : "eye", e?.is_read ? "Mark unread" : "Mark read", false);
    a.original.toggleClass("forage-hidden", !e?.url);
  }

  async load() {
    const el = this.contentEl, tok = ++this.tok;
    el.addClass("forage-article");
    if (this.id == null) { el.empty(); el.createDiv({ cls: "forage-empty", text: "Pick an article from the Forage list." }); return; }
    let clip;
    try { clip = await this.plugin.api(`/api/entries/${this.id}/clip`); }
    catch (err) {
      if (tok !== this.tok) return;
      el.empty();
      const d = el.createDiv("forage-empty");
      d.createDiv({ text: "Couldn't load this article: " + msg(err) });
      d.createEl("button", { text: "Retry" }).onclick = () => this.load();
      return;
    }
    if (tok !== this.tok) return; // a newer article was requested while this one loaded

    // Render off-screen, then swap in: overlapping loads can never stack their articles in the tab.
    const next = createDiv();
    const wrap = next.createDiv("markdown-preview-view markdown-rendered is-readable-line-width");
    const sizer = wrap.createDiv("markdown-preview-sizer markdown-preview-section");
    sizer.createEl("h1", { text: clip.title });
    const when = clip.published ? new Date(clip.published).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" }) : "";
    sizer.createDiv({ cls: "forage-byline", text: [clip.feed_title, clip.author, when].filter(Boolean).join(" · ") });
    const comp = new Component();
    comp.load();
    const body = clip.markdown.replace(/^---\n[\s\S]*?\n---\n+/, "").replace(/^# .*\n+/, "");
    await MarkdownRenderer.render(this.app, body, sizer.createDiv(), "", comp);
    if (tok !== this.tok) { comp.unload(); return; }

    if (this.comp) this.removeChild(this.comp);
    this.comp = comp;
    this.addChild(comp);
    el.empty();
    el.appendChild(next.firstChild);
    el.scrollTop = 0;

    this.entry = { id: clip.id, feed_id: clip.feed_id, title: clip.title, author: clip.author, url: httpOnly(clip.url), starred: clip.starred, is_read: clip.is_read, saved_path: clip.saved_path };
    this.leaf.updateHeader?.();
    this.plugin.currentId = this.id;
    if (!clip.is_read) {
      this.plugin.api(`/api/entries/${this.id}/state`, "POST", { read: true }).then(() => {
        if (this.entry && this.entry.id === clip.id) this.entry.is_read = 1;
        this.plugin.patchEntry(clip.id, { is_read: 1 });
        this.syncActions();
      }).catch(() => {});
    }
    this.plugin.patchEntry(clip.id, { starred: clip.starred, saved_path: clip.saved_path });
    this.syncActions();
  }

  async save(force = false) {
    if (this.id == null || this.busy) return;
    if (!force && this.entry?.saved_path) { new Notice(`Already saved as ${this.entry.saved_path}. Use "Save article again" for another copy.`); return; }
    this.busy = true;
    try {
      const name = await this.plugin.saveClip(this.id, force);
      if (this.entry) this.entry.saved_path = name;
      this.plugin.patchEntry(this.id, { saved_path: name });
    } catch (err) {
      new Notice("Forage: save failed: " + msg(err));
    }
    this.busy = false;
    this.syncActions();
  }

  async toggle(field) {
    if (!this.entry) return;
    const val = this.entry[field] ? 0 : 1;
    try {
      await this.plugin.api(`/api/entries/${this.id}/state`, "POST", { [field === "starred" ? "starred" : "read"]: !!val });
    } catch (err) { new Notice("Forage: couldn't update: " + msg(err)); return; }
    this.entry[field] = val;
    this.plugin.patchEntry(this.id, { [field]: val });
    this.syncActions();
  }

  openOriginal() { if (this.entry?.url) window.open(this.entry.url); }
}

class ForageSettings extends PluginSettingTab {
  constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }
  display() {
    const { containerEl: el } = this;
    el.empty();
    const s = this.plugin.settings;
    new Setting(el).setName("Forage server").setDesc("Address of your Forage server, for example https://forage.example.ts.net.")
      .addText((t) => t.setPlaceholder("https://").setValue(s.server).onChange(async (v) => {
        s.server = v.trim();
        await this.plugin.saveSettings();
        this.plugin.reload();
      }));
    new Setting(el).setName("Inbox folder").setDesc("Where saved articles are written, relative to the vault.")
      .addText((t) => t.setValue(s.inbox).onChange(async (v) => { s.inbox = v.trim(); await this.plugin.saveSettings(); }));
  }
}

module.exports = ForagePlugin;
