"""Pure validation for deterministic gate commands."""
from __future__ import annotations

import os
import re
from pathlib import Path


_ENV_ASSIGNMENT = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*=")
_SHELLS = {"bash", "dash", "fish", "ksh", "sh", "zsh"}
_PYTHON = re.compile(r"^python(?:\d+(?:\.\d+)*)?$")
_NODE = {"node", "nodejs"}
_EVAL_FLAGS = {
    "perl": {"-e", "-E"},
    "ruby": {"-e"},
    "osascript": {"-e"},
    "pwsh": {"-command", "-encodedcommand", "-c"},
    "powershell": {"-command", "-encodedcommand", "-c"},
}
_ENV_VALUE_OPTIONS = {
    "-C",
    "--chdir",
    "-S",
    "--split-string",
    "-u",
    "--unset",
}
_TIMEOUT_VALUE_OPTIONS = {
    "-k",
    "--kill-after",
    "-s",
    "--signal",
}
_COMMAND_WRAPPERS = {
    "busybox",
    "chrt",
    "doas",
    "flock",
    "ionice",
    "nice",
    "nohup",
    "runuser",
    "script",
    "setsid",
    "stdbuf",
    "sudo",
    "su",
    "taskset",
    "time",
    "watch",
    "xargs",
}


def _basename(value: str) -> str:
    return Path(value).name.lower()


def _skip_options(
    argv: list[str],
    index: int,
    value_options: set[str],
) -> int:
    while index < len(argv):
        value = argv[index]
        if value == "--":
            return index + 1
        if not value.startswith("-") or value == "-":
            return index
        option = value.split("=", 1)[0]
        index += 2 if option in value_options and "=" not in value else 1
    return index


def _unwrap_env(argv: list[str]) -> list[str]:
    remaining = argv
    while remaining and _basename(remaining[0]) == "env":
        index = _skip_options(remaining, 1, _ENV_VALUE_OPTIONS)
        while (
            index < len(remaining)
            and _ENV_ASSIGNMENT.match(remaining[index])
        ):
            index += 1
        remaining = remaining[index:]
    return remaining


def _unwrap_timeout(argv: list[str]) -> list[str]:
    remaining = argv
    while remaining and _basename(remaining[0]) in {"timeout", "gtimeout"}:
        index = _skip_options(remaining, 1, _TIMEOUT_VALUE_OPTIONS)
        if index >= len(remaining):
            return []
        index += 1
        remaining = remaining[index:]
        remaining = _unwrap_env(remaining)
    return remaining


def _effective_command(argv: list[str]) -> list[str]:
    return _unwrap_timeout(_unwrap_env(argv))


def _env_argument_groups(argv: list[str]) -> list[list[str]]:
    return [
        argv[index + 1:]
        for index, value in enumerate(argv)
        if _basename(value) == "env"
    ]


def _split_string_in_env_arguments(
    arguments: list[str],
) -> str | None:
    index = 0
    value_options = {"-C", "--chdir", "-u", "--unset"}
    while index < len(arguments):
        argument = arguments[index]
        if argument == "--":
            return None
        if (
            argument == "-S"
            or argument.startswith("-S")
            or argument == "--split-string"
            or argument.startswith("--split-string=")
        ):
            return argument
        option = argument.split("=", 1)[0]
        if option in value_options and "=" not in argument:
            index += 2
            continue
        if argument.startswith("-") or _ENV_ASSIGNMENT.match(argument):
            index += 1
            continue
        return None
    return None


def _env_split_string_flag(argv: list[str]) -> str | None:
    for arguments in _env_argument_groups(argv):
        split_string = _split_string_in_env_arguments(arguments)
        if split_string:
            return split_string
    return None


def _wrapper_error(argv: list[str]) -> str | None:
    split_string = _env_split_string_flag(argv)
    if split_string:
        return (
            "env split-string evaluation is not allowed: "
            f"{split_string}"
        )
    effective = _effective_command(argv)
    if effective and _basename(effective[0]) in _COMMAND_WRAPPERS:
        return f"command wrapper is not allowed in a gate: {effective[0]}"
    return None


def _shell_eval_flag(executable: str, arguments: list[str]) -> str | None:
    if executable not in _SHELLS:
        return None
    for argument in arguments:
        if argument == "--":
            break
        if (
            argument == "--command"
            or (
                argument.startswith("-")
                and not argument.startswith("--")
                and "c" in argument[1:]
            )
        ):
            return argument
    return None


def _short_eval_flag(
    arguments: list[str],
    forbidden: set[str],
) -> str | None:
    for argument in arguments:
        if argument == "--":
            return None
        if (
            argument.startswith("-")
            and not argument.startswith("--")
            and any(flag in argument[1:] for flag in forbidden)
        ):
            return argument
    return None


def _long_eval_flag(
    arguments: list[str],
    forbidden: set[str],
) -> str | None:
    for argument in arguments:
        option = argument.lower().split("=", 1)[0]
        if option in forbidden:
            return argument
    return None


