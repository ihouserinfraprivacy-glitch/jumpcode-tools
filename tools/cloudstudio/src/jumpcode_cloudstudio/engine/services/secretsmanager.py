# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See LICENSE in the project root.

"""AWS Secrets Manager (JSON 1.1): secrets with versions and stages. Values never reach the call history,
the Studio files or the agent; only their size is shown."""

import base64
import secrets as random
import string
import time
import uuid

from .. import wire
from ..wire import AwsError
from .common import json_service

NAME = "secretsmanager"
LABEL = "Secrets Manager"
HIDDEN = "••••••"


def handle(cloud, request):
    return json_service(cloud, request, "", "1.1", OPS, redact)


def redact(op, value, direction):
    if not isinstance(value, dict):
        return value
    result = dict(value)
    for key in ("SecretString", "SecretBinary"):
        if key in result:
            result[key] = HIDDEN
    if "SecretValues" in result:
        result["SecretValues"] = [{**v, "SecretString": HIDDEN} if "SecretString" in v else v for v in result["SecretValues"]]
    return result


def secrets(cloud, account, region):
    return cloud.store.regional(account, region, NAME).setdefault("secrets", {})


def secret_of(cloud, caller, secret_id, allow_deleted=False):
    secret_id = secret_id or ""
    found = None
    for secret in secrets(cloud, caller.account, caller.region).values():
        if secret_id in (secret["name"], secret["arn"]) or (secret_id.startswith("arn:") and secret["arn"].startswith(secret_id)):
            found = secret
            break
    if found is None:
        caller.target = secret_id.split(":secret:")[-1]
        raise AwsError("ResourceNotFoundException", "Secrets Manager can't find the specified secret.")
    caller.target = found["name"]
    if found.get("deleted") and not allow_deleted:
        raise AwsError("InvalidRequestException", "You can't perform this operation on the secret because it was marked for deletion.")
    return found


def _value(params):
    if params.get("SecretString") is not None:
        return {"string": params["SecretString"]}
    if params.get("SecretBinary") is not None:
        return {"binary": params["SecretBinary"] if isinstance(params["SecretBinary"], str) else base64.b64encode(params["SecretBinary"]).decode()}
    return None


def _add_version(secret, value, token=None, stages=None):
    version = token or str(uuid.uuid4())
    for other in secret["versions"].values():
        if "AWSCURRENT" in other["stages"]:
            other["stages"] = ["AWSPREVIOUS"]
        elif "AWSPREVIOUS" in other["stages"]:
            other["stages"] = []
    secret["versions"] = {k: v for k, v in secret["versions"].items() if v["stages"]}
    secret["versions"][version] = {"value": value, "created": time.time(), "stages": stages or ["AWSCURRENT"]}
    secret["changed"] = time.time()
    return version


def create_secret(cloud, caller, params):
    name = params.get("Name") or ""
    caller.target = name
    existing = secrets(cloud, caller.account, caller.region)
    if name in existing:
        if existing[name].get("deleted"):
            raise AwsError("InvalidRequestException", f"You can't create this secret because a secret with this name is already scheduled for deletion.")
        raise AwsError("ResourceExistsException", f"The operation failed because the secret {name} already exists.")
    suffix = "".join(random.choice(string.ascii_letters + string.digits) for _ in range(6))
    secret = {"name": name, "arn": wire.arn("secretsmanager", caller.region, caller.account, f"secret:{name}-{suffix}"), "account": caller.account,
              "region": caller.region, "description": params.get("Description", ""), "created": time.time(), "changed": time.time(),
              "accessed": None, "tags": params.get("Tags") or [], "versions": {}, "deleted": None, "source": params.get("_source")}
    value = _value(params)
    version = _add_version(secret, value, params.get("ClientRequestToken")) if value is not None else None
    existing[name] = secret
    cloud.store.touch()
    result = {"ARN": secret["arn"], "Name": name}
    if version:
        result["VersionId"] = version
    return result


def _current(secret, params):
    wanted_version = params.get("VersionId")
    stage = params.get("VersionStage") or "AWSCURRENT"
    for version_id, version in secret["versions"].items():
        if (wanted_version and version_id == wanted_version) or (not wanted_version and stage in version["stages"]):
            return version_id, version
    raise AwsError("ResourceNotFoundException", f"Secrets Manager can't find the specified secret value for staging label: {stage}")


def get_secret_value(cloud, caller, params):
    secret = secret_of(cloud, caller, params.get("SecretId"))
    version_id, version = _current(secret, params)
    secret["accessed"] = time.time()
    result = {"ARN": secret["arn"], "Name": secret["name"], "VersionId": version_id, "VersionStages": version["stages"], "CreatedDate": version["created"]}
    value = version["value"] or {}
    if "string" in value:
        result["SecretString"] = value["string"]
    else:
        result["SecretBinary"] = value.get("binary", "")
    return result


def batch_get_secret_value(cloud, caller, params):
    values, errors = [], []
    for secret_id in params.get("SecretIdList") or []:
        try:
            values.append(get_secret_value(cloud, caller, {"SecretId": secret_id}))
        except AwsError as error:
            errors.append({"SecretId": secret_id, "ErrorCode": error.code, "Message": error.message})
    return {"SecretValues": values, "Errors": errors}


def put_secret_value(cloud, caller, params):
    secret = secret_of(cloud, caller, params.get("SecretId"))
    value = _value(params)
    if value is None:
        raise AwsError("InvalidRequestException", "You must provide either SecretString or SecretBinary.")
    version = _add_version(secret, value, params.get("ClientRequestToken"), params.get("VersionStages"))
    cloud.store.touch()
    return {"ARN": secret["arn"], "Name": secret["name"], "VersionId": version, "VersionStages": secret["versions"][version]["stages"]}


