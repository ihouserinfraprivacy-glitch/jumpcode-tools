# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See LICENSE in the project root.

"""Runs a local cloud inside the test process and gives boto3 clients pointed at it.
boto3 is only needed by the tests (set CLOUDSTUDIO_TEST_SDK to a folder that has it when it is not installed)."""

import os
from pathlib import Path
import socket
import sys
import tempfile
import threading
import time
import unittest

SDK = os.environ.get("CLOUDSTUDIO_TEST_SDK")
if SDK and SDK not in sys.path:
    sys.path.insert(0, SDK)

try:
    import boto3
    from botocore.config import Config
except ImportError:  # the product never needs boto3; only these tests do
    boto3 = None

from jumpcode_cloudstudio.engine.server import Cloud, serve

needs_sdk = unittest.skipIf(boto3 is None, "boto3 is not installed (set CLOUDSTUDIO_TEST_SDK)")


def free_port():
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


class LocalCloud:
    def __init__(self, persistent=False, region="us-east-1", folder=None):
        self.temporary = None if folder else tempfile.TemporaryDirectory(prefix="cloudstudio-test-")
        self.folder = Path(folder or self.temporary.name)
        self.cloud = Cloud(self.folder, free_port(), persistent, "test-token", region)
        self.server = serve(self.cloud)
        self.cloud.stop_server = self.server.shutdown
        self.thread = threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.1}, daemon=True)
        self.cloud.live.start()
        self.cloud.runtime.start()
        self.cloud.live.status = "running"
        self.thread.start()

    @property
    def endpoint(self):
        return self.cloud.endpoint

    def client(self, service, region=None, key="test", token=None):
        return boto3.client(service, endpoint_url=self.endpoint, region_name=region or self.cloud.region, aws_access_key_id=key,
                            aws_secret_access_key="test", aws_session_token=token,
                            config=Config(retries={"max_attempts": 1}, connect_timeout=5, read_timeout=30))

    def close(self):
        self.server.shutdown()
        self.cloud.shutdown()
        self.server.server_close()
        self.cloud.live.final("stopped")
        time.sleep(0.05)
        if self.temporary:
            try:
                self.temporary.cleanup()
            except OSError:
                pass


class CloudTest(unittest.TestCase):
    """One local cloud per test class."""

    @classmethod
    def setUpClass(cls):
        cls.local = LocalCloud()

    @classmethod
    def tearDownClass(cls):
        cls.local.close()

    def client(self, service, **options):
        return self.local.client(service, **options)


def wait_for(check, timeout=10.0, interval=0.05):
    deadline = time.time() + timeout
    while time.time() < deadline:
        value = check()
        if value:
            return value
        time.sleep(interval)
    return check()
