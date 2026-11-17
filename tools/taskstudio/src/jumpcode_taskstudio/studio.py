# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See LICENSE in the project root.

"""One call's view of the Studio folder: defensive reads, growing revisions and grouped writes."""

import json

from .common import (HISTORY_FILE, PLAN_FILE, PROPOSAL_FILE, SCHEMA, VIEW_FILE, STATE_FILE, STUDIO_FILES, DamagedFile, TaskStudioError,
                     execution_id, has_project, read_json, serialize, write_text)
from .plan import MAX_LOG, MAX_VERSIONS, check_plan, check_proposal

_WRITE_ORDER = (PLAN_FILE, PROPOSAL_FILE, VIEW_FILE, HISTORY_FILE)


def _revision(data):
    value = data.get("revision") if isinstance(data, dict) else None
    return value if isinstance(value, int) and not isinstance(value, bool) and value >= 0 else 0


class Studio:
    """Reads the Studio files of one call and writes them together, under the caller's lock."""

    def __init__(self, root, context, now):
        self.root = root
        self.project = has_project(context)
        self.execution = execution_id(context)
        self.request_id = context.get("request_id") if isinstance(context.get("request_id"), str) else None
        self.now = now
        self.damaged = set()
        self._revisions = {}
        self.state = read_json(root, STATE_FILE)
        if self.state is not None and (not isinstance(self.state.get("documents"), dict)
                                       or set(self.state["documents"]) - set(STUDIO_FILES)):
            raise DamagedFile(STATE_FILE)

    def _read(self, name):
        try:
            data = self.state["documents"].get(name) if self.state is not None else read_json(self.root, name)
            if data is not None and (not isinstance(data, dict) or data.get("schema") != SCHEMA):
                raise DamagedFile(name, newer=isinstance(data, dict) and isinstance(data.get("schema"), int)
                                  and data["schema"] > SCHEMA)
        except DamagedFile:
            self._revisions.setdefault(name, 0)
            self.damaged.add(name)
            raise
        self._revisions[name] = _revision(data)
        return data

    def plan(self, required=True):
        """The checked plan; None when there is none and it is not required."""
        try:
            data = self._read(PLAN_FILE)
            plan = check_plan(data) if data is not None else None
        except DamagedFile as error:
            hint = " Ask the user to update JumpCode." if error.newer else " Call plan to start a new plan."
            raise TaskStudioError(str(error) + "." + hint) from None
        if plan is None and required:
            raise TaskStudioError("There is no plan yet. When the user asks to build something, call plan first.")
        return plan

    def plan_to_replace(self):
        """The plan before `plan` writes a new one; a damaged plan counts as absent, a newer one is kept."""
        try:
            data = self._read(PLAN_FILE)
            return check_plan(data) if data is not None else None
        except DamagedFile as error:
            if error.newer:
                raise TaskStudioError(str(error) + ". Ask the user to update JumpCode.") from None
            self.damaged.add(PLAN_FILE)
            return None

    def proposal(self, strict=False):
        """The pending proposal; a damaged one is absent unless `strict` (apply)."""
        try:
            data = self._read(PROPOSAL_FILE)
            return check_proposal(data) if data is not None else None
        except DamagedFile as error:
            self.damaged.add(PROPOSAL_FILE)
            if strict:
                raise TaskStudioError(f"{error}. Call discard, then propose again.") from None
            return None

    def history(self):
        """The version history; a damaged history starts again rather than blocking the plan."""
        try:
            data = self._read(HISTORY_FILE)
        except DamagedFile:
            data = None
        versions = data.get("versions") if isinstance(data, dict) else None
        versions = [item for item in versions if isinstance(item, dict)] if isinstance(versions, list) else []
        return {"schema": SCHEMA, "revision": 0, "versions": versions}

    def next_revision(self, name):
        """The revision the next write of `name` gets: always one more than the file on disk."""
        if name not in self._revisions:
            try:
                self._read(name)
            except DamagedFile:
                pass
        return self._revisions[name] + 1

    def log(self, task, text, kind="info"):
        """Append one line to the task log, dropping the oldest beyond the limit."""
        entry = {"at": self.now, "text": text, "kind": kind}
        if self.execution:
            entry["execution"] = self.execution
        task["log"] = (task["log"] + [entry])[-MAX_LOG:]

    def commit(self, *, plan=None, proposal=None, history=None, view=None, delete=()):
        """Commit every document with one atomic replacement; legacy documents are read only until migration."""
        given = {PLAN_FILE: plan, PROPOSAL_FILE: proposal, HISTORY_FILE: history, VIEW_FILE: view}
        texts = {}
        for name in _WRITE_ORDER:
            data = given[name]
            if data is None:
                continue
            if name == PLAN_FILE:
                data["updatedAt"] = self.now
            if name == HISTORY_FILE:
                data["versions"] = data["versions"][-MAX_VERSIONS:]
            body = {key: value for key, value in data.items() if key not in ("schema", "revision")}
            document = {"schema": SCHEMA, "revision": self.next_revision(name), **body}
            data["revision"] = document["revision"]
            texts[name] = serialize(name, document)
        documents = dict(self.state["documents"]) if self.state is not None else {}
        if self.state is None:
            for name in STUDIO_FILES:
                if name in texts or name in delete:
                    continue
                try:
                    value = self._read(name)
                except DamagedFile as error:
                    if error.newer:
                        raise
                    continue
                if value is not None:
                    documents[name] = value
        for name in delete:
            documents.pop(name, None)
        documents.update({name: json.loads(text) for name, text in texts.items()})
        state = {"schema": SCHEMA, "revision": _revision(self.state) + 1, "documents": documents}
        write_text(self.root, STATE_FILE, serialize(STATE_FILE, state))
        self.state = state
