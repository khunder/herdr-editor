# Text editor for herdr-app

Status: built 2026-11-13; see Verification at the end for what has and hasn't been tried in the app. Target: herdr-app 0.1.15, herdr-core 0.1.21 (Linux).

## Summary
 
Add a text editor to herdr-app as two personal mods. `explorer` is a sidebar list, under Spaces and Agents, of the current workspace's folders and files. Clicking a text file opens it in `editor`, a pane beside the terminals that edits it with syntax highlighting and saves it back to disk. herdr-app is a closed binary, so the editor is built entirely from what mods are given: the native `Editor` / `EditorState` element from `gpui-base` and the file functions in the `herdr` module.

Today the app can only *view* files: the shipped `files` mod shows a read-only `EditorState` preview. Nothing in the app writes a file the person is editing.

## Goals 

- Open any text file on this machine in an editable pane or tab.
- Save with `ctrl-s`, with a visible unsaved-changes marker.
- Never silently overwrite a file that changed on disk since it was loaded.
- Browse the workspace's folders and files in the sidebar and open a text file with one click.
- Also open files from a shell (`hedit <file>`, `herdr-app do`), so agents can open files for the person too.
- Follow the person's theme, terminal font and zoom.

## Non-goals (v1)

- Editing files on other machines. `writeTextFile` is local only; remote files open read-only.
- LSP, completion, diagnostics, multi-cursor, vim/emacs modes.
- Files over 1 MiB or binary files (`readTextFile` limit; refused with a message).
- Multiple files as tabs inside one editor pane. One pane edits one file; herdr tabs and splits do the arranging.
- Changing shipped mods in place. They are replaced on every start.

## What the person sees

A pane like any other (splits, zooms, closes, has the pane header), containing:

1. **Header row, 28px:** file name, dimmed parent folder, a dot when there are unsaved changes, and a `Save` button. Read-only files show a `read-only` label instead of the button.
2. **Editor:** fills the rest. Line numbers, folding, syntax colors from the theme's ANSI colors (same mapping as the `files` mod), `settings().font_family`.
3. **Notice bar, only when needed:** "Changed on disk" with `Reload` and `Overwrite`; or a load/save error.

## Behavior

| Case | Result |
|---|---|
| Open | `readTextFile(path)`. The loaded text is kept as the *snapshot*. |
| Edit | Dirty = `state.value() !== snapshot`, recomputed on the state's `change` event. |
| Save | `writeTextFile(path, value, snapshot)`. On success the snapshot becomes the saved value. |
| Save conflict | `writeTextFile` rejects on a stale snapshot. Show the notice bar; nothing is written. `Overwrite` re-reads the file and saves against that; `Reload` discards edits. |
| File changes on disk, buffer clean | Reload silently (checked every 3 s; 10 s for remote files). |
| File changes on disk, buffer dirty | Show the notice bar; keep the buffer. |
| New file (path absent) | Empty buffer; first save passes `expected: null`. |
| Close or quit while dirty | The edits are written to `~/.config/herdr-app/editor-drafts/` (also every 4 s while editing). Opening the file again offers `Restore` or `Discard`. A mod can't stop its pane closing, so there is no Save/Cancel dialog. |
| Binary (`\0` in text), over 1 MiB, unreadable | Message in place of the editor; no state created. |
| Remote space | Opens with `readonly: true`; no Save. |

Language comes from the file extension, reusing the `files` mod's alias table (`ts`/`tsx`/`jsx` → `js`, `toml` → `yaml`, and so on).

## Interface

**Props:** `{ file: string, on?: string | null, line?: number }`. `file` is absolute. `line` is accepted but ignored until the element exposes cursor control (see Open questions).

**Opening it:**

```sh
herdr-app do pane.split --direction right --mod editor --props '{"file":"/abs/path"}'
herdr-app do tab.new --mod editor --props '{"file":"/abs/path"}'
```

```sh
hedit path/to/file        # a pane to the right; -d below; -t a new tab
```

**Keys:** `ctrl-s` saves while the editor has the keyboard. The mod handles the key itself, so `keys.json` is untouched and keeps receiving Herdr's new default shortcuts. The mod also answers `editor.save`, `editor.reload`, `editor.overwrite`, `editor.restore-draft` and `editor.discard-draft`, for anyone who wants to bind them under `mod:editor`.

