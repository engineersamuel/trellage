#!/usr/bin/env bash
set -euo pipefail

tests_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
contract_tests_dir="$tests_dir"
smoke_source="$tests_dir/smoke.sh"
contract_root="$(mktemp -d "${TMPDIR:-/tmp}/trellage-copilot-transcript-test.XXXXXX")"
trap 'rm -rf -- "$contract_root"' EXIT

contract_fail() {
  printf 'Trellage Copilot transcript test: FAIL: %s\n' "$1" >&2
  exit 1
}

instrumented_source="$contract_root/smoke-functions.sh"
sed '2,4d' "$smoke_source" >"$instrumented_source"
source "$instrumented_source"

driver_source="$contract_tests_dir/copilot_pty_driver.py"
if [[ -x /usr/bin/python3 ]]; then
  /usr/bin/python3 - "$driver_source" <<'PY'
import runpy
import sys

runpy.run_path(sys.argv[1], run_name="copilot_pty_driver_import_check")
PY
fi

python3 - "$driver_source" <<'PY'
import importlib.util
import os
import pty
import signal
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("copilot_pty_driver", sys.argv[1])
driver = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(driver)

stream_path = "/tmp/streaming worktree with spaces"
stream_modal = (
    "Confirm folder trust\r\n"
    + stream_path + "\r\n"
    + "Do you trust the files in this folder?\r\n"
    + "1. Yes\r\n"
).encode()
stream_modal_lines = (
    b"Confirm folder trust",
    stream_path.encode(),
    b"Do you trust the files in this folder?",
    b"1. Yes",
)

head_view = driver.TerminalView()
evicted_text = b"evicted-visible-line\n"
head_view.feed(
    evicted_text
    + b"x" * (driver.MAX_VISIBLE_BYTES - len(evicted_text) + 1)
)
if "evicted-visible-line" in head_view.visible_text():
    raise SystemExit("logical visible head exposed an evicted physical prefix")

if not hasattr(driver, "VISIBLE_LINE_BOUNDARY"):
    raise SystemExit("terminal view lacks a single-pass CR-or-LF boundary search")

for first_delimiter, later_delimiter in ((b"\n", b"\r"), (b"\r", b"\n")):
    first_line = b"a" * 31 + first_delimiter
    later_line = b"b" * 31 + later_delimiter
    retained_tail = b"c" * (driver.MAX_VISIBLE_BYTES - len(later_line))
    mixed_view = driver.TerminalView()
    mixed_view.feed(first_line + later_line + retained_tail)
    if mixed_view.visible_bytes() != later_line + retained_tail:
        raise SystemExit(
            f"cap eviction skipped the first mixed boundary {first_delimiter!r}"
        )

split_crlf_view = driver.TerminalView()
split_crlf_view.feed(b"x" * driver.MAX_VISIBLE_BYTES + b"\r")
if split_crlf_view.visible_bytes():
    raise SystemExit("CR at the cap boundary did not evict its complete line")
split_crlf_view.feed(b"\nkept-after-split-crlf")
if split_crlf_view.visible_bytes() != b"kept-after-split-crlf":
    raise SystemExit("split CRLF after cap eviction left a partial delimiter")

for delimiter in (b"\n", b"\r"):
    equal_boundary_view = driver.TerminalView()
    equal_boundary_stream = (b"a" + delimiter) * (driver.MAX_VISIBLE_BYTES * 4)
    equal_boundary_view.feed(equal_boundary_stream)
    if equal_boundary_view.visible_bytes() != equal_boundary_stream[
        -driver.MAX_VISIBLE_BYTES:
    ]:
        raise SystemExit(f"{delimiter!r}-only cap eviction retained a partial line")

storage_view = driver.TerminalView()
short_line_stream = b"a\n" * (driver.MAX_VISIBLE_BYTES * 4)
storage_view.feed(short_line_stream)
expected_short_tail = short_line_stream[-driver.MAX_VISIBLE_BYTES:]
if storage_view.visible_bytes() != expected_short_tail:
    raise SystemExit("long short-line stream did not retain a whole-line bounded tail")
if not hasattr(storage_view, "buffered_visible_storage_bytes"):
    raise SystemExit("terminal view lacks physical visible-storage accounting")
if storage_view.buffered_visible_storage_bytes > driver.MAX_VISIBLE_BYTES * 2 + 4096:
    raise SystemExit("terminal view physical visible storage exceeded its constant bound")
if not hasattr(storage_view, "visible_compactions"):
    raise SystemExit("terminal view lacks visible-buffer compaction accounting")
if storage_view.visible_compactions > 16:
    raise SystemExit("short-line eviction compacted more than an amortized bound")

unauthorized_boundaries = (
    ("FS", bytes((0x1C,))),
    ("GS", bytes((0x1D,))),
    ("RS", bytes((0x1E,))),
    ("UTF-8 NEL", bytes((0xC2, 0x85))),
    ("U+2028", chr(0x2028).encode()),
    ("U+2029", chr(0x2029).encode()),
    ("VT", bytes((0x0B,))),
    ("FF", bytes((0x0C,))),
)
for name, separator in unauthorized_boundaries:
    spoof = separator.join(stream_modal_lines) + b"\r\n"
    if driver.contains_exact_trust_modal(spoof, stream_path):
        raise SystemExit(f"unauthorized {name} separator formed exact modal lines")

for name, padding in unauthorized_boundaries:
    padded = b"\r\n".join(
        padding + line + padding for line in stream_modal_lines
    ) + b"\r\n"
    if driver.contains_exact_trust_modal(padded, stream_path):
        raise SystemExit(f"unauthorized {name} padding was stripped from modal lines")

ascii_padded = b"\r\n".join(
    b" \t" + line + b"\t " for line in stream_modal_lines
) + b"\r\n"
if not driver.contains_exact_trust_modal(ascii_padded, stream_path):
    raise SystemExit("ordinary ASCII space/tab display padding was not normalized")

for introducer in (b"\x1bP", b"\x1bX", b"\x1b^", b"\x1b_"):
    view = driver.TerminalView()
    view.feed(introducer[:1])
    view.feed(introducer[1:] + b"\r\n" + stream_modal + b"\x1b")
    if view.visible_lines():
        raise SystemExit(f"unterminated string-control payload became visible for {introducer!r}")
    view.feed(b"\\visible-after-st\r\n")
    if view.visible_lines() != ("visible-after-st",):
        raise SystemExit(f"split ST did not terminate string control for {introducer!r}")

for terminator in (b"\x07", b"\x1b\\"):
    view = driver.TerminalView()
    view.feed(b"\x1b")
    view.feed(b"]\r\n" + stream_modal + terminator[:1])
    if len(terminator) > 1:
        if view.visible_lines():
            raise SystemExit("OSC payload became visible before split ST completed")
        view.feed(terminator[1:])
    view.feed(b"visible-after-osc\r\n")
    if view.visible_lines() != ("visible-after-osc",):
        raise SystemExit(f"OSC payload or terminator became visible for {terminator!r}")

for introducer in (b"\x90", b"\x98", b"\x9d", b"\x9e", b"\x9f"):
    view = driver.TerminalView()
    view.feed(introducer + b"\r\n" + stream_modal + b"\x9cvisible-after-c1\r\n")
    if view.visible_lines() != ("visible-after-c1",):
        raise SystemExit(f"C1 string payload or terminator became visible for {introducer!r}")

