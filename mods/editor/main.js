// A text editor pane: opens one file, edits it, saves it back.
//   herdr-app do pane.split --direction right --mod editor --props '{"file":"/abs/path"}'
//   herdr-app do tab.new --mod editor --props '{"file":"/abs/path"}'
// Props: { file, on?, line? }. `on` (another machine) opens read-only: writes are local only.
// Commands (keys.json "mod:editor", or `herdr-app do editor.<command>`):
//   save, reload, overwrite, restore-draft, discard-draft, preview (markdown: edit / formatted view).
// ctrl-s saves while the editor has the keyboard, without a keys.json entry.
// ctrl-shift-v switches a markdown file between editing and the formatted preview.
// Saving never overwrites a file that changed on disk since it was loaded: it asks.
// Unsaved edits are kept as a draft in ~/.config/herdr-app/editor-drafts/ and offered back.

import { View, div } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState, TextView } from "gpui-base";
import { props, readTextFile, writeTextFile, nextCommand, theme, settings, home, appHome, shared, setShared } from "herdr";
import * as fs from "fs/promises";

// The native highlighter knows: js, rust, python, go, json, yaml, sh, c, cpp, java, ruby, sql, lua, make
// (seen by trying each name in herdr-app 0.1.15). Other code gets its nearest relative's colors.
// Markdown, HTML, XML, CSS and diff have no highlighter and no close relative: they stay plain.
const LANG = {
  ts: "js", tsx: "js", mts: "js", cts: "js", jsx: "js", mjs: "js", cjs: "js", php: "js", jsonc: "json", json5: "json",
  rs: "rust", zig: "rust", py: "python", pyi: "python", rb: "ruby", golang: "go",
  toml: "yaml", yml: "yaml", ini: "yaml", conf: "sh", env: "sh", zsh: "sh", fish: "sh", bash: "sh", dockerfile: "sh",
  h: "c", cc: "cpp", cxx: "cpp", hpp: "cpp", hh: "cpp", cs: "java", kt: "java", kts: "java", swift: "java", scala: "java", dart: "java", groovy: "java", gradle: "java",
  mk: "make", makefile: "make", gnumakefile: "make", md: "markdown", mdx: "markdown",
};
// Files known by name rather than extension.
const NAMED = { makefile: "make", gnumakefile: "make", dockerfile: "sh", containerfile: "sh", ".bashrc": "sh", ".zshrc": "sh", ".profile": "sh", ".bash_profile": "sh", ".gitignore": "sh", ".env": "sh", "justfile": "make" };
const POLL_LOCAL = 3000, POLL_REMOTE = 10000, DRAFT_EVERY = 4000;

// Colors for code and for prose formats (markdown headings, emphasis, links, inline code),
// all from the theme's terminal palette, so the editor follows the theme.
const syntax = (t) => ({
  keyword: t.ansi5, preproc: t.ansi5, "punctuation.special": t.ansi5,
  string: t.ansi2, "string.escape": t.ansi6, "string.regex": t.ansi6, "string.special": t.ansi6, "string.special.symbol": t.ansi6,
  comment: t.dim, "comment.doc": t.dim,
  function: t.ansi4, constructor: t.ansi3,
  type: t.ansi3, enum: t.ansi3, variant: t.ansi6,
  number: t.ansi3, boolean: t.ansi3, constant: t.ansi6,
  variable: t.foreground, "variable.special": t.ansi1, property: t.ansi1,
  operator: t.ansi6, punctuation: t.muted, "punctuation.bracket": t.muted, "punctuation.delimiter": t.muted,
  tag: t.ansi1, "tag.doctype": t.ansi5, attribute: t.ansi3, label: t.ansi4,
  title: t.ansi4, emphasis: t.ansi5, "emphasis.strong": t.ansi3,
  link_text: t.ansi4, link_uri: t.ansi6, "text.literal": t.ansi2, "punctuation.list_marker": t.ansi1,
});
const look = (t) => JSON.stringify([syntax(t), settings().font_family]);
const message = (e) => String(e?.message ?? e).replace(/^Error:\s*/, "");

function hash(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(16).padStart(8, "0");
}

function absolute(path) {
  if (typeof path !== "string" || !path) return null;
  if (path === "~") return home();
  if (path.startsWith("~/")) return home() + path.slice(1);
  return path;
}

function shortFolder(file) {
  const dir = file.slice(0, Math.max(file.lastIndexOf("/"), file.lastIndexOf("\\")));
  const h = home();
  return dir === h ? "~" : dir.startsWith(h + "/") ? "~" + dir.slice(h.length) : dir || "/";
}

