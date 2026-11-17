# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See LICENSE in the project root.

"""Amazon S3 (REST-XML): buckets, objects, ranges, copies, multipart uploads, bucket settings and
event notifications to queues, topics and functions. Path-style and virtual-hosted addressing."""

import base64
import hashlib
import re
import time
import uuid
from urllib.parse import quote, unquote
from xml.etree import ElementTree

from .. import wire
from ..wire import AwsError, Response

NAME = "s3"
LABEL = "S3"
NS = "http://s3.amazonaws.com/doc/2006-03-01/"
_BUCKET = re.compile(r"^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$")
_IP = re.compile(r"^\d+\.\d+\.\d+\.\d+$")
OWNER = {"ID": "75aa57f09aa0c8caeab4f8c24e99d10f8e7faeebf76c078efc7c6caea54ba06a", "DisplayName": "cloudstudio"}
STORED_HEADERS = ("cache-control", "content-disposition", "content-language", "expires", "x-amz-storage-class",
                  "x-amz-website-redirect-location", "x-amz-server-side-encryption")
CONFIG_MISSING = {
    "cors": ("NoSuchCORSConfiguration", "The CORS configuration does not exist"),
    "policy": ("NoSuchBucketPolicy", "The bucket policy does not exist"),
    "tagging": ("NoSuchTagSet", "The TagSet does not exist"),
    "lifecycle": ("NoSuchLifecycleConfiguration", "The lifecycle configuration does not exist"),
    "website": ("NoSuchWebsiteConfiguration", "The specified bucket does not have a website configuration"),
    "encryption": ("ServerSideEncryptionConfigurationNotFoundError", "The server side encryption configuration was not found"),
    "publicAccessBlock": ("NoSuchPublicAccessBlockConfiguration", "The public access block configuration was not found"),
    "ownershipControls": ("OwnershipControlsNotFoundError", "The bucket ownership controls were not found"),
    "replication": ("ReplicationConfigurationNotFoundError", "The replication configuration was not found"),
    "object-lock": ("ObjectLockConfigurationNotFoundError", "Object Lock configuration does not exist for this bucket"),
}
CONFIG_DEFAULTS = {
    "versioning": '<VersioningConfiguration xmlns="%s"/>' % NS,
    "accelerate": '<AccelerateConfiguration xmlns="%s"/>' % NS,
    "requestPayment": '<RequestPaymentConfiguration xmlns="%s"><Payer>BucketOwner</Payer></RequestPaymentConfiguration>' % NS,
    "logging": '<BucketLoggingStatus xmlns="%s"/>' % NS,
    "notification": '<NotificationConfiguration xmlns="%s"/>' % NS,
}
SUBRESOURCES = set(CONFIG_MISSING) | set(CONFIG_DEFAULTS) | {"acl", "location", "uploads", "delete", "versions", "analytics",
                                                              "metrics", "inventory", "intelligent-tiering", "policyStatus"}


def error(code, message, status, **extra):
    return AwsError(code, message, status, extra=extra)


def respond_error(err, request):
    body = {"Code": err.code, "Message": err.message, **{k: v for k, v in err.extra.items()}, "RequestId": request.id}
    if request.method == "HEAD":
        return Response(err.status, b"", {"x-amz-request-id": request.id})
    return wire.xml_response("Error", body, None, err.status, {"x-amz-request-id": request.id})


def buckets(cloud, account):
    return cloud.store.global_(account, NAME).setdefault("buckets", {})


def bucket_of(cloud, account, name):
    bucket = buckets(cloud, account).get(name)
    if bucket is None:
        raise error("NoSuchBucket", "The specified bucket does not exist", 404, BucketName=name)
    return bucket


# ---------------------------------------------------------------- addressing

def address(request):
    """(bucket, key) from a virtual-hosted name (bucket.localhost) or the path."""
    host = request.host.split(":")[0].lower()
    path = request.path
    bucket = None
    if host and not _IP.match(host) and host not in ("localhost",):
        for suffix in (".s3.localhost.localstack.cloud", ".s3.localhost", ".localhost.localstack.cloud", ".localhost"):
            if host.endswith(suffix) and host != suffix.lstrip("."):
                bucket = host[: -len(suffix)]
                break
        if bucket is None:
            match = re.match(r"^(?P<bucket>.+)\.s3[.-]", host)
            if match:
                bucket = match.group("bucket")
    if bucket:
        return bucket, path[1:] if path.startswith("/") else path
    parts = path.lstrip("/").split("/", 1)
    return (parts[0] or None), (parts[1] if len(parts) > 1 else "")


