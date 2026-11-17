# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See LICENSE in the project root.

"""AWS Step Functions (JSON 1.0): state machines in Amazon States Language (JSONPath) run locally:
Pass, Task (Lambda, SQS, SNS, DynamoDB), Choice, Wait, Parallel, Map, Succeed and Fail, with paths,
parameters, intrinsic functions, Retry and Catch."""

import copy
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
import json
import re
import threading
import time
import uuid

from .. import wire
from ..wire import AwsError
from .common import Caller, json_service

NAME = "stepfunctions"
LABEL = "Step Functions"
NAMESPACE = ""
MAX_STEPS = 2000
_runs = {}


def handle(cloud, request):
    return json_service(cloud, request, NAMESPACE, "1.0", OPS)


def machines(cloud, account, region):
    return cloud.store.regional(account, region, NAME).setdefault("machines", {})


def _split(arn):
    parts = (arn or "").split(":")
    if len(parts) < 7:
        raise AwsError("InvalidArn", f"Invalid Arn: '{arn}'")
    return parts[4], parts[3], parts[6], parts[7] if len(parts) > 7 else None


def machine_of(cloud, caller, arn):
    account, region, name, _ = _split(arn)
    caller.target = name
    machine = machines(cloud, account, region).get(name)
    if machine is None:
        raise AwsError("StateMachineDoesNotExist", f"State Machine Does Not Exist: '{arn}'")
    return machine


def execution_of(cloud, caller, arn):
    account, region, name, run = _split(arn)
    caller.target = name
    machine = machines(cloud, account, region).get(name)
    execution = (machine or {}).get("executions", {}).get(run or "")
    if execution is None:
        raise AwsError("ExecutionDoesNotExist", f"Execution Does Not Exist: '{arn}'")
    return machine, execution


def _definition(text):
    try:
        definition = json.loads(text) if isinstance(text, str) else text
    except ValueError as error:
        raise AwsError("InvalidDefinition", f"Invalid State Machine Definition: 'SCHEMA_VALIDATION_FAILED: {error}'") from error
    if not isinstance(definition, dict) or "StartAt" not in definition or not isinstance(definition.get("States"), dict):
        raise AwsError("InvalidDefinition", "Invalid State Machine Definition: 'MISSING_TRANSITION_TARGET: StartAt and States are required'")
    if definition.get("QueryLanguage") == "JSONata":
        raise AwsError("InvalidDefinition", "CloudStudio runs JSONPath state machines; JSONata is not emulated yet.")
    _check_states(definition)
    return definition


def _check_states(definition):
    states = definition["States"]
    if definition["StartAt"] not in states:
        raise AwsError("InvalidDefinition", f"Invalid State Machine Definition: 'MISSING_TRANSITION_TARGET: Missing 'Next' target: {definition['StartAt']}'")
    for name, state in states.items():
        kind = state.get("Type")
        if kind not in ("Pass", "Task", "Choice", "Wait", "Succeed", "Fail", "Parallel", "Map"):
            raise AwsError("InvalidDefinition", f"Invalid State Machine Definition: 'SCHEMA_VALIDATION_FAILED: Unknown state type {kind} at /States/{name}'")
        targets = [state.get("Next")] + [c.get("Next") for c in state.get("Choices", [])] + [state.get("Default")] + [c.get("Next") for c in state.get("Catch", [])]
        for target in filter(None, targets):
            if target not in states:
                raise AwsError("InvalidDefinition", f"Invalid State Machine Definition: 'MISSING_TRANSITION_TARGET: Missing 'Next' target: {target} at /States/{name}'")
        for branch in state.get("Branches", []):
            _check_states(branch)
        processor = state.get("ItemProcessor") or state.get("Iterator")
        if processor:
            _check_states(processor)


def create_machine(cloud, caller, params):
    name = params.get("name") or ""
    caller.target = name
    if not re.match(r"^[A-Za-z0-9_-]{1,80}$", name):
        raise AwsError("InvalidName", f"Invalid Name: '{name}'")
    existing = machines(cloud, caller.account, caller.region)
    if name in existing:
        raise AwsError("StateMachineAlreadyExists", f"State Machine Already Exists: '{existing[name]['arn']}'")
    definition = _definition(params.get("definition"))
    machine = {"name": name, "arn": wire.arn("states", caller.region, caller.account, f"stateMachine:{name}"), "account": caller.account,
               "region": caller.region, "definition": params["definition"] if isinstance(params["definition"], str) else json.dumps(definition),
               "role": params.get("roleArn") or f"arn:aws:iam::{caller.account}:role/cloudstudio-states", "type": params.get("type") or "STANDARD",
               "created": time.time(), "tags": params.get("tags") or [], "executions": {}}
    existing[name] = machine
    cloud.store.touch()
    return {"stateMachineArn": machine["arn"], "creationDate": machine["created"]}


