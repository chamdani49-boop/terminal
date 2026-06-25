#!/usr/bin/env python3
"""
Build public/headlines.json — berita pasar saham Indonesia dari beberapa portal.

Sumber: Google News RSS dengan filter `site:` per portal (andal & seragam,
tanpa perlu tahu URL RSS native tiap situs). Link item membuka artikel asli.

Murni fetch + tulis JSON untuk web (TANPA Gemini / Telegram / Playwright).
Dijalankan terjadwal oleh .github/workflows/refresh-headlines.yml (cron).

Cache: hanya fetch "hari berjalan" (when:2d untuk jaga-jaga zona waktu), lalu
digabung dgn cache lama; item > RETENTION_DAYS dibuang, total dibatasi MAX_ITEMS.
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
OUT = os.path.join(HERE, "..", "public", "headlines.json")

RETENTION_DAYS = 3       # berita lebih tua dari ini dibuang dari cache
MAX_ITEMS = 80           # batas total item di file (biar kecil & cepat)
PER_SOURCE = 12          # ambil maksimal sekian item terbaru per portal

# Portal sumber → domain (dipakai filter `site:` di Google News).
# Ganti / tambah portal di sini saja (mis. ganti dengan referensimu sendiri).
SOURCES = [
    ("CNBC Indonesia",    "cnbcindonesia.com"),
    ("Kontan",            "kontan.co.id"),
    ("Bisnis.com",        "bisnis.com"),
    ("Bloomberg Technoz", "bloombergtechnoz.com"),
    ("EmitenNews",        "emitennews.com"),
    ("InvestorTrust",     "investortrust.id"),
    ("Stockwatch",        "stockwatch.id"),
    ("Katadata",          "katadata.co.id"),
    ("EmitenTrust",       "emitentrust.com"),
    ("IDX Channel",       "idxchannel.com"),
    ("IDN Financials",    "idnfinancials.com"),
    ("Kabar Bursa",       "kabarbursa.com"),
]

UA = ("Mozilla/5.0 (compatible; EconomstockHeadlines/1.0; "
      "+https://github.com/chamdani49-boop/terminal)")


def gnews_url(domain: str) -> str:
    q = f"site:{domain} when:2d"
    return ("https://news.google.com/rss/search?q="
            + urllib.parse.quote(q)
            + "&hl=id-ID&gl=ID&ceid=ID:id")


def fetch(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=25) as r:
        return r.read()


def clean_title(t: str) -> str:
    # Judul Google News biasanya "Judul Berita - Nama Media" → buang sufiks media.
    return re.sub(r"\s+-\s+[^-]+$", "", t).strip() or t.strip()


def parse_feed(xml_bytes: bytes, source: str) -> list:
    out = []
    root = ET.fromstring(xml_bytes)
    for item in root.iter("item"):
        title = (item.findtext("title") or "").strip()
        link = (item.findtext("link") or "").strip()
        if not title or not link:
            continue
        pub = item.findtext("pubDate")
        try:
            dt = parsedate_to_datetime(pub) if pub else datetime.now(timezone.utc)
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
        except Exception:
            dt = datetime.now(timezone.utc)
        out.append({
            "title": clean_title(title),
            "link": link,
            "source": source,
            "ts": int(dt.timestamp()),
        })
    return out[:PER_SOURCE]


def norm_key(s: str) -> str:
    return re.sub(r"\W+", "", (s or "").lower())[:90]


def main() -> int:
    fresh = []
    for name, domain in SOURCES:
        try:
            data = fetch(gnews_url(domain))
            got = parse_feed(data, name)
            print(f"[{name}] {len(got)} item")
            fresh.extend(got)
        except Exception as e:
            print(f"[{name}] GAGAL: {e}", file=sys.stderr)
        time.sleep(1)  # sopan ke Google

    # Gabung dengan cache lama
    existing = []
    if os.path.exists(OUT):
        try:
            with open(OUT, encoding="utf-8") as f:
                existing = (json.load(f) or {}).get("items", [])
        except Exception:
            existing = []

    by_key = {}
    for it in existing + fresh:
        k = norm_key(it.get("title"))
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
    print(f"TOTAL tersimpan: {len(merged)} item -> {OUT}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