def update_secret(cloud, caller, params):
    secret = secret_of(cloud, caller, params.get("SecretId"))
    if params.get("Description") is not None:
        secret["description"] = params["Description"]
    value = _value(params)
    result = {"ARN": secret["arn"], "Name": secret["name"]}
    if value is not None:
        result["VersionId"] = _add_version(secret, value, params.get("ClientRequestToken"))
    secret["changed"] = time.time()
    cloud.store.touch()
    return result


def _describe(secret):
    result = {"ARN": secret["arn"], "Name": secret["name"], "Description": secret.get("description", ""), "CreatedDate": secret["created"],
              "LastChangedDate": secret["changed"], "Tags": secret.get("tags", []),
              "VersionIdsToStages": {k: v["stages"] for k, v in secret["versions"].items()}}
    if secret.get("accessed"):
        result["LastAccessedDate"] = int(secret["accessed"] // 86400 * 86400)
    if secret.get("deleted"):
        result["DeletedDate"] = secret["deleted"]
    return result


def describe_secret(cloud, caller, params):
    return _describe(secret_of(cloud, caller, params.get("SecretId"), allow_deleted=True))


def list_secrets(cloud, caller, params):
    found = [_describe(s) for s in sorted(secrets(cloud, caller.account, caller.region).values(), key=lambda s: s["name"])
             if not s.get("deleted") or params.get("IncludePlannedDeletion")]
    for rule in params.get("Filters") or []:
        values = rule.get("Values") or []
        if rule.get("Key") == "name":
            found = [s for s in found if any(s["Name"].startswith(v) for v in values)]
    return {"SecretList": found}


def delete_secret(cloud, caller, params):
    secret = secret_of(cloud, caller, params.get("SecretId"), allow_deleted=True)
    when = time.time()
    if params.get("ForceDeleteWithoutRecovery"):
        del secrets(cloud, caller.account, caller.region)[secret["name"]]
    else:
        when += int(params.get("RecoveryWindowInDays") or 30) * 86400
        secret["deleted"] = when
    cloud.store.touch()
    return {"ARN": secret["arn"], "Name": secret["name"], "DeletionDate": when}


def restore_secret(cloud, caller, params):
    secret = secret_of(cloud, caller, params.get("SecretId"), allow_deleted=True)
    secret["deleted"] = None
    cloud.store.touch()
    return {"ARN": secret["arn"], "Name": secret["name"]}


def tag_resource(cloud, caller, params):
    secret = secret_of(cloud, caller, params.get("SecretId"))
    tags = {t["Key"]: t["Value"] for t in secret.get("tags", [])}
    tags.update({t["Key"]: t["Value"] for t in params.get("Tags") or []})
    secret["tags"] = [{"Key": k, "Value": v} for k, v in tags.items()]
    cloud.store.touch()
    return {}


def untag_resource(cloud, caller, params):
    secret = secret_of(cloud, caller, params.get("SecretId"))
    secret["tags"] = [t for t in secret.get("tags", []) if t["Key"] not in (params.get("TagKeys") or [])]
    cloud.store.touch()
    return {}


def random_password(cloud, caller, params):
    length = int(params.get("PasswordLength") or 32)
    alphabet = ""
    if not params.get("ExcludeLowercase"):
        alphabet += string.ascii_lowercase
    if not params.get("ExcludeUppercase"):
        alphabet += string.ascii_uppercase
    if not params.get("ExcludeNumbers"):
        alphabet += string.digits
    if not params.get("ExcludePunctuation"):
        alphabet += "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~"
    alphabet = "".join(ch for ch in alphabet if ch not in (params.get("ExcludeCharacters") or ""))
    if params.get("IncludeSpace"):
        alphabet += " "
    return {"RandomPassword": "".join(random.choice(alphabet or string.ascii_letters) for _ in range(length))}


OPS = {
    "CreateSecret": create_secret, "GetSecretValue": get_secret_value, "BatchGetSecretValue": batch_get_secret_value,
    "PutSecretValue": put_secret_value, "UpdateSecret": update_secret, "DescribeSecret": describe_secret, "ListSecrets": list_secrets,
    "DeleteSecret": delete_secret, "RestoreSecret": restore_secret, "TagResource": tag_resource, "UntagResource": untag_resource,
    "GetRandomPassword": random_password,
}


def resources(cloud):
    result = []
    for account, region, service in cloud.store.each(NAME):
        for secret in service.get("secrets", {}).values():
            current = next((v for v in secret["versions"].values() if "AWSCURRENT" in v["stages"]), None)
            value = (current or {}).get("value") or {}
            size = len(value.get("string", "")) if "string" in value else len(value.get("binary", "")) * 3 // 4
            keys = None
            if "string" in value:
                try:
                    import json
                    parsed = json.loads(value["string"])
                    keys = sorted(parsed) if isinstance(parsed, dict) else None
                except ValueError:
                    keys = None
            result.append({"service": NAME, "kind": "secret", "name": secret["name"], "arn": secret["arn"], "account": account, "region": region,
                           "created": secret["created"], "changed": secret["changed"], "accessed": secret.get("accessed"),
                           "versions": len(secret["versions"]), "size": size, "empty": current is None or size == 0, "keys": keys,
                           "deleted": secret.get("deleted"), "source": secret.get("source"), "description": secret.get("description", "")})
    return result