def describe_machine(cloud, caller, params):
    machine = machine_of(cloud, caller, params.get("stateMachineArn"))
    return {"stateMachineArn": machine["arn"], "name": machine["name"], "status": "ACTIVE", "definition": machine["definition"],
            "roleArn": machine["role"], "type": machine["type"], "creationDate": machine["created"],
            "loggingConfiguration": {"level": "OFF", "includeExecutionData": False}}


def list_machines(cloud, caller, params):
    return {"stateMachines": [{"stateMachineArn": m["arn"], "name": m["name"], "type": m["type"], "creationDate": m["created"]}
                              for m in sorted(machines(cloud, caller.account, caller.region).values(), key=lambda m: m["name"])]}


def update_machine(cloud, caller, params):
    machine = machine_of(cloud, caller, params.get("stateMachineArn"))
    if params.get("definition"):
        _definition(params["definition"])
        machine["definition"] = params["definition"]
    if params.get("roleArn"):
        machine["role"] = params["roleArn"]
    cloud.store.touch()
    return {"updateDate": time.time()}


def delete_machine(cloud, caller, params):
    machine = machine_of(cloud, caller, params.get("stateMachineArn"))
    del machines(cloud, machine["account"], machine["region"])[machine["name"]]
    cloud.store.touch()
    return {}


def _new_execution(cloud, machine, name, text, source):
    name = name or str(uuid.uuid4())
    if name in machine["executions"]:
        raise AwsError("ExecutionAlreadyExists", f"Execution Already Exists: '{machine['arn'].replace(':stateMachine:', ':execution:')}:{name}'")
    try:
        value = json.loads(text) if text not in (None, "") else {}
    except ValueError as error:
        raise AwsError("InvalidExecutionInput", f"Invalid State Machine Execution Input: '{error}'") from error
    arn = machine["arn"].replace(":stateMachine:", ":execution:") + f":{name}"
    execution = {"name": name, "arn": arn, "status": "RUNNING", "started": time.time(), "stopped": None, "input": text or "{}",
                 "output": None, "error": None, "cause": None, "steps": [], "history": [], "source": source}
    machine["executions"][name] = execution
    if len(machine["executions"]) > 50:
        oldest = min(machine["executions"].values(), key=lambda e: e["started"])
        del machine["executions"][oldest["name"]]
    cloud.store.touch()
    return execution, value


def start_execution(cloud, caller, params):
    machine = machine_of(cloud, caller, params.get("stateMachineArn"))
    execution, value = _new_execution(cloud, machine, params.get("name"), params.get("input"), caller.source)
    _pool(cloud).submit(Runner(cloud, machine, execution).run, value)
    return {"executionArn": execution["arn"], "startDate": execution["started"]}


def start_sync(cloud, caller, params):
    machine = machine_of(cloud, caller, params.get("stateMachineArn"))
    execution, value = _new_execution(cloud, machine, params.get("name"), params.get("input"), caller.source)
    Runner(cloud, machine, execution).run(value)
    result = _execution_view(machine, execution)
    result.pop("status")
    result["status"] = execution["status"]
    return result


def start_arn(cloud, arn, text, source):
    try:
        caller = Caller(source=source)
        machine = machine_of(cloud, caller, arn)
        execution, value = _new_execution(cloud, machine, None, text, source)
    except AwsError as error:
        cloud.internal_call(NAME, "StartExecution", arn.rsplit(":", 1)[-1], source, error=(error.code, error.message))
        return
    cloud.internal_call(NAME, "StartExecution", machine["name"], source, req=text[:600], account=machine["account"], region=machine["region"])
    _pool(cloud).submit(Runner(cloud, machine, execution).run, value)


def _pool(cloud):
    pool = _runs.get(id(cloud))
    if pool is None:
        pool = _runs[id(cloud)] = ThreadPoolExecutor(max_workers=8, thread_name_prefix="cloudstudio-sfn")
    return pool


