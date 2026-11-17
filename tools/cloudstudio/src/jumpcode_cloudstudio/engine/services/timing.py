# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See LICENSE in the project root.

"""Schedule expressions (rate, cron and at) and when they fire next, plus delivery to a target ARN."""

from datetime import datetime, timedelta, timezone
import json
import re

from ..wire import AwsError

MONTHS = {name: index for index, name in enumerate(["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"], 1)}
DAYS = {name: index for index, name in enumerate(["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"], 1)}
# Zones without daylight saving time, so the emulator works even where the IANA database is missing (Windows).
FIXED = {"UTC": 0, "Etc/UTC": 0, "GMT": 0, "America/Sao_Paulo": -3, "America/Fortaleza": -3, "America/Recife": -3, "America/Bahia": -3,
         "America/Belem": -3, "America/Maceio": -3, "America/Araguaina": -3, "America/Manaus": -4, "America/Cuiaba": -4,
         "America/Campo_Grande": -4, "America/Porto_Velho": -4, "America/Boa_Vista": -4, "America/Rio_Branco": -5,
         "America/Noronha": -2, "America/Argentina/Buenos_Aires": -3, "America/Montevideo": -3, "America/Bogota": -5,
         "America/Lima": -5, "Asia/Tokyo": 9, "Asia/Kolkata": 5.5, "Asia/Shanghai": 8, "Asia/Singapore": 8}
_RATE = re.compile(r"^rate\((?P<n>\d+)\s+(?P<unit>minute|minutes|hour|hours|day|days)\)$")
_CRON = re.compile(r"^cron\((?P<body>[^)]+)\)$")
_AT = re.compile(r"^at\((?P<when>\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})\)$")


def zone(name):
    name = name or "UTC"
    try:
        from zoneinfo import ZoneInfo
        return ZoneInfo(name)
    except (ImportError, KeyError, ValueError) as error:
        if name in FIXED:
            return timezone(timedelta(hours=FIXED[name]))
        raise AwsError("ValidationException", f"Time zone '{name}' is unavailable. Install the IANA tzdata package in the cloud runtime or select an available time zone.") from error


def validate(expression):
    expression = (expression or "").strip()
    if _RATE.match(expression) or _AT.match(expression):
        return expression
    match = _CRON.match(expression)
    if match:
        _cron_fields(match.group("body"))
        return expression
    raise AwsError("ValidationException", f"Invalid Schedule Expression {expression}.")


def _values(field, low, high, names=None):
    field = field.upper()
    if field in ("*", "?"):
        return set(range(low, high + 1))
    result = set()
    for part in field.split(","):
        step = 1
        if "/" in part:
            part, step_text = part.split("/", 1)
            step = int(step_text)
        if part in ("*", ""):
            start, end = low, high
        elif "-" in part:
            first, last = part.split("-", 1)
            start, end = _number(first, names), _number(last, names)
        else:
            start = _number(part, names)
            end = high if step > 1 else start
        if start < low or end > high:
            raise ValueError(part)
        result.update(range(start, end + 1, step))
    return result


def _number(text, names):
    if names and text in names:
        return names[text]
    return int(text)


def _cron_fields(body):
    fields = body.split()
    if len(fields) != 6:
        raise AwsError("ValidationException", f"Invalid Schedule Expression cron({body}): six fields are needed (minutes hours day-of-month month day-of-week year).")
    minutes, hours, dom, month, dow, year = fields
    if dom != "?" and dow != "?":
        raise AwsError("ValidationException", f"Invalid Schedule Expression cron({body}): day-of-month or day-of-week must be '?'.")
    try:
        parsed = {"minutes": _values(minutes, 0, 59), "hours": _values(hours, 0, 23), "months": _values(month, 1, 12, MONTHS),
                  "years": _values(year, 1970, 2199), "dom": None, "dow": None, "last": dom.upper() == "L"}
        if dom not in ("?",) and dom.upper() != "L":
            parsed["dom"] = _values(dom, 1, 31)
        if dow != "?":
            parsed["dow"] = _values(dow, 1, 7, DAYS)
    except (ValueError, KeyError) as error:
        raise AwsError("ValidationException", f"Invalid Schedule Expression cron({body}): CloudStudio understands *, ?, lists, ranges, steps and L.") from error
    return parsed


def next_run(expression, after, tz_name=None, created=None):
    """Next firing time (epoch seconds) strictly after `after`, or None when the schedule is over."""
    expression = expression.strip()
    rate = _RATE.match(expression)
    if rate:
        unit = rate.group("unit").rstrip("s")
        seconds = int(rate.group("n")) * {"minute": 60, "hour": 3600, "day": 86400}[unit]
        base = created if created is not None else after
        if after < base + seconds:
            return base + seconds
        return base + (int((after - base) // seconds) + 1) * seconds
    tz = zone(tz_name)
    at = _AT.match(expression)
    if at:
        when = datetime.strptime(at.group("when"), "%Y-%m-%dT%H:%M:%S").replace(tzinfo=tz).timestamp()
        return when if when > after else None
    cron = _cron_fields(_CRON.match(expression).group("body"))
    start = datetime.fromtimestamp(after, tz).replace(second=0, microsecond=0) + timedelta(minutes=1)
    day = start.replace(hour=0, minute=0)
    for offset in range(0, 366 * 5):
        current = day + timedelta(days=offset)
        if current.year not in cron["years"] or current.month not in cron["months"]:
            continue
        if cron["last"]:
            following = (current.replace(day=28) + timedelta(days=4)).replace(day=1)
            if current.day != (following - timedelta(days=1)).day:
                continue
        elif cron["dom"] is not None and current.day not in cron["dom"]:
            continue
        if cron["dow"] is not None and ((current.isoweekday() % 7) + 1) not in cron["dow"]:
            continue
        for hour in sorted(cron["hours"]):
            for minute in sorted(cron["minutes"]):
                moment = current.replace(hour=hour, minute=minute)
                if moment >= start:
                    return moment.timestamp()
    return None


def deliver(cloud, arn, payload, source, group=None):
    """Sends a schedule's or rule's payload to its target: a function, queue, topic, state machine or event bus."""
    text = payload if isinstance(payload, str) else json.dumps(payload, ensure_ascii=False)
    if ":lambda:" in arn:
        try:
            event = json.loads(text)
        except ValueError:
            event = text
        cloud.runtime.invoke_arn_async(arn, event, source)
    elif ":sqs:" in arn:
        from . import sqs
        sqs.deliver_arn(cloud, arn, text, source, group=group)
    elif ":sns:" in arn:
        from . import sns
        sns.publish_arn(cloud, arn, text, None, source)
    elif ":states:" in arn:
        from . import stepfunctions
        stepfunctions.start_arn(cloud, arn, text, source)
    elif ":events:" in arn and ":event-bus/" in arn:
        from . import events
        events.put_internal(cloud, arn, text, source)
    else:
        cloud.internal_call("scheduler", "Deliver", arn.rsplit(":", 1)[-1], source, error=("UnsupportedTarget", f"CloudStudio cannot deliver to {arn}"))