## The file list (`explorer`)

- **Where:** a third block in the sidebar, under Agents, titled Files with the root folder's name. Hidden when the sidebar is folded to its rail.
- **Root:** the git repo (else the folder) of the terminal last focused in the shown space. Focusing the editor pane doesn't move it.
- **Rows:** folders first, then files, dotfiles dimmed, `.git` left out. Folders open in place and load when opened; open folders are remembered per root. At most 1000 entries per folder and 5000 in all.
- **Refresh:** when the folder changes on disk (local), and every 10 s.
- **Click a file:** it is read first. Binary files and files over 1 MiB get a toast and don't open. A text file opens in the tab's editor pane if there is one without unsaved edits; otherwise in a new pane to the right. So one editor pane per tab is reused, and unsaved work is never replaced.
- **Layout:** shipped layouts are read-only, so the block lives in `layouts/workspace.json`, a clone of `main`. `ctrl-shift-l` cycles layouts; deleting the file removes it. The clone doesn't receive Herdr's later changes to `main`.

## Built from

Source lives in this repo; `./install.sh` copies it into `~/.config/herdr-app/mods/`, runs `herdr-app check` on each mod and installs `hedit` to `~/.local/bin`.

```
mods/editor/     main.js, mod.json            the editor pane
mods/explorer/   main.js, mod.json, 4 svgs    the sidebar file list
bin/hedit        opens a file in the editor from a shell
install.sh
```

- `EditorState.new({ language, value, readonly, font_family, font_size, syntax })` + `Editor.new(state)`; the state is made again when the theme or font changes, since syntax colors are fixed at creation.
- `readTextFile`, `writeTextFile` (atomic replace, snapshot check); a 3-second poll for disk changes rather than `watchFolder`, which would watch the file's whole parent tree.
- Explorer to editor: shared value `editor.request` `{ id, slot, file, on }`. The editor pane the explorer opened in that tab (`props.slot` = the tab id) claims it if it has no unsaved edits; unclaimed after 300 ms, the explorer splits a new pane.
- `exec("sh", ...)` to list a folder and `exec("git", ["rev-parse", "--show-toplevel"])` for the root, both with `on` for remote spaces.

## Constraints and risks

- **`EditorState` is small:** `value`, `set_value`, `on`, `release`. No cursor, selection or scroll API, so jump-to-line and a custom find bar can't be built on it. Whatever undo, find and clipboard the native element provides is what v1 has.
- **`set_value` on reload** likely resets scroll and cursor. Acceptable for an explicit reload; the silent reload of a clean buffer may be jarring and needs trying.
- **`close()` gets 250 ms** and can't open a dialog, hence drafts instead of a close prompt.
- **Dirty check compares whole strings** on each change. Fine under the 1 MiB cap.
- Mods are trusted code with file write access; the editor writes only the file it was opened on, plus its own drafts.

## Syntax colors

The native editor highlights js, rust, python, go, json, yaml, sh, c, cpp, java, ruby, sql, lua and make (found by trying each language name in herdr-app 0.1.15). The editor maps relatives onto those (ts/tsx/php to js, toml/ini to yaml, kotlin/swift/c# to java, zig to rust, Dockerfile and dotfiles to sh). Markdown, HTML, XML, CSS and diff have no highlighter and stay plain; mods have no way to add one.

## Not built

- Jump to line (`props.line`) and a custom find bar: `EditorState` has no cursor API.
- Monaco: mods can't use HTML or a web view, so a browser editor can't be embedded. The native `Editor` element is the only option.
- Creating, renaming and deleting files from the list.

## Verification

Seen working in the app: both mods pass `herdr-app check`; a file opens with syntax colors, line numbers and folding; a draft is offered and `Restore` marks the buffer unsaved with a Save button; closing a pane with unsaved edits leaves a draft; the `workspace` layout loads without errors and has the `explorer` block.

Not yet seen working: saving to disk, the refused save after a change on disk, `Overwrite`, `ctrl-s`, the file list's look and its click-to-open, and remote read-only. The app window stopped drawing during testing, and keys and clicks can't be sent to it from a shell.