export default class TextEditor extends View {
  init(_props, cx) {
    const p = props() ?? {};
    // slot: set by the explorer mod, which reuses this pane for the next file it opens there.
    this.slot = p.slot ?? null;
    this.seenRequest = shared("editor.request")?.id ?? null;
    this.state = null;      // EditorState, once loaded
    this.loads = 0;
    this.handle = cx.focus_handle();
    this.draftDir = `${appHome()}/editor-drafts`;
    this.setFile(p.file, p.on ?? null, p.readonly === true);
    if (this.file) this.load(cx, true);
    cx.timer.every(POLL_LOCAL, (cx) => this.checkDisk(cx));
    cx.timer.every(DRAFT_EVERY, (cx) => this.flushDraft(cx));
    cx.spawn(async (cx) => {
      for (;;) {
        const command = String(await nextCommand()).replace(/^editor[.:]/, "");
        if (command === "save") this.save(cx, false);
        else if (command === "overwrite") this.save(cx, true);
        else if (command === "reload") this.reload(cx);
        else if (command === "restore-draft") this.restoreDraft();
        else if (command === "discard-draft") this.discardDraft(cx);
        else if (command === "focus") this.focus();
        else if (command === "preview") this.togglePreview();
        cx.notify();
      }
    });
  }

  // Points this pane at a file; load() then reads it.
  setFile(file, on, readonly) {
    this.loads++;
    this.state?.release();
    this.state = null;
    this.file = absolute(file);
    this.on = on;
    this.readonly = Boolean(on) || readonly;
    this.name = this.file ? this.file.split(/[\\/]/).pop() : "";
    // Markdown has no highlighter: offer the formatted view instead (read-only files open in it).
    this.markdown = /\.(md|mdx|markdown)$/i.test(this.name);
    this.preview = this.markdown && this.readonly;
    this.snapshot = null;   // the file's text as last read or written; null: not on disk
    this.dirty = false;
    this.saving = false;
    this.checking = false;
    this.notice = null;     // { kind: "conflict" | "draft" | "info" | "error", text }
    this.error = null;      // shown in place of the editor
    this.draft = null;      // a draft waiting for Restore / Discard
    this.draftStale = false;
    this.draftOnDisk = false;
    this.lastPoll = 0;
    this.draftPath = this.file ? `${this.draftDir}/${hash(this.file)}-${this.name.replace(/[^\w.-]/g, "_").slice(0, 60)}.json` : null;
  }

  // The explorer asks the editor of its tab (same slot) to show another file.
  // A pane with unsaved edits doesn't answer: the explorer then opens a new one.
  answerRequest(cx) {
    const request = shared("editor.request");
    if (!request || request.id === this.seenRequest) return;
    this.seenRequest = request.id;
    if (!this.slot || request.slot !== this.slot || request.claimed || this.dirty || this.saving || this.draft) return;
    cx.spawn(async (cx) => {
      const now = shared("editor.request");
      if (now?.id !== request.id || now.claimed || this.dirty || this.saving) return;
      setShared("editor.request", { ...now, claimed: true });
      this.setFile(request.file, request.on ?? null, false);
      this.load(cx, true);
      cx.notify();
    });
  }

  togglePreview() {
    if (!this.markdown) return;
    this.preview = !this.preview;
    if (!this.preview) this.focus();
  }

  focus() {
    if (this.state && typeof this.state.focus === "function") this.state.focus();
    else this.handle.focus();
  }

  // Replaces the editor state, keeping `value`. Called from tasks and handlers, never render.
  makeState(value) {
    const t = theme(), old = this.state, lower = this.name.toLowerCase(), ext = NAMED[lower] ?? (lower.includes(".") ? lower.split(".").pop() : "txt");
    this.look = look(t);
    const state = EditorState.new({
      language: LANG[ext] ?? ext, value, readonly: this.readonly,
      font_family: settings().font_family, font_size: 13, syntax: syntax(t),
    });
    state.on("change", (_e, cx) => {
      if (this.state !== state) return;
      const dirty = state.value() !== (this.snapshot ?? "");
      this.draftStale = true;
      if (dirty !== this.dirty) { this.dirty = dirty; cx.notify(); }
    });
    this.state = state;
    old?.release();
  }

  load(cx, offerDraft) {
    const turn = ++this.loads;
    cx.spawn(async (cx) => {
      try {
        const text = await readTextFile(this.file, { on: this.on });
        if (turn !== this.loads) return;
        if (text === null && this.readonly) throw new Error("no such file");
        if (text?.includes("\0")) { this.fail("Binary file · not opened as text"); return; }
        this.snapshot = text; this.dirty = false; this.error = null; this.notice = null; this.draft = null;
        this.makeState(text ?? "");
        if (this.readonly) return;
        const draft = await this.readDraft();
        if (turn !== this.loads) return;
        if (draft && offerDraft && draft.value !== (text ?? "")) {
          this.draft = draft; this.draftOnDisk = true;
          this.notice = { kind: "draft", text: "Unsaved edits from last time were kept" };
        } else if (draft) await this.removeDraft();
      } catch (e) {
        if (turn === this.loads) this.fail(`Cannot open this file: ${message(e)} (files over 1 MiB are not opened)`);
      } finally { cx.notify(); }
    });
  }