view = driver.TerminalView()
view.feed(b"Confirm folder trust\r\n\x1b[")
view.feed(b"0;0H" + stream_modal.split(b"\r\n", 1)[1])
if "Confirm folder trust" in view.visible_lines():
    raise SystemExit("split CSI home did not reset the visible screen segment")

view = driver.TerminalView()
view.feed(b"Confirm folder trust\r\n\x9b0;0H")
view.feed(stream_modal.split(b"\r\n", 1)[1])
if "Confirm folder trust" in view.visible_lines():
    raise SystemExit("C1 CSI home did not reset the visible screen segment")

view = driver.TerminalView()
positioned_stream_modal = stream_modal.replace(
    b"\r\n", b"\r\n\x1b[2;1H", 1
)
view.feed(positioned_stream_modal[:17])
view.feed(positioned_stream_modal[17:])
if not driver.contains_exact_trust_modal_lines(view.visible_lines(), stream_path):
    raise SystemExit("split non-home CSI broke an exact visible trust modal")

view = driver.TerminalView()
utf8_visible = "visible café 雪\r\n".encode()
for byte in utf8_visible:
    view.feed(bytes((byte,)))
if view.visible_lines() != ("visible café 雪",):
    raise SystemExit("streaming terminal view corrupted split UTF-8")

view = driver.TerminalView()
view.feed(b"\x1b]")
view.feed(b"x" * (driver.MAX_VISIBLE_BYTES + 4096) + stream_modal)
if view.visible_lines() or view.buffered_control_bytes:
    raise SystemExit("hidden control payload entered or expanded bounded parser state")

view = driver.TerminalView()
view.feed(b"v" * (driver.MAX_VISIBLE_BYTES + 4096))
if view.visible_bytes():
    raise SystemExit("overlong unterminated visible line exposed a retained suffix")
view.feed(b"still-the-same-line")
if view.visible_bytes():
    raise SystemExit("discarded overlong line was resurrected by a later chunk")
view.feed(b"\nvisible-after-overlong-line\r\n")
if view.visible_lines() != ("visible-after-overlong-line",):
    raise SystemExit("terminal view did not recover after an overlong line boundary")

for delimiter in (b"\r", b"\n", b"\r\n"):
    view = driver.TerminalView()
    line = b"a" * (driver.MAX_VISIBLE_BYTES - len(delimiter)) + delimiter
    view.feed(line + b"Z")
    if view.visible_bytes() != b"Z":
        raise SystemExit(f"visible cap split the oldest {delimiter!r}-terminated line")

view = driver.TerminalView()
full_line = b"a" * (driver.MAX_VISIBLE_BYTES - 1) + b"\n"
view.feed(full_line)
view.feed(b"b" * (driver.MAX_VISIBLE_BYTES - 1) + b"\nkept")
if view.visible_bytes() != b"kept":
    raise SystemExit("visible cap did not evict multiple oldest whole lines")

view = driver.TerminalView()
view.feed(b"x" * (driver.MAX_VISIBLE_BYTES + 1))
view.feed(stream_modal[:21])
view.feed(stream_modal[21:])
if driver.contains_exact_trust_modal_lines(view.visible_lines(), stream_path):
    raise SystemExit("overlong line suffix became a trust modal across chunks")
view.feed(b"\n" + stream_modal)
if not driver.contains_exact_trust_modal_lines(view.visible_lines(), stream_path):
    raise SystemExit("legitimate trust modal after a line boundary was discarded")

for synthetic_separator in (b"\x1b[2;1H", b"\x1b[2;1f"):
    view = driver.TerminalView()
    view.feed(b"x" * (driver.MAX_VISIBLE_BYTES + 1))
    view.feed(synthetic_separator + stream_modal)
    if driver.contains_exact_trust_modal_lines(view.visible_lines(), stream_path):
        raise SystemExit(
            f"synthetic positioning separator {synthetic_separator!r} ended "
            "overlong-line discard without a raw boundary"
        )

view = driver.TerminalView()
view.feed(b"\x1b[" + b"1;" * (driver.MAX_CONTROL_SEQUENCE_BYTES + 16))
if view.buffered_control_bytes > driver.MAX_CONTROL_SEQUENCE_BYTES:
    raise SystemExit("streaming CSI state exceeded its byte cap")
view.feed(b"Hvisible-after-overflow\r\n")
if view.visible_lines() != ("visible-after-overflow",) or view.buffered_control_bytes:
    raise SystemExit("overflowed CSI state did not recover at its final byte")

def run_hidden_control_case(case: str) -> None:
    with tempfile.TemporaryDirectory(prefix=f"copilot-hidden-{case}-") as fixture:
        root = Path(fixture)
        fake_bin = root / "bin"
        fake_bin.mkdir()
        copilot_home = root / ".copilot"
        copilot_home.mkdir()
        trust_path = str(root / "expected worktree with spaces")
        Path(trust_path).mkdir()
        hidden_selection = root / "hidden-selection"
        fake_entry = fake_bin / "trellage-copilot-entry"
        fake_entry.write_text(
            """#!/usr/bin/env python3
import os
import select
import sys
import time
from pathlib import Path

modal = (
    "Confirm folder trust\\r\\n"
    + os.environ["FAKE_TRUST_PATH"] + "\\r\\n"
    + "Do you trust the files in this folder?\\r\\n"
    + "1. Yes\\r\\n"
).encode()

def reject_selection(timeout):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        ready, _, _ = select.select([0], [], [], 0.05)
        if ready and sys.stdin.buffer.readline().strip() == b"1":
            Path(os.environ["FAKE_HIDDEN_SELECTION"]).write_text("selected", encoding="utf-8")
            raise SystemExit(41)

def write_all(data):
    while data:
        data = data[os.write(1, data):]

case = os.environ["FAKE_CONTROL_CASE"]
if case == "osc-hidden":
    os.write(1, b"\\x1b")
    time.sleep(0.1)
    os.write(1, b"]\\r\\n" + modal)
elif case == "dcs-hidden":
    os.write(1, b"\\x1bP\\r\\n")
    time.sleep(0.1)
    os.write(1, modal)
    reject_selection(0.5)
    os.write(1, b"\\x1b\\\\")
elif case == "control-cap-churn":
    os.write(1, b"\\x1b]")
    write_all(b"x" * int(os.environ["FAKE_CHURN_BYTES"]) + b"\\r\\n" + modal)
else:
    raise SystemExit(42)

reject_selection(10 if case == "control-cap-churn" else 4)
raise SystemExit(0)
""",
            encoding="utf-8",
        )
        fake_entry.chmod(0o700)
        hidden_secret = f"{case}-secret-canary"
        environment = os.environ.copy()
        environment.update(
            {
                "COPILOT_GITHUB_TOKEN": hidden_secret,
                "COPILOT_HOME": str(copilot_home),
                "COPILOT_SMOKE_TIMEOUT": "6" if case == "control-cap-churn" else "2",
                "FAKE_CONTROL_CASE": case,
                "FAKE_TRUST_PATH": trust_path,
                "FAKE_HIDDEN_SELECTION": str(hidden_selection),
                "FAKE_CHURN_BYTES": str(driver.MAX_TRANSCRIPT_BYTES + 4096),
                "PATH": str(fake_bin) + os.pathsep + environment["PATH"],
            }
        )
        hidden = subprocess.run(
            [
                sys.executable,
                sys.argv[1],
                "resume",
                "97531",
                "Without tools, return only 97531.",
                trust_path,
            ],
            env=environment,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=15,
            check=False,
        )
        if hidden_selection.exists():
            raise SystemExit(
                f"hidden-control regression: driver selected an invisible {case} modal"
            )
        if hidden.returncode != 124:
            raise SystemExit(
                f"hidden-control regression: secure driver did not wait for visible modal "
                f"(case={case}, driver_status={hidden.returncode})"
            )
        if hidden_secret.encode() in hidden.stdout + hidden.stderr:
            raise SystemExit(f"hidden-control diagnostic exposed credential for {case}")