def _execution_view(machine, execution):
    result = {"executionArn": execution["arn"], "stateMachineArn": machine["arn"], "name": execution["name"], "status": execution["status"],
              "startDate": execution["started"], "input": execution["input"], "inputDetails": {"included": True}}
    if execution["stopped"]:
        result["stopDate"] = execution["stopped"]
    if execution["output"] is not None:
        result["output"] = execution["output"]
        result["outputDetails"] = {"included": True}
    if execution["error"]:
        result["error"] = execution["error"]
        result["cause"] = execution["cause"] or ""
    return result


def describe_execution(cloud, caller, params):
    machine, execution = execution_of(cloud, caller, params.get("executionArn"))
    return _execution_view(machine, execution)


def list_executions(cloud, caller, params):
    machine = machine_of(cloud, caller, params.get("stateMachineArn"))
    wanted = params.get("statusFilter")
    items = [e for e in sorted(machine["executions"].values(), key=lambda e: e["started"], reverse=True) if not wanted or e["status"] == wanted]
    return {"executions": [{"executionArn": e["arn"], "stateMachineArn": machine["arn"], "name": e["name"], "status": e["status"],
                            "startDate": e["started"], **({"stopDate": e["stopped"]} if e["stopped"] else {})}
                           for e in items[: int(params.get("maxResults") or 100)]]}


def history(cloud, caller, params):
    _, execution = execution_of(cloud, caller, params.get("executionArn"))
    events = list(execution["history"])
    if params.get("reverseOrder"):
        events.reverse()
    return {"events": events[: int(params.get("maxResults") or 1000)]}


def stop_execution(cloud, caller, params):
    _, execution = execution_of(cloud, caller, params.get("executionArn"))
    if execution["status"] == "RUNNING":
        execution.update({"status": "ABORTED", "stopped": time.time(), "error": params.get("error"), "cause": params.get("cause")})
        cloud.store.touch()
    return {"stopDate": execution["stopped"] or time.time()}


OPS = {
    "CreateStateMachine": create_machine, "DescribeStateMachine": describe_machine, "ListStateMachines": list_machines,
    "UpdateStateMachine": update_machine, "DeleteStateMachine": delete_machine, "StartExecution": start_execution,
    "StartSyncExecution": start_sync, "DescribeExecution": describe_execution, "ListExecutions": list_executions,
    "GetExecutionHistory": history, "StopExecution": stop_execution,
    "TagResource": lambda cloud, caller, params: {}, "ListTagsForResource": lambda cloud, caller, params: {"tags": []},
}


# ---------------------------------------------------------------- JSONPath and intrinsic functions

_SEGMENT = re.compile(r"\.([A-Za-z0-9_$@-]+)|\['([^']*)'\]|\[(\d+)\]|\[(\*)\]")


def json_path(value, path, context=None):
    if not isinstance(path, str) or not path.startswith("$"):
        raise StatesError("States.Runtime", f"Invalid path: {path}")
    if path.startswith("$$"):
        value, path = context or {}, path[1:]
    position = 1
    current = value
    while position < len(path):
        match = _SEGMENT.match(path, position)
        if not match:
            raise StatesError("States.Runtime", f"Invalid path: {path}")
        key, quoted, index, star = match.groups()
        if star:
            rest = path[match.end():]
            items = current if isinstance(current, list) else list(current.values()) if isinstance(current, dict) else []
            return [json_path(item, "$" + rest, context) for item in items] if rest else items
        if index is not None:
            if not isinstance(current, list) or int(index) >= len(current):
                raise StatesError("States.Runtime", f"The JSONPath '{path}' could not be found in the input")
            current = current[int(index)]
        else:
            name = key if key is not None else quoted
            if not isinstance(current, dict) or name not in current:
                raise StatesError("States.Runtime", f"The JSONPath '{path}' could not be found in the input '{json.dumps(value)[:200]}'")
            current = current[name]
        position = match.end()
    return current


def set_path(target, path, value):
    if path is None:
        return target
    if path == "$":
        return value
    result = copy.deepcopy(target) if isinstance(target, dict) else {}
    keys = [m.group(1) or m.group(2) for m in _SEGMENT.finditer(path[1:])]
    node = result
    for key in keys[:-1]:
        if not isinstance(node.get(key), dict):
            node[key] = {}
        node = node[key]
    node[keys[-1]] = value
    return result


