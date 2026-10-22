#!/usr/bin/env python3
"""One-shot publication of verified CI artifacts; never overwrite a tag or release."""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request

REPO = 'rommeltrejo/home-assistant-view'
TAG = '0.34'
VERSION = '0.34.0'
NAMES = (
    f'ha.view-{VERSION}-linux-x64-kiosk.tar.gz',
    f'ha.view-{VERSION}-win32-x64-portable.zip',
)
API = f'https://api.github.com/repos/{REPO}'
TOKEN = os.environ.get('GH_TOKEN', '')


def request(method, url, data=None, content_type='application/json'):
    headers = {'Authorization': f'Bearer {TOKEN}', 'Accept': 'application/vnd.github+json',
               'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'ha-view-release'}
    if data is not None:
        headers['Content-Type'] = content_type
    with urllib.request.urlopen(urllib.request.Request(url, data=data, headers=headers, method=method), timeout=120) as response:
        return json.load(response) if response.headers.get('Content-Type', '').startswith('application/json') else response.read()


def absent(url):
    try:
        request('GET', url)
    except urllib.error.HTTPError as error:
        if error.code == 404:
            return
        raise
    raise RuntimeError(f'Already exists; refusing to replace: {url}')


def verify(directory):
    files = []
    expected = set()
    for name in NAMES:
        archive = directory / name
        sidecar = directory / (name + '.sha256')
        expected.update((name, name + '.sha256'))
        if not archive.is_file() or not sidecar.is_file() or not archive.stat().st_size:
            raise RuntimeError(f'Missing or empty distribution: {name}')
        text = sidecar.read_text(encoding='ascii')
        match = re.fullmatch(r'([0-9a-f]{64})  ([^\r\n]+)\n', text)
        if not match or match.group(2) != name:
            raise RuntimeError(f'Invalid SHA-256 sidecar: {sidecar}')
        with archive.open('rb') as stream:
            digest = hashlib.file_digest(stream, 'sha256').hexdigest()
        if digest != match.group(1):
            raise RuntimeError(f'SHA-256 mismatch: {archive}')
        files.extend((archive, sidecar))
    if {p.name for p in directory.iterdir() if p.is_file()} != expected:
        raise RuntimeError('Unexpected or missing release assets')
    return files


def main():
    if not TOKEN:
        raise RuntimeError('Missing GH_TOKEN')
    sha = os.environ['GITHUB_SHA']
    if os.environ.get('GITHUB_REPOSITORY') != REPO or os.environ.get('GITHUB_EVENT_NAME') != 'push':
        raise RuntimeError('Only the canonical repository push can publish')
    if not re.fullmatch(r'[0-9a-f]{40}', sha) or os.environ.get('GITHUB_REF') != 'refs/heads/main':
        raise RuntimeError('Requires a main branch commit SHA')
    if subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip() != sha:
        raise RuntimeError('Checkout is not the workflow commit')
    if len(sys.argv) != 2:
        raise RuntimeError('Expected one release-input directory')
    files = verify(Path(sys.argv[1]))
    absent(f'{API}/git/ref/tags/{TAG}')
    absent(f'{API}/releases/tags/{TAG}')
    # The tag endpoint may not expose drafts; reject those explicitly as well.
    if any(item['tag_name'] == TAG for item in request('GET', f'{API}/releases?per_page=100')):
        raise RuntimeError('Existing draft or published 0.34 release')
    # Do not make a Git tag until both archives, their hashes and all naming are validated.
    tag = request('POST', f'{API}/git/refs', json.dumps({'ref': f'refs/tags/{TAG}', 'sha': sha}).encode())
    if tag['object']['sha'] != sha:
        raise RuntimeError('Created tag does not point to the workflow commit')
    try:
        release = request('POST', f'{API}/releases', json.dumps({
        'tag_name': TAG, 'target_commitish': sha, 'name': f'HA View {TAG}',
        'draft': True, 'prerelease': False, 'generate_release_notes': False,
        'body': 'Unsigned Linux x64 kiosk tarball and Windows x64 portable ZIP. Verify downloads with the accompanying SHA-256 files.'
    }).encode())
    except Exception as error:
        raise RuntimeError(f'Tag {TAG} was created; release draft creation failed; do not retry automatically') from error
    upload = release['upload_url'].split('{')[0]
    for file in files:
        request('POST', upload + '?name=' + urllib.parse.quote(file.name), file.read_bytes(), 'application/octet-stream')
    assets = request('GET', f"{API}/releases/{release['id']}/assets?per_page=100")
    if {asset['name'] for asset in assets} != {file.name for file in files} or any(not a['size'] for a in assets):
        raise RuntimeError('Draft incomplete; leaving unpublished for manual recovery')
    request('PATCH', f"{API}/releases/{release['id']}", json.dumps({'draft': False}).encode())
    print(f'Published {TAG} at {sha} with four verified assets')


if __name__ == '__main__':
    main()
