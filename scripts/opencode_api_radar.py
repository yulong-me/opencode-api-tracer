#!/usr/bin/env python3
from __future__ import annotations

import argparse
import base64
import json
import os
import subprocess
import sys
from collections import defaultdict
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any


DEFAULT_TRACE_DIR = Path(os.environ.get("OPENCODE_API_TRACER_DIR", Path.home() / "opencode-api-tracer"))


def ensure_dependencies() -> None:
    missing = []
    for package, module in [("rich", "rich"), ("textual", "textual"), ("pygments", "pygments"), ("pyperclip", "pyperclip")]:
        try:
            __import__(module)
        except ImportError:
            missing.append(package)

    if not missing:
        return

    print(f"Missing dependencies {missing}; installing...")
    cmd = [sys.executable, "-m", "pip", "install", *missing]
    subprocess.check_call(cmd)
    os.execv(sys.executable, [sys.executable, *sys.argv])


def load_events(trace_dir: Path) -> list[dict[str, Any]]:
    events: list[dict[str, Any]] = []
    if not trace_dir.exists():
        return events
    for file in sorted(trace_dir.glob("*.jsonl"), key=lambda item: item.stat().st_mtime):
        with file.open("r", encoding="utf-8", errors="replace") as handle:
            for line_no, line in enumerate(handle, start=1):
                line = line.strip()
                if not line:
                    continue
                try:
                    row = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if not isinstance(row, dict):
                    continue
                if not row.get("sessionID") or not row.get("kind"):
                    continue
                row["file"] = file
                row["line"] = line_no
                events.append(row)
    events.sort(key=lambda row: row.get("timestamp", ""))
    return events


def summarize_sessions(events: list[dict[str, Any]]) -> list[dict[str, Any]]:
    sessions: dict[str, dict[str, Any]] = {}
    for row in events:
        sid = str(row["sessionID"])
        info = sessions.setdefault(
            sid,
            {
                "sessionID": sid,
                "count": 0,
                "request_count": 0,
                "response_count": 0,
                "error_count": 0,
                "start_time": None,
                "end_time": None,
                "files": set(),
                "title": None,
            },
        )
        info["count"] += 1
        kind = row.get("kind")
        if kind == "request":
            info["request_count"] += 1
            info["title"] = info["title"] or extract_prompt(row.get("body")) or sid
        elif kind == "response":
            info["response_count"] += 1
        elif kind == "error":
            info["error_count"] += 1
        timestamp = row.get("timestamp")
        if timestamp:
            if info["start_time"] is None or timestamp < info["start_time"]:
                info["start_time"] = timestamp
            if info["end_time"] is None or timestamp > info["end_time"]:
                info["end_time"] = timestamp
        if row.get("file"):
            info["files"].add(row["file"])

    out = []
    for info in sessions.values():
        info = dict(info)
        info["files"] = sorted(info["files"])
        out.append(info)
    out.sort(key=lambda row: row.get("end_time") or "", reverse=True)
    return out


def extract_prompt(body: Any) -> str | None:
    def usable(text: str | None) -> str | None:
        if not text:
            return None
        text = text.strip()
        if not text or text == "Generate a title for this conversation:":
            return None
        return text

    def from_part(part: Any) -> str | None:
        if isinstance(part, str):
            return usable(part)
        if not isinstance(part, dict):
            return None
        for key in ("text", "input_text"):
            if isinstance(part.get(key), str):
                found = usable(part[key])
                if found:
                    return found
        return None

    def from_content(content: Any) -> str | None:
        if isinstance(content, str):
            return usable(content)
        if not isinstance(content, list):
            return None
        for part in content:
            found = from_part(part)
            if found:
                return found
        return None

    if not isinstance(body, dict):
        return None
    for key in ("messages", "input"):
        items = body.get(key)
        if not isinstance(items, list):
            continue
        for item in items:
            if not isinstance(item, dict) or item.get("role") != "user":
                continue
            found = from_content(item.get("content")) or from_part(item)
            if found:
                return found
    prompt = body.get("prompt")
    return usable(prompt) if isinstance(prompt, str) else None


