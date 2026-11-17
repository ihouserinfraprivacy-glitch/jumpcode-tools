# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See LICENSE in the project root.

"""Runs Lambda functions as local processes (Python or Node.js from this computer) and drives the cloud's
background work: queue triggers, schedules, rules and expiring items."""

from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import threading
import time
import uuid

from . import wire

RUNNERS = Path(__file__).parent / "runners"
NO_WINDOW = 0x08000000 if os.name == "nt" else 0
STRIPPED = ("AWS_", "AMAZON_", "_CLOUDSTUDIO", "PYTHONHOME", "PYTHONPATH", "PYTHONSTARTUP", "PYTHONSAFEPATH", "PYTHONNOUSERSITE",
            "NODE_OPTIONS", "NODE_PATH", "VIRTUAL_ENV", "CONDA_PREFIX", "JUMPCODE_")
MAX_OUTPUT = 256 * 1024


class Runtime:
    def __init__(self, cloud, python=None, node=None):
        self.cloud = cloud
        self.settings = {"python": python, "node": node}
        self.found = {}
        self.lock = threading.Lock()
        self.processes = set()
        self.pool = ThreadPoolExecutor(max_workers=16, thread_name_prefix="cloudstudio-fn")
        self.busy_mappings = set()
        self.thread = threading.Thread(target=self._tick, name="cloudstudio-ticker", daemon=True)

    def start(self):
        self.thread.start()

    def stop(self):
        with self.lock:
            processes = list(self.processes)
        for process in processes:
            _kill(process)
        self.pool.shutdown(wait=False, cancel_futures=True)

    # ------------------------------------------------------------ interpreters
    def interpreter(self, family):
        if family in self.found:
            return self.found[family]
        configured = self.settings.get(family)
        if family == "python":
            candidates = [configured] if configured else ([["py", "-3"], ["python"], ["python3"]] if os.name == "nt" else [["python3"], ["python"]])
        else:
            candidates = [configured] if configured else [["node"]]
        found = None
        for candidate in candidates:
            command = candidate if isinstance(candidate, list) else [candidate]
            executable = shutil.which(command[0])
            if not executable or "windowsapps" in executable.lower():
                continue
            try:
                output = subprocess.run([executable, *command[1:], "--version"], capture_output=True, timeout=8, creationflags=NO_WINDOW,
                                        env=_clean_env())
            except (OSError, subprocess.SubprocessError):
                continue
            if output.returncode == 0:
                version = (output.stdout or output.stderr).decode("utf-8", "replace").strip().split()[-1].lstrip("v")
                found = {"command": [executable, *command[1:]], "version": version}
                break
        self.found[family] = found
        return found

    def available(self):
        result = {}
        for family in ("python", "node"):
            found = self.found.get(family)
            result[family] = found["version"] if found else None
        return result

    def warm(self):
        """Finds the interpreters in the background so the first invocation does not wait for it."""
        threading.Thread(target=lambda: [self.interpreter("python"), self.interpreter("node"), self.cloud.live.mark("cloud")],
                         daemon=True).start()

    # ------------------------------------------------------------ invocations
    def invoke(self, account, region, name, event, source, asynchronous=False):
        """Runs a function and returns {ok, payload, errorType, logs, ms, request}. Records the call and the logs."""
        from .services import lambda_
        fn = lambda_.find(self.cloud, account, region, name)
        if fn is None:
            message = f"Function not found: {wire.arn('lambda', region, account, 'function:' + str(name))}"
            self.cloud.internal_call("lambda", "Invoke", str(name), source, error=("ResourceNotFoundException", message), account=account, region=region)
            return {"ok": False, "missing": True, "payload": {"errorType": "ResourceNotFoundException", "errorMessage": message}, "ms": 0, "logs": []}
        outcome = self.execute(fn, event)
        entry = {"at": time.time(), "ms": round(outcome["ms"], 1), "source": source, "ok": outcome["ok"], "request": outcome["request"],
                 "error": None if outcome["ok"] else (outcome["payload"] or {}).get("errorType"),
                 "message": None if outcome["ok"] else str((outcome["payload"] or {}).get("errorMessage", ""))[:400],
                 "event": _clip(event), "result": _clip(outcome["payload"])}
        with self.cloud.store.lock:
            fn.setdefault("invocations", []).append(entry)
            del fn["invocations"][:-25]
        self.cloud.store.touch()
        if source != "app" or asynchronous:
            error = None if outcome["ok"] else (entry["error"] or "Unhandled", entry["message"] or "")
            self.cloud.internal_call("lambda", "Invoke", fn["name"], source, outcome["ms"], error, req=_clip(event, 600),
                                     res=_clip(outcome["payload"], 600), account=account, region=region)
        return outcome

    def invoke_async(self, account, region, name, event, source, attempts=3):
        def run():
            for attempt in range(attempts):
                outcome = self.invoke(account, region, name, event, source, asynchronous=True)
                if outcome["ok"] or outcome.get("missing"):
                    return
                if attempt < attempts - 1 and not self.cloud.stopping.wait(1 + attempt):
                    continue
            from .services import lambda_
            lambda_.dead_letter(self.cloud, account, region, name, event, outcome)
        self.pool.submit(run)

    def invoke_arn_async(self, arn, event, source):
        account, region, name = _split_arn(arn, self.cloud.region)
        self.invoke_async(account, region, name, event, source)

    def execute(self, fn, event):
        from .services import lambda_, logs
        request_id = str(uuid.uuid4())
        started = time.perf_counter()
        family = "python" if fn["runtime"].startswith("python") else "node" if fn["runtime"].startswith("nodejs") else None
        stream = f"{time.strftime('%Y/%m/%d', time.gmtime())}/[$LATEST]{uuid.uuid4().hex}"
        group = f"/aws/lambda/{fn['name']}"
        lines = [f"START RequestId: {request_id} Version: $LATEST"]
        payload = None
        ok = False
        ran = False
        interpreter = self.interpreter(family) if family else None
        code_dir = lambda_.code_dir(self.cloud, fn)
        if family is None:
            payload = {"errorType": "Runtime.InvalidRuntime", "errorMessage": f"CloudStudio runs Python and Node.js functions; {fn['runtime']} is not available here."}
        elif interpreter is None:
            payload = {"errorType": "Runtime.Unavailable",
                       "errorMessage": f"{'Python' if family == 'python' else 'Node.js'} was not found on this computer. Install it or set its path in CloudStudio settings."}
        elif code_dir is None or not code_dir.is_dir():
            payload = {"errorType": "Runtime.ImportModuleError", "errorMessage": f"The function code folder is missing: {fn.get('code', {}).get('dir') or '(no code)'}"}
        else:
            ran = True
            ok, payload, output, timed_out = self._run(fn, family, interpreter, code_dir, event, request_id, group, stream)
            lines += output.splitlines()
            if timed_out:
                lines.append(f"{wire.iso()} {request_id} Task timed out after {float(fn['timeout']):.2f} seconds")
        ms = (time.perf_counter() - started) * 1000
        if not ok and payload and not ran:
            lines.append(f"[ERROR] {payload.get('errorType')}: {payload.get('errorMessage')}")
        lines.append(f"END RequestId: {request_id}")
        lines.append(f"REPORT RequestId: {request_id}\tDuration: {ms:.2f} ms\tBilled Duration: {int(ms) + 1} ms\tMemory Size: {fn['memory']} MB\tMax Memory Used: 0 MB")
        logs.append(self.cloud, fn["account"], fn["region"], group, stream, lines)
        in_trace = False
        for line in lines:
            if line.startswith(("START ", "END ", "REPORT ")):
                level, in_trace = "system", False
            elif "[ERROR]" in line or "Traceback" in line or "Task timed out" in line or line.startswith(("Error", "    at ")):
                level, in_trace = "error", True
            elif in_trace and line[:1].isspace():
                level = "error"
            else:
                level, in_trace = "info", False
            self.cloud.log(group, stream, line, level, request_id, fn["account"], fn["region"])
        return {"ok": ok, "payload": payload, "logs": lines, "ms": ms, "request": request_id}

    def _run(self, fn, family, interpreter, code_dir, event, request_id, group, stream):
        from . import operation
        operation.check()
        scratch = self.cloud.root / "data" / "tmp"
        scratch.mkdir(parents=True, exist_ok=True)
        handle, result_path = tempfile.mkstemp(prefix="fn-", suffix=".json", dir=scratch)
        os.close(handle)
        runner = RUNNERS / ("python_runner.py" if family == "python" else "node_runner.cjs")
        environment = self._environment(fn, family, code_dir, request_id, result_path, group, stream)
        timed_out = False
        try:
            process = subprocess.Popen([*interpreter["command"], str(runner)], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                       stderr=subprocess.STDOUT, cwd=str(code_dir), env=environment, creationflags=NO_WINDOW)
        except OSError as error:
            _remove(result_path)
            return False, {"errorType": "Runtime.ExitError", "errorMessage": f"Could not start the function: {error}"}, "", False
        with self.lock:
            self.processes.add(process)
        try:
            deadline = time.monotonic() + float(fn["timeout"])
            data = json.dumps(event, ensure_ascii=False).encode("utf-8")
            while True:
                operation.check()
                remaining = deadline - time.monotonic()
                try:
                    output, _ = process.communicate(data, timeout=max(0, min(0.05, remaining)))
                    break
                except subprocess.TimeoutExpired:
                    data = None
                    if remaining <= 0:
                        raise
        except subprocess.TimeoutExpired:
            timed_out = True
            _kill(process)
            output, _ = process.communicate()
        except (operation.Cancelled, operation.DeadlineExceeded):
            _kill(process)
            process.communicate()
            _remove(result_path)
            raise
        finally:
            with self.lock:
                self.processes.discard(process)
        text = (output or b"")[-MAX_OUTPUT:].decode("utf-8", "replace")
        if timed_out:
            _remove(result_path)
            return False, {"errorMessage": f"{wire.iso()} {request_id} Task timed out after {float(fn['timeout']):.2f} seconds",
                           "errorType": "Sandbox.Timedout"}, text, True
        try:
            with open(result_path, encoding="utf-8") as reader:
                outcome = json.load(reader)
        except (OSError, ValueError):
            outcome = {"ok": False, "errorType": "Runtime.ExitError",
                       "errorMessage": f"RequestId: {request_id} Error: Runtime exited with error: exit status {process.returncode}"}
        finally:
            _remove(result_path)
        if outcome.get("ok"):
            return True, outcome.get("result"), text, False
        payload = {"errorType": outcome.get("errorType", "Error"), "errorMessage": outcome.get("errorMessage", ""),
                   "requestId": request_id, "stackTrace": outcome.get("stackTrace", [])}
        return False, payload, text, False

    def _environment(self, fn, family, code_dir, request_id, result_path, group, stream):
        environment = _clean_env()
        environment.update({str(k): str(v) for k, v in (fn.get("environment") or {}).items()})
        account = fn["account"]
        environment.update({
            "AWS_ACCESS_KEY_ID": account if account != wire.DEFAULT_ACCOUNT else "test",
            "AWS_SECRET_ACCESS_KEY": "test",
            "AWS_SESSION_TOKEN": f"cloudstudio:fn:{fn['name']}",
            "AWS_REGION": fn["region"], "AWS_DEFAULT_REGION": fn["region"],
            "AWS_ENDPOINT_URL": self.cloud.endpoint,
            "AWS_EXECUTION_ENV": f"AWS_Lambda_{fn['runtime']}",
            "AWS_LAMBDA_FUNCTION_NAME": fn["name"], "AWS_LAMBDA_FUNCTION_VERSION": "$LATEST",
            "AWS_LAMBDA_FUNCTION_MEMORY_SIZE": str(fn["memory"]),
            "AWS_LAMBDA_LOG_GROUP_NAME": group, "AWS_LAMBDA_LOG_STREAM_NAME": stream,
            "LAMBDA_TASK_ROOT": str(code_dir), "_HANDLER": fn["handler"], "TZ": "UTC",
            "_CLOUDSTUDIO_RESULT": result_path, "_CLOUDSTUDIO_REQUEST": request_id, "_CLOUDSTUDIO_ARN": fn["arn"],
            "_CLOUDSTUDIO_TIMEOUT": str(fn["timeout"]),
        })
        if family == "python":
            environment.update({"PYTHONUNBUFFERED": "1", "PYTHONIOENCODING": "utf-8", "PYTHONUTF8": "1", "PYTHONDONTWRITEBYTECODE": "1"})
        return environment

    # ------------------------------------------------------------ background work
    def _tick(self):
        from .services import dynamodb, events, lambda_, scheduler
        last_sweep = 0.0
        while not self.cloud.stopping.wait(0.5):
            try:
                self.poll_queues(lambda_)
                scheduler.tick(self.cloud)
                events.tick(self.cloud)
                if time.time() - last_sweep > 15:
                    last_sweep = time.time()
                    dynamodb.expire(self.cloud)
            except Exception as error:  # background work must keep running
                self.cloud.log("/cloudstudio/engine", "ticker", f"{type(error).__name__}: {error}", "error")

    def poll_queues(self, lambda_):
        from .services import sqs
        for mapping, fn in lambda_.queue_mappings(self.cloud):
            if mapping["uuid"] in self.busy_mappings:
                continue
            queue = sqs.by_arn(self.cloud, mapping["source"])
            if queue is None:
                continue
            messages = sqs.take(self.cloud, queue, int(mapping.get("batch", 10)))
            if not messages:
                continue
            self.busy_mappings.add(mapping["uuid"])
            self.pool.submit(self._deliver_batch, mapping, fn, queue, messages)

    def _deliver_batch(self, mapping, fn, queue, messages):
        from .services import sqs
        try:
            event = {"Records": [{
                "messageId": m["id"], "receiptHandle": m["receipt"], "body": m["body"],
                "attributes": {"ApproximateReceiveCount": str(m["receives"]), "SentTimestamp": str(int(m["sent"] * 1000)),
                               "SenderId": m.get("sender", wire.DEFAULT_ACCOUNT), "ApproximateFirstReceiveTimestamp": str(int((m["first_receive"] or m["sent"]) * 1000)),
                               **({"MessageGroupId": m["group"]} if m.get("group") else {})},
                "messageAttributes": {k: {"stringValue": v.get("StringValue"), "binaryValue": v.get("BinaryValue"), "stringListValues": [],
                                          "binaryListValues": [], "dataType": v.get("DataType", "String")} for k, v in (m.get("attributes") or {}).items()},
                "md5OfBody": m["md5"], "eventSource": "aws:sqs", "eventSourceARN": queue["arn"], "awsRegion": queue["region"],
            } for m in messages]}
            outcome = self.invoke(fn["account"], fn["region"], fn["name"], event, f"sqs:{queue['name']}")
            failed_ids = set()
            if outcome["ok"] and "ReportBatchItemFailures" in (mapping.get("responseTypes") or []):
                failures = (outcome["payload"] or {}).get("batchItemFailures") if isinstance(outcome["payload"], dict) else None
                failed_ids = {f.get("itemIdentifier") for f in failures or []}
            if outcome["ok"]:
                with self.cloud.store.lock:
                    queue["messages"] = [m for m in queue["messages"] if m not in messages or m["id"] in failed_ids]
                self.cloud.store.touch()
                mapping["last"] = "OK"
            else:
                mapping["last"] = "PROBLEM: Function call failed"
            mapping["lastAt"] = time.time()
            with sqs.signal(self.cloud):
                sqs.signal(self.cloud).notify_all()
        finally:
            self.busy_mappings.discard(mapping["uuid"])


def _clean_env():
    return {k: v for k, v in os.environ.items() if not k.upper().startswith(STRIPPED)}


def _split_arn(arn, default_region):
    parts = str(arn).split(":")
    if len(parts) >= 7 and parts[2] == "lambda":
        return parts[4], parts[3], parts[6]
    return wire.DEFAULT_ACCOUNT, default_region, str(arn)


def _clip(value, limit=2000):
    text = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False, default=str)
    return text if len(text) <= limit else text[:limit] + "…"


def _kill(process):
    if process.poll() is not None:
        return
    if os.name == "nt":
        subprocess.run(["taskkill", "/F", "/T", "/PID", str(process.pid)], capture_output=True, creationflags=NO_WINDOW)
    else:
        process.kill()


def _remove(path):
    try:
        os.remove(path)
    except OSError:
        pass