def decoded_body(request):
    """The payload of an upload, without the aws-chunked framing SDKs use for streaming and trailing checksums."""
    body = request.body
    encoding = request.headers.get("content-encoding", "")
    signed = request.headers.get("x-amz-content-sha256", "")
    trailers = {}
    if "aws-chunked" in encoding or signed.startswith("STREAMING-"):
        data = bytearray()
        position = 0
        while position < len(body):
            end = body.find(b"\r\n", position)
            if end < 0:
                break
            size = int(body[position:end].split(b";")[0].strip() or b"0", 16)
            position = end + 2
            if size == 0:
                for line in body[position:].split(b"\r\n"):
                    if b":" in line:
                        name, value = line.split(b":", 1)
                        trailers[name.decode().strip().lower()] = value.decode().strip()
                break
            data += body[position:position + size]
            position += size + 2
        body = bytes(data)
    return body, trailers


# ---------------------------------------------------------------- dispatch

def handle(cloud, request):
    try:
        bucket, key = address(request)
        request.target = f"{bucket}/{key}" if bucket and key else (bucket or "")
        if request.method == "OPTIONS":
            return Response(200, b"")
        if not bucket:
            if request.method == "GET":
                return list_buckets(cloud, request)
            raise error("MethodNotAllowed", "The specified method is not allowed against this resource.", 405)
        if not key:
            return bucket_call(cloud, request, bucket)
        return object_call(cloud, request, bucket, key)
    except AwsError as err:
        return respond_error(err, request)


def list_buckets(cloud, request):
    request.op = "ListBuckets"
    entries = [{"Name": b["name"], "CreationDate": wire.iso(b["created"]), "BucketRegion": b["region"]}
               for b in sorted(buckets(cloud, request.account).values(), key=lambda b: b["name"])]
    request.note_res = {"buckets": [b["Name"] for b in entries]}
    return wire.xml_response("ListAllMyBucketsResult", {"Owner": OWNER, "Buckets": {"Bucket": entries}}, NS)


def bucket_call(cloud, request, name):
    method, query = request.method, request.query
    sub = next((s for s in SUBRESOURCES if s in query), None)
    if method == "PUT" and sub is None:
        return create_bucket(cloud, request, name)
    if method == "HEAD":
        request.op = "HeadBucket"
        bucket = bucket_of(cloud, request.account, name)
        return Response(200, b"", {"x-amz-bucket-region": bucket["region"]})
    if method == "DELETE" and sub is None:
        return delete_bucket(cloud, request, name)
    if method == "GET" and sub is None:
        return list_objects(cloud, request, name)
    if sub == "location":
        request.op = "GetBucketLocation"
        bucket = bucket_of(cloud, request.account, name)
        region = "" if bucket["region"] == "us-east-1" else bucket["region"]
        return wire.xml_response("LocationConstraint", region, NS)
    if sub == "delete" and method == "POST":
        return delete_objects(cloud, request, name)
    if sub == "uploads" and method == "GET":
        return list_uploads(cloud, request, name)
    if sub == "versions" and method == "GET":
        return list_objects(cloud, request, name, versions=True)
    if sub == "acl":
        request.op = "GetBucketAcl" if method == "GET" else "PutBucketAcl"
        bucket_of(cloud, request.account, name)
        return Response(200, b"") if method == "PUT" else acl_response()
    return bucket_config(cloud, request, name, sub, method)


def create_bucket(cloud, request, name):
    request.op = "CreateBucket"
    if not _BUCKET.match(name) or ".." in name or _IP.match(name):
        raise error("InvalidBucketName", "The specified bucket is not valid.", 400, BucketName=name)
    region = request.region
    if request.body.strip():
        try:
            root = ElementTree.fromstring(request.body)
            constraint = next((el.text for el in root.iter() if el.tag.endswith("LocationConstraint")), None)
            region = constraint or region
        except ElementTree.ParseError as parse:
            raise error("MalformedXML", "The XML you provided was not well-formed or did not validate against our published schema", 400) from parse
    existing = buckets(cloud, request.account)
    if name in existing:
        if region == "us-east-1":
            return Response(200, b"", {"Location": f"/{name}"})
        raise error("BucketAlreadyOwnedByYou", "Your previous request to create the named bucket succeeded and you already own it.", 409, BucketName=name)
    existing[name] = {"name": name, "region": region, "created": time.time(), "objects": {}, "uploads": {}, "config": {}, "notifications": []}
    cloud.store.touch()
    return Response(200, b"", {"Location": f"/{name}"})


