# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See LICENSE in the project root.

"""AWS STS (query protocol): who is calling, and temporary credentials that keep the caller's account."""

import secrets
import string
import time

from .. import wire
from ..wire import AwsError

NAME = "sts"
LABEL = "STS"
NS = "https://sts.amazonaws.com/doc/2011-06-15/"


def handle(cloud, request):
    form = request.form()
    action = form.get("Action", "")
    request.op = action
    try:
        if action == "GetCallerIdentity":
            result = {"Arn": f"arn:aws:iam::{request.account}:root", "UserId": request.access_key or "AKIAIOSFODNN7EXAMPLE", "Account": request.account}
        elif action in ("AssumeRole", "AssumeRoleWithWebIdentity", "AssumeRoleWithSAML"):
            role = form.get("RoleArn", f"arn:aws:iam::{request.account}:role/cloudstudio")
            session = form.get("RoleSessionName", "cloudstudio")
            account = role.split(":")[4] if role.count(":") >= 5 else request.account
            request.target = role.rsplit("/", 1)[-1]
            result = {"Credentials": _credentials(account, int(form.get("DurationSeconds") or 3600)),
                      "AssumedRoleUser": {"AssumedRoleId": f"AROA{_random(16)}:{session}",
                                          "Arn": f"arn:aws:sts::{account}:assumed-role/{role.rsplit('/', 1)[-1]}/{session}"},
                      "PackedPolicySize": 6}
        elif action in ("GetSessionToken", "GetFederationToken"):
            result = {"Credentials": _credentials(request.account, int(form.get("DurationSeconds") or 43200))}
        elif action == "GetAccessKeyInfo":
            result = {"Account": request.account}
        else:
            raise AwsError("InvalidAction", f"CloudStudio does not emulate STS {action or 'this operation'} yet.")
        request.note_res = {k: v for k, v in result.items() if k != "Credentials"}
        return wire.query_response(action, result, NS, request.id)
    except AwsError as error:
        return wire.query_error(error, NS, request.id)


def _random(length):
    return "".join(secrets.choice(string.ascii_uppercase + string.digits) for _ in range(length))


def _credentials(account, duration):
    # A 12-digit access key keeps the caller in the same local account.
    key = account if account != wire.DEFAULT_ACCOUNT else f"ASIA{_random(16)}"
    return {"AccessKeyId": key, "SecretAccessKey": _random(40), "SessionToken": f"FQoGZXIvYXdzE{_random(60)}",
            "Expiration": wire.iso(time.time() + duration, millis=False)}