  fail(text) {
    this.state?.release(); this.state = null; this.dirty = false; this.notice = null; this.error = text;
  }

  reload(cx) {
    if (!this.file) return;
    this.draftStale = false;
    cx.spawn(async () => { await this.removeDraft(); });
    this.load(cx, false);
  }

  // force: write over whatever is on disk now (after the person chose Overwrite).
  save(cx, force) {
    if (this.readonly || !this.state || this.saving) return;
    const value = this.state.value();
    if (!force && this.snapshot !== null && value === this.snapshot) return;
    this.saving = true;
    cx.spawn(async (cx) => {
      let expected = this.snapshot;
      try {
        if (force) expected = await readTextFile(this.file);
        await writeTextFile(this.file, value, expected);
        this.snapshot = value;
        this.dirty = this.state.value() !== value;
        this.notice = null; this.draft = null;
        this.draftStale = this.dirty;
        if (!this.dirty) await this.removeDraft();
      } catch (e) {
        const disk = await readTextFile(this.file).catch(() => undefined);
        if (disk !== undefined && disk !== expected) {
          this.notice = { kind: "conflict", text: disk === null ? "Deleted on disk since you opened it · not saved" : "Changed on disk since you opened it · not saved" };
        } else this.notice = { kind: "error", text: `Could not save: ${message(e)}` };
      } finally { this.saving = false; cx.notify(); }
    });
  }

  // The file on disk against what was loaded: follow it when the buffer is clean, say so when not.
  checkDisk(cx) {
    if (!this.state || this.saving || this.checking) return;
    if (this.on && Date.now() - this.lastPoll < POLL_REMOTE) return;
    this.lastPoll = Date.now();
    this.checking = true;
    const turn = this.loads, state = this.state;
    cx.spawn(async (cx) => {
      try {
        const disk = await readTextFile(this.file, { on: this.on });
        if (turn !== this.loads || state !== this.state || this.saving) return;
        if (disk === this.snapshot) {
          if (this.notice?.kind === "conflict") { this.notice = null; cx.notify(); }
          return;
        }
        if (disk !== null && disk.includes("\0")) return;
        if (disk !== null && (!this.dirty || disk === state.value())) {
          this.snapshot = disk;
          if (state.value() !== disk) state.set_value(disk);
          this.dirty = false;
          if (this.notice?.kind === "conflict") this.notice = null;
        } else if (disk === null && !this.dirty) {
          this.snapshot = null;
          this.notice = { kind: "info", text: this.readonly ? "Deleted on disk" : "Deleted on disk · Save writes it again" };
        } else {
          this.notice = { kind: "conflict", text: disk === null ? "Deleted on disk while you have unsaved edits" : "Changed on disk while you have unsaved edits" };
        }
        cx.notify();
      } catch { /* unreadable for now: the next poll tries again */ }
      finally { this.checking = false; }
    });
  }

  async readDraft() {
    try {
      if (!(await fs.exists(this.draftPath))) return null;
      const draft = JSON.parse(await fs.readFile(this.draftPath, "utf8"));
      return draft?.file === this.file && typeof draft.value === "string" ? draft : null;
    } catch { return null; }
  }

  async writeDraft() {
    await fs.mkdir(this.draftDir, { recursive: true });
    await fs.writeFile(this.draftPath, JSON.stringify({ file: this.file, value: this.state.value(), saved_at: Date.now() }));
    this.draftOnDisk = true;
  }

  async removeDraft() {
    try { if (await fs.exists(this.draftPath)) await fs.unlink(this.draftPath); } catch { /* nothing to remove */ }
    this.draftOnDisk = false;
  }

  flushDraft(cx) {
    // A draft waiting for an answer is the person's: don't replace or remove it.
    if (this.readonly || !this.state || !this.draftStale || this.draft) return;
    this.draftStale = false;
    cx.spawn(async () => {
      try { if (this.dirty) await this.writeDraft(); else if (this.draftOnDisk) await this.removeDraft(); }
      catch { this.draftStale = true; }
    });
  }

  restoreDraft() {
    if (!this.draft || !this.state) return;
    const value = this.draft.value;
    this.draft = null; this.notice = null;
    this.state.set_value(value);
    this.dirty = value !== (this.snapshot ?? "");
    this.draftStale = true;
  }

  discardDraft(cx) {
    if (!this.draft) return;
    this.draft = null; this.notice = null;
    cx.spawn(async () => { await this.removeDraft(); });
  }