def is_meta_event(row: dict[str, Any]) -> bool:
    body = row.get("body")
    raw = json.dumps(body, ensure_ascii=False) if body is not None else ""
    return "You are a title generator" in raw or "Generate a title for this conversation" in raw


def cst_time(timestamp: str | None) -> str:
    if not timestamp:
        return "unknown"
    try:
        text = timestamp.replace("Z", "+00:00")
        dt = datetime.fromisoformat(text)
        return (dt + timedelta(hours=8)).strftime("%Y-%m-%d %H:%M:%S")
    except Exception:
        return timestamp.replace("T", " ").replace("Z", "")


def payload_text(row: dict[str, Any]) -> str:
    body = row.get("body")
    if isinstance(body, str):
        return body
    return json.dumps(body, indent=2, ensure_ascii=False)


def payload_size_kb(row: dict[str, Any]) -> float:
    return len(payload_text(row).encode("utf-8")) / 1024


def row_status(row: dict[str, Any]) -> str:
    if row.get("kind") == "response":
        return str(row.get("status", ""))
    if row.get("kind") == "error":
        return str(row.get("error", "error"))
    return ""


class JsonlTailer:
    def __init__(self, trace_dir: Path, session_id: str, include_meta: bool = False):
        self.trace_dir = trace_dir
        self.session_id = session_id
        self.include_meta = include_meta
        self.loaded = False
        self.positions: dict[Path, int] = {}
        self.prev_request_sizes: dict[str, float] = defaultdict(float)

    def poll(self) -> list[dict[str, Any]]:
        if not self.loaded:
            self.loaded = True
            rows = [self._decorate(row) for row in load_events(self.trace_dir) if self._accept(row)]
            for file in self._files():
                self.positions[file] = file.stat().st_size
            return rows

        out: list[dict[str, Any]] = []
        for file in self._files():
            last = self.positions.get(file, 0)
            size = file.stat().st_size
            if size < last:
                last = 0
            if size <= last:
                continue
            with file.open("r", encoding="utf-8", errors="replace") as handle:
                handle.seek(last)
                for line_no, line in enumerate(handle, start=1):
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        row = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    if not isinstance(row, dict):
                        continue
                    row["file"] = file
                    row["line"] = line_no
                    if self._accept(row):
                        out.append(self._decorate(row))
                self.positions[file] = handle.tell()
        out.sort(key=lambda row: row.get("timestamp", ""))
        return out

    def _files(self) -> list[Path]:
        if not self.trace_dir.exists():
            return []
        return sorted(self.trace_dir.glob("*.jsonl"), key=lambda item: item.stat().st_mtime)

    def _accept(self, row: dict[str, Any]) -> bool:
        if row.get("sessionID") != self.session_id:
            return False
        return self.include_meta or not is_meta_event(row)

    def _decorate(self, row: dict[str, Any]) -> dict[str, Any]:
        row = dict(row)
        row["size_kb"] = payload_size_kb(row)
        row["delta_kb"] = 0.0
        if row.get("kind") == "request":
            previous = self.prev_request_sizes[self.session_id]
            row["delta_kb"] = max(0.0, row["size_kb"] - previous) if previous > 0 else 0.0
            self.prev_request_sizes[self.session_id] = row["size_kb"]
        row["meta"] = is_meta_event(row)
        return row


def copy_to_clipboard(app: Any, text: str) -> None:
    if not text:
        return
    try:
        app.copy_to_clipboard(text)
    except Exception:
        pass
    try:
        encoded = base64.b64encode(text.encode("utf-8")).decode("ascii")
        sys.__stdout__.write(f"\033]52;c;{encoded}\007")
        sys.__stdout__.flush()
    except Exception:
        pass


