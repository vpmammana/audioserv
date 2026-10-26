<?php
declare(strict_types=1);
require dirname(__DIR__, 2) . '/app/bootstrap.php';
api(function (): void {
    require_method('GET');
    $d = device();
    $before = max(1, (int) ($_GET['before'] ?? PHP_INT_MAX));
    $jobs = query(job_select() . ' WHERE a.device_id = ? AND j.id < ? ORDER BY j.id DESC LIMIT 50', [$d['id'], $before])->fetchAll();
    json_response(['jobs' => array_map('format_job', $jobs), 'has_more' => count($jobs) === 50]);
});