def delete_bucket(cloud, request, name):
    request.op = "DeleteBucket"
    bucket = bucket_of(cloud, request.account, name)
    if bucket["objects"]:
        raise error("BucketNotEmpty", "The bucket you tried to delete is not empty", 409, BucketName=name)
    del buckets(cloud, request.account)[name]
    cloud.store.touch()
    return Response(204, b"")


def acl_response():
    body ='<?xml version="1.0" encoding="UTF-8"?>' + (
        f'<AccessControlPolicy xmlns="{NS}"><Owner><ID>{OWNER["ID"]}</ID><DisplayName>{OWNER["DisplayName"]}</DisplayName></Owner>'
        f'<AccessControlList><Grant><Grantee xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="CanonicalUser">'
        f'<ID>{OWNER["ID"]}</ID><DisplayName>{OWNER["DisplayName"]}</DisplayName></Grantee><Permission>FULL_CONTROL</Permission></Grant>'
        f'</AccessControlList></AccessControlPolicy>')
    return Response(200, body, {"Content-Type": "application/xml"})


def bucket_config(cloud, request, name, sub, method):
    bucket = bucket_of(cloud, request.account, name)
    title = sub[:1].upper() + sub[1:]
    request.op = {"GET": "GetBucket", "PUT": "PutBucket", "DELETE": "DeleteBucket"}.get(method, method) + title
    if sub is None:
        raise error("NotImplemented", "A header you provided implies functionality that is not implemented", 501)
    if method == "PUT":
        text = request.body.decode("utf-8", "replace")
        bucket["config"][sub] = text
        if sub == "notification":
            bucket["notifications"] = parse_notifications(text)
        cloud.store.touch()
        return Response(204 if sub in ("policy",) else 200, b"")
    if method == "DELETE":
        bucket["config"].pop(sub, None)
        if sub == "notification":
            bucket["notifications"] = []
        cloud.store.touch()
        return Response(204, b"")
    if sub in bucket["config"]:
        text = bucket["config"][sub]
        return Response(200, text, {"Content-Type": "application/json" if sub == "policy" else "application/xml"})
    if sub in CONFIG_DEFAULTS:
        return Response(200, CONFIG_DEFAULTS[sub], {"Content-Type": "application/xml"})
    if sub == "policyStatus":
        return wire.xml_response("PolicyStatus", {"IsPublic": False}, NS)
    if sub in CONFIG_MISSING:
        code, message = CONFIG_MISSING[sub]
        raise error(code, message, 404, BucketName=name)
    raise error("NotImplemented", f"CloudStudio does not emulate the S3 {sub} setting yet", 501)


def parse_notifications(text):
    """Queue, topic and function targets of a NotificationConfiguration."""
    result = []
    try:
        root = ElementTree.fromstring(text)
    except ElementTree.ParseError:
        return result
    for element in root:
        tag = element.tag.split("}")[-1]
        kind = {"QueueConfiguration": "sqs", "TopicConfiguration": "sns", "CloudFunctionConfiguration": "lambda",
                "LambdaFunctionConfiguration": "lambda"}.get(tag)
        if not kind:
            continue
        fields = {child.tag.split("}")[-1]: child for child in element}
        target = next((fields[name].text for name in ("Queue", "Topic", "CloudFunction", "Function") if name in fields), None)
        events = [child.text for child in element if child.tag.split("}")[-1] == "Event"]
        rules = []
        for rule in element.iter():
            if rule.tag.split("}")[-1] == "FilterRule":
                values = {child.tag.split("}")[-1]: child.text for child in rule}
                rules.append(((values.get("Name") or "").lower(), values.get("Value") or ""))
        identity = fields["Id"].text if "Id" in fields else uuid.uuid4().hex[:12]
        if target:
            result.append({"id": identity, "kind": kind, "target": target, "events": events, "rules": rules})
    return result


# ---------------------------------------------------------------- listing

