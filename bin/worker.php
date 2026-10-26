#!/usr/bin/env php
<?php
declare(strict_types=1);
require dirname(__DIR__) . '/app/worker.php';
if (PHP_SAPI !== 'cli') exit(1);
umask(0007);
$lock = fopen(config()['storage'] . '/worker.lock', 'c');
if (!$lock || !flock($lock, LOCK_EX | LOCK_NB)) exit("Já existe um worker nesta pasta.\n");
// The DB lock also prevents another installation from consuming the same queue.
$lockName = 'audioserv:' . query('SELECT DATABASE()')->fetchColumn();
if (!(int) query('SELECT GET_LOCK(?, 0)', [$lockName])->fetchColumn()) exit("Já existe um worker nesta fila.\n");
$stop = false;
pcntl_async_signals(true);
pcntl_signal(SIGTERM, function () use (&$stop): void { $stop = true; });
pcntl_signal(SIGINT, function () use (&$stop): void { $stop = true; });
$once = in_array('--once', $argv, true);
try {
    $gpuCheck = run_process(['/usr/bin/nvidia-smi', '--query-gpu=name', '--format=csv,noheader'], 10);
    $gpu = $gpuCheck['exit'] === 0 ? trim(explode("\n", $gpuCheck['out'])[0]) : null;
    if (config()['require_gpu'] && !$gpu) {
        heartbeat('blocked');
        throw new RuntimeException('GPU NVIDIA indisponível. A fila foi preservada.');
    }
    if (!is_executable(config()['whisper_binary'])) throw new RuntimeException('whisper-cli não encontrado.');
    fwrite(STDOUT, 'AudioServ worker iniciado; GPU: ' . ($gpu ?: 'CPU') . "\n");
    $lastMaintenance = 0;
    do {
        if (time() - $lastMaintenance >= 5) {
            heartbeat('ready', $gpu);
            recover_jobs();
            $lastMaintenance = time();
        }
        $job = claim_job();
        if ($job) {
            fwrite(STDOUT, 'Processando áudio ' . $job['id'] . ' (' . $job['slug'] . ")\n");
            process_job($job, $gpu);
        } elseif (!$once) sleep(2);
    } while (!$stop && !$once);
    heartbeat('stopped', $gpu);
} catch (Throwable $e) {
    fwrite(STDERR, 'Worker: ' . $e->getMessage() . "\n");
    exit(1);
} finally {
    query('SELECT RELEASE_LOCK(?)', [$lockName]);
    flock($lock, LOCK_UN);
    fclose($lock);
}
