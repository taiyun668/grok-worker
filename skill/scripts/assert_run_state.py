#!/usr/bin/env python3
"""Fail closed on Provider/controller state splits and unbounded waits."""

from __future__ import annotations

import argparse
import datetime as dt
import json
import pathlib
import sys
from typing import Any


TERMINAL_WAL = {"completed", "failed", "interrupted"}
ACTIVE_WAL = {"planned", "running"}


def load_json(path: pathlib.Path, label: str) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise ValueError(f"{label} is not readable JSON: {path}: {exc}") from exc


def parse_utc(value: str, label: str) -> dt.datetime:
    try:
        parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ValueError(f"{label} must be RFC3339/ISO-8601") from exc
    if parsed.tzinfo is None:
        raise ValueError(f"{label} must include a timezone")
    return parsed.astimezone(dt.timezone.utc)


def emit(decision: str, reason: str, *, exit_code: int, **details: Any) -> int:
    print(json.dumps({"decision": decision, "reason": reason, **details}, ensure_ascii=False, indent=2))
    return exit_code


def result_path_for(wal: dict[str, Any], wal_path: pathlib.Path, data_root: pathlib.Path | None,
                    explicit: pathlib.Path | None) -> pathlib.Path | None:
    if explicit is not None:
        return explicit
    ref = wal.get("finalResultRef")
    if not isinstance(ref, str) or not ref:
        return None
    if data_root is not None:
        return data_root / pathlib.PurePosixPath(ref)
    # WAL is <dataRoot>/runs/<taskId>/<runId>.json.
    try:
        inferred_root = wal_path.parents[2]
    except IndexError:
        return None
    return inferred_root / pathlib.PurePosixPath(ref)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--wal", required=True, type=pathlib.Path)
    parser.add_argument("--foreground", required=True,
                        choices=["inProgress", "completed", "failed", "unknown"])
    parser.add_argument("--data-root", type=pathlib.Path)
    parser.add_argument("--result", type=pathlib.Path)
    parser.add_argument("--last-progress-at")
    parser.add_argument("--now")
    parser.add_argument("--has-policy-activity", action="store_true")
    parser.add_argument("--has-workspace-changes", action="store_true")
    args = parser.parse_args()

    try:
        wal = load_json(args.wal, "WAL")
        if not isinstance(wal, dict):
            raise ValueError("WAL root must be an object")
        status = wal.get("status")
        if status not in ACTIVE_WAL | TERMINAL_WAL:
            raise ValueError(f"unsupported WAL status: {status!r}")
    except ValueError as exc:
        return emit("reconcile", "wal-unreadable-or-invalid", exit_code=2, error=str(exc))

    if args.foreground == "inProgress" and status in TERMINAL_WAL:
        return emit("reconcile", "PROVIDER_CONTROLLER_STATE_SPLIT", exit_code=2,
                    foreground=args.foreground, walStatus=status, autoResendAllowed=False)
    if args.foreground in {"completed", "failed"} and status in ACTIVE_WAL:
        return emit("reconcile", "PROVIDER_CONTROLLER_STATE_SPLIT", exit_code=2,
                    foreground=args.foreground, walStatus=status, autoResendAllowed=False)

    evidence_present = bool(args.has_policy_activity or args.has_workspace_changes or wal.get("attempts"))
    if status in {"failed", "interrupted"}:
        return emit("do_not_resend", "terminal-noncompletion-requires-reconciliation", exit_code=2,
                    walStatus=status, evidencePresent=evidence_present, autoResendAllowed=False)

    if status == "completed":
        result_path = result_path_for(wal, args.wal, args.data_root, args.result)
        if result_path is None or not result_path.is_file():
            return emit("reconcile", "completed-wal-without-result-capsule", exit_code=2,
                        walStatus=status, autoResendAllowed=False)
        try:
            result = load_json(result_path, "Result Capsule")
        except ValueError as exc:
            return emit("reconcile", "result-capsule-unreadable", exit_code=2,
                        error=str(exc), autoResendAllowed=False)
        attempt_ids = {
            item.get("invocationId") for item in wal.get("attempts", [])
            if isinstance(item, dict) and isinstance(item.get("invocationId"), str)
        }
        identity_ok = (
            isinstance(result, dict)
            and result.get("taskId") == wal.get("taskId")
            and result.get("invocationId") in attempt_ids
            and result.get("status") == "completed"
        )
        if not identity_ok:
            return emit("reconcile", "result-capsule-identity-mismatch", exit_code=2,
                        resultPath=str(result_path), autoResendAllowed=False)
        return emit("terminal_candidate", "result-capsule-present-and-identity-bound", exit_code=0,
                    resultPath=str(result_path), boundaryVerificationRequired=True,
                    autoResendAllowed=False)

    if status == "running" and args.last_progress_at:
        try:
            now = parse_utc(args.now, "--now") if args.now else dt.datetime.now(dt.timezone.utc)
            age_seconds = max(0, int((now - parse_utc(args.last_progress_at, "--last-progress-at")).total_seconds()))
        except ValueError as exc:
            return emit("reconcile", "progress-time-invalid", exit_code=2, error=str(exc))
        if age_seconds >= 600:
            return emit("reconcile", "stale-progress-controller-escalation", exit_code=2,
                        staleSeconds=age_seconds, autoResendAllowed=False)
        if age_seconds >= 300:
            return emit("escalate", "stale-progress-read-only-reconciliation", exit_code=3,
                        staleSeconds=age_seconds, autoResendAllowed=False)

    return emit("continue_wait", "states-compatible-within-bound", exit_code=0,
                foreground=args.foreground, walStatus=status, suppressUnchangedCommentary=True)


if __name__ == "__main__":
    raise SystemExit(main())