def list_objects(cloud, request, name, versions=False):
    bucket = bucket_of(cloud, request.account, name)
    query = request.query
    v2 = query.get("list-type") == "2"
    request.op = "ListObjectVersions" if versions else ("ListObjectsV2" if v2 else "ListObjects")
    prefix = query.get("prefix", "")
    delimiter = query.get("delimiter", "")
    max_keys = min(int(query.get("max-keys") or 1000), 1000)
    url = query.get("encoding-type") == "url"
    enc = (lambda value: quote(value, safe="/")) if url else (lambda value: value)
    start = query.get("continuation-token") or query.get("start-after") or query.get("marker") or query.get("key-marker") or ""
    if query.get("continuation-token"):
        try:
            start = base64.urlsafe_b64decode(start.encode()).decode()
        except ValueError:
            raise error("InvalidArgument", "The continuation token provided is incorrect", 400)
    keys = sorted(k for k in bucket["objects"] if k.startswith(prefix) and k > start)
    contents, prefixes = [], []
    truncated = False
    last = None
    for key in keys:
        if len(contents) + len(prefixes) >= max_keys:
            truncated = True
            break
        if delimiter:
            rest = key[len(prefix):]
            cut = rest.find(delimiter)
            if cut >= 0:
                common = prefix + rest[:cut + len(delimiter)]
                if common not in prefixes:
                    if last is not None and last.startswith(common):
                        continue
                    prefixes.append(common)
                last = common
                continue
        obj = bucket["objects"][key]
        entry = {"Key": enc(key), "LastModified": wire.iso(obj["modified"]), "ETag": f'"{obj["etag"]}"', "Size": obj["size"],
                 "StorageClass": obj.get("headers", {}).get("x-amz-storage-class", "STANDARD")}
        if versions:
            entry.update({"VersionId": "null", "IsLatest": True})
        if not v2 or query.get("fetch-owner") == "true":
            entry["Owner"] = OWNER
        contents.append(entry)
        last = key
    result = {"Name": name, "Prefix": enc(prefix)}
    if versions:
        result.update({"KeyMarker": query.get("key-marker", ""), "MaxKeys": max_keys, "IsTruncated": truncated})
        result["Version"] = contents
        if delimiter:
            result["Delimiter"] = enc(delimiter)
        result["CommonPrefixes"] = [{"Prefix": enc(p)} for p in prefixes]
        return wire.xml_response("ListVersionsResult", result, NS)
    if v2:
        result["KeyCount"] = len(contents) + len(prefixes)
        if query.get("continuation-token"):
            result["ContinuationToken"] = query["continuation-token"]
        if query.get("start-after"):
            result["StartAfter"] = enc(query["start-after"])
    else:
        result["Marker"] = enc(query.get("marker", ""))
    result["MaxKeys"] = max_keys
    if delimiter:
        result["Delimiter"] = enc(delimiter)
    if url:
        result["EncodingType"] = "url"
    result["IsTruncated"] = truncated
    if truncated and last is not None:
        if v2:
            result["NextContinuationToken"] = base64.urlsafe_b64encode(last.encode()).decode()
        elif delimiter:
            result["NextMarker"] = enc(last)
    result["Contents"] = contents
    result["CommonPrefixes"] = [{"Prefix": enc(p)} for p in prefixes]
    request.note_res = {"keys": len(contents), "prefixes": len(prefixes)}
    return wire.xml_response("ListBucketResult", result, NS)


def list_uploads(cloud, request, name):
    request.op = "ListMultipartUploads"
    bucket = bucket_of(cloud, request.account, name)
    uploads = [{"Key": u["key"], "UploadId": upload_id, "Initiated": wire.iso(u["created"]), "StorageClass": "STANDARD",
                "Owner": OWNER, "Initiator": OWNER} for upload_id, u in bucket["uploads"].items()]
    return wire.xml_response("ListMultipartUploadsResult", {"Bucket": name, "KeyMarker": "", "UploadIdMarker": "", "MaxUploads": 1000,
                                                            "IsTruncated": False, "Upload": uploads}, NS)


# ---------------------------------------------------------------- objects

def object_call(cloud, request, name, key):
    method, query = request.method, request.query
    if "uploads" in query and method == "POST":
        return create_upload(cloud, request, name, key)
    if "uploadId" in query:
        if method == "PUT":
            return upload_part(cloud, request, name, key)
        if method == "POST":
            return complete_upload(cloud, request, name, key)
        if method == "DELETE":
            return abort_upload(cloud, request, name, key)
        if method == "GET":
            return list_parts(cloud, request, name, key)
    if "tagging" in query:
        return object_tagging(cloud, request, name, key)
    if "acl" in query:
        request.op = "GetObjectAcl" if method == "GET" else "PutObjectAcl"
        find(cloud, request, name, key)
        return Response(200, b"") if method == "PUT" else acl_response()
    if method == "PUT":
        if "x-amz-copy-source" in request.headers:
            return copy_object(cloud, request, name, key)
        return put_object(cloud, request, name, key)
    if method in ("GET", "HEAD"):
        return get_object(cloud, request, name, key, head=method == "HEAD")
    if method == "DELETE":
        return delete_object(cloud, request, name, key)
    if method == "POST" and "select" in query:
        raise error("NotImplemented", "CloudStudio does not run S3 Select queries", 501)
    raise error("MethodNotAllowed", "The specified method is not allowed against this resource.", 405)


