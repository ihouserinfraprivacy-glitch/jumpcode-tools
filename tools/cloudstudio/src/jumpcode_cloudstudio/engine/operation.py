# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See LICENSE in the project root.

"""Cancellation and execution deadlines belong to their operation, never to the cloud."""

from contextlib import contextmanager
from contextvars import ContextVar
import threading
import time

from .wire import AwsError

_current = ContextVar("cloudstudio_operation", default=None)
_deadline = ContextVar("cloudstudio_deadline", default=None)


class Cancelled(AwsError):
    def __init__(self):
        super().__init__("OperationCancelled", "The operation was cancelled. Changes already completed are kept.")


class DeadlineExceeded(Exception):
    """The enclosing execution expired, rather than an individual service call."""


@contextmanager
def deadline(when):
    """Use a monotonic deadline; nested executions cannot extend their parent's budget."""
    parent = _deadline.get()
    token = _deadline.set(min(parent, when) if parent is not None else when)
    try:
        check()
        yield
    finally:
        _deadline.reset(token)


class Operations:
    def __init__(self):
        self.lock = threading.Lock()
        self.pending = {}

    def open(self, key):
        if not isinstance(key, str) or not 16 <= len(key) <= 128:
            raise AwsError("InvalidOperation", "Invalid operation identifier")
        with self.lock:
            if key in self.pending:
                raise AwsError("InvalidOperation", "Operation already exists")
            self.pending[key] = (threading.Event(), False)

    def cancel(self, key):
        with self.lock:
            entry = self.pending.get(key)
            if entry:
                entry[0].set()

    def close(self, key):
        with self.lock:
            entry = self.pending.get(key)
            if entry and not entry[1]:
                self.pending.pop(key)

    @contextmanager
    def use(self, key):
        if not key:
            yield
            return
        with self.lock:
            entry = self.pending.get(key)
            if not entry or entry[1]:
                raise AwsError("InvalidOperation", "Operation is missing or already running")
            self.pending[key] = (entry[0], True)
        token = _current.set(entry[0])
        try:
            check()
            yield
        finally:
            _current.reset(token)
            with self.lock:
                self.pending.pop(key, None)


def check():
    event = _current.get()
    if event is not None and event.is_set():
        raise Cancelled()
    expires = _deadline.get()
    if expires is not None and time.monotonic() >= expires:
        raise DeadlineExceeded()


def wait(seconds, stopping):
    deadline = time.monotonic() + max(0, seconds)
    while True:
        check()
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return stopping.is_set()
        if stopping.wait(min(0.05, remaining)):
            return True
