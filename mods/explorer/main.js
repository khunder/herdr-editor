// The current workspace's folders and files, as a sidebar list beside Spaces and Agents.
// Root: the repo (else the folder) of the terminal last focused in the shown space.
// Folders open in place and load when opened. Clicking a text file opens it in the
// `editor` mod: the tab's editor pane if it has one without unsaved edits, else a new
// pane to the right. Binary files and files over 1 MiB are refused with a toast.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { spaces, panes, focused, exec, readTextFile, watchFolder, theme, home, run, notify, shared, setShared, layout } from "herdr";

const PER_FOLDER = 1000, TOTAL = 5000, REFRESH = 10000, CLAIM_WAIT = 300;
// Lists one folder as kind\0name\0 pairs (d or f), without .git.
const LIST = 'n=0; for p in "$1"/* "$1"/.[!.]* "$1"/..?*; do [ -e "$p" ] || [ -L "$p" ] || continue; name=${p##*/}; [ "$name" = .git ] && continue; if [ -d "$p" ]; then kind=d; else kind=f; fi; printf "%s\\0%s\\0" "$kind" "$name"; n=$((n+1)); [ "$n" -gt ' + PER_FOLDER + ' ] && break; done; exit 0';

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}
// The sidebar folded to its rail: no room for a tree.
const narrow = () => (find(layout(), "sidebar")?.size?.px ?? Infinity) < 160;

async function list(path, on) {
  const r = await exec("sh", ["-c", LIST, "explorer", path], { on });
  if (r.code !== 0) throw new Error(r.stderr.trim() || "Cannot list this folder");
  const fields = r.stdout.split("\0"), out = [];
  for (let i = 0; i + 1 < fields.length; i += 2) out.push({ name: fields[i + 1], dir: fields[i] === "d" });
  return out.sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
}

export default class Explorer extends View {
  init(_props, cx) {
    this.root = null; this.on = null;
    this.entries = new Map();   // folder path relative to root ("" = root) -> entries
    this.folders = new Set();   // open folders, relative
    this.opened = new Map();    // root key -> open folders, to come back to
    this.lastCwd = new Map();   // space id -> the folder of its last focused terminal
    this.pending = new Set();
    this.selected = null;       // absolute path of the file opened last
    this.error = null; this.limited = false; this.loading = false;
    this.targetKey = null; this.generation = 0; this.watched = null;
    this.follow(cx);
    cx.timer.every(REFRESH, (cx) => { this.follow(cx); this.reload(cx); });
  }

  // Where the person is working: a terminal's folder. A focused mod pane (the editor)
  // has none, so the space's last one stays.
  target() {
    const space = spaces().find((s) => s.active);
    if (!space) return null;
    const f = focused();
    const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
    let cwd = pane?.terminal ? pane.cwd : f && f.pane === null ? f.cwd : null;
    if (cwd) this.lastCwd.set(space.id, cwd);
    else cwd = this.lastCwd.get(space.id);
    if (!cwd) {
      const tab = space.tabs.find((t) => t.active)?.id;
      cwd = panes().find((p) => p.tab === tab && p.terminal && p.cwd)?.cwd ?? (space.folder || (space.machine ? null : home()));
    }
    return cwd ? { cwd, on: space.machine ?? null } : null;
  }

  // Follows the target: its repo's top folder, else the folder itself.
  follow(cx) {
    const target = this.target(), key = JSON.stringify(target);
    if (key === this.targetKey) return;
    this.targetKey = key;
    if (!target) { this.setRoot(null, null); return; }
    cx.spawn(async (cx) => {
      let root = target.cwd;
      try {
        const r = await exec("git", ["rev-parse", "--show-toplevel"], { cwd: target.cwd, on: target.on });
        if (r.code === 0 && r.stdout.trim()) root = r.stdout.trim();
      } catch { /* no git, or not a folder any more: the folder itself */ }
      if (this.targetKey !== key) return;
      if (this.setRoot(root, target.on)) this.reload(cx);
      cx.notify();
    });
  }

  setRoot(root, on) {
    if (root === this.root && on === this.on) return false;
    if (this.root) this.opened.set(JSON.stringify([this.root, this.on]), this.folders);
    this.root = root; this.on = on; this.generation++;
    this.folders = new Set(this.opened.get(JSON.stringify([root, on])));
    this.entries = new Map(); this.pending = new Set();
    this.error = null; this.limited = false; this.loading = false;
    return Boolean(root);
  }

  async loadFolder(path, generation) {
    const entries = await list(path ? `${this.root}/${path}` : this.root, this.on);
    if (generation !== this.generation || (path && !this.folders.has(path))) return;
    let used = 0;
    for (const [p, e] of this.entries) if (p !== path) used += e.length;
    const room = Math.max(0, Math.min(PER_FOLDER, TOTAL - used));
    if (entries.length > room) this.limited = true;
    this.entries.set(path, entries.slice(0, room));
  }