def find(cloud, request, name, key):
    bucket = bucket_of(cloud, request.account, name)
    obj = bucket["objects"].get(key)
    if obj is None:
        raise error("NoSuchKey", "The specified key does not exist.", 404, Key=key)
    return bucket, obj


def _meta(request):
    return {k[len("x-amz-meta-"):]: v for k, v in request.headers.items() if k.startswith("x-amz-meta-")}


def _kept_headers(request):
    headers = {k: v for k, v in request.headers.items() if k in STORED_HEADERS}
    encoding = ",".join(part.strip() for part in request.headers.get("content-encoding", "").split(",") if part.strip() and part.strip() != "aws-chunked")
    if encoding:
        headers["content-encoding"] = encoding
    return headers


def _checksums(request, trailers):
    found = {}
    for source in (request.headers, trailers):
        for name, value in source.items():
            if name.startswith("x-amz-checksum-") and name != "x-amz-checksum-type" and name != "x-amz-checksum-algorithm":
                found[name] = value
    return found


def store_object(cloud, account, bucket, key, data, content_type, meta=None, headers=None, checksums=None, source="app", event="Put"):
    digest = cloud.store.put_blob(data)
    obj = {"key": key, "blob": digest, "size": len(data), "etag": wire.md5_hex(data), "modified": time.time(),
           "type": content_type or "binary/octet-stream", "meta": meta or {}, "headers": headers or {}, "checksums": checksums or {}, "tags": {}}
    with cloud.store.lock:
        bucket["objects"][key] = obj
    cloud.store.touch()
    notify(cloud, account, bucket, key, obj, f"ObjectCreated:{event}")
    return obj


def put_object(cloud, request, name, key):
    request.op = "PutObject"
    bucket = bucket_of(cloud, request.account, name)
    data, trailers = decoded_body(request)
    supplied = request.headers.get("content-md5")
    if supplied and base64.b64encode(hashlib.md5(data, usedforsecurity=False).digest()).decode() != supplied:
        raise error("BadDigest", "The Content-MD5 you specified did not match what we received.", 400)
    obj = store_object(cloud, request.account, bucket, key, data, request.headers.get("content-type"), _meta(request),
                       _kept_headers(request), _checksums(request, trailers))
    tags = request.headers.get("x-amz-tagging")
    if tags:
        obj["tags"] = dict(pair.split("=", 1) if "=" in pair else (pair, "") for pair in tags.split("&") if pair)
    request.note_req = {"key": key, "bytes": len(data), "type": obj["type"]}
    return Response(200, b"", {"ETag": f'"{obj["etag"]}"', **obj["checksums"]})


def get_object(cloud, request, name, key, head=False):
    request.op = "HeadObject" if head else "GetObject"
    _, obj = find(cloud, request, name, key)
    etag = f'"{obj["etag"]}"'
    match = request.headers.get("if-match")
    if match and match.strip() not in (etag, "*", obj["etag"]):
        raise error("PreconditionFailed", "At least one of the pre-conditions you specified did not hold", 412, Condition="If-Match")
    none_match = request.headers.get("if-none-match")
    if none_match and none_match.strip() in (etag, "*", obj["etag"]):
        return Response(304, b"", {"ETag": etag})
    headers = {"Content-Type": obj["type"], "ETag": etag, "Last-Modified": wire.http_date(obj["modified"]), "Accept-Ranges": "bytes"}
    headers.update({f"x-amz-meta-{k}": v for k, v in obj.get("meta", {}).items()})
    for header, value in obj.get("headers", {}).items():
        headers[header] = value
    if obj.get("tags"):
        headers["x-amz-tagging-count"] = str(len(obj["tags"]))
    for header in ("content-type", "content-language", "expires", "cache-control", "content-disposition", "content-encoding"):
        override = request.query.get(f"response-{header}")
        if override:
            headers["Content-Type" if header == "content-type" else header] = override
    data = b"" if head and "range" not in request.headers else cloud.store.get_blob(obj["blob"])
    status = 200
    ranged = request.headers.get("range", "")
    if ranged.startswith("bytes="):
        size = obj["size"]
        first, _, last = ranged[6:].split(",")[0].partition("-")
        try:
            if first == "":
                start, end = max(0, size - int(last)), size - 1
            else:
                start, end = int(first), (int(last) if last else size - 1)
        except ValueError:
            start, end = 0, size - 1
        end = min(end, size - 1)
        if start >= size or start > end:
            raise error("InvalidRange", "The requested range is not satisfiable", 416, RangeRequested=ranged, ActualObjectSize=size)
        data = cloud.store.get_blob(obj["blob"])[start:end + 1]
        headers["Content-Range"] = f"bytes {start}-{end}/{size}"
        status = 206
    if head:
        headers["Content-Length"] = str(len(data) if status == 206 else obj["size"])
        return Response(status, b"", headers)
    request.note_res = {"bytes": len(data), "type": obj["type"]}
    return Response(status, data, headers)