def run_selector(trace_dir: Path, include_meta: bool) -> tuple[Path, str]:
    ensure_dependencies()

    from rich.console import Console
    from rich.prompt import IntPrompt
    from rich.table import Table

    console = Console()
    if not trace_dir.exists():
        console.print(f"[bold red]Trace directory does not exist: {trace_dir}[/]")
        sys.exit(1)
    events = [row for row in load_events(trace_dir) if include_meta or not is_meta_event(row)]
    sessions = summarize_sessions(events)
    if not sessions:
        console.print(f"[bold red]No trace JSONL events found in {trace_dir}[/]")
        sys.exit(0)

    table = Table(title="OpenCode API Trace Sessions", show_header=True, header_style="bold cyan")
    table.add_column("#", justify="right", style="bold yellow")
    table.add_column("Session", style="bold green")
    table.add_column("Title", style="cyan")
    table.add_column("Start UTC+8", style="dim")
    table.add_column("End UTC+8", style="magenta")
    table.add_column("Rows", justify="right")
    table.add_column("Req/Res/Err", justify="right")
    for index, item in enumerate(sessions, start=1):
        table.add_row(
            str(index),
            item["sessionID"],
            str(item.get("title") or item["sessionID"])[:64],
            cst_time(item.get("start_time")),
            cst_time(item.get("end_time")),
            str(item["count"]),
            f"{item['request_count']}/{item['response_count']}/{item['error_count']}",
        )
    console.print(table)
    choice = IntPrompt.ask("Select session", choices=[str(i) for i in range(1, len(sessions) + 1)])
    return trace_dir, sessions[choice - 1]["sessionID"]


