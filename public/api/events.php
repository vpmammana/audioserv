<?php
declare(strict_types=1);
require dirname(__DIR__, 2) . '/app/bootstrap.php';
api(function (): void {
    require_method('GET');
    $d = device();
    $cursor = max(0, (int) ($_SERVER['HTTP_LAST_EVENT_ID'] ?? $_GET['after'] ?? 0));
    if (($_GET['transport'] ?? '') === 'poll') {
        $events = events_after($d['id'], $cursor);
        json_response(['events' => $events, 'worker' => worker_health()]);
    }
    header('Content-Type: text/event-stream; charset=utf-8');
    header('Cache-Control: no-cache, no-store, no-transform');
    header('X-Accel-Buffering: no');
    ini_set('zlib.output_compression', '0');
    while (ob_get_level()) ob_end_clean();
    set_time_limit(config()['stream_seconds'] + 5);
    ignore_user_abort(false);
    echo "retry: 1500\n\n";
    flush();
    $started = microtime(true);
    $heartbeat = 0;
    while (!connection_aborted() && microtime(true) - $started < config()['stream_seconds']) {
        foreach (events_after($d['id'], $cursor) as $event) {
            $cursor = $event['id'];
            echo 'id: ' . $cursor . "\nevent: job\ndata: " . json_encode($event, JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE) . "\n\n";
        }
        if (time() - $heartbeat >= 8) {
            echo 'event: heartbeat' . "\ndata: " . json_encode(['worker' => worker_health()]) . "\n\n";
            $heartbeat = time();
        }
        flush();
        usleep(750000);
    }
    // An explicit rotation is distinct from a network error in the client.
    echo "event: rotate\ndata: {}\n\n";
    flush();
});
