#!/usr/bin/env python3
"""Merge managed Codex tables without reserializing profile-local TOML.

A small lexical scanner keeps multiline strings/arrays opaque. Unsupported
managed dotted/inline assignments fail closed instead of guessing their scope.
"""
import re
import json
import sys

DEFAULTS = {
    ('features',): {'hooks': 'true'},
    ('features', 'context_management'): {'experimental_mode': 'true'},
    ('agents',): {
        'enabled': 'true',
        'max_concurrent_threads_per_session': '4',
        'default_subagent_model': '"gpt-5.6-luna"',
        'default_subagent_reasoning_effort': '"max"',
    },
}
KEY = r"(?:[A-Za-z0-9_-]+|\"(?:[^\"\\]|\\.)*\"|'[^']*')"

def path(value):
    if not re.fullmatch(KEY + r'(?:\s*\.\s*' + KEY + r')*', value.strip()):
        raise ValueError('unsupported TOML key syntax')
    def decode(part):
        if part.startswith('"'):
            part = re.sub(
                r'\\(?:U[0-9a-fA-F]{8}|.)',
                lambda match: json.dumps(chr(int(match[0][2:], 16)))[1:-1]
                if match[0].startswith('\\U') else match[0], part)
            return json.loads(part)
        return part[1:-1] if part.startswith("'") else part
    return tuple(decode(part) for part in re.findall(KEY, value))

def statements(text):
    start = i = depth = 0
    quote = None
    while i < len(text):
        char = text[i]
        if quote:
            if quote.startswith('"') and char == '\\':
                i += 2
                continue
            if text.startswith(quote, i):
                i += len(quote)
                if len(quote) == 3:
                    # TOML permits one or two literal quotes before the closing delimiter.
                    for _ in range(2):
                        if i < len(text) and text[i] == quote[0]:
                            i += 1
                quote = None
                continue
        elif char in "\"'":
            quote = char * 3 if text.startswith(char * 3, i) else char
            i += len(quote)
            continue
        elif char == '#':
            end = text.find('\n', i)
            i = len(text) if end < 0 else end
            continue
        elif char in '[{':
            depth += 1
        elif char in ']}':
            depth -= 1
        elif char == '\n' and depth == 0:
            yield text[start:i + 1]
            start = i + 1
        i += 1
    if quote or depth:
        raise ValueError('unterminated TOML value')
    if start < len(text):
        yield text[start:]

def merge(text):
    output = []
    scope = ()
    tables = set()
    keys = set()
    written = {table: set() for table in DEFAULTS}
    def flush():
        if scope in DEFAULTS:
            for key, value in DEFAULTS[scope].items():
                if key not in written[scope]:
                    if output and not output[-1].endswith('\n'):
                        output.append('\n')
                    output.append(key + ' = ' + value + '\n')
                    written[scope].add(key)
    for statement in statements(text):
        stripped = statement.strip()
        if not stripped or stripped.startswith('#'):
            output.append(statement)
            continue
        header = re.fullmatch(r'\[(\[?\s*' + KEY + r'(?:\s*\.\s*' + KEY + r')*\s*\]?)\]\s*(?:#[^\n]*)?', stripped)
        if header:
            flush()
            raw = header[1]
            array = raw.startswith('[') and raw.endswith(']')
            scope = path(raw[1:-1] if array else raw)
            if scope in DEFAULTS and (array or scope in tables):
                raise ValueError('duplicate or array managed table')
            if array:
                keys = {key for key in keys if key[:len(scope)] != scope}
            if any(scope[:len(table) + 1] == table + (key,)
                   for table, settings in DEFAULTS.items() for key in settings):
                raise ValueError('managed scalar cannot be a table')
            tables.add(scope)
            output.append(statement)
            continue
        assignment = re.match(r'\s*(' + KEY + r'(?:\s*\.\s*' + KEY + r')*)\s*=', statement)
        if not assignment:
            raise ValueError('unsupported TOML statement')
        local = path(assignment[1])
        full = scope + local
        if full in keys:
            raise ValueError('duplicate TOML key')
        keys.add(full)
        if not scope and local[0] in ('features', 'agents'):
            raise ValueError('managed settings must use explicit tables')
        if scope == ('features',) and local[0] == 'context_management':
            raise ValueError('context management must use an explicit table')
        if scope in DEFAULTS and local[0] in DEFAULTS[scope]:
            if len(local) != 1:
                raise ValueError('managed scalar cannot be dotted')
            output.append(local[0] + ' = ' + DEFAULTS[scope][local[0]] + '\n')
            written[scope].add(local[0])
        else:
            output.append(statement)
    flush()
    for table, settings in DEFAULTS.items():
        if table not in tables:
            if output and not output[-1].endswith('\n'):
                output.append('\n')
            output.append('\n[' + '.'.join(table) + ']\n')
            output.extend(key + ' = ' + value + '\n' for key, value in settings.items())
    return ''.join(output)

if __name__ == '__main__':
    try:
        result = merge(sys.stdin.read())
    except (ValueError, OverflowError) as error:
        print('unsafe profile-local config: ' + str(error), file=sys.stderr)
        sys.exit(1)
    sys.stdout.write(result)