def _intrinsic(text, value, context):
    tokens = re.findall(r"'(?:[^'\\]|\\.)*'|States\.[A-Za-z]+|\$\$?[^,()\s]*|-?\d+(?:\.\d+)?|true|false|null|[(),]", text)
    position = [0]

    def parse():
        token = tokens[position[0]]
        position[0] += 1
        if token.startswith("States."):
            position[0] += 1  # (
            args = []
            while tokens[position[0]] != ")":
                args.append(parse())
                if tokens[position[0]] == ",":
                    position[0] += 1
            position[0] += 1
            return _call(token[7:], args)
        if token.startswith("'"):
            return re.sub(r"\\(.)", r"\1", token[1:-1])
        if token.startswith("$"):
            return json_path(value, token, context)
        return json.loads(token)

    return parse()


def _call(name, args):
    if name == "Format":
        template, rest = args[0], list(args[1:])
        return re.sub(r"\{\}", lambda _: str(rest.pop(0)) if not isinstance(rest[0], (dict, list)) else json.dumps(rest.pop(0)), template)
    if name == "StringToJson":
        return json.loads(args[0])
    if name == "JsonToString":
        return json.dumps(args[0], separators=(",", ":"))
    if name == "Array":
        return list(args)
    if name == "ArrayLength":
        return len(args[0])
    if name == "ArrayGetItem":
        return args[0][int(args[1])]
    if name == "ArrayContains":
        return args[1] in args[0]
    if name == "ArrayRange":
        return list(range(int(args[0]), int(args[1]) + 1, int(args[2])))
    if name == "ArrayUnique":
        seen = []
        for item in args[0]:
            if item not in seen:
                seen.append(item)
        return seen
    if name == "ArrayPartition":
        size = int(args[1])
        return [args[0][i:i + size] for i in range(0, len(args[0]), size)]
    if name == "MathAdd":
        return args[0] + args[1]
    if name == "MathRandom":
        import random
        return random.randint(int(args[0]), int(args[1]))
    if name == "StringSplit":
        return [part for part in str(args[0]).split(args[1]) if part != ""] if len(args[1]) == 1 else re.split("[" + re.escape(args[1]) + "]", args[0])
    if name == "UUID":
        return str(uuid.uuid4())
    if name == "Base64Encode":
        import base64
        return base64.b64encode(str(args[0]).encode()).decode()
    if name == "Base64Decode":
        import base64
        return base64.b64decode(args[0]).decode()
    if name == "Hash":
        import hashlib
        return hashlib.new(args[1].replace("-", "").lower(), str(args[0]).encode()).hexdigest()
    if name == "JsonMerge":
        merged = dict(args[0])
        merged.update(args[1])
        return merged
    raise StatesError("States.Runtime", f"The intrinsic function States.{name} is not supported by CloudStudio")


def resolve(template, value, context):
    """Parameters / ResultSelector / ItemSelector: keys ending in .$ are paths or intrinsic functions."""
    if isinstance(template, dict):
        result = {}
        for key, item in template.items():
            if key.endswith(".$"):
                result[key[:-2]] = _intrinsic(item, value, context) if isinstance(item, str) and item.startswith("States.") else json_path(value, item, context)
            else:
                result[key] = resolve(item, value, context)
        return result
    if isinstance(template, list):
        return [resolve(item, value, context) for item in template]
    return template


# ---------------------------------------------------------------- execution

class StatesError(Exception):
    def __init__(self, error, cause):
        super().__init__(cause)
        self.error = error
        self.cause = cause