def run_partial_line_cap_case() -> None:
    with tempfile.TemporaryDirectory(prefix="copilot-partial-line-cap-") as fixture:
        root = Path(fixture)
        fake_bin = root / "bin"
        fake_bin.mkdir()
        copilot_home = root / ".copilot"
        copilot_home.mkdir()
        trust_path = str(root / "expected worktree with spaces")
        Path(trust_path).mkdir()
        cap_selection = root / "cap-selection"
        fake_entry = fake_bin / "trellage-copilot-entry"
        fake_entry.write_text(
            """#!/usr/bin/env python3
import os
import select
import sys
import time
from pathlib import Path

modal = (
    "Confirm folder trust\\r\\n"
    + os.environ["FAKE_TRUST_PATH"] + "\\r\\n"
    + "Do you trust the files in this folder?\\r\\n"
    + "1. Yes\\r\\n"
).encode()
tail = modal + b"z" * (
    int(os.environ["FAKE_VISIBLE_CAP"]) - len(modal) - modal.count(b"\\n")
)
payload = b"not-a-modal-prefix:" + tail
while payload:
    payload = payload[os.write(1, payload):]

deadline = time.monotonic() + 4
premature_deadline = time.monotonic() + 0.4
while time.monotonic() < premature_deadline:
    ready, _, _ = select.select([0], [], [], 0.05)
    if ready and sys.stdin.buffer.readline().strip():
        raise SystemExit(41)

ready, _, _ = select.select([0], [], [], 0)
if ready and b"1" in os.read(0, 65536):
    raise SystemExit(41)

os.write(1, b"\\r\\n" + modal)
while time.monotonic() < deadline:
    ready, _, _ = select.select([0], [], [], 0.05)
    if ready and sys.stdin.buffer.readline().strip() == b"1":
        Path(os.environ["FAKE_CAP_SELECTION"]).write_text(
            "selected-after-boundary", encoding="utf-8"
        )
        time.sleep(4)
        raise SystemExit(0)
raise SystemExit(42)
""",
            encoding="utf-8",
        )
        fake_entry.chmod(0o700)
        cap_secret = "partial-line-cap-secret-canary"
        environment = os.environ.copy()
        environment.update(
            {
                "COPILOT_GITHUB_TOKEN": cap_secret,
                "COPILOT_HOME": str(copilot_home),
                "COPILOT_SMOKE_TIMEOUT": "2",
                "FAKE_TRUST_PATH": trust_path,
                "FAKE_CAP_SELECTION": str(cap_selection),
                "FAKE_VISIBLE_CAP": str(driver.MAX_VISIBLE_BYTES),
                "PATH": str(fake_bin) + os.pathsep + environment["PATH"],
            }
        )
        capped = subprocess.run(
            [
                sys.executable,
                sys.argv[1],
                "resume",
                "97531",
                "Without tools, return only 97531.",
                trust_path,
            ],
            env=environment,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=8,
            check=False,
        )
        if capped.returncode != 124:
            raise SystemExit(
                "visible-cap regression: secure driver did not wait for a whole-line modal "
                f"(driver_status={capped.returncode})"
            )
        selection_phase = (
            cap_selection.read_text(encoding="utf-8")
            if cap_selection.exists()
            else None
        )
        if selection_phase != "selected-after-boundary":
            raise SystemExit(
                "visible-cap regression: driver did not select the legitimate modal "
                "after a raw line boundary"
            )
        if cap_secret.encode() in capped.stdout + capped.stderr:
            raise SystemExit("visible-cap diagnostic exposed credential material")


def run_unauthorized_boundary_case() -> None:
    with tempfile.TemporaryDirectory(prefix="copilot-unauthorized-boundary-") as fixture:
        root = Path(fixture)
        fake_bin = root / "bin"
        fake_bin.mkdir()
        copilot_home = root / ".copilot"
        copilot_home.mkdir()
        trust_path = str(root / "expected worktree with spaces")
        Path(trust_path).mkdir()
        premature_input = root / "premature-input"
        boundary_selection = root / "boundary-selection"
        fake_entry = fake_bin / "trellage-copilot-entry"
        fake_entry.write_text(
            """#!/usr/bin/env python3
import os
import select
import sys
import time
from pathlib import Path

lines = (
    b"Confirm folder trust",
    os.environ["FAKE_TRUST_PATH"].encode(),
    b"Do you trust the files in this folder?",
    b"1. Yes",
)
modal = b"\\r\\n".join(lines) + b"\\r\\n"
separators = (
    bytes((0x1C,)),
    bytes((0x1D,)),
    bytes((0x1E,)),
    bytes((0xC2, 0x85)),
    chr(0x2028).encode(),
    chr(0x2029).encode(),
)

def write_all(data):
    while data:
        data = data[os.write(1, data):]

for separator in separators:
    write_all(separator.join(lines) + b"\\r\\n")
for padding in (bytes((0x0B,)), bytes((0x0C,)), bytes((0xC2, 0x85))):
    write_all(b"\\r\\n".join(padding + line + padding for line in lines) + b"\\r\\n")

premature_deadline = time.monotonic() + 0.6
while time.monotonic() < premature_deadline:
    ready, _, _ = select.select([0], [], [], 0.05)
    if ready and b"1" in os.read(0, 65536):
        Path(os.environ["FAKE_PREMATURE_INPUT"]).write_text("premature", encoding="utf-8")
        raise SystemExit(41)

ready, _, _ = select.select([0], [], [], 0)
if ready and b"1" in os.read(0, 65536):
    Path(os.environ["FAKE_PREMATURE_INPUT"]).write_text("premature", encoding="utf-8")
    raise SystemExit(41)

write_all(b"\\r\\n" + modal)
deadline = time.monotonic() + 3
while time.monotonic() < deadline:
    ready, _, _ = select.select([0], [], [], 0.05)
    if ready and sys.stdin.buffer.readline().strip() == b"1":
        Path(os.environ["FAKE_BOUNDARY_SELECTION"]).write_text(
            "selected-after-boundary", encoding="utf-8"
        )
        time.sleep(4)
        raise SystemExit(0)
raise SystemExit(42)
""",
            encoding="utf-8",
        )
        fake_entry.chmod(0o700)
        boundary_secret = "unauthorized-boundary-secret-canary"
        environment = os.environ.copy()
        environment.update(
            {
                "COPILOT_GITHUB_TOKEN": boundary_secret,
                "COPILOT_HOME": str(copilot_home),
                "COPILOT_SMOKE_TIMEOUT": "3",
                "FAKE_TRUST_PATH": trust_path,
                "FAKE_PREMATURE_INPUT": str(premature_input),
                "FAKE_BOUNDARY_SELECTION": str(boundary_selection),
                "PATH": str(fake_bin) + os.pathsep + environment["PATH"],
            }
        )
        bounded = subprocess.run(
            [
                sys.executable,
                sys.argv[1],
                "resume",
                "97531",
                "Without tools, return only 97531.",
                trust_path,
            ],
            env=environment,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=9,
            check=False,
        )
        if premature_input.exists() or bounded.returncode == 126:
            raise SystemExit(
                "unauthorized visible separator or control padding became a trust modal"
            )
        if bounded.returncode != 124:
            raise SystemExit(
                "unauthorized-boundary regression: secure driver did not wait after "
                f"the legitimate selection (driver_status={bounded.returncode})"
            )
        selection_phase = (
            boundary_selection.read_text(encoding="utf-8")
            if boundary_selection.exists()
            else None
        )
        if selection_phase != "selected-after-boundary":
            raise SystemExit(
                "unauthorized-boundary regression: driver did not select the legitimate "
                "modal after a raw line boundary"
            )
        if boundary_secret.encode() in bounded.stdout + bounded.stderr:
            raise SystemExit(
                "unauthorized-boundary diagnostic exposed credential material"
            )


