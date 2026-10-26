"""Real PHP/MySQL/GPU integration; refuses the production database."""
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
BASE = 'http://127.0.0.1:8098/api/'
ENV = dict(os.environ, AUDIOCONTINUO_CONFIG=str(ROOT / 'var/qa/config.php'))
c = json.loads(subprocess.check_output(['php', '-r', 'echo json_encode(require getenv("AUDIOCONTINUO_CONFIG"));'], env=ENV))
assert 'dbname=audiocontinuo_test;' in c['db']['dsn']
db = pymysql.connect(host='127.0.0.1', port=33080, user=c['db']['user'], password=c['db']['password'], database='audiocontinuo_test', autocommit=True)
with wave.open('/home/victor/whisper.cpp/samples/jfk.wav', 'rb') as f:
    pcm = f.readframes(160000)
out = io.BytesIO()
with wave.open(out, 'wb') as f:
    f.setparams((1, 2, 16000, 0, 'NONE', 'not compressed')); f.writeframes(pcm)
sample = out.getvalue()

def client():
    s = requests.Session(); data = s.get(BASE + 'bootstrap.php', timeout=10).json()
    return s, data['csrf']

def upload(s, csrf, recording=None, number=1, request=None, model='small', content=sample):
    return s.post(BASE + 'upload.php', headers={'X-CSRF-Token': csrf}, data={
        'request_id': request or str(uuid.uuid4()), 'recording_id': recording or str(uuid.uuid4()),
        'chunk_number': number, 'model': model, 'language': 'en'}, files={'audio': ('chunk.wav', content, 'audio/wav')}, timeout=10)

def status(s, ids):
    for _ in range(150):
        jobs = {j['id']: j for j in s.get(BASE + 'bootstrap.php', timeout=10).json()['jobs']}
        if all(i in jobs and jobs[i]['status'] in ('completed', 'failed') for i in ids): return [jobs[i] for i in ids]
        time.sleep(.2)
    raise AssertionError('Transcription timed out')

worker = None
log = open(ROOT / 'var/qa/logs/integration-worker.log', 'a')
try:
    s, csrf = client(); stranger, other_csrf = client()
    assert upload(s, '').status_code == 403
    assert upload(s, csrf, content=b'bad audio' * 500).status_code == 415
    assert upload(s, csrf, model='not-a-model').status_code == 422
    rec = str(uuid.uuid4()); rid = str(uuid.uuid4())
    assert upload(s, csrf, recording=rec, number=2).status_code == 409
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        responses = list(pool.map(lambda _: upload(s, csrf, recording=rec, request=rid), range(2)))
    assert sorted(r.status_code for r in responses) == [200, 202], [(r.status_code, r.text) for r in responses]
    job1 = responses[0].json()['job']['id']
    assert responses[1].json()['job']['id'] == job1
    stream = s.get(BASE + 'events.php?after=0', stream=True, timeout=(5, 35))
    before = time.monotonic(); r = upload(s, csrf, recording=rec, number=2, model='large-v3')
    assert r.status_code == 202, r.text
    assert time.monotonic() - before < 3
    job2 = r.json()['job']['id']
    assert stranger.get(BASE + f'audio.php?id={job1}', timeout=5).status_code == 404
    assert stranger.get(BASE + 'events.php?transport=poll', timeout=5).json()['events'] == []
    ranged = s.get(BASE + f'audio.php?id={job1}', headers={'Range': 'bytes=0-99'}, timeout=5)
    assert ranged.status_code == 206 and ranged.content == sample[:100]
    print('PASS: canonical WAV validation, CSRF, ordered chunks, concurrent idempotency, independent upload/SSE, isolation', flush=True)
    worker = subprocess.Popen(['php', 'bin/worker.php'], cwd=ROOT, env=ENV, stdout=log, stderr=log)
    done = set(); last = 0
    for line in stream.iter_lines(chunk_size=1, decode_unicode=True):
        if line.startswith('id: '): last = int(line[4:])
        if line.startswith('data: '):
            event = json.loads(line[6:])
            if event.get('status') == 'completed': done.add(event['job']['id'])
            if {job1, job2}.issubset(done): break
    stream.close()
    a, b = status(s, [job1, job2])
    assert all(j['status'] == 'completed' and 'country' in j['text'].lower() for j in [a, b]), [a, b]
    assert a['finished_at'] <= b['started_at']
    assert a['recording_id'] == b['recording_id'] and [a['chunk_number'], b['chunk_number']] == [1, 2]
    assert s.get(BASE + f'events.php?transport=poll&after={last}', timeout=5).json()['events'] == []
    print('PASS: real Small/Large v3 GPU results, sequence metadata, FIFO and SSE cursor', flush=True)
    worker.terminate(); worker.wait(timeout=40); worker = None
    quota, qcsrf = client(); queued = []
    for _ in range(12):
        r = upload(quota, qcsrf); assert r.status_code == 202, r.text; queued.append(r.json()['job']['id'])
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        responses = list(pool.map(lambda _: upload(quota, qcsrf), range(2)))
    assert sorted(r.status_code for r in responses) == [202, 429]
    for r in responses:
        if r.status_code == 202: queued.append(r.json()['job']['id'])
        else: assert r.json()['code'] == 'queue_limit'
    jobs = quota.get(BASE + 'bootstrap.php', timeout=5).json()['jobs']
    assert sum(j['byte_size'] for j in jobs if j['status'] in ['queued', 'normalizing', 'transcribing']) <= c['queue_bytes_per_device']
    print('PASS: concurrent requests cannot exceed the per-device byte cap', flush=True)
    with db.cursor() as cur:
        cur.execute('SELECT audio_file_id FROM transcription_jobs WHERE id=%s', (queued[0],)); file_id = cur.fetchone()[0]
        cur.execute('UPDATE audio_files SET byte_size=%s WHERE id=%s', (c['queue_bytes_global'], file_id))
        try:
            r = upload(stranger, other_csrf); assert r.status_code == 429 and r.json()['code'] == 'queue_limit'
        finally:
            cur.execute('UPDATE audio_files SET byte_size=%s WHERE id=%s', (len(sample), file_id))
            # Retire only quota-test tasks so GPU tests do not waste time on them.
            cur.execute('UPDATE transcription_jobs SET status=\'failed\', finished_at=UTC_TIMESTAMP(3), error_code=\'test_fixture\' WHERE id IN (' + ','.join(['%s'] * len(queued)) + ')', queued)
    print('PASS: global byte cap applies across different devices', flush=True)
    r = upload(s, csrf); recovery = r.json()['job']['id']
    with db.cursor() as cur:
        cur.execute("UPDATE transcription_jobs SET status='transcribing', attempts=1, lease_token='expired', lease_until=DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 1 SECOND) WHERE id=%s", (recovery,))
    worker = subprocess.Popen(['php', 'bin/worker.php'], cwd=ROOT, env=ENV, stdout=log, stderr=log)
    recovered = status(s, [recovery])[0]
    assert recovered['status'] == 'completed' and recovered['attempts'] == 2
    print('PASS: abandoned chunks recover after a worker interruption', flush=True)
    print('ALL INTEGRATION CHECKS PASSED', flush=True)
finally:
    if worker: worker.terminate(); worker.wait(timeout=40)
    db.close(); log.close()