def delete_object(cloud, request, name, key):
    request.op = "DeleteObject"
    bucket = bucket_of(cloud, request.account, name)
    with cloud.store.lock:
        obj = bucket["objects"].pop(key, None)
    if obj is not None:
        cloud.store.touch()
        notify(cloud, request.account, bucket, key, obj, "ObjectRemoved:Delete")
    return Response(204, b"")


def delete_objects(cloud, request, name):
    request.op = "DeleteObjects"
    bucket = bucket_of(cloud, request.account, name)
    try:
        root = ElementTree.fromstring(request.body)
    except ElementTree.ParseError as parse:
        raise error("MalformedXML", "The XML you provided was not well-formed or did not validate against our published schema", 400) from parse
    quiet = any(el.tag.endswith("Quiet") and (el.text or "").lower() == "true" for el in root)
    deleted = []
    for element in root:
        if element.tag.endswith("Object"):
            key = next((child.text for child in element if child.tag.endswith("Key")), None)
            if key is None:
                continue
            with cloud.store.lock:
                obj = bucket["objects"].pop(key, None)
            if obj is not None:
                notify(cloud, request.account, bucket, key, obj, "ObjectRemoved:Delete")
            deleted.append({"Key": key})
    cloud.store.touch()
    request.note_req = {"keys": [d["Key"] for d in deleted][:50]}
    return wire.xml_response("DeleteResult", {"Deleted": [] if quiet else deleted}, NS)


def copy_object(cloud, request, name, key):
    request.op = "CopyObject"
    source = unquote(request.headers["x-amz-copy-source"]).split("?")[0].lstrip("/")
    source_bucket, _, source_key = source.partition("/")
    _, original = find(cloud, request, source_bucket, source_key)
    bucket = bucket_of(cloud, request.account, name)
    replace = request.headers.get("x-amz-metadata-directive", "COPY").upper() == "REPLACE"
    data = cloud.store.get_blob(original["blob"])
    obj = store_object(cloud, request.account, bucket, key, data,
                       request.headers.get("content-type") if replace else original["type"],
                       _meta(request) if replace else dict(original.get("meta", {})),
                       _kept_headers(request) if replace else dict(original.get("headers", {})), event="Copy")
    return wire.xml_response("CopyObjectResult", {"LastModified": wire.iso(obj["modified"]), "ETag": f'"{obj["etag"]}"'}, NS)


def object_tagging(cloud, request, name, key):
    _, obj = find(cloud, request, name, key)
    if request.method == "GET":
        request.op = "GetObjectTagging"
        tags = [{"Key": k, "Value": v} for k, v in obj.get("tags", {}).items()]
        return wire.xml_response("Tagging", {"TagSet": {"Tag": tags}}, NS)
    if request.method == "DELETE":
        request.op = "DeleteObjectTagging"
        obj["tags"] = {}
        cloud.store.touch()
        return Response(204, b"")
    request.op = "PutObjectTagging"
    root = ElementTree.fromstring(request.body)
    tags = {}
    for tag in root.iter():
        if tag.tag.endswith("Tag") and not tag.tag.endswith("TagSet"):
            values = {child.tag.split("}")[-1]: child.text or "" for child in tag}
            tags[values.get("Key", "")] = values.get("Value", "")
    obj["tags"] = tags
    cloud.store.touch()
    return Response(200, b"")


# ---------------------------------------------------------------- multipart

