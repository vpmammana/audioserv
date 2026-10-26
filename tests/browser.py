"""Push-to-talk browser checks with real AudioWorklet and simulated microphone."""
import json
import os
from pathlib import Path
import subprocess
import time
from playwright.sync_api import sync_playwright, expect
ROOT = Path(__file__).resolve().parent.parent
URL = 'http://127.0.0.1:8098/'
ENV = dict(os.environ, AUDIOCONTINUO_CONFIG=str(ROOT / 'var/qa/config.php'))
log = open(ROOT / 'var/qa/logs/browser-worker.log', 'a')
worker = subprocess.Popen(['php', 'bin/worker.php'], cwd=ROOT, env=ENV, stdout=log, stderr=log)

def until(page, expression, timeout=30):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if page.evaluate(expression): return
        page.wait_for_timeout(200)
    raise AssertionError('Timeout: ' + expression)

def hold(page):
    page.locator('#record').hover(); page.mouse.down()
    expect(page.locator('#recorder')).to_have_class('recorder is-recording', timeout=10000)

try:
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, args=['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--use-file-for-fake-audio-capture=/home/victor/whisper.cpp/samples/jfk.wav'])
        context = browser.new_context(viewport={'width':1440,'height':1000}, permissions=['microphone'], has_touch=True)
        page = context.new_page(); errors=[]
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.goto(URL,wait_until='networkidle'); expect(page.locator('#record')).to_be_enabled()
        page.select_option('#language','en')
        page.screenshot(path=str(ROOT/'var/qa/desktop.png'),full_page=True)
        page.evaluate('''() => {
            const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
            window.originalMedia = original;
            navigator.mediaDevices.getUserMedia = async (...args) => { await new Promise(r => setTimeout(r, 600)); window.delayedStream = await original(...args); return window.delayedStream; };
        }''')
        page.locator('#record').hover(); page.mouse.down(); page.wait_for_timeout(150); page.mouse.up(); page.wait_for_timeout(1000)
        assert page.evaluate('recording === null && press === null && jobs.size === 0')
        assert page.evaluate('!window.delayedStream || window.delayedStream.getTracks().every(t => t.readyState === "ended")')
        page.evaluate('() => { navigator.mediaDevices.getUserMedia = window.originalMedia; }')
        print('PASS: release before microphone permission completes never starts recording later',flush=True)
        hold(page)
        page.wait_for_timeout(12000)
        assert page.evaluate('press !== null && recording !== null && jobs.size >= 1'), 'Chunks must upload while held'
        page.mouse.move(15,15); page.mouse.up()
        until(page, 'recording === null && uploads.size === 0 && !pending()')
        actual=page.evaluate('Array.from(jobs.values()).map(j => ({chunk:j.chunk_number,status:j.status,duration:j.duration_ms,recording:j.recording_id}))')
        assert len(actual)>=2 and all(j['status']=='completed' for j in actual), actual
        assert [j['chunk'] for j in actual]==list(range(1,len(actual)+1)),actual
        assert len({j['recording'] for j in actual})==1
        assert all(j['duration']<=10000 for j in actual)
        previous=page.evaluate('jobs.size'); page.wait_for_timeout(1800); assert page.evaluate('jobs.size')==previous
        expect(page.locator('#record')).to_have_attribute('aria-pressed','false')
        print('PASS: continuous hold sends independent chunks before release; last partial; release outside button stops new capture',flush=True)
        page.select_option('#model','large-v3'); page.locator('#record').focus(); page.keyboard.down('Space')
        expect(page.locator('#recorder')).to_have_class('recorder is-recording')
        page.wait_for_timeout(1700); page.keyboard.up('Space')
        until(page, 'recording === null && uploads.size === 0 && !pending()')
        assert page.evaluate('Array.from(jobs.values()).at(-1).model')=='large-v3'
        print('PASS: keyboard hold/release and Large v3 GPU transcription',flush=True)
        hold(page); page.wait_for_timeout(600); page.evaluate('window.dispatchEvent(new Event("blur"))'); page.mouse.up()
        until(page, 'recording === null && uploads.size === 0 && !pending()')
        expect(page.locator('#record')).to_have_attribute('aria-pressed','false')
        page.set_viewport_size({'width':390,'height':844})
        page.click('#settings-toggle'); page.select_option('#model','small'); page.select_option('#chat-size','large'); page.keyboard.press('Escape')
        cdp=context.new_cdp_session(page); box=page.locator('#record').bounding_box(); x=box['x']+box['width']/2; y=box['y']+box['height']/2
        cdp.send('Input.dispatchTouchEvent',{'type':'touchStart','touchPoints':[{'x':x,'y':y}]})
        expect(page.locator('#recorder')).to_have_class('recorder is-recording')
        page.wait_for_timeout(1200)
        cdp.send('Input.dispatchTouchEvent',{'type':'touchEnd','touchPoints':[]})
        until(page, 'recording === null && uploads.size === 0 && !pending()')
        assert page.evaluate('document.body.scrollWidth <= innerWidth')
        page.click('#theme'); page.wait_for_timeout(250); page.screenshot(path=str(ROOT/'var/qa/mobile-dark.png'),full_page=True)
        print('PASS: lost focus stops capture; touch hold/release, mobile, theme and font sizing',flush=True)
        context.close()
        # Use a smaller client budget to exercise the exact limit path in seconds.
        limited=browser.new_context(viewport={'width':1200,'height':900},permissions=['microphone'])
        limited.add_init_script('''(() => { window.alertStarts = 0; const original = AudioBufferSourceNode.prototype.start; AudioBufferSourceNode.prototype.start = function(...a) { window.alertStarts++; return original.apply(this,a); }; })();''')
        lp=limited.new_page(); lp.on('pageerror',lambda e: errors.append(str(e)))
        def smaller_budget(route):
            response=route.fetch(); data=response.json(); data['limits']['queue_bytes']=32768
            route.fulfill(response=response,json=data)
        lp.route('**/api/bootstrap.php',smaller_budget)
        lp.goto(URL); expect(lp.locator('#record')).to_be_enabled(); hold(lp)
        expect(lp.locator('#limit-notice')).to_be_visible(timeout=10000)
        until(lp,'recording === null && press === null && alertStarts === 1')
        expect(lp.locator('#record')).to_have_attribute('aria-pressed','false')
        lp.wait_for_timeout(2000)
        assert lp.evaluate('recording === null && press === null && alertStarts === 1')
        lp.mouse.up(); lp.screenshot(path=str(ROOT/'var/qa/limit.png'),full_page=True)
        print('PASS: byte cap automatically releases button, stops microphone, displays exact warning and plays local spoken alert once',flush=True)
        limited.close()
        assert not errors,errors
        browser.close()
        print('ALL BROWSER CHECKS PASSED',flush=True)
finally:
    worker.terminate(); worker.wait(timeout=40); log.close()