  reload(cx) {
    if (!this.root || this.loading) return;
    const generation = this.generation;
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        this.limited = false;
        for (const path of ["", ...this.folders]) {
          if (generation !== this.generation) return;
          try { await this.loadFolder(path, generation); }
          catch (e) {
            if (!path) throw e;
            // An open folder that's gone: close it.
            if (generation === this.generation) { this.folders.delete(path); this.entries.delete(path); }
          }
        }
        if (generation === this.generation) { this.error = null; this.watch(cx); }
      } catch (e) {
        if (generation === this.generation) { this.error = String(e?.message ?? e); this.entries = new Map(); }
      } finally {
        if (generation === this.generation) this.loading = false;
        cx.notify();
      }
    });
  }

  // Local folders refresh as they change; the timer covers remote ones and big trees.
  watch(cx) {
    const key = JSON.stringify([this.root, this.on]);
    if (this.on || this.watched === key || this.root === home() || this.root === "/") return;
    this.watched = key;
    const root = this.root;
    cx.spawn(async (cx) => {
      try {
        while (this.watched === key && this.root === root) {
          await watchFolder(root);
          if (this.watched === key && this.root === root) this.reload(cx);
        }
      } catch { if (this.watched === key) this.watched = null; }
    });
  }

  toggle(path, cx) {
    if (this.folders.has(path)) {
      for (const folder of [...this.folders]) if (folder === path || folder.startsWith(path + "/")) {
        this.folders.delete(folder);
        this.entries.delete(folder);
      }
      return;
    }
    this.folders.add(path);
    if (this.entries.has(path) || this.pending.has(path)) return;
    const generation = this.generation;
    this.pending.add(path);
    cx.spawn(async (cx) => {
      try { await this.loadFolder(path, generation); }
      catch (e) {
        if (generation === this.generation) {
          this.folders.delete(path);
          notify({ title: "Cannot open this folder", body: String(e?.message ?? e), level: "error" });
        }
      } finally {
        if (generation === this.generation) this.pending.delete(path);
        cx.notify();
      }
    });
  }

  // Text files only: read it first, and leave binaries and big files alone.
  open(path, cx) {
    const file = `${this.root}/${path}`, on = this.on, name = path.split("/").pop();
    cx.spawn(async (cx) => {
      let text;
      try { text = await readTextFile(file, { on }); }
      catch { notify({ title: `Can't open ${name}`, body: "Not a text file, or larger than 1 MiB.", level: "warning" }); return; }
      if (text === null) { notify({ title: `${name} is gone`, level: "warning" }); this.reload(cx); return; }
      if (text.includes("\0")) { notify({ title: `Can't open ${name}`, body: "It is a binary file. Only text files open in the editor.", level: "warning" }); return; }
      this.selected = file;
      const tab = focused()?.tab;
      const split = () => run("pane.split", { direction: "right", mod: "editor", props: { file, on, slot: tab } });
      if (!tab || !panes().some((p) => p.tab === tab && p.mod === "editor")) { split(); cx.notify(); return; }
      // Ask the tab's editor to show it; with unsaved edits it won't, so open another.
      const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      setShared("editor.request", { id, slot: tab, file, on });
      cx.timer.after(CLAIM_WAIT, () => {
        const request = shared("editor.request");
        if (request?.id !== id || request.claimed) return;
        setShared("editor.request", { ...request, claimed: true });
        split();
      });
      cx.notify();
    });
  }

  rows(prefix, depth, out, t) {
    if (out.length >= TOTAL || depth > 40) return out;
    for (const entry of this.entries.get(prefix) ?? []) {
      if (out.length >= TOTAL) break;
      const path = prefix ? `${prefix}/${entry.name}` : entry.name, open = this.folders.has(path);
      const selected = !entry.dir && this.selected === `${this.root}/${path}`;
      out.push(h_flex().id(`ex-${path}`).h(26).flex_none().pl(8 + depth * 14).pr(8).gap(6).items_center().rounded(6).cursor_pointer()
        .when(selected, (el) => el.bg(t.selected))
        .hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => { if (entry.dir) this.toggle(path, cx); else this.open(path, cx); cx.notify(); })
        .child(entry.dir ? svg(`mods/explorer/chevron-${open ? "down" : "right"}.svg`).size(11).flex_none().text_color(t.dim) : div().w(11).flex_none())
        .child(svg(`mods/explorer/${entry.dir ? "folder" : "file"}.svg`).size(13).flex_none().text_color(entry.dir ? t.muted : t.dim))
        .child(div().flex_1().min_w(0).truncate().text_color(selected ? t.foreground : entry.name.startsWith(".") ? t.dim : t.muted).child(entry.name)));
      if (entry.dir && open) this.rows(path, depth + 1, out, t);
    }
    return out;
  }

  render(cx) {
    this.follow(cx);
    const t = theme();
    const base = v_flex().id("explorer").size_full().min_h(0).bg(t.chrome).border_t(1).border_color(t.border).text_size(12.5);
    if (narrow()) return base;
    const h = home(), root = this.root;
    const where = !root ? "" : root === h ? "~" : root.split(/[\\/]/).filter(Boolean).pop() ?? "/";
    const empty = !this.entries.get("")?.length;
    return base
      .child(h_flex().px(16).h(41).pt(14).pb(5).flex_none().gap(8).items_center()
        .child(div().flex_none().text_size(11.5).font_medium().text_color(t.dim).child("Files"))
        .child(div().flex_1().min_w(0).truncate().text_right().text_size(11).text_color(t.dim).child(where + (this.on ? ` · ${this.on}` : ""))))
      .child(v_flex().id("ex-list").flex_1().min_h(0).px(8).pb(6).overflow_y_scrollbar().children(this.rows("", 0, [], t))
        .when(empty, (el) => el.child(div().px(8).py(4).text_size(12).text_color(t.dim).child(this.error || (this.loading ? "Loading…" : root ? "Empty folder" : "No folder"))))
        .when(this.limited, (el) => el.child(div().px(8).py(6).text_size(11).text_color(t.dim).child(`Showing at most ${PER_FOLDER} per folder, ${TOTAL} in all`))));
  }
}
