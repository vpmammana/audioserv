"""Integration against the isolated MySQL 8 + Apache instance; real Whisper GPU.
Run with the existing Python containing requests and pymysql. No production writes.
"""
import concurrent.futures
import io
import json
import os
from pathlib import Path
import subprocess
import time
import uuid
import wave

import pymysql
import requests

ROOT = Path(__file__).resolve().parent.parent
BASE = 'http://127.0.0.1:8096/api/'
ENV = dict(os.environ, AUDIOSERV_CONFIG=str(ROOT / 'var/qa/config.php'))
config = json.loads(subprocess.check_output(['php', '-r', 'echo json_encode(require getenv("AUDIOSERV_CONFIG"));'], env=ENV))
assert 'dbname=audioserv_test;' in config['db']['dsn'], 'Refusing production database'
database = pymysql.connect(host='127.0.0.1', port=33079, user=config['db']['user'], password=config['db']['password'], database='audioserv_test', autocommit=True)
sample = Path('/home/victor/whisper.cpp/samples/jfk.wav').read_bytes()
session = requests.Session()
initial = session.get(BASE + 'bootstrap.php', timeout=10).json()
headers = {'X-CSRF-Token': initial['csrf']}
worker = None
worker_log = open(ROOT / 'var/qa/logs/integration-worker.log', 'a')


def upload(model='small', request_id=None, content=sample, name='fixture.wav', custom_headers=None):
    return session.post(BASE + 'upload.php', headers=headers if custom_headers is None else custom_headers,
                        data={'model': model, 'language': 'en', 'request_id': request_id or str(uuid.uuid4())},
                        files={'audio': (name, content, 'audio/wav')}, timeout=15)


def start_worker():
    global worker
    worker = subprocess.Popen(['php', str(ROOT / 'bin/worker.php')], env=ENV, stdout=worker_log, stderr=worker_log)


def stop_worker():
    global worker
    if worker:
        worker.terminate()
        worker.wait(timeout=40)
        worker = None


def wait_jobs(ids, timeout=50):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        jobs = {j['id']: j for j in session.get(BASE + 'bootstrap.php', timeout=10).json()['jobs']}
        if all(i in jobs and jobs[i]['status'] in ('completed', 'failed') for i in ids):
            return [jobs[i] for i in ids]
        time.sleep(.3)
    raise AssertionError('Timed out waiting for jobs')


