#!/usr/bin/env python3
"""
fetch-financials-r2.py — unduh laporan keuangan baru dari R2 (bucket smartmoney, folder financials/) ke data/financials-r2/.

File di R2 ditulis scraper web Pantau: financials/<KODE>/<periode>.json. build-valuation.py lalu menyambungkannya ke
data Excel (lihat scripts/financials_overlay.py). Folder data/financials-r2/ tidak di-commit (.gitignore).

Butuh secret GitHub (Settings → Secrets and variables → Actions):
  R2_ENDPOINT          https://<account-id>.r2.cloudflarestorage.com
  R2_ACCESS_KEY_ID     kunci token R2 (cukup izin baca / Object Read only)
  R2_SECRET_ACCESS_KEY rahasia token R2
  R2_BUCKET            (opsional, default smartmoney)
Tanpa secret: tidak ada yang diunduh, valuasi dibangun dari Excel saja (sama seperti sebelumnya).
"""

import os, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'data', 'financials-r2')


def main():
    ep, key, sec = (os.environ.get(k, '').strip() for k in ('R2_ENDPOINT', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'))
    bucket = os.environ.get('R2_BUCKET', '').strip() or 'smartmoney'
    if not (ep and key and sec):
        print('[fetch-financials-r2] secret R2 belum diatur → dilewati (valuasi dari Excel saja)')
        return 0
    import boto3
    s3 = boto3.client('s3', endpoint_url=ep, region_name='auto', aws_access_key_id=key, aws_secret_access_key=sec)
    n = size = 0
    for page in s3.get_paginator('list_objects_v2').paginate(Bucket=bucket, Prefix='financials/'):
        for o in page.get('Contents') or []:
            k = o['Key']
            parts = k.split('/')
            if len(parts) != 3 or not parts[2].endswith('.json') or not parts[1].isalnum():
                continue
            dst = os.path.join(OUT, parts[1].upper(), parts[2])
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            s3.download_file(bucket, k, dst)
            n += 1
            size += o.get('Size') or 0
    print(f'[fetch-financials-r2] {n} file ({size / 1e6:.1f} MB) diunduh ke data/financials-r2/')
    return 0


if __name__ == '__main__':
    sys.exit(main())