class Runner:
    def __init__(self, cloud, machine, execution):
        self.cloud = cloud
        self.machine = machine
        self.execution = execution
        self.counter = 0
        self.lock = threading.Lock()
        self.steps = 0

    def event(self, kind, details=None, key=None):
        with self.lock:
            self.counter += 1
            entry = {"timestamp": time.time(), "type": kind, "id": self.counter, "previousEventId": self.counter - 1}
            if details is not None:
                entry[key or (kind[:1].lower() + kind[1:] + "EventDetails")] = details
            self.execution["history"].append(entry)
            del self.execution["history"][:-500]

    def run(self, value):
        from .. import operation
        execution = self.execution
        definition = json.loads(self.machine["definition"])
        context = {"Execution": {"Id": execution["arn"], "Name": execution["name"], "StartTime": wire.iso(execution["started"]),
                                 "Input": value, "RoleArn": self.machine["role"]},
                   "StateMachine": {"Id": self.machine["arn"], "Name": self.machine["name"]}}
        self.event("ExecutionStarted", {"input": execution["input"], "roleArn": self.machine["role"]})
        try:
            deadline = time.monotonic() + float(definition.get("TimeoutSeconds") or 86400 * 365)
            with operation.deadline(deadline):
                output = self.run_states(definition, value, context)
                if execution["status"] == "ABORTED":
                    return
                encoded = json.dumps(output, ensure_ascii=False)
                operation.check()
                execution.update({"status": "SUCCEEDED", "output": encoded, "stopped": time.time()})
                self.event("ExecutionSucceeded", {"output": execution["output"]})
        except operation.Cancelled:
            execution.update({"status": "ABORTED", "stopped": time.time()})
            for step in execution["steps"]:
                if step["status"] == "running":
                    step.update({"status": "aborted", "ended": time.time()})
            self.event("ExecutionAborted", {"cause": "The Studio operation was cancelled"})
            raise
        except (StatesError, operation.DeadlineExceeded) as error:
            if execution["status"] == "ABORTED":
                return
            if isinstance(error, operation.DeadlineExceeded):
                error = StatesError("States.Timeout", "The execution timed out")
            for step in execution["steps"]:
                if step["status"] == "running":
                    step.update({"status": "failed", "ended": time.time(), "error": f"{error.error}: {error.cause}"[:600]})
            status = "TIMED_OUT" if error.error == "States.Timeout" else "FAILED"
            execution.update({"status": status, "error": error.error, "cause": error.cause, "stopped": time.time()})
            self.event("ExecutionTimedOut" if status == "TIMED_OUT" else "ExecutionFailed", {"error": error.error, "cause": error.cause})
        except Exception as error:  # an emulator bug ends the execution instead of hanging it
            execution.update({"status": "FAILED", "error": "States.Runtime", "cause": f"CloudStudio: {type(error).__name__}: {error}", "stopped": time.time()})
            self.event("ExecutionFailed", {"error": "States.Runtime", "cause": execution["cause"]})
        finally:
            self.cloud.store.touch()

    def run_states(self, definition, value, context, prefix=""):
        from .. import operation
        name = definition["StartAt"]
        states = definition["States"]
        while True:
            operation.check()
            if self.execution["status"] == "ABORTED":
                raise StatesError("States.Aborted", "Execution was stopped")
            self.steps += 1
            if self.steps > MAX_STEPS:
                raise StatesError("States.Runtime", f"CloudStudio stopped the execution after {MAX_STEPS} state transitions")
            state = states[name]
            step = {"name": prefix + name, "type": state["Type"], "status": "running", "started": time.time(), "ended": None,
                    "input": _clip(value), "output": None, "error": None}
            self.execution["steps"].append(step)
            del self.execution["steps"][:-200]
            self.cloud.store.touch()
            self.event(f"{state['Type']}StateEntered", {"name": name, "input": json.dumps(value, ensure_ascii=False)}, "stateEnteredEventDetails")
            state_context = {**context, "State": {"Name": name, "EnteredTime": wire.iso()}}
            try:
                value, next_name = self.step(state, value, state_context, prefix + name + " › ")
                operation.check()
            except StatesError as error:
                operation.check()
                step.update({"status": "failed", "ended": time.time(), "error": f"{error.error}: {error.cause}"[:600]})
                catcher = next((c for c in state.get("Catch", []) if _errors_match(c.get("ErrorEquals", []), error.error)), None)
                if catcher is None:
                    raise
                value = set_path(value, catcher.get("ResultPath", "$"), {"Error": error.error, "Cause": error.cause})
                step["output"] = _clip(value)
                name = catcher["Next"]
                continue
            step.update({"status": "ok", "ended": time.time(), "output": _clip(value)})
            self.event(f"{state['Type']}StateExited", {"name": name, "output": json.dumps(value, ensure_ascii=False)}, "stateExitedEventDetails")
            if next_name is None:
                return value
            name = next_name

    def step(self, state, raw, context, prefix):
        from .. import operation
        kind = state["Type"]
        if kind == "Fail":
            error = state.get("Error") or (json_path(raw, state["ErrorPath"], context) if state.get("ErrorPath") else "States.Fail")
            cause = state.get("Cause") or (json_path(raw, state["CausePath"], context) if state.get("CausePath") else "")
            raise StatesError(error, cause)
        value = json_path(raw, state["InputPath"], context) if state.get("InputPath", "$") not in ("$", None) else (raw if state.get("InputPath", "$") == "$" else {})
        if kind == "Succeed":
            return self.output(state, value, context), None
        if kind == "Wait" and "Parameters" in state:
            raise StatesError("States.Runtime", "Wait states do not take Parameters")
        if kind == "Choice":
            for choice in state.get("Choices", []):
                if _choice(choice, value, context):
                    return self.output(state, value, context), choice["Next"]
            if "Default" in state:
                return self.output(state, value, context), state["Default"]
            raise StatesError("States.NoChoiceMatched", "No Choice Rule matched and no Default was specified")
        if "Parameters" in state:
            value = resolve(state["Parameters"], value, context)
        if kind == "Pass":
            result = state["Result"] if "Result" in state else value
        elif kind == "Wait":
            seconds = state.get("Seconds")
            if state.get("SecondsPath"):
                seconds = json_path(value, state["SecondsPath"], context)
            target = state.get("Timestamp") or (json_path(value, state["TimestampPath"], context) if state.get("TimestampPath") else None)
            wait = float(seconds) if seconds is not None else max(0.0, _timestamp(target) - time.time()) if target else 0.0
            if operation.wait(wait, self.cloud.stopping):
                raise StatesError("States.Aborted", "The local cloud stopped")
            return self.output(state, value, context), (None if state.get("End") else state.get("Next"))
        elif kind == "Task":
            result = self.retrying(state, lambda: self.task(state, value, context))
        elif kind == "Parallel":
            result = self.retrying(state, lambda: self.parallel(state, value, context, prefix))
        elif kind == "Map":
            result = self.retrying(state, lambda: self.map(state, value, context, prefix))
        else:
            raise StatesError("States.Runtime", f"Unsupported state type {kind}")
        if state.get("ResultSelector") and kind != "Pass":
            result = resolve(state["ResultSelector"], result, context)
        combined = set_path(raw, state.get("ResultPath", "$"), result) if "ResultPath" not in state or state["ResultPath"] is not None else raw
        output = json_path(combined, state["OutputPath"], context) if state.get("OutputPath", "$") not in ("$", None) else (combined if state.get("OutputPath", "$") == "$" else {})
        return output, (None if state.get("End") else state.get("Next"))

    def output(self, state, value, context):
        path = state.get("OutputPath", "$")
        if path is None:
            return {}
        return value if path == "$" else json_path(value, path, context)

    def retrying(self, state, action):
        from .. import operation
        attempts = {}
        while True:
            operation.check()
            try:
                return action()
            except StatesError as error:
                retrier = next((r for r in state.get("Retry", []) if _errors_match(r.get("ErrorEquals", []), error.error)), None)
                if retrier is None:
                    raise
                key = id(retrier)
                attempts[key] = attempts.get(key, 0) + 1
                if attempts[key] > int(retrier.get("MaxAttempts", 3)):
                    raise
                delay = float(retrier.get("IntervalSeconds", 1)) * float(retrier.get("BackoffRate", 2.0)) ** (attempts[key] - 1)
                delay = min(delay, float(retrier.get("MaxDelaySeconds", delay)))
                if operation.wait(delay, self.cloud.stopping):
                    raise

    def task(self, state, value, context):
        resource = state.get("Resource", "")
        timeout = float(state.get("TimeoutSeconds") or 99999)
        self.event("TaskScheduled", {"resourceType": resource.split(":")[2] if ":" in resource else "", "resource": resource,
                                     "region": self.machine["region"], "parameters": json.dumps(value, ensure_ascii=False)})
        if re.match(r"^arn:aws:lambda:", resource) or resource.startswith("arn:aws:states:::lambda:invoke"):
            if resource.startswith("arn:aws:states:::"):
                function = value.get("FunctionName") if isinstance(value, dict) else None
                payload = value.get("Payload", {}) if isinstance(value, dict) else value
            else:
                function, payload = resource, value
            account, region, name = _lambda_target(function, self.machine)
            outcome = self.cloud.runtime.invoke(account, region, name, payload, f"sfn:{self.machine['name']}")
            if outcome["ms"] / 1000 > timeout:
                raise StatesError("States.Timeout", f"Task timed out after {timeout} seconds")
            if not outcome["ok"]:
                payload_error = outcome["payload"] or {}
                error = payload_error.get("errorType") or "Lambda.Unknown"
                if outcome.get("missing"):
                    error = "Lambda.ResourceNotFoundException"
                cause = json.dumps(payload_error, ensure_ascii=False)
                self.event("TaskFailed", {"resource": resource, "error": error, "cause": cause})
                raise StatesError(error, cause)
            self.event("TaskSucceeded", {"resource": resource, "output": json.dumps(outcome["payload"], ensure_ascii=False, default=str)})
            if resource.startswith("arn:aws:states:::"):
                return {"ExecutedVersion": "$LATEST", "Payload": outcome["payload"], "StatusCode": 200,
                        "SdkHttpMetadata": {"HttpStatusCode": 200}, "SdkResponseMetadata": {"RequestId": outcome["request"]}}
            return outcome["payload"]
        match = re.match(r"^arn:aws:states:::(?:aws-sdk:)?(?P<service>sqs|sns|dynamodb|events|states):(?P<action>[A-Za-z]+)(?:\.sync|\.waitForTaskToken)?$", resource)
        if match:
            return self.sdk_task(match.group("service"), match.group("action"), value)
        raise StatesError("States.TaskFailed", f"CloudStudio cannot run the task resource {resource}")

    def sdk_task(self, service, action, value):
        from .. import operation
        params = value if isinstance(value, dict) else {}
        op = action[:1].upper() + action[1:]
        caller = Caller(self.machine["account"], self.machine["region"], f"sfn:{self.machine['name']}")
        caller.service = {"states": NAME}.get(service, service)
        try:
            if service == "sqs":
                from . import sqs
                params = dict(params)
                if isinstance(params.get("MessageBody"), (dict, list)):
                    params["MessageBody"] = json.dumps(params["MessageBody"], ensure_ascii=False)
                from .common import run_json
                return run_json(self.cloud, caller, sqs.OPS, op, params)
            if service == "dynamodb":
                from . import dynamodb
                from .common import run_json
                return run_json(self.cloud, caller, dynamodb.OPS, op, params)
            if service == "events":
                from . import events
                from .common import run_json
                params = {"Entries": [{**e, "Detail": json.dumps(e["Detail"]) if isinstance(e.get("Detail"), (dict, list)) else e.get("Detail")}
                                      for e in params.get("Entries", [])]}
                return run_json(self.cloud, caller, events.OPS, op, params)
            if service == "states":
                from .common import run_json
                return run_json(self.cloud, caller, OPS, op, {**params, "input": json.dumps(params.get("Input", {}))})
            if service == "sns":
                from . import sns
                message = params.get("Message")
                params = {**params, "Message": message if isinstance(message, str) else json.dumps(message, ensure_ascii=False)}
                if op not in sns.OPS:
                    raise AwsError("InvalidAction", f"{op} is not supported")
                result = sns.OPS[op](self.cloud, caller, params)
                self.cloud.internal_call("sns", op, caller.target, caller.source, account=caller.account, region=caller.region)
                return result
        except operation.Cancelled:
            raise
        except AwsError as error:
            prefix = {"sqs": "Sqs", "sns": "Sns", "dynamodb": "DynamoDb", "events": "EventBridge", "states": "Sfn"}[service]
            raise StatesError(f"{prefix}.{error.code}", error.message) from error
        raise StatesError("States.TaskFailed", f"CloudStudio cannot run {service}:{action}")

    def parallel(self, state, value, context, prefix):
        results = []
        for index, branch in enumerate(state.get("Branches", [])):
            results.append(self.run_states(branch, copy.deepcopy(value), context, f"{prefix}{index + 1}: "))
        return results

    def map(self, state, value, context, prefix):
        items = json_path(value, state["ItemsPath"], context) if state.get("ItemsPath") else value
        if not isinstance(items, list):
            raise StatesError("States.Runtime", "Map state input is not an array")
        processor = state.get("ItemProcessor") or state.get("Iterator")
        selector = state.get("ItemSelector") or state.get("Parameters")
        results = []
        for index, item in enumerate(items):
            item_context = {**context, "Map": {"Item": {"Index": index, "Value": item}}}
            item_value = resolve(selector, value, item_context) if selector and "ItemSelector" in state else item
            results.append(self.run_states(processor, item_value, item_context, f"{prefix}[{index}] "))
        return results


