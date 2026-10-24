"""Pick the last complete review object out of noisy Codex output.

Codex sometimes writes more than one JSON value, or trailing lines after a
valid object. json.load then fails with "Extra data". Job outputs are not
used for this payload: callers pass the raw text from a file or artifact.

A parse failure reports only counts and the missing field name. It must not
include any of the review text.
"""

import json

VERDICT_FIELD = "merge_recommendation"


def _line_count(text):
    if not text:
        return 0
    return text.count("\n") + (0 if text.endswith("\n") else 1)


def _json_values(text):
    decoder = json.JSONDecoder()
    idx = 0
    length = len(text)
    while idx < length:
        while idx < length and text[idx].isspace():
            idx += 1
        if idx >= length:
            return
        try:
            value, end = decoder.raw_decode(text, idx)
        except json.JSONDecodeError:
            next_object = text.find("{", idx + 1)
            next_array = text.find("[", idx + 1)
            candidates = [pos for pos in (next_object, next_array) if pos >= 0]
            if not candidates:
                return
            idx = min(candidates)
            continue
        yield value
        if end <= idx:
            idx += 1
        else:
            idx = end


def _objects(text):
    """Complete JSON objects: top-level dicts, and dict items of a top-level list."""
    found = []
    for value in _json_values(text):
        if isinstance(value, dict):
            found.append(value)
        elif isinstance(value, list):
            found.extend(item for item in value if isinstance(item, dict))
    return found


def _failure(byte_length, line_count, object_count):
    return (
        "审核结果解析失败。"
        f"字节数={byte_length}，行数={line_count}，"
        f"JSON 对象数={object_count}，缺失字段={VERDICT_FIELD}"
    )


def load_last_verdict(text):
    """Return the last complete object that contains merge_recommendation.

    Raises ValueError with byte length, line count, object count, and the
    missing field. The message never quotes the review text.
    """
    if isinstance(text, bytes):
        byte_length = len(text)
        text = text.decode("utf-8", errors="replace")
    else:
        text = str(text)
        byte_length = len(text.encode("utf-8"))
    line_count = _line_count(text)
    objects = _objects(text.lstrip("\ufeff"))
    verdicts = [obj for obj in objects if isinstance(obj, dict) and VERDICT_FIELD in obj]
    if not verdicts:
        raise ValueError(_failure(byte_length, line_count, len(objects)))
    return verdicts[-1]