def _configured_eval_flag(
    executable: str,
    arguments: list[str],
) -> str | None:
    forbidden = _EVAL_FLAGS.get(executable)
    if not forbidden:
        return None
    short = {
        flag[1:]
        for flag in forbidden
        if flag.startswith("-") and not flag.startswith("--")
    }
    long = {
        flag.lower()
        for flag in forbidden
        if flag.startswith("--") or len(flag) > 2
    }
    return (
        _short_eval_flag(arguments, short)
        or _long_eval_flag(arguments, long)
    )


def _interpreter_eval_flag(
    executable: str, arguments: list[str],
) -> str | None:
    if _PYTHON.fullmatch(executable):
        return _short_eval_flag(arguments, {"c"})
    if executable in _NODE:
        return (
            _short_eval_flag(arguments, {"e", "p"})
            or _long_eval_flag(arguments, {"--eval", "--print"})
        )
    return _configured_eval_flag(executable, arguments)


def _nested_interpreter_error(argv: list[str]) -> str | None:
    for index in range(1, len(argv)):
        executable = _basename(argv[index])
        arguments = argv[index + 1:]
        shell_flag = _shell_eval_flag(executable, arguments)
        if shell_flag:
            return f"{executable} {shell_flag}"
        interpreter_flag = _interpreter_eval_flag(
            executable,
            arguments,
        )
        if interpreter_flag:
            return f"{executable} {interpreter_flag}"
    return None


def _awk_error(executable: str, arguments: list[str]) -> str | None:
    if executable not in {"awk", "gawk", "mawk", "nawk"}:
        return None
    if any(
        argument in {"-f", "--file"}
        or argument.startswith("--file=")
        for argument in arguments
    ):
        return None
    return f"{executable} inline program"


def _find_error(executable: str, arguments: list[str]) -> str | None:
    if executable != "find":
        return None
    forbidden = {"-exec", "-execdir", "-ok", "-okdir"}
    return next(
        (argument for argument in arguments if argument in forbidden),
        None,
    )


def _call_flag(arguments: list[str]) -> str | None:
    return next(
        (
            argument
            for argument in arguments
            if argument in {"-c", "--call"}
            or argument.startswith("--call=")
        ),
        None,
    )


def _npm_error(executable: str, arguments: list[str]) -> str | None:
    if executable == "npx":
        flag = _call_flag(arguments)
        return f"npx {flag}" if flag else None
    if (
        executable == "npm"
        and arguments
        and arguments[0] in {"exec", "x"}
    ):
        flag = _call_flag(arguments[1:])
        return f"npm {arguments[0]} {flag}" if flag else None
    return None


def _git_alias_error(executable: str, arguments: list[str]) -> str | None:
    if executable != "git":
        return None
    for index, argument in enumerate(arguments):
        candidate = ""
        if argument == "-c" and index + 1 < len(arguments):
            candidate = arguments[index + 1]
        elif argument.startswith("-c") and len(argument) > 2:
            candidate = argument[2:]
        if candidate.lower().startswith("alias.") and "=!" in candidate:
            return "git shell alias"
    return None


def _forwarding_error(command: list[str]) -> str | None:
    executable = _basename(command[0])
    arguments = command[1:]
    return (
        _awk_error(executable, arguments)
        or _find_error(executable, arguments)
        or _npm_error(executable, arguments)
        or _git_alias_error(executable, arguments)
        or _nested_interpreter_error(command)
    )


def _inline_evaluation_error(argv: list[str]) -> str | None:
    command = _effective_command(argv)
    if not command:
        return "gate command has no executable after wrappers"
    executable = _basename(command[0])
    arguments = command[1:]
    shell_flag = _shell_eval_flag(executable, arguments)
    if shell_flag:
        return (
            "inline program evaluation is not allowed for gate commands: "
            f"{executable} {shell_flag}"
        )
    interpreter_flag = _interpreter_eval_flag(executable, arguments)
    if interpreter_flag:
        return (
            "inline program evaluation is not allowed for gate commands: "
            f"{executable} {interpreter_flag}"
        )
    forwarding_error = _forwarding_error(command)
    if forwarding_error:
        return (
            "inline or forwarded program evaluation is not allowed for "
            f"gate commands: {forwarding_error}"
        )
    return None


def gate_command_errors(argv: list[str]) -> list[str]:
    """Return deterministic safety errors for one direct gate command."""
    errors: list[str] = []
    if not argv:
        return ["gate command requires an executable"]
    for index, argument in enumerate(argv):
        if "\x00" in argument or "\n" in argument:
            errors.append(f"invalid control character in argv[{index}]")
        if index > 0 and os.path.isabs(argument):
            errors.append(f"absolute path in argv[{index}]: {argument}")
        segments = argument.replace("\\", "/").split("/")
        if ".." in segments:
            errors.append(f"parent traversal in argv[{index}]: {argument}")
    wrapper_error = _wrapper_error(argv)
    if wrapper_error:
        errors.append(wrapper_error)
    inline_error = _inline_evaluation_error(argv)
    if inline_error:
        errors.append(inline_error)
    return errors