def _lambda_target(function, machine):
    text = str(function or "")
    if text.startswith("arn:"):
        parts = text.split(":")
        return parts[4], parts[3], parts[6]
    return machine["account"], machine["region"], text.split(":")[0]


def _errors_match(names, error):
    return "States.ALL" in names or error in names or ("States.TaskFailed" in names and not error.startswith("States."))


def _timestamp(text):
    try:
        return datetime.fromisoformat(str(text).replace("Z", "+00:00")).timestamp()
    except ValueError as error:
        raise StatesError("States.Runtime", f"Invalid timestamp {text}") from error


def _choice(rule, value, context):
    if "And" in rule:
        return all(_choice(r, value, context) for r in rule["And"])
    if "Or" in rule:
        return any(_choice(r, value, context) for r in rule["Or"])
    if "Not" in rule:
        return not _choice(rule["Not"], value, context)
    try:
        variable = json_path(value, rule["Variable"], context)
        present = True
    except StatesError:
        variable, present = None, False
    for key, expected in rule.items():
        if key in ("Variable", "Next"):
            continue
        if key == "IsPresent":
            return present == expected
        if not present:
            return False
        if key.endswith("Path"):
            expected = json_path(value, expected, context)
            key = key[:-4]
        if key == "IsNull":
            return (variable is None) == expected
        if key == "IsString":
            return isinstance(variable, str) == expected
        if key == "IsNumeric":
            return (isinstance(variable, (int, float)) and not isinstance(variable, bool)) == expected
        if key == "IsBoolean":
            return isinstance(variable, bool) == expected
        if key == "IsTimestamp":
            try:
                _timestamp(variable)
                return expected is True
            except StatesError:
                return expected is False
        if key == "StringMatches":
            expression = "^" + ".*".join(re.escape(part) for part in str(expected).split("*")) + "$"
            return isinstance(variable, str) and re.match(expression, variable) is not None
        for prefix, kind in (("String", str), ("Numeric", (int, float)), ("Boolean", bool), ("Timestamp", str)):
            if key.startswith(prefix):
                if not isinstance(variable, kind) or (prefix == "Numeric" and isinstance(variable, bool)):
                    return False
                left, right = (variable, expected)
                if prefix == "Timestamp":
                    left, right = _timestamp(variable), _timestamp(expected)
                op = key[len(prefix):]
                return {"Equals": left == right, "LessThan": left < right, "GreaterThan": left > right,
                        "LessThanEquals": left <= right, "GreaterThanEquals": left >= right}.get(op, False)
    return False


