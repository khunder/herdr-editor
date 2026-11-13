# herdr-editor

A text editor for herdr-app, built as two mods:

- **explorer**: a sidebar list of the current workspace's folders and files. Click a text file to open it.
- **editor**: a pane that edits a file with syntax highlighting and saves it back to disk.

Target: herdr-app 0.1.15, herdr-core 0.1.21 (Linux).

## Install

```sh
./install.sh
```

This copies the mods into `~/.config/herdr-app/mods/` (or `$HERDR_APP_HOME/mods/`), runs `herdr-app check` on each, and installs the `hedit` launcher to `~/.local/bin`. herdr reloads mods as soon as they change, so there's no restart.

## Use

- Click a file in the **Files** sidebar.
- From a shell: `hedit <file>` opens it in a pane to the right; `hedit -d <file>` below; `hedit -t <file>` in a new tab.
- Or directly: `herdr-app do pane.split --direction right --mod editor --props '{"file":"/abs/path"}'`

## Features

- **Save** with `ctrl-s`. A dot in the header marks unsaved changes.
- **Never overwrites a file that changed on disk** since it was loaded: it asks you to Reload or Overwrite.
- Follows changes on disk while you have no unsaved edits.
- **Unsaved edits are kept as drafts** in `~/.config/herdr-app/editor-drafts/` and offered back when you reopen the file.
- **Markdown preview**: a Preview / Edit button (or `ctrl-shift-v`) shows `.md` files formatted. herdr 0.1.15 has no Markdown highlighter, so the source view stays plain.
- Files on another machine open read-only.

See [spec.md](spec.md) for the full design.
