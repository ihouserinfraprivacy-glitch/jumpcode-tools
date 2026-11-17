# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See LICENSE in the project root.

"""Cancellation is scoped to an authenticated control request, never to the gateway."""

from contextlib import contextmanager
from contextvars import ContextVar
import threading

_current = ContextVar("paystudio_operation", default=None)


class Cancelled(ValueError):
    pass


def checkpoint():
    event = _current.get()
    if event is not None and event.is_set():
        raise Cancelled("The operation was cancelled. Changes already completed are kept.")


def wait(seconds):
    event = _current.get()
    (event or threading.Event()).wait(seconds)
    checkpoint()


class Operations:
    def __init__(self):
        self.lock = threading.Lock()
        self.pending = {}

    def open(self, key):
        if not isinstance(key, str) or not 16 <= len(key) <= 128:
            raise ValueError("Invalid operation identifier")
        with self.lock:
            if key in self.pending:
                raise ValueError("Operation already exists")
            self.pending[key] = (threading.Event(), False)

    def cancel(self, key):
        with self.lock:
            if key in self.pending:
                self.pending[key][0].set()

    def close(self, key):
        with self.lock:
            entry = self.pending.get(key)
            if entry and not entry[1]:
                self.pending.pop(key)

    @contextmanager
    def use(self, key):
        if key is None:
            yield
            return
        with self.lock:
            entry = self.pending.get(key)
            if not entry or entry[1]:
                raise ValueError("Operation is missing or already running")
            self.pending[key] = (entry[0], True)
        token = _current.set(entry[0])
        try:
            checkpoint()
            yield
            checkpoint()
        finally:
            _current.reset(token)
            with self.lock:
                self.pending.pop(key, None)