def _clip(value, limit=1200):
    text = json.dumps(value, ensure_ascii=False, default=str)
    return text if len(text) <= limit else text[:limit] + "…"


def resources(cloud):
    result = []
    for account, region, service in cloud.store.each(NAME):
        for machine in service.get("machines", {}).values():
            try:
                definition = json.loads(machine["definition"])
            except ValueError:
                definition = {}
            states = [{"name": n, "type": s.get("Type"), "next": s.get("Next"), "end": bool(s.get("End")),
                       "resource": s.get("Resource"), "choices": [c.get("Next") for c in s.get("Choices", [])] + ([s["Default"]] if s.get("Default") else []),
                       "catch": [c.get("Next") for c in s.get("Catch", [])],
                       "function": (s.get("Parameters") or {}).get("FunctionName") or (s.get("Resource") if ":lambda:" in str(s.get("Resource")) else None)}
                      for n, s in (definition.get("States") or {}).items()]
            executions = sorted(machine.get("executions", {}).values(), key=lambda e: e["started"], reverse=True)[:10]
            result.append({"service": NAME, "kind": "state-machine", "name": machine["name"], "arn": machine["arn"], "account": account,
                           "region": region, "created": machine["created"], "type": machine["type"], "start": definition.get("StartAt"),
                           "states": states,
                           "executions": [{"name": e["name"], "status": e["status"], "started": e["started"], "stopped": e["stopped"],
                                           "error": e["error"], "cause": (e["cause"] or "")[:600], "input": e["input"][:1200],
                                           "output": (e["output"] or "")[:1200], "steps": e["steps"][-60:]} for e in executions]})
    return result
