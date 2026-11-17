# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See LICENSE in the project root.

"""Runs one Lambda invocation of a Python handler: reads the event on stdin, calls handler(event, context)
and writes the result (or the error) as JSON to the file CloudStudio named. print() output is the function's log."""

import importlib
import json
import os
import sys
import time
import traceback


class Context:
    def __init__(self):
        self.function_name = os.environ.get("AWS_LAMBDA_FUNCTION_NAME", "")
        self.function_version = os.environ.get("AWS_LAMBDA_FUNCTION_VERSION", "$LATEST")
        self.invoked_function_arn = os.environ.get("_CLOUDSTUDIO_ARN", "")
        self.memory_limit_in_mb = os.environ.get("AWS_LAMBDA_FUNCTION_MEMORY_SIZE", "128")
        self.aws_request_id = os.environ.get("_CLOUDSTUDIO_REQUEST", "")
        self.log_group_name = os.environ.get("AWS_LAMBDA_LOG_GROUP_NAME", "")
        self.log_stream_name = os.environ.get("AWS_LAMBDA_LOG_STREAM_NAME", "")
        self.identity = None
        self.client_context = None
        self._deadline = time.time() + float(os.environ.get("_CLOUDSTUDIO_TIMEOUT", "3"))

    def get_remaining_time_in_millis(self):
        return max(0, int((self._deadline - time.time()) * 1000))


def main():
    result_path = os.environ["_CLOUDSTUDIO_RESULT"]
    task_root = os.environ.get("LAMBDA_TASK_ROOT", os.getcwd())
    handler = os.environ.get("_HANDLER", "lambda_function.lambda_handler")
    sys.path.insert(0, task_root)
    for layer in filter(None, os.environ.get("_CLOUDSTUDIO_PATHS", "").split(os.pathsep)):
        sys.path.insert(1, layer)
    try:
        event = json.loads(sys.stdin.buffer.read().decode("utf-8") or "null")
        module_name, _, function_name = handler.rpartition(".")
        if not module_name:
            raise ImportError(f"Bad handler '{handler}': not enough values to unpack (expected 2, got 1)")
        try:
            module = importlib.import_module(module_name.replace("/", "."))
        except ModuleNotFoundError as error:
            if error.name and module_name.replace("/", ".").startswith(error.name):
                raise RuntimeError(f"Unable to import module '{module_name}': No module named '{error.name}'") from error
            raise
        function = getattr(module, function_name, None)
        if function is None:
            raise AttributeError(f"Handler '{function_name}' missing on module '{module_name}'")
        value = function(event, Context())
        outcome = {"ok": True, "result": value}
        try:
            json.dumps(value)
        except (TypeError, ValueError) as error:
            outcome = {"ok": False, "errorType": "Runtime.MarshalError", "errorMessage": f"Unable to marshal response: {error}", "stackTrace": []}
    except Exception as error:  # the function's own error is its result
        error_type = type(error).__name__
        if isinstance(error, RuntimeError) and str(error).startswith("Unable to import module"):
            error_type = "Runtime.ImportModuleError"
        # Like Lambda, the trace shows the function's frames, not the runner's.
        frames = [frame for frame in traceback.extract_tb(error.__traceback__) if os.path.abspath(frame.filename) != os.path.abspath(__file__)]
        lines = [line.rstrip("\n") for line in traceback.format_list(frames)]
        sys.stdout.flush()
        sys.stderr.write(f"[ERROR] {error_type}: {error}\nTraceback (most recent call last):\n" + "\n".join(lines) + "\n")
        sys.stderr.flush()
        outcome = {"ok": False, "errorType": error_type, "errorMessage": str(error), "stackTrace": lines}
    sys.stdout.flush()
    with open(result_path, "w", encoding="utf-8") as stream:
        json.dump(outcome, stream, ensure_ascii=False, default=str)


if __name__ == "__main__":
    main()
