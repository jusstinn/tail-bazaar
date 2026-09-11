"""Canonical JSON (format id "tb-cjson-1") and commitment hashing.

The rules below are the specification. The TypeScript port in web/src/canonical.ts
implements the same rules and the test suite checks both produce identical bytes.

1. Output is UTF-8. No insignificant whitespace: separators are "," and ":" only.
2. Objects: keys must be ASCII strings; they are sorted by code point, recursively.
3. Strings: JSON escaping of only '"', '\\' and control characters U+0000..U+001F
   (short forms \\n \\r \\t \\b \\f, others as \\u00XX with lowercase hex). Non-ASCII
   characters are written as raw UTF-8, never as \\u escapes.
4. Numbers: NaN and +/-Infinity are rejected. A number whose value is integral
   (including the floats 2.0 and -0.0) is written as integer digits ("2", "0").
   Any other number is written as the shortest decimal string that round-trips to
   the same IEEE-754 double (Python repr / ECMAScript Number#toString), expanded to
   plain positional notation with no exponent. Producers round evidence floats to
   6 decimal places with quantize() before serializing, which keeps this short.
5. true/false/null as in JSON. No other types.

commitment = keccak256(canonical_bytes(private_package)) as 0x-prefixed lowercase hex.
The private package contains a 32-byte random salt ("salt_hex"), so the commitment
does not leak the package contents to anyone who can guess the scenario.
"""

from __future__ import annotations

import json
import math
import secrets
from typing import Any

from Crypto.Hash import keccak

FORMAT_ID = "tb-cjson-1"


def _expand_exponent(s: str) -> str:
    """Turn a shortest-repr float like '1.5e-05' into plain notation '0.000015'."""
    if "e" not in s and "E" not in s:
        return s
    mant, exp = s.lower().split("e")
    exp_i = int(exp)
    neg = mant.startswith("-")
    if neg:
        mant = mant[1:]
    if "." in mant:
        ip, fp = mant.split(".")
    else:
        ip, fp = mant, ""
    digits = ip + fp
    point = len(ip) + exp_i  # position of the decimal point within digits
    if point <= 0:
        out = "0." + "0" * (-point) + digits
    elif point >= len(digits):
        out = digits + "0" * (point - len(digits))
    else:
        out = digits[:point] + "." + digits[point:]
    # strip trailing zeros in the fractional part and a dangling point
    if "." in out:
        out = out.rstrip("0").rstrip(".")
    # strip leading zeros of the integer part (keep one)
    ip2, _, fp2 = out.partition(".")
    ip2 = ip2.lstrip("0") or "0"
    out = ip2 + ("." + fp2 if fp2 else "")
    return ("-" if neg else "") + out


def format_number(x: Any) -> str:
    if isinstance(x, bool):
        raise TypeError("bool is not a number here")
    if isinstance(x, int):
        return str(x)
    if isinstance(x, float):
        if math.isnan(x) or math.isinf(x):
            raise ValueError("NaN/Infinity are not allowed in canonical JSON")
        if x == math.floor(x):
            return str(int(x))  # integral floats, including -0.0, become integer digits
        return _expand_exponent(repr(x))
    raise TypeError(f"unsupported number type {type(x)!r}")


def dumps(value: Any) -> str:
    """Serialize to the canonical string form."""
    parts: list[str] = []
    _write(value, parts)
    return "".join(parts)


def _write(v: Any, out: list[str]) -> None:
    if v is None:
        out.append("null")
    elif v is True:
        out.append("true")
    elif v is False:
        out.append("false")
    elif isinstance(v, (int, float)):
        out.append(format_number(v))
    elif isinstance(v, str):
        out.append(json.dumps(v, ensure_ascii=False))
    elif isinstance(v, (list, tuple)):
        out.append("[")
        for i, item in enumerate(v):
            if i:
                out.append(",")
            _write(item, out)
        out.append("]")
    elif isinstance(v, dict):
        keys = list(v.keys())
        for k in keys:
            if not isinstance(k, str) or not k.isascii():
                raise TypeError(f"object keys must be ASCII strings, got {k!r}")
        out.append("{")
        for i, k in enumerate(sorted(keys)):
            if i:
                out.append(",")
            out.append(json.dumps(k))
            out.append(":")
            _write(v[k], out)
        out.append("}")
    else:
        raise TypeError(f"unsupported type {type(v)!r}")


def dumps_bytes(value: Any) -> bytes:
    return dumps(value).encode("utf-8")


def keccak256_hex(data: bytes) -> str:
    h = keccak.new(digest_bits=256)
    h.update(data)
    return "0x" + h.hexdigest()


def commitment(value: Any) -> str:
    """keccak256 over the canonical bytes of a document."""
    return keccak256_hex(dumps_bytes(value))


def quantize(x: Any, places: int = 6) -> Any:
    """Round floats to `places` decimals recursively; leaves ints/strings alone."""
    if isinstance(x, bool):
        return x
    if isinstance(x, float):
        r = round(x, places)
        if r == 0:
            return 0
        return r
    if isinstance(x, dict):
        return {k: quantize(v, places) for k, v in x.items()}
    if isinstance(x, (list, tuple)):
        return [quantize(v, places) for v in x]
    return x


def new_salt_hex() -> str:
    return "0x" + secrets.token_hex(32)


def is_canonical(raw: bytes) -> bool:
    """True if `raw` is exactly the canonical serialization of the document it encodes."""
    try:
        doc = json.loads(raw.decode("utf-8"))
    except Exception:
        return False
    return dumps_bytes(doc) == raw
