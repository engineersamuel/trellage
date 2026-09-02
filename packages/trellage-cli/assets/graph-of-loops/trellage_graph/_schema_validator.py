"""Minimal JSON Schema Draft 2020-12 validator using only stdlib.

Supports the subset used by the locked graph-of-loops schemas:
type, properties, required, additionalProperties, items, enum, pattern,
minLength, minItems, minimum, oneOf, $ref (internal $defs only), const.

No external dependencies.  Returns a list of error strings.
"""

from __future__ import annotations

import re
from typing import Any

# ------------------------------------------------------------------
# Internal helpers
# ------------------------------------------------------------------


def _resolve_ref(schema: dict[str, Any], root: dict[str, Any]) -> dict[str, Any]:
    """Resolve a $ref within the same schema document."""
    ref = schema.get("$ref")
    if ref is None:
        return schema
    if not ref.startswith("#/"):
        return schema  # only internal refs supported
    parts = ref.lstrip("#/").split("/")
    node: Any = root
    for part in parts:
        if isinstance(node, dict):
            node = node.get(part)
        else:
            return schema
    if isinstance(node, dict):
        return node
    return schema


def _type_name(value: Any) -> str:
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "boolean"
    if isinstance(value, int):
        return "integer"
    if isinstance(value, float):
        return "number"
    if isinstance(value, str):
        return "string"
    if isinstance(value, list):
        return "array"
    if isinstance(value, dict):
        return "object"
    return type(value).__name__


def _check_type(value: Any, expected: str | list[str]) -> bool:
    actual = _type_name(value)
    if isinstance(expected, list):
        ok = actual in expected
        # integer also satisfies number
        if not ok and actual == "integer" and "number" in expected:
            ok = True
        return ok
    if expected == "number":
        return actual in ("integer", "number")
    return actual == expected


# ------------------------------------------------------------------
# Core validation
# ------------------------------------------------------------------


def _validate_one_of(
    instance: Any,
    schema: dict[str, Any],
    root: dict[str, Any],
    path: str,
) -> list[str]:
    if "oneOf" not in schema:
        return []
    branches = [
        _validate(instance, candidate, root, path)
        for candidate in schema["oneOf"]
    ]
    matches = sum(not branch_errors for branch_errors in branches)
    return (
        []
        if matches == 1
        else [f"{path}: expected exactly one matching oneOf schema, got {matches}"]
    )


def _validate_string(
    instance: Any,
    schema: dict[str, Any],
    path: str,
) -> list[str]:
    if not isinstance(instance, str):
        return []
    errors: list[str] = []
    if "minLength" in schema and len(instance) < schema["minLength"]:
        errors.append(
            f"{path}: string length {len(instance)} < minLength {schema['minLength']}"
        )
    if "maxLength" in schema and len(instance) > schema["maxLength"]:
        errors.append(
            f"{path}: string length {len(instance)} > maxLength {schema['maxLength']}"
        )
    if "pattern" in schema and not re.search(schema["pattern"], instance):
        errors.append(
            f"{path}: {instance!r} does not match pattern {schema['pattern']!r}"
        )
    return errors


def _validate_number(
    instance: Any,
    schema: dict[str, Any],
    path: str,
) -> list[str]:
    if not isinstance(instance, (int, float)) or isinstance(instance, bool):
        return []
    errors: list[str] = []
    if "minimum" in schema and instance < schema["minimum"]:
        errors.append(f"{path}: {instance} < minimum {schema['minimum']}")
    if "exclusiveMinimum" in schema and instance <= schema["exclusiveMinimum"]:
        errors.append(
            f"{path}: {instance} <= exclusiveMinimum {schema['exclusiveMinimum']}"
        )
    return errors


def _validate_object(
    instance: Any,
    schema: dict[str, Any],
    root: dict[str, Any],
    path: str,
) -> list[str]:
    if not isinstance(instance, dict):
        return []
    errors: list[str] = []
    properties = schema.get("properties", {})
    additional = schema.get("additionalProperties", True)
    for required in schema.get("required", []):
        if required not in instance:
            errors.append(f"{path}: missing required property {required!r}")
    for key, value in instance.items():
        child_path = f"{path}.{key}"
        if key in properties:
            errors.extend(_validate(value, properties[key], root, child_path))
        elif additional is False:
            errors.append(f"{path}: unexpected property {key!r}")
        elif isinstance(additional, dict):
            errors.extend(_validate(value, additional, root, child_path))
    return errors


def _validate_array(
    instance: Any,
    schema: dict[str, Any],
    root: dict[str, Any],
    path: str,
) -> list[str]:
    if not isinstance(instance, list):
        return []
    errors: list[str] = []
    if "minItems" in schema and len(instance) < schema["minItems"]:
        errors.append(
            f"{path}: array length {len(instance)} < minItems {schema['minItems']}"
        )
    items = schema.get("items")
    if items is not None:
        for index, item in enumerate(instance):
            errors.extend(_validate(item, items, root, f"{path}[{index}]"))
    return errors


def _validate(
    instance: Any,
    schema: dict[str, Any],
    root: dict[str, Any],
    path: str,
) -> list[str]:
    """Validate *instance* against *schema*, returning error messages."""
    errors: list[str] = []

    schema = _resolve_ref(schema, root)

    errors.extend(_validate_one_of(instance, schema, root, path))

    # const
    if "const" in schema:
        if instance != schema["const"]:
            errors.append(f"{path}: expected const {schema['const']!r}, got {instance!r}")
            return errors

    # enum
    if "enum" in schema:
        if instance not in schema["enum"]:
            errors.append(f"{path}: {instance!r} not in enum {schema['enum']}")
            return errors

    # type
    if "type" in schema:
        if not _check_type(instance, schema["type"]):
            errors.append(
                f"{path}: expected type {schema['type']}, got {_type_name(instance)}"
            )
            return errors  # no point checking further

    errors.extend(_validate_string(instance, schema, path))
    errors.extend(_validate_number(instance, schema, path))
    errors.extend(_validate_object(instance, schema, root, path))
    errors.extend(_validate_array(instance, schema, root, path))

    return errors


# ------------------------------------------------------------------
# Public API
# ------------------------------------------------------------------


def validate(instance: Any, schema: dict[str, Any]) -> list[str]:
    """Validate *instance* against a JSON Schema document.

    Returns a list of human-readable error strings.  An empty list
    means the instance is valid.
    """
    return _validate(instance, schema, schema, "$")