transcript_case = os.environ.get("COPILOT_TRANSCRIPT_CASE")
hidden_control_cases = ("osc-hidden", "dcs-hidden", "control-cap-churn")
if transcript_case in hidden_control_cases:
    run_hidden_control_case(transcript_case)
    raise SystemExit(0)
if transcript_case == "partial-line-cap":
    run_partial_line_cap_case()
    raise SystemExit(0)
if transcript_case == "unauthorized-boundaries":
    run_unauthorized_boundary_case()
    raise SystemExit(0)
if transcript_case is None:
    for hidden_control_case in hidden_control_cases:
        run_hidden_control_case(hidden_control_case)
    run_partial_line_cap_case()
    run_unauthorized_boundary_case()

modal_path = "/tmp/expected worktree [with] spaces"
modal_chunks = (
    b"\x1b[1;1H\x1b[1mConfirm folder trust\x1b[0m\r\n",
    modal_path.encode() + b"\r\nDo you trust the files in this folder?\r\n",
    b"1. Yes\r\n",
)
modal_transcript = bytearray()
for index, chunk in enumerate(modal_chunks):
    modal_transcript.extend(chunk)
    recognized = driver.contains_exact_trust_modal(modal_transcript, modal_path)
    if recognized != (index == len(modal_chunks) - 1):
        raise SystemExit("exact trust modal split across PTY chunks was misrecognized")

non_modals = (
    (
        "Confirm folder trust\n/tmp/wrong\n"
        "Do you trust the files in this folder?\n1. Yes\n"
        f"unrelated diagnostic path: {modal_path}\n"
    ),
    (
        "Confirm folder trust\n"
        f"{modal_path}/child\n"
        "Do you trust the files in this folder?\n1. Yes\n"
    ),
    (
        "Confirm folder trust\n"
        "Do you trust the files in this folder?\n"
        f"{modal_path}\n1. Yes\n"
    ),
    (
        "Confirm folder trust\n"
        f"{modal_path}\n"
        "screen changed\n"
        "Do you trust the files in this folder?\n1. Yes\n"
    ),
    (
        "Confirm folder trust\n"
        "\x1b[2J\x1b[H"
        f"{modal_path}\n"
        "Do you trust the files in this folder?\n1. Yes\n"
    ),
)
for non_modal in non_modals:
    if driver.contains_exact_trust_modal(non_modal.encode(), modal_path):
        raise SystemExit("non-contiguous or inexact trust modal was accepted")

modal_tail = (
    modal_path.encode()
    + b"\r\nDo you trust the files in this folder?\r\n1. Yes\r\n"
)
boundary_sequences = (
    b"\x1b[H", b"\x1b[0H", b"\x1b[;H", b"\x1b[0;0H",
    b"\x1b[1H", b"\x1b[1;H", b"\x1b[;1H", b"\x1b[1;1H",
    b"\x1b[0;H", b"\x1b[;0H", b"\x1b[00;00H",
    b"\x1b[f", b"\x1b[0f", b"\x1b[;f", b"\x1b[0;0f",
    b"\x1b[1f", b"\x1b[1;f", b"\x1b[;1f", b"\x1b[1;1f",
    b"\x1b[0;f", b"\x1b[;0f", b"\x1b[00;00f",
    b"\x1b[0;1H", b"\x1b[1;0H", b"\x1b[0;1f", b"\x1b[1;0f",
    b"\x1b[J", b"\x1b[0J", b"\x1b[1J", b"\x1b[2J", b"\x1b[3J",
    b"\x1b[?47h", b"\x1b[?47l", b"\x1b[?1047h", b"\x1b[?1047l",
    b"\x1b[?1049h", b"\x1b[?1049l", b"\x1b[?25;1049h",
    b"\x1bc", b"\x1b[!p",
)
for sequence in boundary_sequences:
    if not driver.is_screen_boundary_sequence(sequence):
        raise SystemExit(f"semantic boundary classifier rejected {sequence!r}")
    separated = b"Confirm folder trust\r\n" + sequence + modal_tail
    if driver.contains_exact_trust_modal(separated, modal_path):
        raise SystemExit(f"screen boundary {sequence!r} was ignored")

non_boundary_sequences = (
    b"\x1b[2H", b"\x1b[1;2H", b"\x1b[2;1H", b"\x1b[0;2f",
    b"\x1b[2;0f", b"\x1b[1;1;1H", b"\x1b[4J", b"\x1b[;J",
    b"\x1b[?2J", b"\x1b[?46h", b"\x1b[?1048l", b"\x1b[1049h",
    b"\x1b[?;1049h", b"\x1b[?1049;l",
    b"\x1b[?25h", b"\x1b[?25l", b"\x1b[0!p", b"\x1b[!q",
    b"\x1b[0m", b"\x1b[K", b"\x1b[2K", b"\x1b[6n",
)
for sequence in non_boundary_sequences:
    if driver.is_screen_boundary_sequence(sequence):
        raise SystemExit(f"semantic boundary classifier accepted {sequence!r}")

positioned_modal = (
    b"Confirm folder trust\x1b[0m\r\n\x1b[2;1f"
    + modal_path.encode()
    + b"\r\n\x1b[3;1HDo you trust the files in this folder?\r\n"
    + b"\x1b[4;1f1. Yes\r\n"
)
if not driver.contains_exact_trust_modal(positioned_modal, modal_path):
    raise SystemExit("ordinary cursor positioning or SGR reset split an exact trust modal")