def create_upload(cloud, request, name, key):
    request.op = "CreateMultipartUpload"
    bucket = bucket_of(cloud, request.account, name)
    upload_id = uuid.uuid4().hex
    bucket["uploads"][upload_id] = {"key": key, "created": time.time(), "type": request.headers.get("content-type"),
                                    "meta": _meta(request), "headers": _kept_headers(request), "parts": {}}
    cloud.store.touch()
    return wire.xml_response("InitiateMultipartUploadResult", {"Bucket": name, "Key": key, "UploadId": upload_id}, NS)


def _upload(cloud, request, name, key):
    bucket = bucket_of(cloud, request.account, name)
    upload = bucket["uploads"].get(request.query.get("uploadId", ""))
    if upload is None or upload["key"] != key:
        raise error("NoSuchUpload", "The specified upload does not exist. The upload ID may be invalid, or the upload may have been aborted or completed.",
                    404, UploadId=request.query.get("uploadId", ""))
    return bucket, upload


def upload_part(cloud, request, name, key):
    request.op = "UploadPart"
    _, upload = _upload(cloud, request, name, key)
    number = int(request.query.get("partNumber") or 0)
    if not 1 <= number <= 10000:
        raise error("InvalidArgument", "Part number must be an integer between 1 and 10000, inclusive", 400)
    if "x-amz-copy-source" in request.headers:
        source = unquote(request.headers["x-amz-copy-source"]).split("?")[0].lstrip("/")
        source_bucket, _, source_key = source.partition("/")
        _, original = find(cloud, request, source_bucket, source_key)
        data = cloud.store.get_blob(original["blob"])
        ranged = request.headers.get("x-amz-copy-source-range", "")
        if ranged.startswith("bytes="):
            first, _, last = ranged[6:].partition("-")
            data = data[int(first):int(last) + 1]
    else:
        data, _ = decoded_body(request)
    digest = cloud.store.put_blob(data)
    etag = wire.md5_hex(data)
    upload["parts"][str(number)] = {"blob": digest, "etag": etag, "size": len(data), "at": time.time()}
    cloud.store.touch()
    if "x-amz-copy-source" in request.headers:
        return wire.xml_response("CopyPartResult", {"LastModified": wire.iso(), "ETag": f'"{etag}"'}, NS)
    return Response(200, b"", {"ETag": f'"{etag}"'})


def complete_upload(cloud, request, name, key):
    request.op = "CompleteMultipartUpload"
    bucket, upload = _upload(cloud, request, name, key)
    try:
        root = ElementTree.fromstring(request.body)
    except ElementTree.ParseError as parse:
        raise error("MalformedXML", "The XML you provided was not well-formed or did not validate against our published schema", 400) from parse
    chosen = []
    for part in root:
        if not part.tag.endswith("Part"):
            continue
        values = {child.tag.split("}")[-1]: (child.text or "") for child in part}
        number = values.get("PartNumber", "")
        stored = upload["parts"].get(number)
        if stored is None or values.get("ETag", "").strip('"') != stored["etag"]:
            raise error("InvalidPart", "One or more of the specified parts could not be found. The part may not have been uploaded, or the specified entity tag may not match the part's entity tag.", 400)
        chosen.append((int(number), stored))
    if [n for n, _ in chosen] != sorted(n for n, _ in chosen):
        raise error("InvalidPartOrder", "The list of parts was not in ascending order. Parts must be ordered by part number.", 400)
    data = b"".join(cloud.store.get_blob(stored["blob"]) for _, stored in chosen)
    obj = store_object(cloud, request.account, bucket, key, data, upload.get("type"), upload.get("meta"), upload.get("headers"),
                       event="CompleteMultipartUpload")
    combined = hashlib.md5(b"".join(bytes.fromhex(stored["etag"]) for _, stored in chosen), usedforsecurity=False).hexdigest()
    obj["etag"] = f"{combined}-{len(chosen)}"
    del bucket["uploads"][request.query["uploadId"]]
    cloud.store.touch()
    return wire.xml_response("CompleteMultipartUploadResult", {"Location": f"{cloud.endpoint}/{name}/{quote(key)}", "Bucket": name,
                                                                "Key": key, "ETag": f'"{obj["etag"]}"'}, NS)


def abort_upload(cloud, request, name, key):
    request.op = "AbortMultipartUpload"
    bucket, _ = _upload(cloud, request, name, key)
    del bucket["uploads"][request.query["uploadId"]]
    cloud.store.touch()
    return Response(204, b"")


