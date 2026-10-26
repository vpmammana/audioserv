<?php
declare(strict_types=1);
require_once __DIR__ . '/bootstrap.php';

final class JobFailure extends RuntimeException
{
    public function __construct(public string $reason, string $message, public bool $retryable = false)
    {
        parent::__construct($message);
    }
}

function run_process(array $command, int $timeout, ?callable $tick = null): array
{
    // Array arguments bypass the shell entirely; uploaded names are never commands.
    $process = proc_open($command, [0 => ['file', '/dev/null', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes);
    if (!is_resource($process)) throw new JobFailure('process', 'Não foi possível iniciar o processamento.', true);
    stream_set_blocking($pipes[1], false);
    stream_set_blocking($pipes[2], false);
    $out = $err = '';
    $start = microtime(true);
    $exit = -1;
    try {
        do {
            $out = substr($out . stream_get_contents($pipes[1]), -1024 * 1024);
            $err = substr($err . stream_get_contents($pipes[2]), -1024 * 1024);
            $status = proc_get_status($process);
            if (!$status['running']) { $exit = $status['exitcode']; break; }
            if (microtime(true) - $start > $timeout) throw new JobFailure('timeout', 'O processamento ultrapassou o tempo limite.', true);
            if ($tick) $tick();
            usleep(100000);
        } while (true);
        $out = substr($out . stream_get_contents($pipes[1]), -1024 * 1024);
        $err = substr($err . stream_get_contents($pipes[2]), -1024 * 1024);
    } finally {
        if (proc_get_status($process)['running']) {
            proc_terminate($process);
            usleep(150000);
            if (proc_get_status($process)['running']) proc_terminate($process, 9);
        }
        fclose($pipes[1]);
        fclose($pipes[2]);
        proc_close($process);
    }
    return ['exit' => $exit, 'out' => $out, 'err' => $err];
}

function heartbeat(string $status = 'ready', ?string $gpu = null): void
{
    query('INSERT INTO worker_heartbeats (worker_id, last_seen_at, status, gpu_name) VALUES (?, UTC_TIMESTAMP(3), ?, ?)
        ON DUPLICATE KEY UPDATE last_seen_at = VALUES(last_seen_at), status = VALUES(status), gpu_name = VALUES(gpu_name)',
        ['gpu-0', $status, $gpu]);
}

function recover_jobs(): int
{
    $rows = query("SELECT j.id, a.device_id FROM transcription_jobs j JOIN audio_files a ON a.id = j.audio_file_id
        WHERE j.status IN ('normalizing','transcribing') AND j.lease_until < UTC_TIMESTAMP(3) LIMIT 100")->fetchAll();
    $count = 0;
    foreach ($rows as $row) {
        db()->beginTransaction();
        try {
            lock_device((int) $row['device_id']);
            $j = query("SELECT * FROM transcription_jobs WHERE id = ? AND status IN ('normalizing','transcribing')
                AND lease_until < UTC_TIMESTAMP(3) FOR UPDATE", [$row['id']])->fetch();
            if ($j) {
                $retry = $j['attempts'] < $j['max_attempts'];
                $state = $retry ? 'queued' : 'failed';
                $message = $retry ? 'Processamento interrompido. Áudio devolvido à fila.' : 'Não foi possível concluir após três tentativas.';
                query("UPDATE transcription_jobs SET status = ?, progress = 0, lease_token = NULL, lease_until = NULL,
                    available_at = UTC_TIMESTAMP(3), finished_at = " . ($retry ? 'NULL' : 'UTC_TIMESTAMP(3)') . ",
                    error_code = 'interrupted', error_message = ? WHERE id = ?", [$state, $message, $j['id']]);
                emit_event((int) $j['id'], $state, $message);
                $count++;
            }
            db()->commit();
        } catch (Throwable $e) { db()->rollBack(); throw $e; }
    }
    return $count;
}

function claim_job(): ?array
{
    $candidate = query("SELECT j.id, a.device_id FROM transcription_jobs j JOIN audio_files a ON a.id = j.audio_file_id
        WHERE j.status = 'queued' AND j.available_at <= UTC_TIMESTAMP(3) ORDER BY j.id LIMIT 1")->fetch();
    if (!$candidate) return null;
    db()->beginTransaction();
    try {
        lock_device((int) $candidate['device_id']);
        $job = query("SELECT j.*, a.device_id, a.storage_key, m.slug FROM transcription_jobs j
            JOIN audio_files a ON a.id = j.audio_file_id JOIN whisper_models m ON m.id = j.model_id
            WHERE j.id = ? AND j.status = 'queued' AND j.available_at <= UTC_TIMESTAMP(3) FOR UPDATE", [$candidate['id']])->fetch();
        if (!$job) { db()->commit(); return null; }
        $job['lease_token'] = bin2hex(random_bytes(16));
        $job['attempts']++;
        query("UPDATE transcription_jobs SET status = 'normalizing', progress = 10, attempts = attempts + 1,
            lease_token = ?, lease_until = DATE_ADD(UTC_TIMESTAMP(3), INTERVAL ? SECOND),
            started_at = UTC_TIMESTAMP(3), finished_at = NULL, error_code = NULL, error_message = NULL WHERE id = ?",
            [$job['lease_token'], config()['lease_seconds'], $job['id']]);
        emit_event((int) $job['id'], 'normalizing', 'Preparando áudio ' . $job['id'] . '.');
        db()->commit();
        return $job;
    } catch (Throwable $e) { db()->rollBack(); throw $e; }
}

function owned_job(array $job): void
{
    if (!query('SELECT id FROM transcription_jobs WHERE id = ? AND lease_token = ? FOR UPDATE', [$job['id'], $job['lease_token']])->fetch()) {
        throw new RuntimeException('A tarefa não pertence mais a este worker.');
    }
}

function fail_job(array $job, Throwable $error): void
{
    $known = $error instanceof JobFailure;
    $retry = (!$known || $error->retryable) && $job['attempts'] < $job['max_attempts'];
    $code = $known ? $error->reason : 'internal';
    $message = $known ? $error->getMessage() : 'Falha temporária no servidor.';
    if ($retry) $message .= ' Uma nova tentativa será feita automaticamente.';
    $state = $retry ? 'queued' : 'failed';
    db()->beginTransaction();
    try {
        lock_device((int) $job['device_id']);
        owned_job($job);
        query("UPDATE transcription_jobs SET status = ?, progress = 0, lease_token = NULL, lease_until = NULL,
            error_code = ?, error_message = ?, available_at = DATE_ADD(UTC_TIMESTAMP(3), INTERVAL ? SECOND),
            finished_at = " . ($retry ? 'NULL' : 'UTC_TIMESTAMP(3)') . ' WHERE id = ?',
            [$state, $code, $message, 10 * $job['attempts'], $job['id']]);
        emit_event((int) $job['id'], $state, $message);
        db()->commit();
    } catch (Throwable $e) { db()->rollBack(); throw $e; }
    error_log('AudioServ job ' . $job['id'] . ': ' . $code . ($retry ? ' (retry)' : ' (failed)'));
}

function process_job(array $job, ?string $gpu): void
{
    $c = config();
    $prefix = $c['storage'] . '/work/' . $job['id'] . '-' . $job['lease_token'];
    $wav = $prefix . '.wav';
    $renewed = 0;
    $tick = function () use ($job, $gpu, &$renewed, $c): void {
        if (time() - $renewed < 5) return;
        $updated = query('UPDATE transcription_jobs SET lease_until = DATE_ADD(UTC_TIMESTAMP(3), INTERVAL ? SECOND)
            WHERE id = ? AND lease_token = ?', [$c['lease_seconds'], $job['id'], $job['lease_token']]);
        if (!$updated->rowCount()) throw new RuntimeException('Lease perdido.');
        heartbeat('busy', $gpu);
        $renewed = time();
    };
    $started = microtime(true);
    try {
        $tick();
        $input = $c['storage'] . '/uploads/' . $job['storage_key'];
        if (!is_file($input)) throw new JobFailure('missing_audio', 'O arquivo de áudio não está disponível.');
        $converted = run_process(['/usr/bin/ffmpeg', '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
            '-protocol_whitelist', 'file,pipe', '-threads', '2', '-i', $input, '-map', '0:a:0', '-vn',
            '-t', (string) ($c['max_duration_seconds'] + 1), '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-f', 'wav', $wav], 120, $tick);
        if ($converted['exit'] !== 0 || !is_file($wav)) throw new JobFailure('invalid_audio', 'Este arquivo não contém um áudio válido ou está corrompido.');
        $probe = run_process(['/usr/bin/ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', $wav], 10, $tick);
        $duration = (float) trim($probe['out']);
        if ($duration > $c['max_duration_seconds']) throw new JobFailure('too_long', 'O áudio ultrapassa o limite de 20 minutos.');
        if ($duration < 0.1) throw new JobFailure('too_short', 'O áudio é curto demais para transcrever.');
        db()->beginTransaction();
        lock_device((int) $job['device_id']);
        owned_job($job);
        query('UPDATE audio_files SET duration_ms = ? WHERE id = ?', [(int) round($duration * 1000), $job['audio_file_id']]);
        query("UPDATE transcription_jobs SET status = 'transcribing', progress = 25 WHERE id = ?", [$job['id']]);
        emit_event((int) $job['id'], 'transcribing', 'Tratando áudio ' . $job['id'] . ' com Whisper ' . $job['slug'] . '.');
        db()->commit();
        $model = model_path($job['slug']);
        if (!is_readable($model)) throw new JobFailure('model_missing', 'O modelo selecionado não está disponível.');
        $result = run_process([$c['whisper_binary'], '-m', $model, '-f', $wav, '-l', $job['language'],
            '-t', (string) $c['threads'], '-bs', '5', '-bo', '5', '-oj', '-of', $prefix], $c['job_timeout_seconds'], $tick);
        if ($result['exit'] !== 0 || !is_file($prefix . '.json')) throw new JobFailure('whisper', 'O Whisper não conseguiu concluir a transcrição.', true);
        if ($c['require_gpu'] && !preg_match('/using CUDA\d* backend/', $result['err'])) {
            throw new JobFailure('gpu_unavailable', 'A GPU não está disponível para processar o áudio.', true);
        }
        $output = json_decode(file_get_contents($prefix . '.json'), true, 512, JSON_THROW_ON_ERROR);
        if (!isset($output['transcription']) || !is_array($output['transcription'])) throw new JobFailure('invalid_output', 'O Whisper retornou um resultado inválido.', true);
        $segments = $output['transcription'];
        $text = trim(implode(' ', array_map(fn (array $s): string => trim($s['text'] ?? ''), $segments)));
        db()->beginTransaction();
        lock_device((int) $job['device_id']);
        owned_job($job);
        query('INSERT INTO transcriptions (job_id, detected_language, text, processing_ms, engine) VALUES (?, ?, ?, ?, ?)',
            [$job['id'], $output['result']['language'] ?? $job['language'], $text, (int) round((microtime(true) - $started) * 1000), 'whisper.cpp CUDA']);
        $transcription = (int) db()->lastInsertId();
        foreach ($segments as $n => $s) {
            query('INSERT INTO transcription_segments (transcription_id, sequence_number, start_ms, end_ms, text) VALUES (?, ?, ?, ?, ?)',
                [$transcription, $n, max(0, (int) ($s['offsets']['from'] ?? 0)), max(0, (int) ($s['offsets']['to'] ?? 0)), trim($s['text'] ?? '')]);
        }
        query("UPDATE transcription_jobs SET status = 'completed', progress = 100, finished_at = UTC_TIMESTAMP(3),
            lease_token = NULL, lease_until = NULL WHERE id = ?", [$job['id']]);
        emit_event((int) $job['id'], 'completed', 'Áudio ' . $job['id'] . ' tratado.');
        db()->commit();
    } catch (Throwable $e) {
        if (db()->inTransaction()) db()->rollBack();
        fail_job($job, $e);
    } finally {
        foreach ([$wav, $prefix . '.json'] as $file) if (is_file($file)) unlink($file);
        heartbeat('ready', $gpu);
    }
}