with tempfile.TemporaryDirectory(prefix="copilot-live-shaped-trust-") as fixture:
    root = Path(fixture)
    fake_bin = root / "bin"
    fake_bin.mkdir()
    copilot_home = root / ".copilot"
    copilot_home.mkdir()
    trust_path = str(root / "expected worktree with spaces")
    Path(trust_path).mkdir()
    selection = root / "selection"
    fake_entry = fake_bin / "trellage-copilot-entry"
    fake_entry.write_text(
        """#!/usr/bin/env python3
import os
import sys
import time
from pathlib import Path

horizontal = "─" * 118
modal = (
    "\\x1b[?1006h\\x1b[?25l\\x1b[H\\x1b[2J"
    "\\x1b[?25l\\x1b[H\\x1b[2J\\x1b[8;3H"
    "Confirm folder trust\\r\\n"
    "╭" + horizontal + "╮\\r\\n"
    "│ " + os.environ["FAKE_TRUST_PATH"] + "│\\r\\n"
    "╰" + horizontal + "╯\\r\\n"
    "Copilot can read files in this folder and, with your permission, edit them or run code and shell commands. It will\\r\\n"
    "remember your permissions for the rest of this session.\\r\\n"
    "Do you trust the files in this folder?\\r\\n"
    "Current selection: 1. Yes\\r\\n"
    "2. Yes, and remember this folder for future sessions\\r\\n"
).encode()
os.write(1, modal)
if sys.stdin.buffer.readline().strip() == b"1":
    Path(os.environ["FAKE_SELECTION"]).write_text("selected", encoding="utf-8")
time.sleep(10)
""",
        encoding="utf-8",
    )
    fake_entry.chmod(0o700)
    live_secret = "live-shaped-trust-secret-canary"
    environment = os.environ.copy()
    environment.update(
        {
            "COPILOT_GITHUB_TOKEN": live_secret,
            "COPILOT_HOME": str(copilot_home),
            "COPILOT_SMOKE_TIMEOUT": "1",
            "FAKE_SELECTION": str(selection),
            "FAKE_TRUST_PATH": trust_path,
            "PATH": str(fake_bin) + os.pathsep + environment["PATH"],
        }
    )
    live_shaped = subprocess.run(
        [
            sys.executable,
            sys.argv[1],
            "resume",
            "97531",
            "Without tools, return only 97531.",
            trust_path,
        ],
        env=environment,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=8,
        check=False,
    )
    if live_shaped.returncode != 124:
        raise SystemExit(
            "live-shaped trust regression: secure driver did not reach its "
            f"post-selection timeout (driver_status={live_shaped.returncode})"
        )
    if not selection.exists():
        raise SystemExit(
            "live-shaped trust regression: driver did not select the exact "
            "framed Copilot trust modal"
        )
    if live_secret.encode() in live_shaped.stdout + live_shaped.stderr:
        raise SystemExit("live-shaped trust diagnostic printed inherited credential material")

if transcript_case == "live-trust-modal":
    raise SystemExit(0)

with tempfile.TemporaryDirectory(prefix="copilot-erase-display-trust-") as fixture:
    root = Path(fixture)
    fake_bin = root / "bin"
    fake_bin.mkdir()
    copilot_home = root / ".copilot"
    copilot_home.mkdir()
    trust_path = str(root / "expected worktree with spaces")
    Path(trust_path).mkdir()
    erase_selection = root / "erase-selection"
    fake_entry = fake_bin / "trellage-copilot-entry"
    fake_entry.write_text(
        """#!/usr/bin/env python3
import os
import select
import sys
import time
from pathlib import Path

os.write(1, b"Confirm folder trust\\r\\n\\x1b[")
time.sleep(0.1)
os.write(1, (
    "1J"
    + os.environ["FAKE_TRUST_PATH"] + "\\r\\n"
    + "Do you trust the files in this folder?\\r\\n"
    + "1. Yes\\r\\n"
).encode())
deadline = time.monotonic() + 4
while time.monotonic() < deadline:
    ready, _, _ = select.select([0], [], [], 0.05)
    if ready and sys.stdin.buffer.readline().strip() == b"1":
        Path(os.environ["FAKE_ERASE_SELECTION"]).write_text("selected", encoding="utf-8")
        raise SystemExit(41)
raise SystemExit(0)
""",
        encoding="utf-8",
    )
    fake_entry.chmod(0o700)
    erase_secret = "erase-display-secret-canary"
    environment = os.environ.copy()
    environment.update(
        {
            "COPILOT_GITHUB_TOKEN": erase_secret,
            "COPILOT_HOME": str(copilot_home),
            "COPILOT_SMOKE_TIMEOUT": "1",
            "FAKE_TRUST_PATH": trust_path,
            "FAKE_ERASE_SELECTION": str(erase_selection),
            "PATH": str(fake_bin) + os.pathsep + environment["PATH"],
        }
    )
    erased = subprocess.run(
        [
            sys.executable,
            sys.argv[1],
            "resume",
            "97531",
            "Without tools, return only 97531.",
            trust_path,
        ],
        env=environment,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=8,
        check=False,
    )
    if erase_selection.exists():
        raise SystemExit(
            "erase-display regression: driver selected a trust modal split across ESC[1J"
        )
    if erased.returncode != 124:
        raise SystemExit(
            "erase-display regression: secure driver did not wait for one screen segment "
            f"(driver_status={erased.returncode})"
        )
    if erase_secret.encode() in erased.stdout + erased.stderr:
        raise SystemExit("erase-display diagnostic printed inherited credential material")

if os.environ.get("COPILOT_TRANSCRIPT_CASE") == "erase-display-boundary":
    raise SystemExit(0)

with tempfile.TemporaryDirectory(prefix="copilot-cup-home-trust-") as fixture:
    root = Path(fixture)
    fake_bin = root / "bin"
    fake_bin.mkdir()
    copilot_home = root / ".copilot"
    copilot_home.mkdir()
    trust_path = str(root / "expected worktree with spaces")
    Path(trust_path).mkdir()
    home_selection = root / "home-selection"
    fake_entry = fake_bin / "trellage-copilot-entry"
    fake_entry.write_text(
        """#!/usr/bin/env python3
import os
import select
import sys
import time
from pathlib import Path

os.write(1, b"Confirm folder trust\\r\\n\\x1b[")
time.sleep(0.1)
os.write(1, (
    "0;0H"
    + os.environ["FAKE_TRUST_PATH"] + "\\r\\n"
    + "Do you trust the files in this folder?\\r\\n"
    + "1. Yes\\r\\n"
).encode())
deadline = time.monotonic() + 4
while time.monotonic() < deadline:
    ready, _, _ = select.select([0], [], [], 0.05)
    if ready and sys.stdin.buffer.readline().strip() == b"1":
        Path(os.environ["FAKE_HOME_SELECTION"]).write_text("selected", encoding="utf-8")
        raise SystemExit(41)
raise SystemExit(0)
""",
        encoding="utf-8",
    )
    fake_entry.chmod(0o700)
    home_secret = "cup-home-secret-canary"
    environment = os.environ.copy()
    environment.update(
        {
            "COPILOT_GITHUB_TOKEN": home_secret,
            "COPILOT_HOME": str(copilot_home),
            "COPILOT_SMOKE_TIMEOUT": "1",
            "FAKE_TRUST_PATH": trust_path,
            "FAKE_HOME_SELECTION": str(home_selection),
            "PATH": str(fake_bin) + os.pathsep + environment["PATH"],
        }
    )
    homed = subprocess.run(
        [
            sys.executable,
            sys.argv[1],
            "resume",
            "97531",
            "Without tools, return only 97531.",
            trust_path,
        ],
        env=environment,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=8,
        check=False,
    )
    if home_selection.exists():
        raise SystemExit(
            "CUP home regression: driver selected a trust modal split across ESC[0;0H"
        )
    if homed.returncode != 124:
        raise SystemExit(
            "CUP home regression: secure driver did not wait for one screen segment "
            f"(driver_status={homed.returncode})"
        )
    if home_secret.encode() in homed.stdout + homed.stderr:
        raise SystemExit("CUP home diagnostic printed inherited credential material")

