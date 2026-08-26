#!/usr/bin/env python3
"""Fail closed unless a Grok Worker capsule and optional plan select grok-4.6."""

from __future__ import annotations

import argparse
import json
import pathlib
import sys
from typing import Any


ONLY_MODEL = "grok-4.6"


def load_json(path_text: str, label: str) -> Any:
    path = pathlib.Path(path_text)
    try:
        return json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise ValueError(f"{label} is not readable JSON: {path}: {exc}") from exc


def model_values(value: Any, location: str = "$") -> list[tuple[str, str]]:
    found: list[tuple[str, str]] = []
    if isinstance(value, dict):
        for key, child in value.items():
            child_location = f"{location}.{key}"
            normalized_key = str(key).lower().replace("_", "").replace("-", "")
            if normalized_key in {"model", "selectedmodel", "fallbackmodel"}:
                if not isinstance(child, str):
                    raise ValueError(f"{child_location} must be a string")
                found.append((child_location, child))
            elif normalized_key in {"models", "fallbackmodels", "allowedmodels"}:
                if not isinstance(child, list) or not all(isinstance(item, str) for item in child):
                    raise ValueError(f"{child_location} must be a string array")
                found.extend((f"{child_location}[{index}]", item) for index, item in enumerate(child))
            else:
                found.extend(model_values(child, child_location))
    elif isinstance(value, list):
        for index, child in enumerate(value):
            found.extend(model_values(child, f"{location}[{index}]"))
    return found


def validate_capsule(capsule: Any) -> None:
    if not isinstance(capsule, dict):
        raise ValueError("capsule root must be an object")
    if capsule.get("model") != ONLY_MODEL:
        raise ValueError(f"$.model must equal {ONLY_MODEL!r}")
    for location, value in model_values(capsule):
        if value != ONLY_MODEL:
            raise ValueError(f"forbidden model at {location}: {value!r}; only {ONLY_MODEL!r} is allowed")


def validate_plan(plan: Any) -> None:
    if not isinstance(plan, dict):
        raise ValueError("plan root must be an object")
    template = plan.get("planTemplate")
    if not isinstance(template, dict) or not isinstance(template.get("args"), list):
        raise ValueError("$.planTemplate.args must be an array")
    args = template["args"]
    model_positions = [index for index, value in enumerate(args) if value == "--model"]
    if len(model_positions) != 1:
        raise ValueError("plan must contain exactly one --model argument")
    index = model_positions[0]
    if index + 1 >= len(args) or args[index + 1] != ONLY_MODEL:
        actual = args[index + 1] if index + 1 < len(args) else "<missing>"
        raise ValueError(f"plan --model must equal {ONLY_MODEL!r}, got {actual!r}")
    for position, value in enumerate(args):
        if isinstance(value, str) and value.startswith("grok-") and value != ONLY_MODEL:
            raise ValueError(f"forbidden model in plan args[{position}]: {value!r}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--capsule", required=True, help="Task Capsule JSON path")
    parser.add_argument("--plan", help="Optional grok-worker plan JSON path")
    args = parser.parse_args()
    try:
        validate_capsule(load_json(args.capsule, "capsule"))
        if args.plan:
            validate_plan(load_json(args.plan, "plan"))
    except ValueError as exc:
        print(f"GROK46_GATE_BLOCKED: {exc}", file=sys.stderr)
        return 2
    print("GROK46_GATE_PASS: capsule and plan select only grok-4.6" if args.plan else "GROK46_GATE_PASS: capsule selects only grok-4.6")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