try:
    assert upload(custom_headers={}).status_code == 403
    assert upload(model='not-a-model').status_code == 422
    assert upload(content=b'not an audio file' * 100).status_code == 415
    assert upload(request_id='invalid').status_code == 422
    print('PASS: CSRF, model allowlist, MIME and request identifiers', flush=True)

    duplicate_id = str(uuid.uuid4())
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        responses = list(pool.map(lambda _: upload(request_id=duplicate_id), range(2)))
    assert sorted(r.status_code for r in responses) == [200, 202], [(r.status_code, r.text) for r in responses]
    job1 = responses[0].json()['job']['id']
    assert all(r.json()['job']['id'] == job1 for r in responses)

    stream = session.get(BASE + 'events.php?after=0', stream=True, timeout=(5, 35))
    assert stream.status_code == 200 and stream.headers['Content-Type'].startswith('text/event-stream')
    start = time.monotonic()
    response = upload(model='large-v3')
    assert response.status_code == 202, response.text
    assert time.monotonic() - start < 5, 'SSE blocked a parallel upload'
    job2 = response.json()['job']['id']
    print('PASS: concurrent idempotency; upload remains available during SSE', flush=True)

    stranger = requests.Session()
    stranger.get(BASE + 'bootstrap.php', timeout=5)
    assert stranger.get(BASE + f'audio.php?id={job1}', timeout=5).status_code == 404
    assert stranger.get(BASE + 'events.php?transport=poll&after=0', timeout=5).json()['events'] == []
    assert stranger.get(BASE + 'history.php', timeout=5).json()['jobs'] == []
    ranged = session.get(BASE + f'audio.php?id={job1}', headers={'Range': 'bytes=0-99'}, timeout=5)
    assert ranged.status_code == 206 and ranged.content == sample[:100]
    assert session.get(BASE + f'audio.php?id={job1}', headers={'Range': 'bytes=99999999-'}, timeout=5).status_code == 416
    print('PASS: device isolation and authenticated audio byte ranges', flush=True)

    start_worker()
    observed = set()
    last_id = 0
    for line in stream.iter_lines(chunk_size=1, decode_unicode=True):
        if line.startswith('id: '):
            last_id = max(last_id, int(line[4:]))
        if line.startswith('data: '):
            event = json.loads(line[6:])
            if event.get('status') == 'completed':
                observed.add(event['job']['id'])
            if {job1, job2}.issubset(observed):
                break
    stream.close()
    assert {job1, job2}.issubset(observed), observed
    completed = wait_jobs([job1, job2])
    for job in completed:
        assert job['status'] == 'completed', job
        assert 'country' in job['text'].lower()
        assert job['duration_ms'] == 11000
        assert job['processing_ms'] > 0
    assert completed[0]['finished_at'] <= completed[1]['started_at'], 'GPU queue must be sequential'
    assert session.get(BASE + f'events.php?transport=poll&after={last_id}', timeout=5).json()['events'] == []
    replay = session.get(BASE + 'events.php?after=0', headers={'Last-Event-ID': str(last_id - 1)}, stream=True, timeout=(5, 35))
    first_event = next(line for line in replay.iter_lines(chunk_size=1, decode_unicode=True) if line.startswith('id: '))
    assert int(first_event[4:]) == last_id
    replay.close()
    print('PASS: real small + large-v3 GPU transcriptions, FIFO, SSE replay and cursor', flush=True)

    stop_worker()
    assert not session.get(BASE + 'bootstrap.php', timeout=5).json()['worker']['online']
    job3 = upload().json()['job']['id']
    job4 = upload().json()['job']['id']
    with database.cursor() as cur:
        cur.execute("UPDATE transcription_jobs SET status='transcribing', attempts=1, lease_token='expired', lease_until=DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 1 SECOND) WHERE id=%s", (job3,))
        cur.execute("UPDATE transcription_jobs SET status='transcribing', attempts=3, lease_token='expired', lease_until=DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 1 SECOND) WHERE id=%s", (job4,))
    start_worker()
    recovered, exhausted = wait_jobs([job3, job4])
    assert recovered['status'] == 'completed' and recovered['attempts'] == 2
    assert exhausted['status'] == 'failed' and exhausted['attempts'] == 3
    print('PASS: interrupted lease recovery, bounded retry and stopped-worker health', flush=True)

    bad = bytearray(sample[:1000])
    bad[12:] = b'\x00' * (len(bad) - 12)
    invalid = upload(content=bytes(bad))
    if invalid.status_code == 202:
        failed = wait_jobs([invalid.json()['job']['id']])[0]
        assert failed['status'] == 'failed' and failed['attempts'] == 1
    else:
        assert invalid.status_code == 415
    print('PASS: corrupt audio fails safely', flush=True)
    with database.cursor() as cur:
        cur.execute('SELECT COUNT(*) FROM transcriptions t JOIN transcription_segments s ON s.transcription_id=t.id WHERE t.job_id IN (%s,%s)', (job1, job2))
        assert cur.fetchone()[0] >= 2
        cur.execute('SELECT token_hash FROM client_devices WHERE token_hash=%s', (session.cookies.get('audioserv_device'),))
        assert cur.fetchone() is None, 'Raw cookie must never be stored'
    print('PASS: normalized segments and hashed browser identity', flush=True)
    print('ALL INTEGRATION CHECKS PASSED', flush=True)
finally:
    stop_worker()
    worker_log.close()
    database.close()