if os.environ.get("COPILOT_TRANSCRIPT_CASE") == "cup-home-boundary":
    raise SystemExit(0)

with tempfile.TemporaryDirectory(prefix="copilot-spoofed-trust-") as fixture:
    root = Path(fixture)
    fake_bin = root / "bin"
    fake_bin.mkdir()
    copilot_home = root / ".copilot"
    copilot_home.mkdir()
    trust_path = str(root / "expected worktree with spaces")
    wrong_trust_path = str(root / "wrong-worktree")
    Path(trust_path).mkdir()
    Path(wrong_trust_path).mkdir()
    wrong_selection = root / "wrong-selection"
    fake_entry = fake_bin / "trellage-copilot-entry"
    fake_entry.write_text(
        """#!/usr/bin/env python3
import os
import select
import sys
import time
from pathlib import Path

os.write(1, (
    "Confirm folder trust\\r\\n"
    + os.environ["FAKE_WRONG_TRUST_PATH"] + "\\r\\n"
    + "Do you trust the files in this folder?\\r\\n"
    + "1. Yes\\r\\n"
    + "unrelated diagnostic path: " + os.environ["FAKE_TRUST_PATH"] + "\\r\\n"
).encode())
deadline = time.monotonic() + 4
while time.monotonic() < deadline:
    ready, _, _ = select.select([0], [], [], 0.05)
    if ready and sys.stdin.buffer.readline().strip() == b"1":
        Path(os.environ["FAKE_WRONG_SELECTION"]).write_text("selected", encoding="utf-8")
        raise SystemExit(41)
raise SystemExit(0)
""",
        encoding="utf-8",
    )
    fake_entry.chmod(0o700)
    spoofed_secret = "spoofed-trust-secret-canary"
    environment = os.environ.copy()
    environment.update(
        {
            "COPILOT_GITHUB_TOKEN": spoofed_secret,
            "COPILOT_HOME": str(copilot_home),
            "COPILOT_SMOKE_TIMEOUT": "1",
            "FAKE_TRUST_PATH": trust_path,
            "FAKE_WRONG_TRUST_PATH": wrong_trust_path,
            "FAKE_WRONG_SELECTION": str(wrong_selection),
            "PATH": str(fake_bin) + os.pathsep + environment["PATH"],
        }
    )
    spoofed = subprocess.run(
        [
            sys.executable,
            sys.argv[1],
            "resume",
            "97531",
            "Without tools, return only 97531.",
            trust_path,
        ],
        env=environment,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=8,
        check=False,
    )
    if wrong_selection.exists():
        raise SystemExit(
            "spoofed trust regression: driver selected the wrong-path modal "
            "after the expected path appeared as unrelated output"
        )
    if spoofed.returncode != 124:
        raise SystemExit(
            "spoofed trust regression: secure driver did not wait for an exact modal "
            f"(driver_status={spoofed.returncode})"
        )
    if spoofed_secret.encode() in spoofed.stdout + spoofed.stderr:
        raise SystemExit("spoofed trust diagnostic printed inherited credential material")

if os.environ.get("COPILOT_TRANSCRIPT_CASE") == "spoofed-trust":
    raise SystemExit(0)

with tempfile.TemporaryDirectory(prefix="copilot-duplicate-trust-") as fixture:
    root = Path(fixture)
    fake_bin = root / "bin"
    fake_bin.mkdir()
    copilot_home = root / ".copilot"
    copilot_home.mkdir()
    trust_path = str(root / "worktree with spaces")
    Path(trust_path).mkdir()
    fake_entry = fake_bin / "trellage-copilot-entry"
    fake_entry.write_text(
        """#!/usr/bin/env python3
import os
import sys
import time

modal = (
    "Confirm folder trust\\r\\n"
    + os.environ["FAKE_TRUST_PATH"] + "\\r\\n"
    + "Do you trust the files in this folder?\\r\\n"
    + "1. Yes\\r\\n"
).encode()
os.write(1, modal)
if sys.stdin.buffer.readline().strip() != b"1":
    raise SystemExit(40)
os.write(1, modal)
time.sleep(4)
""",
        encoding="utf-8",
    )
    fake_entry.chmod(0o700)
    duplicate_secret = "duplicate-trust-secret-canary"
    environment = os.environ.copy()
    environment.update(
        {
            "COPILOT_GITHUB_TOKEN": duplicate_secret,
            "COPILOT_HOME": str(copilot_home),
            "COPILOT_SMOKE_TIMEOUT": "3",
            "FAKE_TRUST_PATH": trust_path,
            "PATH": str(fake_bin) + os.pathsep + environment["PATH"],
        }
    )
    duplicate = subprocess.run(
        [
            sys.executable,
            sys.argv[1],
            "resume",
            "97531",
            "Without tools, return only 97531.",
            trust_path,
        ],
        env=environment,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=8,
        check=False,
    )
    duplicate_stderr = duplicate.stderr.decode("utf-8", "replace")
    if duplicate.returncode != 126 or "duplicate folder trust modal" not in duplicate_stderr:
        raise SystemExit(
            "duplicate trust modal was not rejected after exact selection "
            f"(driver_status={duplicate.returncode})"
        )
    if duplicate_secret in duplicate_stderr:
        raise SystemExit("duplicate trust diagnostic printed inherited credential material")

secret = b"split-secret-canary"
carry = b""
for chunk in (b"prefix-split-", b"secret-", b"canary-suffix"):
    found, carry = driver.scan_raw_secret(secret, carry, chunk)
    if chunk != b"canary-suffix" and found:
        raise SystemExit("raw secret scanner reported a premature match")
if not found:
    raise SystemExit("raw secret scanner missed a split-chunk exact token")

transcript = bytearray(b"older")
driver.append_capped(transcript, b"-newer", 6)
if transcript != b"-newer":
    raise SystemExit("PTY transcript cap retained unbounded history")

master, slave = pty.openpty()
child = subprocess.Popen(
    [sys.executable, "-c", "import os; os.write(1, b'exit-split-'); os.write(1, b'secret'); raise SystemExit(0)"],
    stdout=slave,
    stderr=slave,
    close_fds=True,
)
if child.wait(timeout=5) != 0:
    raise SystemExit("post-exit PTY fixture child failed")
def close_slave():
    time.sleep(0.1)
    os.close(slave)
threading.Thread(target=close_slave, daemon=True).start()
found, _, drained = driver.drain_raw_pty(master, b"exit-split-secret", b"", read_size=5)
os.close(master)
if not found or not drained:
    raise SystemExit("post-exit PTY drain missed a split exact token")

