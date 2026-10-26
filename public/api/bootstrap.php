<?php
declare(strict_types=1);
require dirname(__DIR__, 2) . '/app/bootstrap.php';
api(function (): void {
    require_method('GET');
    $d = device(true);
    query('UPDATE client_devices SET last_seen_at = UTC_TIMESTAMP(3) WHERE id = ? AND last_seen_at < DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 5 MINUTE)', [$d['id']]);
    db()->beginTransaction();
    // Cursor and history share a repeatable-read snapshot, so no update is lost.
    $cursor = (int) query('SELECT COALESCE(MAX(e.id), 0) FROM job_events e JOIN transcription_jobs j ON j.id = e.job_id
        JOIN audio_files a ON a.id = j.audio_file_id WHERE a.device_id = ?', [$d['id']])->fetchColumn();
    $jobs = query(job_select() . ' WHERE a.device_id = ? ORDER BY j.id DESC LIMIT 50', [$d['id']])->fetchAll();
    $active = query(job_select() . " WHERE a.device_id = ? AND j.status IN ('queued','normalizing','transcribing') ORDER BY j.id", [$d['id']])->fetchAll();
    db()->commit();
    $byId = [];
    foreach (array_merge($jobs, $active) as $j) $byId[$j['id']] = format_job($j);
    json_response(['csrf' => $d['csrf'], 'cursor' => $cursor, 'jobs' => array_values($byId),
        'has_more' => count($jobs) === 50, 'models' => models(), 'worker' => worker_health(),
        'limits' => ['bytes' => config()['max_upload_bytes'], 'seconds' => config()['max_duration_seconds'],
            'chunk_seconds' => config()['chunk_seconds'], 'queue_bytes' => config()['queue_bytes_per_device'],
            'global_queue_bytes' => config()['queue_bytes_global'], 'pcm_bytes_per_second' => 32000]]);
});
