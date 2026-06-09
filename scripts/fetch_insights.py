#!/usr/bin/env python3
"""
Build public/insights.json — artikel "Insight" milik sendiri (economstock.com).

Sumber: feed Blogger label "Insight" (economstock.com adalah situs Blogger,
jadi tersedia feed RSS/Atom resmi per label — tanpa scraping HTML).
  https://www.economstock.com/feeds/posts/default/-/Insight?alt=rss

Berbeda dari berita (headlines.json):
  - Ini INSIGHT, bukan berita harian → retensi panjang (90 hari / 3 bulan).
  - Ditarik jarang (2x/hari) lewat .github/workflows/refresh-insights.yml.
  - Semua item diberi source="Economstock" dan cat="insight" supaya frontend
    bisa menggabungkannya ke daftar Headlines + difilter sbg kategori Insight.

Murni fetch + tulis JSON untuk web (TANPA Gemini / Telegram / Playwright).
"""
import json
import os
import re
import sys
import time
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "public", "insights.json")

SOURCE_NAME = "Economstock"
LABEL = "Insight"
RETENTION_DAYS = 90      # insight bertahan 3 bulan di cache
MAX_ITEMS = 60           # batas total item di file
MAX_FETCH = 50           # ambil maksimal sekian item terbaru dari feed

# Feed RSS Blogger untuk label tertentu (alt=rss → format RSS 2.0).
FEED_URL = (
    "https://www.economstock.com/feeds/posts/default/-/"
    + urllib.parse.quote(LABEL)
    + f"?alt=rss&max-results={MAX_FETCH}"
)

UA = ("Mozilla/5.0 (compatible; EconomstockInsights/1.0; "
      "+https://github.com/chamdani49-boop/terminal)")


def fetch(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=25) as r:
        return r.read()


def _strip_ns(tag: str) -> str:
    return tag.split("}", 1)[-1] if "}" in tag else tag


def _text(el):
    return (el.text or "").strip() if el is not None else ""


def parse_feed(xml_bytes: bytes) -> list:
    """Dukung RSS 2.0 (alt=rss) maupun Atom (jaga-jaga bila Blogger balikkan Atom)."""
    out = []
    root = ET.fromstring(xml_bytes)

    # --- RSS 2.0: <channel><item> ---
    items = list(root.iter("item"))
    if items:
        for item in items:
            title = (item.findtext("title") or "").strip()
            link = (item.findtext("link") or "").strip()
            pub = item.findtext("pubDate")
            if not title or not link:
                continue
            ts = _parse_ts(pub)
            out.append(_mk(title, link, ts))
        return out[:MAX_FETCH]

    # --- Atom: <feed><entry> ---
    for entry in root.iter():
        if _strip_ns(entry.tag) != "entry":
            continue
        title, link, pub = "", "", ""
        for ch in entry:
            t = _strip_ns(ch.tag)
            if t == "title":
                title = _text(ch)
            elif t == "link":
                rel = ch.attrib.get("rel", "alternate")
                if rel == "alternate" and ch.attrib.get("href"):
                    link = ch.attrib["href"].strip()
            elif t in ("published", "updated") and not pub:
                pub = _text(ch)
        if title and link:
            out.append(_mk(title, link, _parse_ts(pub)))
    return out[:MAX_FETCH]


def _parse_ts(s):
    if not s:
        return int(datetime.now(timezone.utc).timestamp())
    # RFC822 (RSS) dulu, lalu ISO8601 (Atom)
    try:
        dt = parsedate_to_datetime(s)
    except Exception:
        try:
            dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
        except Exception:
            dt = datetime.now(timezone.utc)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return int(dt.timestamp())


def _mk(title, link, ts):
    return {
        "title": re.sub(r"\s+", " ", title).strip(),
        "link": link,
        "source": SOURCE_NAME,
        "cat": "insight",
        "ts": ts,
    }


def norm_key(s: str) -> str:
    return re.sub(r"\W+", "", (s or "").lower())[:90]


def main() -> int:
    fresh = []
    try:
        fresh = parse_feed(fetch(FEED_URL))
        print(f"[{SOURCE_NAME}/{LABEL}] {len(fresh)} item dari feed")
    except Exception as e:
        print(f"[{SOURCE_NAME}/{LABEL}] GAGAL fetch feed: {e}", file=sys.stderr)

    # Gabung dengan cache lama (jangan buang insight lama walau feed kosong/gagal)
    existing = []
    if os.path.exists(OUT):
        try:
            with open(OUT, encoding="utf-8") as f:
                existing = (json.load(f) or {}).get("items", [])
        except Exception:
            existing = []

    by_key = {}
    for it in existing + fresh:
        # paksa atribut sumber/kategori konsisten
        it.setdefault("source", SOURCE_NAME)
        it.setdefault("cat", "insight")
        k = it.get("link") or norm_key(it.get("title"))
        if not k:
            continue
        if k not in by_key or it.get("ts", 0) > by_key[k].get("ts", 0):
            by_key[k] = it

    cutoff = int(time.time()) - RETENTION_DAYS * 86400
    merged = [it for it in by_key.values() if it.get("ts", 0) >= cutoff]
    merged.sort(key=lambda x: x.get("ts", 0), reverse=True)
    merged = merged[:MAX_ITEMS]

    payload = {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "count": len(merged),
        "items": merged,
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=0)
    print(f"TOTAL tersimpan: {len(merged)} insight -> {OUT}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