with tempfile.TemporaryDirectory(prefix="copilot-process-group-") as fixture:
    descendant_pid_file = Path(fixture) / "descendant.pid"
    master, slave = pty.openpty()
    leader = subprocess.Popen(
        [
            sys.executable,
            "-c",
            """import os
import signal
import sys
import time
from pathlib import Path

descendant = os.fork()
if descendant:
    raise SystemExit(0)
signal.signal(signal.SIGTERM, signal.SIG_IGN)
Path(sys.argv[1]).write_text(str(os.getpid()), encoding="utf-8")
while True:
    time.sleep(1)
""",
            str(descendant_pid_file),
        ],
        stdin=slave,
        stdout=slave,
        stderr=slave,
        start_new_session=True,
        close_fds=True,
    )
    os.close(slave)
    leader.wait(timeout=5)
    deadline = time.monotonic() + 5
    while not descendant_pid_file.exists() and time.monotonic() < deadline:
        time.sleep(0.05)
    if not descendant_pid_file.exists():
        os.killpg(leader.pid, signal.SIGKILL)
        raise SystemExit("process-group fixture did not create its descendant")
    descendant_pid = int(descendant_pid_file.read_text(encoding="utf-8"))
    started = time.monotonic()
    driver.terminate(leader)
    elapsed = time.monotonic() - started
    try:
        os.kill(descendant_pid, 0)
    except ProcessLookupError:
        descendant_alive = False
    else:
        descendant_alive = True
    if descendant_alive:
        os.killpg(leader.pid, signal.SIGKILL)
    os.close(master)
    if elapsed > 7 or descendant_alive:
        raise SystemExit(
            "PTY termination left a same-process-group descendant "
            f"(elapsed={elapsed:.2f}, descendant_alive={descendant_alive})"
        )

with tempfile.TemporaryDirectory(prefix="copilot-timeout-diagnostic-") as fixture:
    root = Path(fixture)
    fake_bin = root / "bin"
    fake_bin.mkdir()
    copilot_home = root / ".copilot"
    copilot_home.mkdir()
    trust_path = str(root / "worktree with spaces")
    Path(trust_path).mkdir()
    fake_entry = fake_bin / "trellage-copilot-entry"
    fake_entry.write_text(
        """#!/usr/bin/env python3
import os
import sys
import time

trust_path = os.environ["FAKE_TRUST_PATH"]
os.write(1, (
    "Confirm folder trust\\r\\n"
    + trust_path + "\\r\\n"
    + "Do you trust the files in this folder?\\r\\n"
    + "1. Yes\\r\\n"
).encode())
if sys.stdin.buffer.readline().strip() != b"1":
    raise SystemExit(40)
time.sleep(10)
""",
        encoding="utf-8",
    )
    fake_entry.chmod(0o700)
    timeout_secret = "timeout-diagnostic-secret-canary"
    environment = os.environ.copy()
    environment.update(
        {
            "COPILOT_GITHUB_TOKEN": timeout_secret,
            "COPILOT_HOME": str(copilot_home),
            "COPILOT_SMOKE_TIMEOUT": "1",
            "FAKE_TRUST_PATH": trust_path,
            "PATH": str(fake_bin) + os.pathsep + environment["PATH"],
        }
    )
    timed_out = subprocess.run(
        [
            sys.executable,
            sys.argv[1],
            "resume",
            "97531",
            "Without tools, return only 97531.",
            trust_path,
        ],
        env=environment,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=8,
        check=False,
    )
    timeout_stderr = timed_out.stderr.decode("utf-8", "replace")
    expected_state = (
        "readiness_seen=False, resume_typed=False, resume_sent=False"
    )
    if timed_out.returncode != 124 or expected_state not in timeout_stderr:
        raise SystemExit(
            "timeout diagnostic omitted secret-safe resume state "
            f"(driver_status={timed_out.returncode})"
        )
    if timeout_secret in timeout_stderr:
        raise SystemExit("timeout diagnostic printed inherited credential material")

with tempfile.TemporaryDirectory(prefix="copilot-delayed-resume-") as fixture:
    root = Path(fixture)
    fake_bin = root / "bin"
    fake_bin.mkdir()
    copilot_home = root / ".copilot"
    copilot_home.mkdir()
    trust_path = str(root / "worktree with spaces")
    Path(trust_path).mkdir()
    early_input = root / "early-input"
    fake_entry = fake_bin / "trellage-copilot-entry"
    fake_entry.write_text(
        """#!/usr/bin/env python3
import json
import os
import select
import sys
import time
from pathlib import Path

trust_path = os.environ["FAKE_TRUST_PATH"]
early_input = Path(os.environ["FAKE_EARLY_INPUT"])
path_split = len(trust_path) // 2
os.write(1, ("Confirm folder trust\\r\\n" + trust_path[:path_split]).encode())
time.sleep(0.1)
os.write(1, (
    trust_path[path_split:] + "\\r\\n"
    + "Do you trust the files in this folder?\\r\\n"
).encode())
time.sleep(0.1)
os.write(1, b"1. Yes\\r\\n")
if sys.stdin.buffer.readline().strip() != b"1":
    raise SystemExit(40)

os.write(1, b"Start of Prompt Indicator\\r\\n")
os.write(1, b"status: MCP Servers reloaded: 1 server connected soon\\r\\n")
deadline = time.monotonic() + 2.0
while time.monotonic() < deadline:
    ready, _, _ = select.select([0], [], [], 0.05)
    if ready:
        if os.read(0, 65536).strip():
            early_input.write_text("prompt arrived before readiness marker")
            raise SystemExit(42)

os.write(1, b"\\x1b[7;3H\\x1b[32mMCP Servers reloa")
time.sleep(0.1)
os.write(1, b"ded: 1 server connected\\x1b[0m\\x1b[38;26HClaude Sonnet 5")
if os.environ["FAKE_PROMPT"] not in sys.stdin.buffer.readline().decode():
    raise SystemExit(43)
if sys.stdin.buffer.readline().strip():
    raise SystemExit(45)

session = "11111111-2222-3333-4444-555555555555"
events = Path(os.environ["COPILOT_HOME"]) / "session-state" / session / "events.jsonl"
events.parent.mkdir(parents=True)
with events.open("w", encoding="utf-8") as handle:
    handle.write(json.dumps({"type": "assistant.message", "content": os.environ["FAKE_EXPECTED"]}) + "\\n")
    handle.write(json.dumps({"type": "assistant.turn_end"}) + "\\n")

while True:
    line = sys.stdin.buffer.readline()
    if not line:
        raise SystemExit(44)
    if line.strip() == b"/exit":
        raise SystemExit(0)
""",
        encoding="utf-8",
    )
    fake_entry.chmod(0o700)
    environment = os.environ.copy()
    environment.update(
        {
            "COPILOT_GITHUB_TOKEN": "delayed-hydration-secret-canary",
            "COPILOT_HOME": str(copilot_home),
            "COPILOT_SMOKE_TIMEOUT": "8",
            "FAKE_EARLY_INPUT": str(early_input),
            "FAKE_EXPECTED": "97531",
            "FAKE_PROMPT": "Without tools, return only 97531.",
            "FAKE_TRUST_PATH": trust_path,
            "PATH": str(fake_bin) + os.pathsep + environment["PATH"],
        }
    )
    delayed = subprocess.run(
        [
            sys.executable,
            sys.argv[1],
            "resume",
            environment["FAKE_EXPECTED"],
            environment["FAKE_PROMPT"],
            trust_path,
        ],
        env=environment,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=12,
        check=False,
    )
    if delayed.returncode != 0 or early_input.exists():
        raise SystemExit(
            "delayed resume hydration accepted prompt before exact readiness marker "
            f"(driver_status={delayed.returncode})"
        )
PY

