# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See LICENSE in the project root.

"""Starts the local cloud: python -m jumpcode_cloudstudio.engine --studio <folder> --port 4566.
The first line on stdin is the control token; when stdin closes (the tool's process ended), the cloud stops."""

import argparse
import json
import sys
import threading
import time


def main(argv=None):
    began = time.time()
    parser = argparse.ArgumentParser(prog="cloudstudio-engine")
    parser.add_argument("--studio", required=True)
    parser.add_argument("--port", type=int, default=4566)
    parser.add_argument("--storage", choices=("memory", "persistent"), default="memory")
    parser.add_argument("--region", default="us-east-1")
    parser.add_argument("--python")
    parser.add_argument("--node")
    parser.add_argument("--spawned", type=float)
    options = parser.parse_args(argv)
    token = sys.stdin.readline().strip()

    from .server import Cloud, serve
    from .state import StateError
    try:
        cloud = Cloud(options.studio, options.port, options.storage == "persistent", token, options.region,
                      [options.python] if options.python else None, [options.node] if options.node else None)
    except StateError as error:
        sys.stdout.write(json.dumps({"ready": False, "error": "state", "message": str(error)}) + "\n")
        sys.stdout.flush()
        return 4
    try:
        server = serve(cloud)
    except OSError as error:
        sys.stdout.write(json.dumps({"ready": False, "error": "port", "message": str(error)}) + "\n")
        sys.stdout.flush()
        return 3
    cloud.stop_server = server.shutdown
    cloud.live.start()
    cloud.runtime.start()
    cloud.runtime.warm()
    cloud.ready_ms = round((time.time() - (options.spawned or began)) * 1000)
    cloud.live.status = "running"
    cloud.live.mark("cloud", "resources", "calls", "logs")
    sys.stdout.write(json.dumps({"ready": True, "port": options.port, "readyMs": cloud.ready_ms}) + "\n")
    sys.stdout.flush()

    def watch_parent():
        try:
            while sys.stdin.readline():
                pass
        except (OSError, ValueError):
            pass
        server.shutdown()

    threading.Thread(target=watch_parent, name="cloudstudio-parent", daemon=True).start()
    try:
        server.serve_forever(poll_interval=0.25)
    finally:
        cloud.shutdown()
        server.server_close()
        try:
            cloud.live.final("stopped")
        except Exception:  # the Studio files are best effort on the way out
            pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