def run_tui(tailer: JsonlTailer, live: bool) -> None:
    ensure_dependencies()
    import difflib

    from rich.text import Text
    from textual import on
    from textual.app import App, ComposeResult
    from textual.binding import Binding
    from textual.containers import Horizontal, Vertical, VerticalScroll
    from textual.widgets import Button, DataTable, Footer, Header, Label, TextArea

    def bar(size_kb: float, delta_kb: float, width: int = 15, max_kb: float = 200.0) -> Text:
        blocks = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉"]

        def scale(kb: float) -> float:
            return (min(max(0.0, kb), max_kb) / max_kb) ** 0.6

        total_units = int(scale(size_kb) * width * 8)
        if delta_kb > 0:
            base_units = int(scale(max(0.0, size_kb - delta_kb)) * width * 8)
            delta_units = total_units - base_units
            if delta_units == 0 and delta_kb > 0.1:
                delta_units = 1
                base_units = max(0, base_units - 1)
        else:
            base_units = total_units
            delta_units = 0

        base_full, base_rem = divmod(base_units, 8)
        delta_full, delta_rem = divmod(delta_units, 8)
        base = "█" * base_full + (blocks[base_rem] if base_rem else "")
        delta = "█" * delta_full + (blocks[delta_rem] if delta_rem else "")
        rendered = len(base) + len(delta)
        out = Text()
        out.append(base, style="cyan")
        out.append(delta, style="red" if delta_kb > 10 else "yellow" if delta_kb > 2 else "green")
        out.append("░" * max(0, width - rendered), style="dim")
        return out

    class ApiTraceRadar(App):
        CSS = """
        Screen { layout: horizontal; }
        #left-pane { width: 50%; height: 100%; border-right: vkey $panel; }
        #right-pane { width: 50%; height: 100%; background: $surface; layout: vertical; }
        #filter-container { height: auto; border-bottom: solid #333; background: #0f172a; }
        #filter-title { width: 100%; padding: 1 1 0 1; content-align: center middle; }
        #filter-bar { padding: 0 1 1 1; height: auto; align: center middle; }
        .filter-btn { margin-right: 2; min-width: 14; }
        #right-header { height: auto; width: 100%; padding: 1 2; align: left middle; background: #1e293b; border-bottom: solid #333; }
        #detail-title { text-style: bold; color: #e2e8f0; width: 1fr; }
        #right-buttons { layout: horizontal; width: auto; height: auto; }
        .action-btn { min-width: 12; height: 1; border: none; padding: 0 2; margin-left: 2; color: white; }
        #status-banner { width: 100%; height: auto; padding: 1; text-style: bold; display: none; }
        .banner-red { background: #8B0000; color: white; }
        .banner-yellow { background: #B8860B; color: white; }
        .banner-green { background: #006400; color: white; }
        #diff-container { width: 100%; height: auto; max-height: 40%; background: #1A365D; color: #E2E8F0; border-bottom: hkey cyan; display: none; layout: vertical; }
        #diff-title { padding: 1; width: 100%; text-style: bold; color: cyan; }
        #diff-summary { height: 1fr; width: 100%; padding: 0; border: none; background: transparent; }
        #json-view { height: 1fr; width: 100%; border: none; }
        DataTable { height: 100%; }
        """
        BINDINGS = [Binding("q", "quit", "Quit")]

        def __init__(self) -> None:
            super().__init__()
            self.rows: list[dict[str, Any]] = []
            self.filters = {"request", "response", "error"}
            self.current_text = ""
            self.current_index: int | None = None

        def compose(self) -> ComposeResult:
            yield Header(show_clock=True)
            with Horizontal():
                with VerticalScroll(id="left-pane"):
                    with Vertical(id="filter-container"):
                        yield Label("API Trace Filters", id="filter-title")
                        with Horizontal(id="filter-bar"):
                            yield Button("✅ Request", id="btn_request", variant="success", classes="filter-btn")
                            yield Button("✅ Response", id="btn_response", variant="success", classes="filter-btn")
                            yield Button("✅ Error", id="btn_error", variant="success", classes="filter-btn")
                    yield DataTable(id="request-table")
                with Vertical(id="right-pane"):
                    with Horizontal(id="right-header"):
                        yield Label("Details", id="detail-title")
                        with Horizontal(id="right-buttons"):
                            yield Button("Copy selected", id="btn_copy_selected", classes="action-btn")
                            yield Button("Copy all", id="btn_copy_all", classes="action-btn")
                    yield Label(id="status-banner")
                    with Vertical(id="diff-container"):
                        yield Label(id="diff-title")
                        diff = TextArea(id="diff-summary")
                        diff.read_only = True
                        yield diff
                    view = TextArea("Select a row on the left", id="json-view")
                    view.read_only = True
                    yield view
            yield Footer()

        def on_mount(self) -> None:
            self.title = f"{'LIVE' if live else 'STATIC'} API Trace - {tailer.session_id}"
            table = self.query_one(DataTable)
            table.cursor_type = "row"
            table.zebra_stripes = True
            table.add_columns("Time UTC+8", "Kind", "Load", "Size", "Status")
            if live:
                self.set_interval(1.5, self.check_updates)
            self.check_updates()

        @on(Button.Pressed)
        def on_button(self, event: Button.Pressed) -> None:
            button = event.button
            if button.id == "btn_copy_all":
                copy_to_clipboard(self, self.current_text)
                self.notify("Copied full payload")
                return
            if button.id == "btn_copy_selected":
                selected = self.query_one("#json-view", TextArea).selected_text or self.query_one("#diff-summary", TextArea).selected_text
                if selected:
                    copy_to_clipboard(self, selected)
                    self.notify("Copied selection")
                else:
                    self.notify("Select text in the right pane first", severity="warning")
                return
            mapping = {"btn_request": "request", "btn_response": "response", "btn_error": "error"}
            labels = {"btn_request": "Request", "btn_response": "Response", "btn_error": "Error"}
            kind = mapping.get(button.id or "")
            if not kind:
                return
            if kind in self.filters:
                self.filters.remove(kind)
                button.label = f"⬜ {labels[button.id]}"
                button.variant = "default"
            else:
                self.filters.add(kind)
                button.label = f"✅ {labels[button.id]}"
                button.variant = "success"
            self.refresh_table()

        def row_args(self, row: dict[str, Any]) -> tuple[Any, Any, Any, Any, Any]:
            kind = row.get("kind", "")
            meta = row.get("meta")
            style = "dim" if meta else "bold cyan" if kind == "request" else "bold blue" if kind == "response" else "bold red"
            label = f"{kind}{' [meta]' if meta else ''}"
            return (
                cst_time(row.get("timestamp")),
                Text(label, style=style),
                bar(row.get("size_kb", 0.0), row.get("delta_kb", 0.0)) if kind == "request" else Text(""),
                Text(f"{row.get('size_kb', 0.0):.1f}K", style="green" if row.get("size_kb", 0.0) < 50 else "yellow"),
                row_status(row),
            )

        def refresh_table(self) -> None:
            table = self.query_one(DataTable)
            table.clear()
            target = -1
            visible = 0
            for index, row in enumerate(self.rows):
                if row.get("kind") not in self.filters:
                    continue
                table.add_row(*self.row_args(row), key=str(index))
                if self.current_index == index:
                    target = visible
                visible += 1
            if target >= 0:
                table.move_cursor(row=target, animate=False)
            elif table.row_count:
                table.move_cursor(row=table.row_count - 1, animate=False)

        def check_updates(self) -> None:
            new_rows = tailer.poll()
            if not new_rows:
                return
            table = self.query_one(DataTable)
            at_bottom = table.row_count == 0 or table.cursor_row == table.row_count - 1
            start = len(self.rows)
            added = 0
            for offset, row in enumerate(new_rows):
                index = start + offset
                self.rows.append(row)
                if row.get("kind") in self.filters:
                    table.add_row(*self.row_args(row), key=str(index))
                    added += 1
            if added and at_bottom and table.row_count:
                table.move_cursor(row=table.row_count - 1, animate=True)
            if added:
                self.notify(f"Captured {added} API trace rows", title="Update")

        def on_data_table_row_highlighted(self, event: DataTable.RowHighlighted) -> None:
            index = int(event.row_key.value)
            self.current_index = index
            row = self.rows[index]
            text = payload_text(row)
            self.current_text = text
            view = self.query_one("#json-view", TextArea)
            view.language = "json"
            view.text = text
            banner = self.query_one("#status-banner", Label)
            diff_container = self.query_one("#diff-container", Vertical)
            diff_view = self.query_one("#diff-summary", TextArea)
            if row.get("kind") != "request":
                banner.display = False
                diff_container.display = False
                return
            delta = row.get("delta_kb", 0.0)
            if delta > 0.1:
                banner.remove_class("banner-red", "banner-yellow", "banner-green")
                banner.display = True
                banner.add_class("banner-red" if delta > 10 else "banner-yellow" if delta > 2 else "banner-green")
                banner.update(f"Request grew by +{delta:.1f} KB")
            else:
                banner.display = False
            previous = next((item for item in reversed(self.rows[:index]) if item.get("kind") == "request"), None)
            if not previous:
                diff_container.display = False
                return
            diff_lines = []
            matcher = difflib.SequenceMatcher(None, payload_text(previous).splitlines(), text.splitlines())
            for tag, _i1, _i2, j1, j2 in matcher.get_opcodes():
                if tag in ("insert", "replace"):
                    diff_lines.extend(text.splitlines()[j1:j2])
            if diff_lines:
                diff_container.display = True
                self.query_one("#diff-title", Label).update(f"Incremental lines ({len(diff_lines)})")
                diff_view.language = "json"
                diff_view.text = "\n".join(diff_lines)
            else:
                diff_container.display = False

    ApiTraceRadar().run()


def main() -> None:
    parser = argparse.ArgumentParser(description="OpenCode API JSONL radar")
    parser.add_argument("trace_dir", nargs="?", default=str(DEFAULT_TRACE_DIR), help="Trace JSONL directory")
    parser.add_argument("--session", help="Session ID to open directly")
    parser.add_argument("--static", action="store_true", help="Disable live polling")
    parser.add_argument("--include-meta", action="store_true", help="Include title-generation and other meta requests")
    args = parser.parse_args()

    trace_dir = Path(args.trace_dir).expanduser()
    session = args.session
    if not session:
        trace_dir, session = run_selector(trace_dir, args.include_meta)
    run_tui(JsonlTailer(trace_dir, session, include_meta=args.include_meta), live=not args.static)


if __name__ == "__main__":
    main()