  // The pane is going (or the app quits): keep unsaved edits for next time.
  async close() {
    if (this.readonly || !this.state || !this.dirty || this.draft) return;
    try { await this.writeDraft(); } catch { /* best effort */ }
  }

  button(t, id, label, primary, action) {
    return h_flex().id(id).h(20).px(8).flex_none().items_center().rounded(5).border_1()
      .border_color(primary ? t.solid : t.input).bg(primary ? t.solid : t.raised)
      .text_color(primary ? t.solid_foreground : t.foreground).text_size(11).cursor_pointer()
      .hover((s) => s.opacity(0.85))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { action(cx); cx.notify(); })
      .child(label);
  }

  noticeBar(t) {
    const n = this.notice, color = n.kind === "error" || n.kind === "conflict" ? t.blocked : t.accent;
    const bar = h_flex().h(30).flex_none().px(10).gap(8).items_center().border_b(1).border_color(t.border).bg(color + "1f")
      .child(div().size(6).flex_none().rounded(3).bg(color))
      .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(n.text));
    if (n.kind === "conflict") return bar
      .child(this.button(t, "ed-reload", "Reload", false, (cx) => this.reload(cx)))
      .child(this.button(t, "ed-overwrite", "Overwrite", true, (cx) => this.save(cx, true)));
    if (n.kind === "draft") return bar
      .child(this.button(t, "ed-discard", "Discard", false, (cx) => this.discardDraft(cx)))
      .child(this.button(t, "ed-restore", "Restore", true, () => this.restoreDraft()));
    return bar.child(this.button(t, "ed-dismiss", "Dismiss", false, () => { this.notice = null; }));
  }

  render(cx) {
    const t = theme();
    this.answerRequest(cx);
    // Syntax colors are fixed when a state is made: make it again when the theme or font changes.
    if (this.state && this.look !== look(t)) {
      this.look = look(t);
      cx.spawn(async (cx) => { if (this.state) { this.makeState(this.state.value()); cx.notify(); } });
    }
    const canSave = !this.readonly && Boolean(this.state) && (this.dirty || this.snapshot === null);
    const header = h_flex().h(28).flex_none().px(10).gap(8).items_center().border_b(1).border_color(t.border).bg(t.surface)
      .child(div().flex_none().max_w(320).truncate().font_medium().text_color(t.foreground).child(this.name || "Editor"))
      .when(this.dirty, (el) => el.child(div().size(7).flex_none().rounded(4).bg(t.accent)))
      .child(div().flex_1().min_w(0).truncate().text_color(t.dim).child(this.file ? shortFolder(this.file) + (this.on ? ` · ${this.on}` : "") : ""))
      .when(Boolean(this.state) && this.snapshot === null && !this.readonly, (el) => el.child(div().flex_none().text_size(11).text_color(t.muted).child("new file")))
      .when(this.markdown && Boolean(this.state), (el) => el.child(
        this.button(t, "ed-preview", this.preview ? "Edit" : "Preview", false, () => this.togglePreview())))
      .when(this.readonly && Boolean(this.file), (el) => el.child(div().flex_none().text_size(11).text_color(t.muted).child("read-only")))
      .when(!this.readonly && Boolean(this.state), (el) => el.child(
        canSave
          ? this.button(t, "ed-save", this.saving ? "Saving…" : "Save", true, (cx) => this.save(cx, false))
          : div().flex_none().text_size(11).text_color(t.dim).child("Saved")));

    const body = this.state && this.preview
      ? div().id("ed-preview-scroll").flex_1().min_h(0).overflow_y_scroll().px(20).py(14).text_size(14).child(
          TextView.markdown("ed-preview", this.state.value()).selectable(true))
      : this.state
      ? Editor.new(this.state).flex_1().min_h(0)
      : div().flex_1().min_h(0).p(14).text_color(t.dim).child(
          !this.file ? "No file. Open one with: herdr-app do pane.split --direction right --mod editor --props '{\"file\":\"/path/to/file\"}'"
            : this.error ?? "Loading…");

    return v_flex().id("editor").track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.keystroke === "ctrl-shift-v" || e.keystroke === "cmd-shift-v") {
          if (!this.markdown) return;
          this.togglePreview();
          cx.stop_propagation();
          cx.notify();
          return;
        }
        if (e.keystroke !== "ctrl-s" && e.keystroke !== "cmd-s") return;
        this.save(cx, false);
        cx.stop_propagation();
        cx.notify();
      })
      .size_full().min_h(0).bg(t.background).text_color(t.foreground).text_size(12)
      .child(header)
      .when(Boolean(this.notice), (el) => el.child(this.noticeBar(t)))
      .child(body);
  }
}
