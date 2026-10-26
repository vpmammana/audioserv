#!/usr/bin/env php
<?php
declare(strict_types=1);
require dirname(__DIR__) . '/app/worker.php';
if (PHP_SAPI !== 'cli') exit(1);
try {
    echo 'PHP: ' . PHP_VERSION . "\n";
    echo 'MySQL: ' . query('SELECT VERSION()')->fetchColumn() . "\n";
    echo 'Banco: ' . query('SELECT DATABASE()')->fetchColumn() . "\n";
    echo 'Worker: ' . (worker_health()['online'] ? 'disponível' : 'parado ou sem heartbeat recente') . "\n";
    $gpu = run_process(['/usr/bin/nvidia-smi', '--query-gpu=name,memory.total', '--format=csv,noheader'], 10);
    echo 'GPU: ' . ($gpu['exit'] === 0 ? trim($gpu['out']) : 'indisponível') . "\n";
    echo 'whisper-cli: ' . (is_executable(config()['whisper_binary']) ? 'encontrado' : 'não encontrado') . "\n";
    echo 'Modelos instalados: ' . implode(', ', array_column(array_filter(models(), fn ($m) => $m['available']), 'slug')) . "\n";
    foreach (query('SELECT status, COUNT(*) AS total FROM transcription_jobs GROUP BY status')->fetchAll() as $row) {
        echo $row['status'] . ': ' . $row['total'] . "\n";
    }
} catch (Throwable $e) {
    fwrite(STDERR, $e->getMessage() . "\n");
    exit(1);
}