if [[ "${COPILOT_TRANSCRIPT_CASE:-}" == "spoofed-trust" \
  || "${COPILOT_TRANSCRIPT_CASE:-}" == "live-trust-modal" \
  || "${COPILOT_TRANSCRIPT_CASE:-}" == "erase-display-boundary" \
  || "${COPILOT_TRANSCRIPT_CASE:-}" == "cup-home-boundary" \
  || "${COPILOT_TRANSCRIPT_CASE:-}" == "osc-hidden" \
  || "${COPILOT_TRANSCRIPT_CASE:-}" == "dcs-hidden" \
  || "${COPILOT_TRANSCRIPT_CASE:-}" == "control-cap-churn" \
  || "${COPILOT_TRANSCRIPT_CASE:-}" == "partial-line-cap" \
  || "${COPILOT_TRANSCRIPT_CASE:-}" == "unauthorized-boundaries" ]]; then
  printf 'Trellage Copilot focused trust test: PASS\n'
  exit 0
fi

tail_root="$contract_root/tail-diagnostic"
mkdir "$tail_root"
copilot_root="$tail_root"
copilot_container_id=tail-fixture-container
copilot_smoke_token='tail-diagnostic-secret-canary'
docker() {
  printf '%*s' 3000 '' | tr ' ' x
  printf '\nsafe-bounded-tail-marker\ntimed out\n%s\n' "$copilot_smoke_token"
  return 124
}
tail_status=0
(
  run_expect_session resume 97531 'fixture prompt'
) >"$contract_root/tail-diagnostic.stdout" \
  2>"$contract_root/tail-diagnostic.stderr" || tail_status=$?
[[ "$tail_status" -ne 0 ]] \
  || contract_fail 'smoke tail fixture unexpectedly succeeded'
grep -Fq 'safe-bounded-tail-marker' "$contract_root/tail-diagnostic.stderr" \
  || contract_fail 'smoke failure did not expose its bounded stderr tail'
! grep -Fq "$copilot_smoke_token" "$contract_root/tail-diagnostic.stderr" \
  || contract_fail 'smoke failure tail exposed credential material'
[[ "$(wc -c <"$contract_root/tail-diagnostic.stderr" | tr -d ' ')" -le 1600 ]] \
  || contract_fail 'smoke failure tail exceeded its diagnostic bound'
unset -f docker

state_root="$contract_root/state"
state_stderr="$contract_root/state.stderr"
state_token='binary-cache-token-canary'
mkdir -p "$state_root/.cache/copilot"
dd if=/dev/zero of="$state_root/.cache/copilot/cache.bin" bs=1 count=65530 2>/dev/null
printf '%s' "$state_token" >>"$state_root/.cache/copilot/cache.bin"
state_status=0
printf '%s\n' "$state_token" \
  | python3 "$contract_tests_dir/copilot_state_scanner.py" "$state_root" \
      >/dev/null 2>"$state_stderr" || state_status=$?
[[ "$state_status" -eq 1 ]] \
  || contract_fail "binary state scanner returned $state_status instead of rejecting cache leakage"
STATE_TOKEN="$state_token" python3 - "$state_stderr" <<'PY' \
  || contract_fail 'binary state scanner printed the secret pattern'
import os
import sys

with open(sys.argv[1], "rb") as handle:
    raise SystemExit(1 if os.environ["STATE_TOKEN"].encode() in handle.read() else 0)
PY

mutable_root="$contract_root/mutable-home"
mkdir -p \
  "$mutable_root/.cache/copilot/pkg/linux-arm64/1.0.75" \
  "$mutable_root/.copilot/logs" \
  "$mutable_root/installed-plugins/hve-core" \
  "$mutable_root/session-state"
printf '%s' 'access_token' >"$mutable_root/installed-plugins/hve-core/docs.bin"
printf '%s' 'access_token' >"$mutable_root/.cache/copilot/pkg/linux-arm64/1.0.75/app.js"
printf '%s' 'device_code' >"$mutable_root/.copilot/logs/copilot.log"
printf '%s\n' access_token \
  device_code \
  | python3 "$contract_tests_dir/copilot_state_scanner.py" "$mutable_root" --mutable-copilot-home \
      >/dev/null 2>"$contract_root/mutable-clean.stderr" \
  || contract_fail 'mutable-state scanner rejected immutable code, documentation, or operational logs'
printf '%s' "$state_token" >>"$mutable_root/.copilot/logs/copilot.log"
log_status=0
printf '%s\n' "$state_token" \
  | python3 "$contract_tests_dir/copilot_state_scanner.py" "$mutable_root" \
      >/dev/null 2>"$contract_root/log-leak.stderr" || log_status=$?
[[ "$log_status" -eq 1 ]] \
  || contract_fail "exact state scanner returned $log_status instead of rejecting log leakage"
printf '\000%s' 'access_token' >"$mutable_root/session-state/auth.bin"
mutable_status=0
printf '%s\n' access_token \
  | python3 "$contract_tests_dir/copilot_state_scanner.py" "$mutable_root" --mutable-copilot-home \
      >/dev/null 2>"$contract_root/mutable-leak.stderr" || mutable_status=$?
[[ "$mutable_status" -eq 1 ]] \
  || contract_fail "mutable-state scanner returned $mutable_status instead of rejecting a binary credential marker"

image_contract_source="$contract_tests_dir/image_contract.sh"
! grep -q 'grep -I' "$image_contract_source" \
  || contract_fail 'image contract still excludes binary files from leakage scans'
image_binary_root="$contract_root/image-binary"
mkdir "$image_binary_root"
printf '\000%s' '/src/copilot-seed' >"$image_binary_root/cache.bin"
find "$image_binary_root" -type f -exec grep -alF '/src/copilot-seed' {} + | grep -q . \
  || contract_fail 'binary image-contract fixture did not expose build-path leakage'

login_output="$contract_root/login.out"
printf '%s\n%s\n' \
  'To authenticate, visit https://github.com/login/device and enter code ABCD-EFGH' \
  'Waiting for authorization...' >"$login_output"
validate_copilot_login_output "$login_output" \
  || contract_fail 'exact Copilot login markers were rejected'
printf '%s\n' 'Authentication failed; log in again.' >>"$login_output"
if validate_copilot_login_output "$login_output"; then
  contract_fail 'misleading login/auth error text was accepted as the login UI'
fi

marketplace_output="$contract_root/marketplaces.out"
plugin_output="$contract_root/plugins.out"
printf '%s\n' \
  'Included with GitHub Copilot:' \
  '  ◆ copilot-plugins (GitHub: github/copilot-plugins)' \
  '  ◆ awesome-copilot (GitHub: github/awesome-copilot)' \
  '' \
  'Registered marketplaces:' \
  '  • hve-core (GitHub: microsoft/hve-core)' >"$marketplace_output"
printf '%s\n' '  • hve-core@hve-core (v3.3.101)' >"$plugin_output"
validate_copilot_inventory_output "$marketplace_output" "$plugin_output" 3.3.101 \
  || contract_fail 'exact normalized Copilot inventory was rejected'
printf '%s\n' '  • unexpected@hve-core (v1.0.0)' >>"$plugin_output"
if validate_copilot_inventory_output "$marketplace_output" "$plugin_output" 3.3.101; then
  contract_fail 'extra Copilot plugin inventory entry was accepted'
fi
printf '%s\n' '  • hve-core@hve-core (v3.3.101)' >"$plugin_output"
printf '%s\n' '  • unexpected (GitHub: example/unexpected)' >>"$marketplace_output"
if validate_copilot_inventory_output "$marketplace_output" "$plugin_output" 3.3.101; then
  contract_fail 'extra Copilot marketplace inventory entry was accepted'
fi

printf 'Trellage Copilot transcript test: PASS\n'
