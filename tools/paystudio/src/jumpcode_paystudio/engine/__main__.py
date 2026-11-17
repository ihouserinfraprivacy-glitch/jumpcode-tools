# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See LICENSE in the project root.

"""Starts the fake gateway: python -m jumpcode_paystudio.engine --studio <folder> --port 4570.
stdin line 1 is the control token and line 2 the settings (webhook addresses and test secrets, never on the
command line). When stdin closes (the tool's process ended), the gateway stops."""

import argparse
import json
import sys
import threading
import time


def main(argv=None):
    began = time.time()
    parser = argparse.ArgumentParser(prog="paystudio-engine")
    parser.add_argument("--studio", required=True)
    parser.add_argument("--port", type=int, default=4570)
    parser.add_argument("--storage", choices=("memory", "persistent"), default="memory")
    parser.add_argument("--spawned", type=float)
    options = parser.parse_args(argv)
    token = sys.stdin.readline().strip()
    try:
        settings = json.loads(sys.stdin.readline() or "{}")
    except ValueError:
        settings = {}

    from .core import Gateway
    from .server import serve
    gw = Gateway(options.studio, options.port, options.storage == "persistent", token, settings)
    try:
        server = serve(gw)
    except OSError as error:
        sys.stdout.write(json.dumps({"ready": False, "error": "port", "message": str(error)}) + "\n")
        sys.stdout.flush()
        return 3
    gw.stop_server = server.shutdown
    gw.ready_ms = round((time.time() - (options.spawned or began)) * 1000)
    gw.status = "running"
    gw.touch("pay", "charges", "webhooks", "calls")
    worker = threading.Thread(target=gw.run_background, name="paystudio-background", daemon=True)
    worker.start()
    sys.stdout.write(json.dumps({"ready": True, "port": options.port, "readyMs": gw.ready_ms}) + "\n")
    sys.stdout.flush()

    def watch_parent():
        try:
            while sys.stdin.readline():
                pass
        except (OSError, ValueError):
            pass
        server.shutdown()

    threading.Thread(target=watch_parent, name="paystudio-parent", daemon=True).start()
    try:
        server.serve_forever(poll_interval=0.25)
    finally:
        gw.stopping.set()
        server.server_close()
        try:
            gw.save()
            gw.final()
        except Exception:  # the Studio files are best effort on the way out
            pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