def list_parts(cloud, request, name, key):
    request.op = "ListParts"
    _, upload = _upload(cloud, request, name, key)
    parts = [{"PartNumber": int(n), "LastModified": wire.iso(p["at"]), "ETag": f'"{p["etag"]}"', "Size": p["size"]}
             for n, p in sorted(upload["parts"].items(), key=lambda kv: int(kv[0]))]
    return wire.xml_response("ListPartsResult", {"Bucket": name, "Key": key, "UploadId": request.query["uploadId"],
                                                 "MaxParts": 1000, "IsTruncated": False, "Part": parts}, NS)


# ---------------------------------------------------------------- events

def notify(cloud, account, bucket, key, obj, event):
    """Sends an S3 event to the queues, topics and functions the bucket's notification settings name."""
    targets = [n for n in bucket.get("notifications", []) if _wants(n, event, key)]
    if not targets:
        return
    region = bucket["region"]
    for target in targets:
        record = {
            "eventVersion": "2.1", "eventSource": "aws:s3", "awsRegion": region, "eventTime": wire.iso(), "eventName": event,
            "userIdentity": {"principalId": "AWS:CLOUDSTUDIO"}, "requestParameters": {"sourceIPAddress": "127.0.0.1"},
            "responseElements": {"x-amz-request-id": uuid.uuid4().hex[:16].upper(), "x-amz-id-2": uuid.uuid4().hex},
            "s3": {"s3SchemaVersion": "1.0", "configurationId": target["id"],
                   "bucket": {"name": bucket["name"], "ownerIdentity": {"principalId": "CLOUDSTUDIO"}, "arn": f"arn:aws:s3:::{bucket['name']}"},
                   "object": {"key": quote(key), "size": obj.get("size", 0), "eTag": obj.get("etag", ""), "sequencer": f"{int(time.time() * 1e6):X}"}},
        }
        message = {"Records": [record]}
        source = f"s3:{bucket['name']}"
        if target["kind"] == "sqs":
            from . import sqs
            sqs.deliver_arn(cloud, target["target"], message, source)
        elif target["kind"] == "sns":
            from . import sns
            sns.publish_arn(cloud, target["target"], message, "Amazon S3 Notification", source)
        elif target["kind"] == "lambda":
            cloud.runtime.invoke_arn_async(target["target"], message, source)


def _wants(notification, event, key):
    if not any(event == wanted.replace("s3:", "") or (wanted.endswith("*") and event.startswith(wanted.replace("s3:", "")[:-1]))
               for wanted in notification.get("events", [])):
        return False
    for name, value in notification.get("rules", []):
        if name == "prefix" and not key.startswith(value):
            return False
        if name == "suffix" and not key.endswith(value):
            return False
    return True


# ---------------------------------------------------------------- Studio

TEXT_TYPES = ("text/", "application/json", "application/xml", "application/javascript", "application/x-yaml", "application/csv")
IMAGE_TYPES = ("image/png", "image/jpeg", "image/gif", "image/webp", "image/svg+xml")


def resources(cloud):
    result = []
    for account, _, service in cloud.store.each(NAME, "global"):
        for bucket in service.get("buckets", {}).values():
            objects = sorted(bucket["objects"].values(), key=lambda o: o["modified"], reverse=True)
            listed = []
            previews = 0
            images = 0
            for obj in objects[:300]:
                entry = {"key": obj["key"], "size": obj["size"], "type": obj["type"], "modified": obj["modified"], "etag": obj["etag"],
                         "meta": obj.get("meta", {})}
                kind = obj["type"].split(";")[0].strip().lower()
                if previews < 30 and obj["size"] <= 4096 and (kind.startswith(TEXT_TYPES) or obj["key"].endswith((".json", ".txt", ".csv", ".md", ".html"))):
                    entry["text"] = cloud.store.get_blob(obj["blob"]).decode("utf-8", "replace")
                    previews += 1
                elif images < 8 and obj["size"] <= 96 * 1024 and kind in IMAGE_TYPES:
                    entry["image"] = f"data:{kind};base64," + base64.b64encode(cloud.store.get_blob(obj["blob"])).decode("ascii")
                    images += 1
                listed.append(entry)
            result.append({
                "service": NAME, "kind": "bucket", "name": bucket["name"], "arn": f"arn:aws:s3:::{bucket['name']}", "account": account,
                "region": bucket["region"], "created": bucket["created"], "count": len(objects), "bytes": sum(o["size"] for o in objects),
                "objects": listed, "uploads": len(bucket["uploads"]),
                "notifications": [{"kind": n["kind"], "target": n["target"], "events": n["events"]} for n in bucket.get("notifications", [])],
                "settings": sorted(bucket.get("config", {})),
            })
    return result
