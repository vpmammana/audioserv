"""Browser QA against isolated Apache/MySQL, with Chromium's simulated microphone."""
import os
from pathlib import Path
import subprocess
import time
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parent.parent
URL = 'http://127.0.0.1:8096/'
ENV = dict(os.environ, AUDIOSERV_CONFIG=str(ROOT / 'var/qa/config.php'))
worker = None
log = open(ROOT / 'var/qa/logs/browser-worker.log', 'a')


def start_worker():
    global worker
    worker = subprocess.Popen(['php', str(ROOT / 'bin/worker.php')], env=ENV, stdout=log, stderr=log)


def stop_worker():
    global worker
    if worker:
        worker.terminate()
        worker.wait(timeout=40)
        worker = None


try:
    start_worker()
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, args=[
            '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
            '--use-file-for-fake-audio-capture=/home/victor/whisper.cpp/samples/jfk.wav'])
        context = browser.new_context(viewport={'width': 1440, 'height': 1000}, permissions=['microphone', 'clipboard-read', 'clipboard-write'])
        page = context.new_page()
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.goto(URL)
        expect(page.locator('#record')).to_be_enabled()
        expect(page.locator('#model')).to_have_value('small')
        page.select_option('#language', 'en')
        page.screenshot(path=str(ROOT / 'var/qa/desktop-light.png'), full_page=True)
        page.click('#theme')
        expect(page.locator('html')).to_have_attribute('data-theme', 'dark')
        page.reload()
        expect(page.locator('html')).to_have_attribute('data-theme', 'dark')
        expect(page.locator('#record')).to_be_enabled()
        page.screenshot(path=str(ROOT / 'var/qa/desktop-dark.png'), full_page=True)
        page.click('#theme')
        print('PASS: bootstrap, model selection, dark/light persistence', flush=True)

        page.click('#record')
        expect(page.locator('#recorder')).to_have_class('recorder is-recording')
        page.wait_for_timeout(3500)
        page.select_option('#model', 'large-v3')  # First recording must retain small.
        page.click('#record')
        expect(page.locator('#record')).to_be_enabled()
        page.click('#record')
        expect(page.locator('#recorder')).to_have_class('recorder is-recording')
        page.wait_for_timeout(3000)
        page.click('#record')
        expect(page.locator('[data-result-id]')).to_have_count(2, timeout=45000)
        expect(page.locator('#pending-count')).to_have_text('0')
        state = page.evaluate('Array.from(jobs.values()).map(j => ({status:j.status, model:j.model}))')
        assert [j['model'] for j in state] == ['small', 'large-v3'], state
        assert all(j['status'] == 'completed' for j in state), state
        page.screenshot(path=str(ROOT / 'var/qa/chat-light.png'), full_page=True)
        print('PASS: two actual MediaRecorder uploads, settings snapshot, GPU replies', flush=True)

        page.locator('[data-result-id] .text-button').first.click()
        expect(page.locator('#toast')).to_have_text('Texto copiado.')
        with page.expect_download() as download:
            page.click('#export')
        assert download.value.suggested_filename.endswith('.txt')
        page.reload()
        expect(page.locator('[data-result-id]')).to_have_count(2)
        idle_requests = []
        page.on('request', lambda req: idle_requests.append(req.url) if '/api/events.php' in req.url else None)
        page.wait_for_timeout(6000)
        assert not idle_requests, 'No status requests should run with an empty queue'
        print('PASS: clipboard, export, history restoration, no idle polling', flush=True)

        page.set_viewport_size({'width': 390, 'height': 844})
        page.click('#settings-toggle')
        expect(page.locator('#sidebar')).to_have_class('sidebar open')
        page.select_option('#model', 'small')
        page.keyboard.press('Escape')
        assert page.evaluate('document.body.scrollWidth <= innerWidth')
        page.screenshot(path=str(ROOT / 'var/qa/mobile-light.png'), full_page=True)
        page.click('#theme')
        page.screenshot(path=str(ROOT / 'var/qa/mobile-dark.png'), full_page=True)
        print('PASS: mobile layout and preferences in both themes', flush=True)

        # A lost confirmation must preserve the blob and request UUID for safe retry.
        page.route('**/api/upload.php', lambda route: route.fulfill(status=503, content_type='application/json', body='{"error":"Falha simulada no envio"}'), times=1)
        page.locator('#file').set_input_files('/home/victor/whisper.cpp/samples/jfk.wav')
        expect(page.get_by_role('button', name='Reenviar', exact=True)).to_be_visible()
        assert page.evaluate('uploads.size') == 1
        page.get_by_role('button', name='Reenviar', exact=True).click()
        expect(page.locator('[data-result-id]')).to_have_count(3, timeout=30000)
        assert page.evaluate('uploads.size') == 0
        print('PASS: failed upload retains audio and can be retried', flush=True)

        # Force SSE network failures to verify adaptive fallback, then stop at idle.
        stop_worker()
        page.route('**/api/events.php?after=*', lambda route: route.abort())
        page.locator('#file').set_input_files('/home/victor/whisper.cpp/samples/jfk.wav')
        deadline = time.monotonic() + 25
        while time.monotonic() < deadline and not page.evaluate('fallback'):
            page.wait_for_timeout(300)
        assert page.evaluate('fallback'), 'SSE errors did not activate fallback'
        start_worker()
        expect(page.locator('[data-result-id]')).to_have_count(4, timeout=45000)
        expect(page.locator('#pending-count')).to_have_text('0')
        assert page.evaluate('source === null && pollTimer === null')
        print('PASS: SSE failure switches to adaptive polling, which stops at idle', flush=True)
        assert not errors, errors
        context.close()
        browser.close()
        print('ALL BROWSER CHECKS PASSED', flush=True)
finally:
    stop_worker()
    log.close()
